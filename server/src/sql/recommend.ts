// Query única da recomendação, reescrita p/ busca instantânea na base global
// (28,9M empresas). Decisões que derrubam o tempo de ~29s para <1s no pior caso
// (São Paulo capital, ~2,7M ativas, sem CNAE-alvo):
//
//  1) ÍNDICE DE COBERTURA (companies_reco_cov_idx, migração 058): partial em
//     (municipio_id) INCLUDE (id,uf,regiao,cnae_principal,cnae_divisao,porte,
//     capital_social) WHERE ativa. O scan de candidatos vira Index Only Scan —
//     zero acesso ao heap de 18GB. Exige visibility map atualizado (VACUUM); o
//     ETL roda VACUUM ANALYZE ao final da carga.
//  2) ln() em float8, não numeric. O `ln(capital_social)` por linha (2,7M) em
//     numeric custava ~2,6s; `capital_social::float8` usa o ln nativo em C.
//  3) enabled_regions como ARRAYS ($9/$10), não subquery EXISTS. O EXISTS virava
//     "hashed SubPlan" e bloqueava o paralelismo; com arrays escalares o planner
//     paraleliza o scan (4 workers).
//  4) PROXIMIDADE por MUNICÍPIO, não por empresa. A distância vira uma constante
//     por município (centroide->origem), calculada na rota e embutida como um
//     CASE sobre municipio_id (pare-safe, sem JOIN — um JOIN degradaria a
//     estimativa e cairia em plano serial). A distância exata (geocode) só é
//     calculada para as 20 linhas exibidas, no SELECT externo.
//
// Ranking usa a proximidade em nível de município (dentro de uma cidade, a
// variação intraurbana é ínfima perto da normalização de 150km); a distância
// mostrada no card é a exata (geocode do endereço), só p/ as 20 linhas da página.

const DEFAULT_NORM_M = 150_000; // proximity normalization in municipio mode (~150km)
const CAPITAL_REF = 1_000_000;  // capital_social normalization reference
const LN_CAPREF = Math.log(1 + CAPITAL_REF); // divisor pré-calculado do ln (float)
const IDADE_REF_ANOS = 20;      // tempo de vida que satura o componente idade

// Acima disto o CASE de proximidade fica grande demais p/ valer a pena; com
// território tão amplo a proximidade por município é sinal fraco -> usa a média
// como constante única (mantém o plano paralelo com um escalar).
const MAX_PROX_CASE = 300;

export interface RecommendProfile {
  cnaes_alvo: number[];
  territorio_municipios: number[];
  pesos: { cnae?: number; proximidade?: number; porte?: number; capital?: number; idade?: number };
  // Endereço de partida (origem das rotas) definido nos filtros. Quando presente,
  // a proximidade é medida a partir daqui em vez do centroide do território.
  partida?: { lat: number; lon: number } | null;
}

export interface RecommendFilters {
  q?: string;            // texto: razão / fantasia / cnpj
  porte?: string;        // porte_emp
  capMin?: number;       // capital social (R$) — faixa
  capMax?: number;
  idadeMin?: number;     // tempo de vida (anos) — faixa
  idadeMax?: number;
}

export interface RecommendArgs {
  orgId: number;
  profile: RecommendProfile;
  limit: number;
  offset: number;
  filters?: RecommendFilters;
  // derivados de cnaes_alvo + cnae_divisao_secao (calculados na rota, cacheados):
  divisoesAlvo: number[];   // divisões dos CNAEs alvo (fit 0.6)
  secoesAlvo: string[];     // seções dessas divisões (fit 0.3)
  pruneDivisoes: number[];  // todas as divisões dessas seções (poda de candidatos)
  // regiões habilitadas (gate da recomendação), como arrays escalares:
  regioesUf: string[];      // UFs habilitadas
  regioesRegiao: string[];  // regiões habilitadas (regiao_br)
  // proximidade por município: pc já é wProx*(1 - min(dist/norm, 1)).
  muniProx: { id: number; pc: number }[];
  // origem (partida ou centroide do território) — só p/ a distância exibida.
  origin: { lat: number; lon: number };
}

// Monta o termo de proximidade: CASE sobre municipio_id com o pc de cada
// município (paralelo-safe, sem JOIN). Território muito amplo -> constante média.
// Teto do total de empresas do perfil. Contar exato o território todo (SP capital
// = 2,4M candidatos) custa ~0,5s por request; parar em CAP+1 custa ~5ms e responde
// a única pergunta que interessa na tela ("tem muita empresa aqui?").
export const RECOMMEND_COUNT_CAP = 10_000;

