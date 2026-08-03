import type { FastifyInstance } from 'fastify';
import { query, withClient } from '../db.ts';
import { requireAuth, requirePermission } from '../auth.ts';
import { config } from '../config.ts';
import {
  buildRecommendQuery, buildRecommendCountQuery, RECOMMEND_COUNT_CAP,
  type RecommendProfile, type RecommendFilters,
} from '../sql/recommend.ts';

const PORTES = new Set(['nao_informado', 'micro', 'pequeno', 'demais']);
const PROX_NORM_M = 150_000; // normalização da proximidade (~150km) — casa com o SQL

// cnae_divisao_secao é estática (~99 linhas, escrita só por seed) — cache em memória.
let divisaoSecao: Map<number, string> | null = null;
async function getDivisaoSecao(): Promise<Map<number, string>> {
  if (!divisaoSecao) {
    const rows = await query<{ divisao: number; secao: string }>(
      'SELECT divisao, secao FROM cnae_divisao_secao',
    );
    divisaoSecao = new Map(rows.map((r) => [r.divisao, r.secao]));
  }
  return divisaoSecao;
}

// Regiões habilitadas (gate da recomendação). Mutável (o ETL habilita UF a UF),
// então consulta por request — 27 linhas, custo desprezível perto da query principal.
async function getEnabledRegions(): Promise<{ ufs: string[]; regioes: string[] }> {
  const rows = await query<{ uf: string | null; regiao: string | null }>(
    'SELECT uf, regiao FROM enabled_regions',
  );
  const ufs = [...new Set(rows.map((r) => r.uf).filter((u): u is string => !!u))];
  const regioes = [...new Set(rows.map((r) => r.regiao).filter((r): r is string => !!r))];
  return { ufs, regioes };
}

// Origem da proximidade (partida ou centroide do território) + distância de cada
// município do território até a origem. A distância é constante por município, então
// vira o termo de proximidade por município (embutido como CASE no SQL) — sem JOIN
// por linha e sem geografia por empresa (o que mantém o plano paralelo e barato).
async function muniProximity(
  municipios: number[], wProx: number, partida: { lat: number; lon: number } | null,
): Promise<{ muniProx: { id: number; pc: number }[]; origin: { lat: number; lon: number } }> {
  const rows = await query<{ id: number; dist_m: number; olat: number; olon: number }>(
    `WITH o AS (
       SELECT CASE WHEN $2::float8 IS NOT NULL
                   THEN ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography
                   ELSE (SELECT ST_Centroid(ST_Collect(geom::geometry))::geography
                         FROM municipios WHERE id = ANY($1::int[])) END AS g
     )
     SELECT m.id,
            ST_Distance(m.geom, o.g, false) AS dist_m,
            ST_Y(o.g::geometry) AS olat, ST_X(o.g::geometry) AS olon
     FROM municipios m, o
     WHERE m.id = ANY($1::int[])`,
    [municipios, partida ? partida.lat : null, partida ? partida.lon : null],
  );
  const muniProx = rows.map((r) => ({
    id: Number(r.id),
    pc: wProx * (1 - Math.min(Number(r.dist_m) / PROX_NORM_M, 1)),
  }));
  const first = rows[0];
  // território sem geometria (não deveria ocorrer): origem no centro do Brasil.
  const origin = first ? { lat: Number(first.olat), lon: Number(first.olon) } : { lat: -15.78, lon: -47.93 };
  return { muniProx, origin };
}

// Tiers de fit calculados aqui (e não em CTE) p/ virarem = ANY($array) no SQL:
// arrays indexáveis deixam o planner combinar índices na poda de candidatos.
async function cnaeTiers(cnaesAlvo: number[]): Promise<{
  divisoesAlvo: number[]; secoesAlvo: string[]; pruneDivisoes: number[];
}> {
  const map = await getDivisaoSecao();
  const divisoesAlvo = [...new Set(cnaesAlvo.map((c) => Math.floor(c / 100000)))];
  const secoesAlvo = [...new Set(divisoesAlvo.map((d) => map.get(d)).filter((s): s is string => !!s))];
  const secSet = new Set(secoesAlvo);
  const pruneDivisoes = [...map.entries()].filter(([, s]) => secSet.has(s)).map(([d]) => d);
  return { divisoesAlvo, secoesAlvo, pruneDivisoes };
}

const parseInts = (s?: string): number[] =>
  (s ?? '').split(/[,\s]+/).map((x) => parseInt(x, 10)).filter(Number.isFinite);

function parseFilters(q: {
  q?: string; porte?: string;
  cap_min?: number; cap_max?: number; idade_min?: number; idade_max?: number;
}): RecommendFilters {
  const texto = (q.q ?? '').trim();
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  return {
    capMin: num(q.cap_min), capMax: num(q.cap_max),
    idadeMin: num(q.idade_min), idadeMax: num(q.idade_max),
    // <3 chars: o GIN trgm não indexa o padrão -> ILIKE '%x%' vira seq scan
    // na base inteira a cada tecla. Ignora até o termo ficar utilizável.
    q: texto.length >= 3 ? texto : undefined,
    porte: q.porte && PORTES.has(q.porte) ? q.porte : undefined,
  };
}

