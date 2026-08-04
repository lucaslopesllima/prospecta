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
  fonte: string;
  confianca: number;
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
// que não é palpite. Fora do .br o registro.br não sabe responder (devolveria
// 404, que viraria "domínio livre" gravado errado no cache), então esse caso é
// tratado à parte, sem passar pela varredura.
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
  dominio: string, site: Site, cached: boolean, fonte = 'registrobr', confianca = 100,
): DominioEmpresa =>
  ({ dominio, site_url: site.url, site_status: site.status, status: 'achou', fonte, confianca, cached });

const semDominio = (status: StatusDominio, cached: boolean): DominioEmpresa =>
  ({ dominio: null, site_url: null, site_status: null, status, fonte: 'registrobr', confianca: 0, cached });

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
    await gravar(e.id, emailDom, CONFIANCA_EMAIL, 0, site, 'email_rfb');
    return achou(emailDom, site, false, 'email_rfb', CONFIANCA_EMAIL);
  };

  // 1. Já varrido antes, dentro do TTL. dominio NULL = negativo cacheado.
  const salvo = await one<{ dominio: string | null; site_url: string | null; site_status: StatusSite | null }>(
    `SELECT dominio, site_url, site_status FROM company_dominio
      WHERE company_id = $1
        AND atualizado_em > now() - ((CASE WHEN dominio IS NULL THEN $2 ELSE $3 END) || ' days')::interval`,
    [e.id, String(TTL_VAZIO_DIAS), String(TTL_ACHOU_DIAS)],
  );
  if (salvo) {
    return salvo.dominio
      ? achou(salvo.dominio, { url: salvo.site_url, status: salvo.site_status }, true)
      : semDominio('nao_encontrado', true);
  }

  // 2. Matriz ou outra filial da mesma raiz já confirmou um domínio — o site é o
  //    mesmo para todas. Custa uma query local e pula a varredura inteira.
  const irmao = await one<{ dominio: string }>(
    `SELECT dominio FROM rdap_domain
      WHERE titular_cnpj IS NOT NULL AND left(titular_cnpj, 8) = $1
      ORDER BY length(dominio), dominio LIMIT 1`,
    [raiz],
  );
  if (irmao) {
    const site = await siteDoDominio(irmao.dominio);
    await gravar(e.id, irmao.dominio, 100, 0, site);
    return achou(irmao.dominio, site, false);
  }

  // 3. Portão: CNPJ sem domínio nenhum -> não há o que varrer. null (RDAP
  //    instável) cai na varredura, para não gravar falso negativo.
  //
  //    Pergunta pela MATRIZ, não pela empresa aberta. Domínio de grupo fica
  //    registrado no CNPJ da matriz, e o registro.br responde 404 (lido como
  //    zero) para o CNPJ de uma filial — foi o que marcou a MALINSKI (filial
  //    ...0930, matriz ...0183) como "sem site" sem varrer candidato nenhum.
  //    O LIKE por raiz usa companies_cnpj_prefix_idx (bpchar_pattern_ops).
  const matriz = await one<{ cnpj: string }>(
    'SELECT cnpj FROM companies WHERE cnpj LIKE $1 AND matriz_filial = 1 LIMIT 1',
    [`${raiz}%`],
  );
  const total = await contarDominios(matriz?.cnpj ?? e.cnpj);
  if (total === 0) {
    // Zero domínios .br não exclui um domínio .com no e-mail do cadastro.
    const email = await porEmail();
    if (email) return email;
    await gravar(e.id, null, 0, 0);
    return semDominio('nao_encontrado', false);
  }

  // 4. Varredura. Compara pela RAIZ do CNPJ (8 dígitos) porque o domínio fica
  //    registrado na matriz e a empresa aberta pode ser filial.
  let consultas = 0;
  let indeterminado = false;
  for (const dominio of dominiosAlvo(candidatosDominio(e.razao_social, e.nome_fantasia), emailDom)) {
    consultas++;

    // Cache por domínio. TTL curto quando o titular veio sem CNPJ (cota do
    // registro.br), longo para 'livre' e 'confirmado', que são estáveis.
    const cache = await one<{ registrado: boolean; titular_cnpj: string | null }>(
      `SELECT registrado, titular_cnpj FROM rdap_domain
        WHERE dominio = $1
          AND verificado_em > now() - ((CASE WHEN registrado AND titular_cnpj IS NULL
                                             THEN $2 ELSE $3 END) || ' days')::interval`,
      [dominio, String(TTL_SEM_TITULAR_DIAS), String(TTL_ACHOU_DIAS)],
    );

    let titular: string | null;
    if (cache) {
      titular = cache.titular_cnpj;
      // Registrado e sem CNPJ dentro do TTL curto: continua indeterminado.
      if (cache.registrado && !titular) indeterminado = true;
    } else {
      const r = await consultarDominio(dominio);
      if (!r) { indeterminado = true; continue; } // rede/5xx: não cacheia
      if (r.estado === 'sem_titular') indeterminado = true;
      titular = r.estado === 'confirmado' ? r.titularCnpj : null;
      await query(
        `INSERT INTO rdap_domain (dominio, registrado, titular_cnpj, verificado_em)
           VALUES ($1, $2, $3, now())
         ON CONFLICT (dominio) DO UPDATE
           SET registrado = EXCLUDED.registrado, titular_cnpj = EXCLUDED.titular_cnpj,
               verificado_em = now()`,
        [dominio, r.estado !== 'livre', titular],
      );
    }

    if (titular && titular.slice(0, 8) === raiz) {
      const site = await siteDoDominio(dominio);
      await gravar(e.id, dominio, 100, consultas, site);
      return achou(dominio, site, false);
    }
  }

  // Negativo só é gravado se a varredura foi conclusiva do início ao fim. Com
  // censura ou falha no meio, devolve indeterminado sem cachear — senão a
  // empresa ficaria marcada "sem site" por 30 dias por causa de rate limit.
  const email = await porEmail();
  if (email) return email;
  if (indeterminado) return semDominio('indeterminado', false);
  await gravar(e.id, null, 0, consultas);
  return semDominio('nao_encontrado', false);
}