// Predicados de candidato — mesma poda usada pelo ranking e pela contagem. Os
// índices dos parâmetros vêm de fora porque as duas queries têm layouts distintos.
function candidatePredicates(idx: {
  munis: number; org: number; cnaes: number; prune: number; uf: number; regiao: number;
}): string {
  return `c.situacao_cadastral = 'ativa'
      -- empresas da base de demonstração (migração 073) são fictícias e vivem no
      -- mesmo pool global: nunca podem ser sugeridas para nenhum tenant.
      AND c.source <> 'demo'
      AND c.municipio_id = ANY($${idx.munis}::int[])
      AND (cardinality($${idx.cnaes}::int[]) = 0 OR c.cnae_divisao = ANY($${idx.prune}::smallint[]))
      AND (c.uf = ANY($${idx.uf}::bpchar[]) OR c.regiao = ANY($${idx.regiao}::regiao_br[]))
      AND NOT EXISTS (
        SELECT 1 FROM company_relationships r WHERE r.org_id = $${idx.org} AND r.company_id = c.id
      )`;
}

// Filtros server-side (WHERE sobre toda a base dentro do território/alvo).
// Empurra os parâmetros em `params` a partir do fim e devolve o trecho de WHERE.
function filterPredicates(f: RecommendFilters, params: unknown[]): string {
  let p = params.length;
  const extra: string[] = [];
  if (f.porte) { params.push(f.porte); extra.push(`c.porte = $${++p}::porte_emp`); }
  // Faixas de capital social e tempo de vida. Ambas as colunas estão no INCLUDE
  // do índice de cobertura (migração 068), então o filtro não custa heap.
  if (f.capMin != null) { params.push(f.capMin); extra.push(`c.capital_social >= $${++p}::numeric`); }
  if (f.capMax != null) { params.push(f.capMax); extra.push(`c.capital_social <= $${++p}::numeric`); }
  // idade em anos -> data limite. Empresa sem data_inicio_atividade (nulo na base
  // RFB) sai do resultado quando a faixa é usada — não dá p/ afirmar a idade dela.
  if (f.idadeMin != null) {
    params.push(f.idadeMin);
    extra.push(`c.data_inicio_atividade <= CURRENT_DATE - ($${++p}::float8 * 365.25)::int`);
  }
  if (f.idadeMax != null) {
    params.push(f.idadeMax);
    extra.push(`c.data_inicio_atividade >= CURRENT_DATE - ($${++p}::float8 * 365.25)::int`);
  }
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    params.push(`%${f.q}%`); const a = ++p;
    if (digits.length >= 2) {
      params.push(`${digits}%`); const b = ++p;
      extra.push(`(c.razao_social ILIKE $${a} OR c.nome_fantasia ILIKE $${a} OR c.cnpj LIKE $${b})`);
    } else {
      extra.push(`(c.razao_social ILIKE $${a} OR c.nome_fantasia ILIKE $${a})`);
    }
  }
  return extra.length ? `\n    AND ${extra.join('\n    AND ')}` : '';
}

// Total de empresas do perfil, capado em RECOMMEND_COUNT_CAP+1 (o +1 distingue
// "exatamente 10.000" de "10.000+"). Sem score, sem sort e sem o join de seção:
// só o Index Scan do território, que o LIMIT interrompe assim que enche a cota.
export function buildRecommendCountQuery(args: RecommendArgs): { text: string; params: unknown[] } {
  const params: unknown[] = [
    args.profile.territorio_municipios ?? [], // $1 municipios
    args.orgId,                               // $2 orgId
    args.profile.cnaes_alvo ?? [],            // $3 cnaes
    args.pruneDivisoes,                       // $4 pruneDivisoes
    args.regioesUf,                           // $5 regioesUf
    args.regioesRegiao,                       // $6 regioesRegiao
  ];
  const where = candidatePredicates({ munis: 1, org: 2, cnaes: 3, prune: 4, uf: 5, regiao: 6 });
  const extraPredicates = filterPredicates(args.filters ?? {}, params);
  const text = `
SELECT count(*)::int AS total FROM (
  SELECT 1
  FROM companies c
  WHERE ${where}${extraPredicates}
  LIMIT ${RECOMMEND_COUNT_CAP + 1}
) t`;
  return { text, params };
}