// Pesos do score vêm do filtro (cliente). Mantém o default antigo do perfil-alvo
// quando o cliente não envia o valor, p/ a recomendação não zerar um fator.
function parsePesos(
  q: { w_cnae?: number; w_prox?: number; w_porte?: number; w_capital?: number; w_idade?: number },
): RecommendProfile['pesos'] {
  const num = (v: number | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : d;
  return {
    cnae: num(q.w_cnae, 0.4),
    proximidade: num(q.w_prox, 0.25),
    porte: num(q.w_porte, 0.15),
    capital: num(q.w_capital, 0.1),
    idade: num(q.w_idade, 0.1),
  };
}

export function recommendRoutes(app: FastifyInstance): void {
  app.get('/api/recommend', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          q: { type: 'string' },
          cnae: { type: 'string' },   // CNAEs-alvo (fit em tiers) — csv
          munis: { type: 'string' },  // território: ids de município — csv
          porte: { type: 'string' },
          w_cnae: { type: 'number', minimum: 0, maximum: 1 },
          w_prox: { type: 'number', minimum: 0, maximum: 1 },
          w_porte: { type: 'number', minimum: 0, maximum: 1 },
          w_capital: { type: 'number', minimum: 0, maximum: 1 }, // capital social
          w_idade: { type: 'number', minimum: 0, maximum: 1 },   // tempo de vida da empresa
          cap_min: { type: 'number', minimum: 0 },               // faixa de capital social (R$)
          cap_max: { type: 'number', minimum: 0 },
          idade_min: { type: 'number', minimum: 0, maximum: 200 }, // faixa de tempo de vida (anos)
          idade_max: { type: 'number', minimum: 0, maximum: 200 },
          partida_lat: { type: 'number', minimum: -90, maximum: 90 },   // origem da proximidade
          partida_lon: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const query = req.query as {
      limit?: number; offset?: number; q?: string; cnae?: string; munis?: string;
      porte?: string; w_cnae?: number; w_prox?: number; w_porte?: number;
      w_capital?: number; w_idade?: number;
      cap_min?: number; cap_max?: number; idade_min?: number; idade_max?: number;
      partida_lat?: number; partida_lon?: number;
    };
    const { limit = 20, offset = 0 } = query;
    const filters = parseFilters(query);

    // Config da recomendação vem do filtro da tela (sem perfil server-side):
    // território (municípios) + CNAEs-alvo + pesos.
    const municipios = parseInts(query.munis);
    if (municipios.length === 0) {
      return reply.code(400).send({ error: 'defina o território (municípios) na busca' });
    }
    const pesos = parsePesos(query);
    const partida = typeof query.partida_lat === 'number' && typeof query.partida_lon === 'number'
      ? { lat: query.partida_lat, lon: query.partida_lon } : null;
    const profile: RecommendProfile = {
      cnaes_alvo: parseInts(query.cnae),
      territorio_municipios: municipios,
      pesos,
      partida,
    };

    const [tiers, regions, prox] = await Promise.all([
      cnaeTiers(profile.cnaes_alvo ?? []),
      getEnabledRegions(),
      muniProximity(municipios, pesos.proximidade ?? 0.3, partida),
    ]);

    const args = {
      orgId, profile, limit, offset, filters, ...tiers,
      regioesUf: regions.ufs, regioesRegiao: regions.regioes,
      muniProx: prox.muniProx, origin: prox.origin,
    };
    const { text, params } = buildRecommendQuery(args);
    // Total de empresas do perfil, capado (ver RECOMMEND_COUNT_CAP): vai na mesma
    // conexão/transação da recomendação — é uma varredura que o LIMIT corta cedo.
    const count = buildRecommendCountQuery(args);

    // Run in a tx on a single connection so SET LOCAL work_mem applies to the recommendation sort.
    const { rows, total } = await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL work_mem = '${config.recommendWorkMem}'`);
        const r = await client.query(text, params);
        const t = await client.query<{ total: number }>(count.text, count.params);
        await client.query('COMMIT');
        return { rows: r.rows, total: Number(t.rows[0]?.total ?? 0) };
      } catch (e) {
        // sem ROLLBACK a conexão volta ao pool em transação abortada e envenena
        // as próximas requisições que a reusarem.
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    return {
      results: rows,
      page: {
        limit, offset, count: rows.length,
        // total > CAP: a contagem parou no teto, o número exibido é "CAP+".
        total: Math.min(total, RECOMMEND_COUNT_CAP),
        total_capped: total > RECOMMEND_COUNT_CAP,
      },
    };
  });
}
