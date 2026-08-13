// Enriquecimento sob demanda: descobre o site próprio da empresa via registro.br.
//
// Sob demanda por escolha de projeto, e a fonte reforça a escolha: o registro.br
// só divulga o CNPJ do titular ~16 vezes por minuto por IP (ver rdap.ts). Varrer
// os ~29M de CNPJs da base é inviável; enriquece-se o que o representante abre.
//
// Estratégia, em ordem de custo crescente (para na primeira que resolve):
//   1. company_dominio  — já varreu esta empresa? devolve, inclusive o "não achei".
//   2. rdap_domain      — outro CNPJ da mesma raiz (matriz/filial) já confirmou? o site é o mesmo.
//   3. contarDominios() — 1 consulta: CNPJ tem 0 domínios? encerra sem varrer.
//   4. varredura        — domínio do e-mail da Receita primeiro (único candidato
//                         que não é palpite), depois os derivados do nome; todos
//                         confirmados pelo CNPJ do titular.
//   5. e-mail fora do .br — o registro.br não cobre, então entra com confiança
//                         menor e só se o site responder.
import { one, query } from './db.ts';
import { candidatosDominio, consultarDominio, contarDominios, dominioDeEmail } from './rdap.ts';
import { resolverSite, type StatusSite } from './site.ts';

// 'achou'          -> dominio preenchido, confirmado por CNPJ
// 'nao_encontrado' -> varredura completa, nenhum candidato é da empresa
// 'indeterminado'  -> registro.br censurou/falhou no meio; nada foi concluído.
//                     O client deve oferecer "tentar de novo", não dizer "sem site".
export type StatusDominio = 'achou' | 'nao_encontrado' | 'indeterminado';

export interface DominioEmpresa {
  dominio: string | null;
  // URL que o domínio serve de fato (com www/http certos, após redirects), ou
  // null quando o domínio existe mas não publica site. É esta que a ficha abre.
  site_url: string | null;
  site_status: StatusSite | null;
  status: StatusDominio;
  // 'registrobr' -> domínio da própria empresa, confirmado pelo CNPJ raiz
  // 'email_rfb'  -> domínio do e-mail declarado à Receita, fora do .br
  // 'marca'      -> domínio da MARCA que a empresa opera, de outro CNPJ
  fonte: string;
  confianca: number;
  // Quem registrou o domínio, quando não é a própria empresa (fonte 'marca').
  // A ficha precisa disso para dizer de quem é o site em vez de dar a entender
  // que é da loja aberta.
  titular: string | null;
  cached: boolean;
}

// Domínio confirmado não muda com frequência; "não achei" merece nova tentativa
// mais cedo (a empresa pode ter registrado site nesse meio tempo).
const TTL_ACHOU_DIAS = 180;
const TTL_VAZIO_DIAS = 30;
// Domínio existe mas o titular veio sem CNPJ: quase sempre é a cota do
// registro.br, que reseta em minutos. Reconsultar no dia seguinte já resolve.
const TTL_SEM_TITULAR_DIAS = 1;

// Teto duro de consultas por empresa. Sem ele, 6 candidatos x 3 TLDs a 700ms =
// 12s segurando a request. 5 cobre o caso dominante e limita o pior caso a ~3,5s.
const MAX_CONSULTAS = 5;

export interface EmpresaParaEnriquecer {
  id: number;
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  email: string | null;
}

// .com.br é esmagadoramente dominante, então TODOS os candidatos são testados
// nele antes de qualquer outro TLD. ind.br/agr.br só para o candidato mais
// provável (o 1º), e só se ainda sobrar orçamento de consultas.
// O domínio do e-mail da Receita vem PRIMEIRO quando é .br: é o único candidato
// que não é palpite. Fantasia e razão social vêm depois, pois são derivados do
// nome. Fora do .br o registro.br não sabe responder (devolveria 404, que
// viraria "domínio livre" gravado errado no cache); ele é testado como site
// antes da varredura, sem passar pelo registro.br.
function dominiosAlvo(candidatos: string[], emailDom: string | null): string[] {
  const alvos = candidatos.map((c) => `${c}.com.br`);
  if (candidatos[0]) alvos.push(`${candidatos[0]}.ind.br`, `${candidatos[0]}.agr.br`);
  const lista = emailDom?.endsWith('.br') ? [emailDom, ...alvos] : alvos;
  return [...new Set(lista)].slice(0, MAX_CONSULTAS);
}

