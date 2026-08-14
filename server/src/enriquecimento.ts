// Enriquecimento sob demanda: descobre o site próprio da empresa via registro.br.
//
// Sob demanda por escolha de projeto, e a fonte reforça a escolha: o registro.br
// só divulga o CNPJ do titular ~16 vezes por minuto por IP (ver rdap.ts). Varrer
// os ~29M de CNPJs da base é inviável; enriquece-se o que o representante abre.
//
// Estratégia, em ordem de custo crescente (para na primeira que resolve):
//   1. contarDominios() — 1 consulta: CNPJ tem 0 domínios? encerra sem varrer.
//   2. varredura        — domínio do e-mail da Receita primeiro (único candidato
//                         que não é palpite), depois os derivados do nome; todos
//                         confirmados pelo CNPJ do titular.
//   3. e-mail fora do .br — o registro.br não cobre, então entra com confiança
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
}

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
// viraria "domínio livre" incorretamente); ele é testado como site
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

interface Site { url: string | null; status: StatusSite | null }

async function siteDoDominio(dominio: string): Promise<Site> {
  return resolverSite(dominio);
}

const achou = (
  dominio: string, site: Site,
  fonte = 'registrobr', confianca = 100, titular: string | null = null,
): DominioEmpresa =>
  ({ dominio, site_url: site.url, site_status: site.status, status: 'achou', fonte, confianca, titular });

const semDominio = (status: StatusDominio): DominioEmpresa =>
  ({ dominio: null, site_url: null, site_status: null, status, fonte: 'registrobr', confianca: 0, titular: null });

// Quem registrou o domínio, pelo nome que a Receita conhece. Só é consultado
// para domínio de MARCA — no domínio próprio o titular é a própria empresa.
// Prefere o estabelecimento exato do titular e cai na matriz da mesma raiz; o
// LIKE por raiz usa companies_cnpj_prefix_idx.
async function titularDoCnpj(titularCnpj: string): Promise<string | null> {
  // Razão social, não fantasia: a fantasia do titular costuma ser a própria
  // marca ("site da marca · COLCCI" não diz nada), e o que falta ao
  // representante é a pessoa jurídica por trás — "AMC TEXTIL LTDA".
  const c = await one<{ nome: string }>(
    `SELECT razao_social AS nome FROM companies WHERE cnpj LIKE $1
      ORDER BY (cnpj = $2) DESC, matriz_filial LIMIT 1`,
    [`${titularCnpj.slice(0, 8)}%`, titularCnpj],
  );
  return c?.nome ?? null;
}

//   string      -> CNPJ do titular
//   null        -> domínio livre (ou registrado por pessoa física)
//   'censurado' -> registrado, mas a cota escondeu o titular
//   undefined   -> rede/5xx: nada foi concluído
async function titularNoRegistro(dominio: string): Promise<string | null | undefined | 'censurado'> {
  const r = await consultarDominio(dominio);
  if (!r) return undefined;
  if (r.estado === 'sem_titular') return 'censurado';
  return r.estado === 'confirmado' ? r.titularCnpj : null;
}

export async function descobrirDominio(e: EmpresaParaEnriquecer): Promise<DominioEmpresa> {
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
    return achou(emailDom, site, 'email_rfb', CONFIANCA_EMAIL);
  };

  // Site da MARCA que a empresa opera: domínio derivado da fantasia, registrado
  // e pertencente a OUTRO CNPJ. Não é o site da empresa, e a ficha nunca vai
  // dizer que é — mas é onde o representante encontra a marca que ela vende.
  // Só entra com o site de pé: marca desativada não ajuda ninguém.
  const acharMarca = async (candidatos: string[]): Promise<DominioEmpresa | null> => {
    for (const c of candidatos) {
      const dominio = `${c}.com.br`;
      const titular = await titularNoRegistro(dominio);
      if (typeof titular !== 'string' || titular === 'censurado') continue;
      if (titular.slice(0, 8) === raiz) continue; // é da própria empresa: outro caminho trata
      const site = await siteDoDominio(dominio);
      if (site.status !== 'vivo' && site.status !== 'bloqueado') continue;
      return achou(dominio, site, 'marca', CONFIANCA_MARCA, await titularDoCnpj(titular));
    }
    return null;
  };

  // Domínios derivados da FANTASIA. São eles — e só eles — que podem valer como
  // site da marca quando pertencem a outro CNPJ: "COLCCI CHAPECO" rende
  // 'colccichapeco' e 'colcci', e é o segundo que é a marca. Palpite vindo da
  // razão social batendo em CNPJ alheio é coincidência, não vínculo.
  // Slug curto demais (3 letras) é genérico e traria ruído.
  const marcas = (e.nome_fantasia ? candidatosDominio(e.nome_fantasia, null) : [])
    .filter((c) => c.length >= 4).slice(0, 2);
  const dominiosMarca = new Set(marcas.map((m) => `${m}.com.br`));
  const alvos = dominiosAlvo(candidatosDominio(e.razao_social, e.nome_fantasia), emailDom);

  // E-mail corporativo fora do .br é sondado em paralelo à busca no registro.br.
  // Sem confirmação possível nessa fonte, só entra se responder como site; se
  // responder, mantém prioridade sobre os palpites de marca ou nome.
  const emailForaBr = porEmail();

  // 1. Portão: CNPJ sem domínio nenhum -> não há o que varrer. null (RDAP
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
    return semDominio('nao_encontrado');
  }

  // 2. Varredura. Compara pela RAIZ do CNPJ (8 dígitos) porque o domínio fica
  //    registrado na matriz e a empresa aberta pode ser filial.
  let consultas = 0;
  let indeterminado = false;
  let marcaDeTerceiro: { dominio: string; titularCnpj: string } | null = null;
  for (const dominio of alvos) {
    consultas++;
    const titular = await titularNoRegistro(dominio);
    if (titular === undefined) { indeterminado = true; continue; }
    if (titular === 'censurado') { indeterminado = true; continue; }

    if (titular && titular.slice(0, 8) === raiz) {
      const email = await emailForaBr;
      if (email) return email;
      const site = await siteDoDominio(dominio);
      return achou(dominio, site);
    }

    // Titular de OUTRA raiz. Descartado, com uma exceção: o domínio da marca.
    if (titular && dominiosMarca.has(dominio)) marcaDeTerceiro ??= { dominio, titularCnpj: titular };
  }

  const email = await emailForaBr;
  if (email) return email;

  // Site da marca. Entra atrás de tudo que fala da empresa em si (domínio
  // próprio e do e-mail declarado). Confiança baixa e fonte 'marca' fazem
  // a ficha rotular "site da marca X" em vez de fingir que é da loja.
  if (marcaDeTerceiro) {
    const site = await siteDoDominio(marcaDeTerceiro.dominio);
    if (site.status === 'vivo' || site.status === 'bloqueado') {
      return achou(marcaDeTerceiro.dominio, site, 'marca', CONFIANCA_MARCA,
        await titularDoCnpj(marcaDeTerceiro.titularCnpj));
    }
  }

  // Censura/falha continua indeterminada; varredura conclusiva informa não
  // encontrado apenas nesta resposta. Nenhum resultado é persistido.
  if (indeterminado) return semDominio('indeterminado');
  return semDominio('nao_encontrado');
}