function proximityExpr(muniProx: { id: number; pc: number }[]): string {
  if (muniProx.length === 0) return '0::float8';
  if (muniProx.length > MAX_PROX_CASE) {
    const avg = muniProx.reduce((s, m) => s + m.pc, 0) / muniProx.length;
    return `${avg.toExponential()}::float8`;
  }
  // ids são inteiros e pc são números calculados no servidor — seguros p/ embutir.
  const whens = muniProx
    .map((m) => `WHEN ${Math.trunc(m.id)} THEN ${m.pc.toExponential()}::float8`)
    .join(' ');
  return `CASE c.municipio_id ${whens} ELSE 0 END`;
}

export function buildRecommendQuery(args: RecommendArgs): { text: string; params: unknown[] } {
  const { orgId, profile, limit, offset } = args;
  const cnaes = profile.cnaes_alvo ?? [];
  const municipios = profile.territorio_municipios ?? [];

  const wCnae = profile.pesos?.cnae ?? 0.4;
  const wPorte = profile.pesos?.porte ?? 0.15;
  const wCapital = profile.pesos?.capital ?? 0.1;
  const wIdade = profile.pesos?.idade ?? 0.1;
  // wProx não entra no SQL como parâmetro (já vem multiplicado dentro do pc de
  // cada município, ver muniProximity) — aqui ele só compõe o divisor. Default
  // 0.25 = o mesmo de parsePesos.
  const wProx = profile.pesos?.proximidade ?? 0.25;

  // NORMALIZAÇÃO DO SCORE. O score é a soma dos cinco componentes já ponderados,
  // então o teto dele é a SOMA DOS PESOS, não 1. Com os pesos default a soma dá
  // exatamente 1,0 e dividir é inócuo; mas quem mexe nos sliders encolhe o teto
  // junto (cinco pesos em 0,10 -> teto 0,50) e a tela passava a mostrar "27 de
  // 100" para a melhor empresa da lista, como se as empresas tivessem piorado.
  // Dividir pela soma devolve a escala 0..1 sem mexer no ranking — divisor
  // constante e positivo não altera a ordem. Todos os pesos em zero: score é 0
  // de qualquer jeito, divide por 1 só p/ não dar divisão por zero.
  // round: a soma dos default em float dá 1.0000000000000002 e sujaria o SQL.
  const wSoma = Math.round((wCnae + wProx + wPorte + wCapital + wIdade) * 1e6) / 1e6;
  const norm = `${(wSoma > 0 ? wSoma : 1).toExponential()}::float8`;

  // $1 municipios, $2 orgId, $3 wCnae, $4 wPorte, $5 cnaes, $6 divisoesAlvo,
  // $7 secoesAlvo, $8 pruneDivisoes, $9 regioesUf, $10 regioesRegiao,
  // $11 limit, $12 offset, $13 originLat, $14 originLon,
  // $15 wCapital, $16 wIdade, $17+ filtros
  const params: unknown[] = [
    municipios, orgId, wCnae, wPorte,
    cnaes, args.divisoesAlvo, args.secoesAlvo, args.pruneDivisoes,
    args.regioesUf, args.regioesRegiao, limit, offset,
    args.origin.lat, args.origin.lon,
    wCapital, wIdade,
  ];

  const prox = proximityExpr(args.muniProx);

  // fit em tiers. Sem CNAE-alvo os arrays vêm vazios: ANY(vazio)=false -> fit=0
  // (sempre referencia $5/$6/$7, senão o Postgres não infere o tipo do param).
  const fitExpr =
    `CASE WHEN c.cnae_principal = ANY($5::int[]) THEN 1.0::float8
          WHEN c.cnae_divisao = ANY($6::smallint[]) THEN 0.6::float8
          WHEN cds.secao = ANY($7::text[]) THEN 0.3::float8
          ELSE 0::float8 END`;
  const cdsJoin = 'LEFT JOIN cnae_divisao_secao cds ON cds.divisao = c.cnae_divisao';
  // Poda por divisão (só varre as divisões das seções-alvo). Sem CNAE-alvo
  // (cardinality 0) o filtro é TRUE e varre o território todo.
  const where = candidatePredicates({ munis: 1, org: 2, cnaes: 5, prune: 8, uf: 9, regiao: 10 });

  // porte, capital social e tempo de vida são componentes independentes (cada um
  // com o seu peso) — antes capital estava embutido no componente porte.
  const porteS = `(CASE c.porte WHEN 'demais' THEN 1.0 WHEN 'pequeno' THEN 0.7 WHEN 'micro' THEN 0.4 ELSE 0.2 END)::float8`;
  const capitalS = `LEAST(ln(1 + COALESCE(c.capital_social, 0)::float8) / ${LN_CAPREF}, 1.0)`;
  // tempo de vida: linear até ${IDADE_REF_ANOS} anos (satura em 1). Sem data de
  // início (base RFB tem nulos) o componente é 0, não penaliza nem premia.
  const idadeS = `LEAST(GREATEST((CURRENT_DATE - COALESCE(c.data_inicio_atividade, CURRENT_DATE))::float8 / 365.25, 0) / ${IDADE_REF_ANOS}::float8, 1.0)`;

  const extraPredicates = filterPredicates(args.filters ?? {}, params);

  const text = `
WITH cand AS (
  -- score num nível externo p/ o ORDER BY referenciar prox/fit/porte_comp por nome
  -- (aliases não são visíveis dentro de expressões do mesmo SELECT).
  SELECT raw.*, ((raw.prox + $3 * raw.fit + raw.porte_comp + raw.capital_comp + raw.idade_comp) / ${norm}) AS score
  FROM (
    SELECT
      c.id, c.municipio_id, c.cnae_principal,
      ${fitExpr} AS fit,
      (${prox}) AS prox,
      ($4 * ${porteS}) AS porte_comp,
      ($15::float8 * ${capitalS}) AS capital_comp,
      ($16::float8 * ${idadeS}) AS idade_comp
    FROM companies c
    ${cdsJoin}
    WHERE ${where}${extraPredicates}
  ) raw
  ORDER BY score DESC
  LIMIT $11 OFFSET $12
)
SELECT
  cand.id, c2.cnpj, c2.razao_social, c2.nome_fantasia, cand.cnae_principal,
  cand.municipio_id, c2.uf, c2.porte, c2.capital_social, c2.data_inicio_atividade,
  -- ponto exibido: geocode de rua/cep (exato) -> geom da empresa -> centroide do município
  ST_Y(pt.g::geometry) AS lat, ST_X(pt.g::geometry) AS lon,
  cand.score,
  jsonb_build_object(
    'cnae_match', CASE WHEN cand.fit >= 1.0 THEN 'classe' WHEN cand.fit >= 0.6 THEN 'divisao'
                       WHEN cand.fit >= 0.3 THEN 'secao' ELSE 'nenhum' END,
    'cnae_principal', cand.cnae_principal,
    -- distância exata (geocode) só p/ as 20 linhas exibidas
    'distancia_km', round((ST_Distance(pt.g, ST_SetSRID(ST_MakePoint($14::float8, $13::float8), 4326)::geography, false) / 1000.0)::numeric, 1),
    'porte', c2.porte,
    'capital_social', c2.capital_social,
    'idade_anos', CASE WHEN c2.data_inicio_atividade IS NOT NULL
                       THEN round(((CURRENT_DATE - c2.data_inicio_atividade)::numeric / 365.25), 1) END,
    -- componentes na MESMA escala do score (divididos pela soma dos pesos), p/ as
    -- cinco barrinhas do card somarem exatamente o score exibido.
    'componentes', jsonb_build_object(
      'cnae', round((($3 * cand.fit) / ${norm})::numeric, 3),
      'proximidade', round((cand.prox / ${norm})::numeric, 3),
      'porte', round((cand.porte_comp / ${norm})::numeric, 3),
      'capital', round((cand.capital_comp / ${norm})::numeric, 3),
      'idade', round((cand.idade_comp / ${norm})::numeric, 3)
    )
  ) AS reason
FROM cand
JOIN companies c2 ON c2.id = cand.id
LEFT JOIN municipios mun ON mun.id = cand.municipio_id
LEFT JOIN company_geocode gc ON gc.company_id = cand.id AND gc.precisao <> 'municipio'
LEFT JOIN LATERAL (
  SELECT COALESCE(
    CASE WHEN gc.lat IS NOT NULL THEN ST_SetSRID(ST_MakePoint(gc.lon, gc.lat), 4326)::geography END,
    c2.geom, mun.geom
  ) AS g
) pt ON true
ORDER BY score DESC
`;

  return { text, params };
}