// Confiança do domínio vindo do e-mail da Receita sem confirmação no registro.br
// (o domínio não é .br). É o cadastro da própria empresa, mas ninguém provou que
// o domínio é dela — pode ser do contador. A UI diferencia isso de 100.
const CONFIANCA_EMAIL = 70;

// Domínio da MARCA que a empresa opera, registrado por outro CNPJ (a loja
// franqueada de fantasia COLCCI e o colcci.com.br da AMC TEXTIL). O vínculo com
// a marca é real e confirmado; o que NÃO se afirma é que o site seja da loja —
// daí a confiança baixa, que a ficha traduz em rótulo explícito.
const CONFIANCA_MARCA = 40;

async function gravar(
  companyId: number, dominio: string | null, confianca: number, candidatos: number,
  site: Site = { url: null, status: null }, fonte = 'registrobr',
): Promise<void> {
  await query(
    `INSERT INTO company_dominio (company_id, dominio, fonte, confianca, candidatos, site_url, site_status)
       VALUES ($1, $2, $7, $3, $4, $5, $6)
     ON CONFLICT (company_id) DO UPDATE
       SET dominio = EXCLUDED.dominio, fonte = EXCLUDED.fonte,
           confianca = EXCLUDED.confianca, candidatos = EXCLUDED.candidatos,
           site_url = EXCLUDED.site_url, site_status = EXCLUDED.site_status,
           atualizado_em = now()`,
    [companyId, dominio, confianca, candidatos, site.url, site.status, fonte],
  );
}

interface Site { url: string | null; status: StatusSite | null }

// Matriz e filial servem o mesmo site: se outra empresa já sondou este domínio,
// reaproveita em vez de bater no servidor da empresa de novo.
async function siteDoDominio(dominio: string): Promise<Site> {
  const visto = await one<{ site_url: string | null; site_status: StatusSite | null }>(
    `SELECT site_url, site_status FROM company_dominio
      WHERE dominio = $1 AND site_status IS NOT NULL LIMIT 1`,
    [dominio],
  );
  if (visto) return { url: visto.site_url, status: visto.site_status };
  return resolverSite(dominio);
}

const achou = (
  dominio: string, site: Site, cached: boolean,
  fonte = 'registrobr', confianca = 100, titular: string | null = null,
): DominioEmpresa =>
  ({ dominio, site_url: site.url, site_status: site.status, status: 'achou', fonte, confianca, titular, cached });

const semDominio = (status: StatusDominio, cached: boolean): DominioEmpresa =>
  ({ dominio: null, site_url: null, site_status: null, status, fonte: 'registrobr', confianca: 0, titular: null, cached });

// Quem registrou o domínio, pelo nome que a Receita conhece. Só é consultado
// para domínio de MARCA — no domínio próprio o titular é a própria empresa.
// Prefere o estabelecimento exato do titular e cai na matriz da mesma raiz; o
// LIKE por raiz usa companies_cnpj_prefix_idx.
async function titularDoDominio(dominio: string): Promise<string | null> {
  const d = await one<{ titular_cnpj: string | null }>(
    'SELECT titular_cnpj FROM rdap_domain WHERE dominio = $1', [dominio],
  );
  if (!d?.titular_cnpj) return null;
  // Razão social, não fantasia: a fantasia do titular costuma ser a própria
  // marca ("site da marca · COLCCI" não diz nada), e o que falta ao
  // representante é a pessoa jurídica por trás — "AMC TEXTIL LTDA".
  const c = await one<{ nome: string }>(
    `SELECT razao_social AS nome FROM companies WHERE cnpj LIKE $1
      ORDER BY (cnpj = $2) DESC, matriz_filial LIMIT 1`,
    [`${d.titular_cnpj.slice(0, 8)}%`, d.titular_cnpj],
  );
  return c?.nome ?? null;
}

// Consulta UM domínio no registro.br, com o cache local por domínio na frente.
// TTL curto quando o titular veio sem CNPJ (cota do registro.br), longo para
// 'livre' e 'confirmado', que são estáveis.
//
//   string      -> CNPJ do titular
//   null        -> domínio livre (ou registrado por pessoa física)
//   'censurado' -> registrado, mas a cota escondeu o titular
//   undefined   -> rede/5xx: nada foi concluído e nada é cacheado
async function titularNoRegistro(
  dominio: string, ignorarCache = false,
): Promise<string | null | undefined | 'censurado'> {
  const cache = ignorarCache ? null : await one<{ registrado: boolean; titular_cnpj: string | null }>(
    `SELECT registrado, titular_cnpj FROM rdap_domain
      WHERE dominio = $1
        AND verificado_em > now() - ((CASE WHEN registrado AND titular_cnpj IS NULL
                                           THEN $2 ELSE $3 END) || ' days')::interval`,
    [dominio, String(TTL_SEM_TITULAR_DIAS), String(TTL_ACHOU_DIAS)],
  );
  if (cache) {
    if (cache.titular_cnpj) return cache.titular_cnpj;
    return cache.registrado ? 'censurado' : null;
  }

  const r = await consultarDominio(dominio);
  if (!r) return undefined;
  const titular = r.estado === 'confirmado' ? r.titularCnpj : null;
  await query(
    `INSERT INTO rdap_domain (dominio, registrado, titular_cnpj, verificado_em)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (dominio) DO UPDATE
       SET registrado = EXCLUDED.registrado, titular_cnpj = EXCLUDED.titular_cnpj,
           verificado_em = now()`,
    [dominio, r.estado !== 'livre', titular],
  );
  return r.estado === 'sem_titular' ? 'censurado' : titular;
}

export async function descobrirDominio(
  e: EmpresaParaEnriquecer, opcoes: { ignorarCache?: boolean } = {},
): Promise<DominioEmpresa> {
  const raiz = e.cnpj.slice(0, 8);
  const emailDom = dominioDeEmail(e.email);

  // Último recurso, para e-mail de domínio próprio FORA do .br: o registro.br
  // não cobre esses TLDs, então ninguém confirma a posse. Aceita mesmo assim —
  // é o domínio que a empresa declarou à Receita — mas só se o site estiver de
  // pé (domínio de contador desativado não vira "site da empresa") e com
  // confiança menor, para a ficha poder dizer de onde veio.
  const porEmail = async (): Promise<DominioEmpresa | null> => {
    if (!emailDom || emailDom.endsWith('.br')) return null;
    const site = await siteDoDominio(emailDom);
    if (site.status !== 'vivo' && site.status !== 'bloqueado') return null;
    await gravar(e.id, emailDom, CONFIANCA_EMAIL, 0, site, 'email_rfb');
    return achou(emailDom, site, false, 'email_rfb', CONFIANCA_EMAIL);
  };

  // Site da MARCA que a empresa opera: domínio derivado da fantasia, registrado
  // e pertencente a OUTRO CNPJ. Não é o site da empresa, e a ficha nunca vai
  // dizer que é — mas é onde o representante encontra a marca que ela vende.
  // Só entra com o site de pé: marca desativada não ajuda ninguém.
  const acharMarca = async (candidatos: string[]): Promise<DominioEmpresa | null> => {
    for (const c of candidatos) {
      const dominio = `${c}.com.br`;
      const titular = await titularNoRegistro(dominio, opcoes.ignorarCache);
      if (typeof titular !== 'string' || titular === 'censurado') continue;
      if (titular.slice(0, 8) === raiz) continue; // é da própria empresa: outro caminho trata
      const site = await siteDoDominio(dominio);
      if (site.status !== 'vivo' && site.status !== 'bloqueado') continue;
      await gravar(e.id, dominio, CONFIANCA_MARCA, candidatos.length, site, 'marca');
      return achou(dominio, site, false, 'marca', CONFIANCA_MARCA, await titularDoDominio(dominio));
    }
    return null;
  };

  // 1. Já varrido antes, dentro do TTL. dominio NULL = negativo cacheado.
  //    fonte e confiança vêm do banco: sem elas o domínio de marca voltaria do
  //    cache disfarçado de domínio próprio.
  const salvo = opcoes.ignorarCache ? null : await one<{
    dominio: string | null; site_url: string | null; site_status: StatusSite | null;
    fonte: string; confianca: number;
  }>(
    `SELECT dominio, site_url, site_status, fonte, confianca FROM company_dominio
      WHERE company_id = $1
        AND atualizado_em > now() - ((CASE WHEN dominio IS NULL THEN $2 ELSE $3 END) || ' days')::interval`,
    [e.id, String(TTL_VAZIO_DIAS), String(TTL_ACHOU_DIAS)],
  );
  if (salvo) {
    return salvo.dominio
      ? achou(salvo.dominio, { url: salvo.site_url, status: salvo.site_status }, true,
        salvo.fonte, salvo.confianca,
        salvo.fonte === 'marca' ? await titularDoDominio(salvo.dominio) : null)
      : semDominio('nao_encontrado', true);
  }

  // 2. Matriz ou outra filial da mesma raiz já confirmou um domínio. Custa uma
  //    query local e pode pular a varredura inteira — mas não pode ser cego:
  //    um grupo tem várias marcas, e a AMC TEXTIL (raiz 75364570) é titular de
  //    menegotti.com.br, amctextil.com.br E colcci.com.br. Herdar o primeiro
  //    irmão fazia a filial cuja fantasia é COLCCI devolver menegotti.com.br.
  // Domínios derivados da FANTASIA. São eles — e só eles — que podem valer como
  // site da marca quando pertencem a outro CNPJ: "COLCCI CHAPECO" rende
  // 'colccichapeco' e 'colcci', e é o segundo que é a marca. Palpite vindo da
  // razão social batendo em CNPJ alheio é coincidência, não vínculo.
  // Slug curto demais (3 letras) é genérico e traria ruído.
  const marcas = (e.nome_fantasia ? candidatosDominio(e.nome_fantasia, null) : [])
    .filter((c) => c.length >= 4).slice(0, 2);
  const dominiosMarca = new Set(marcas.map((m) => `${m}.com.br`));
  const alvos = dominiosAlvo(candidatosDominio(e.razao_social, e.nome_fantasia), emailDom);
  const irmaos = (await query<{ dominio: string }>(
    `SELECT dominio FROM rdap_domain
      WHERE titular_cnpj IS NOT NULL AND left(titular_cnpj, 8) = $1
      ORDER BY length(dominio), dominio`,
    [raiz],
  )).map((r) => r.dominio);

  //    a) O irmão é candidato DESTE estabelecimento: confirmado e da marca certa.
  const doEstabelecimento = irmaos.find((d) => alvos.includes(d));
  //    b) Sem fantasia e sem e-mail próprio, nada distingue este estabelecimento
  //       do grupo — varrer os mesmos candidatos do irmão só gastaria consulta.
  const semMarcaPropria = !e.nome_fantasia && !emailDom ? irmaos[0] : undefined;
  const herdado = doEstabelecimento ?? semMarcaPropria;
  if (herdado) {
    const site = await siteDoDominio(herdado);
    await gravar(e.id, herdado, 100, 0, site);
    return achou(herdado, site, false);
  }

  // E-mail corporativo fora do .br é sondado em paralelo à busca no registro.br.
  // Sem confirmação possível nessa fonte, só entra se responder como site; se
  // responder, mantém prioridade sobre os palpites de marca ou nome.
  const emailForaBr = porEmail();

  // 3. Portão: CNPJ sem domínio nenhum -> não há o que varrer. null (RDAP
  //    instável) cai na varredura, para não gravar falso negativo.
  //
  //    Só vale para empresa de estabelecimento ÚNICO. O registro.br conta os
  //    domínios de um CNPJ, e num grupo o domínio pode estar em qualquer
  //    estabelecimento: a AMC TEXTIL (raiz 75364570) tem 0 domínios na matriz
  //    ...0001-60 e 94 na filial ...0007-55, que é a titular de colcci.com.br,
  //    de amctextil.com.br e de menegotti.com.br. Perguntar pela matriz marcava
  //    o grupo inteiro como "sem site" sem varrer candidato nenhum — e perguntar
  //    pela filial aberta tinha o defeito espelhado, que foi como a MALINSKI
  //    (filial ...0930, matriz ...0183) se perdeu. Não existe estabelecimento
  //    certo para perguntar: a resposta de um não representa o grupo.
  //
  //    Então com mais de um estabelecimento o portão é pulado e a varredura
  //    decide. Custa até MAX_CONSULTAS onde antes custava 1, e só para grupo —
  //    a esmagadora maioria da base é estabelecimento único e não muda nada.
  //    O LIKE por raiz usa companies_cnpj_prefix_idx (bpchar_pattern_ops).
  const estab = await one<{ n: number }>(
    'SELECT count(*)::int AS n FROM companies WHERE cnpj LIKE $1', [`${raiz}%`],
  );
  const total = (estab?.n ?? 1) > 1 ? null : await contarDominios(e.cnpj);
  if (total === 0) {
    // Zero domínios .br não exclui um domínio .com no e-mail do cadastro.
    const email = await emailForaBr;
    if (email) return email;
    // Nem exclui a MARCA: a loja franqueada de fantasia COLCCI não tem domínio
    // nenhum, e é justamente aí que o site da marca é a única pista. Custa até
    // 2 consultas, e só para empresa que tem fantasia.
    const marcaAqui = await acharMarca(marcas);
    if (marcaAqui) return marcaAqui;
    await gravar(e.id, null, 0, 0);
    return semDominio('nao_encontrado', false);
  }

  // 4. Varredura. Compara pela RAIZ do CNPJ (8 dígitos) porque o domínio fica
  //    registrado na matriz e a empresa aberta pode ser filial.
  let consultas = 0;
  let indeterminado = false;
  let marcaDeTerceiro: string | null = null;
  for (const dominio of alvos) {
    consultas++;
    const titular = await titularNoRegistro(dominio, opcoes.ignorarCache);
    if (titular === undefined) { indeterminado = true; continue; } // rede/5xx: não cacheia
    if (titular === 'censurado') { indeterminado = true; continue; }

    if (titular && titular.slice(0, 8) === raiz) {
      const email = await emailForaBr;
      if (email) return email;
      const site = await siteDoDominio(dominio);
      await gravar(e.id, dominio, 100, consultas, site);
      return achou(dominio, site, false);
    }

    // Titular de OUTRA raiz. Descartado, com uma exceção: o domínio da marca.
    if (titular && dominiosMarca.has(dominio)) marcaDeTerceiro ??= dominio;
  }

  // Nenhum candidato próprio confirmou, mas um irmão da mesma raiz tem domínio
  // confirmado: é o site do grupo, e serve. Fica DEPOIS da varredura (e não
  // antes, como já esteve) para o estabelecimento com marca própria ter a
  // chance de achar a dele primeiro.
  if (irmaos[0]) {
    const email = await emailForaBr;
    if (email) return email;
    const site = await siteDoDominio(irmaos[0]);
    await gravar(e.id, irmaos[0], 100, consultas, site);
    return achou(irmaos[0], site, false);
  }

  const email = await emailForaBr;
  if (email) return email;

  // Site da marca. Entra atrás de tudo que fala da empresa em si (domínio
  // próprio, do grupo, do e-mail declarado). A varredura já consultou o domínio,
  // então aqui só sai do cache. Confiança baixa e fonte 'marca' são o que fazem
  // a ficha rotular "site da marca X" em vez de fingir que é da loja.
  const marcaAchada = marcaDeTerceiro
    ? await acharMarca([marcaDeTerceiro.replace(/\.com\.br$/, '')])
    : null;
  if (marcaAchada) return marcaAchada;

  // Negativo só é gravado se a varredura foi conclusiva do início ao fim. Com
  // censura ou falha no meio, devolve indeterminado sem cachear — senão a
  // empresa ficaria marcada "sem site" por 30 dias por causa de rate limit.
  if (indeterminado) return semDominio('indeterminado', false);
  await gravar(e.id, null, 0, consultas);
  return semDominio('nao_encontrado', false);
}
