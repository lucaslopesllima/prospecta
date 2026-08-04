// Cliente RDAP do registro.br. Só HTTP, sem banco — o cache e a orquestração
// ficam em enriquecimento.ts (mesma divisão de geocode.ts x routes/companies.ts).
//
// O registro.br NÃO tem busca reversa CNPJ -> domínios: /domains?entityHandle=...
// responde 501 Not Implemented. /entity/<cnpj> devolve QUANTOS domínios o CNPJ
// tem (nicbr_domainCount) mas não quais. Então o fluxo é o inverso do intuitivo:
// gerar candidatos de domínio a partir do nome e confirmar cada um em
// /domain/<d>, que traz o CNPJ do titular em publicIds. A confirmação é exata —
// ou o CNPJ raiz bate, ou não é a empresa. Não é heurística.
//
// Privacidade: a resposta traz também nome/e-mail do contato administrativo
// (pessoa física). Nada disso é lido aqui de propósito — para confirmar a posse
// do domínio o CNPJ basta, e é o que atravessa a fronteira deste módulo.
import { config } from './config.ts';

// 'livre'       -> 404, domínio não registrado
// 'confirmado'  -> registrado e o CNPJ do titular veio na resposta
// 'sem_titular' -> registrado, mas SEM o CNPJ (ver censura abaixo) ou titular PF
// null          -> indeterminado (timeout/5xx/rede): não concluir, não cachear
export type ResultadoDominio =
  | { estado: 'livre' }
  | { estado: 'confirmado'; titularCnpj: string } // 14 dígitos, sem máscara
  | { estado: 'sem_titular' };

// Duas defesas diferentes do registro.br, medidas contra o serviço real:
//
// 1) Paralelismo derruba a conexão (ECONNRESET, sem 429): 40 consultas
//    simultâneas devolveram 5 resets. Daí o throttle global, sequencial.
//
// 2) O CNPJ do titular tem cota por IP — ~16 divulgações por minuto. Passando
//    disso, a resposta continua 200 e completa, só que SEM o campo publicIds.
//    Degrada calado: o mesmo domínio consultado com 3s de intervalo devolveu o
//    CNPJ numa vez e omitiu na seguinte. É anti-coleta em massa, e é por isso
//    que 'sem_titular' NÃO pode ser lido como "não é desta empresa" — seria
//    falso negativo gravado no cache. Só 'livre' e 'confirmado' concluem algo.
const INTERVALO_MS = 700;
let ultimaChamada = 0;
async function throttle(): Promise<void> {
  const espera = Math.max(0, ultimaChamada + INTERVALO_MS - Date.now());
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaChamada = Date.now();
}

// null = indeterminado (rede/timeout/5xx) — o chamador não deve cachear.
async function get(path: string): Promise<{ ok: true; json: unknown } | { ok: false; naoExiste: boolean }> {
  try {
    await throttle();
    const resp = await fetch(`${config.rdapUrl}/${path}`, {
      headers: { 'User-Agent': 'Rovva/1.0 (enriquecimento sob demanda)', Accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(8000), // serviço externo lento não pode travar a request
    });
    // 404 é resposta legítima: domínio livre / CNPJ sem cadastro no registro.br.
    if (resp.status === 404) return { ok: false, naoExiste: true };
    if (!resp.ok) return { ok: false, naoExiste: false };
    return { ok: true, json: await resp.json() };
  } catch {
    return { ok: false, naoExiste: false };
  }
}

interface RdapEntity {
  roles?: string[];
  publicIds?: { type?: string; identifier?: string }[];
}

function cnpjDoRegistrante(json: unknown): string | null {
  const d = json as { entities?: RdapEntity[] };
  for (const e of d.entities ?? []) {
    if (!e.roles?.includes('registrant')) continue;
    for (const p of e.publicIds ?? []) {
      if (p.type === 'cnpj' && p.identifier) {
        const dig = p.identifier.replace(/\D/g, '');
        if (dig.length === 14) return dig;
      }
    }
  }
  return null;
}

export async function consultarDominio(dominio: string): Promise<ResultadoDominio | null> {
  const r = await get(`domain/${encodeURIComponent(dominio)}`);
  if (!r.ok) return r.naoExiste ? { estado: 'livre' } : null;
  const cnpj = cnpjDoRegistrante(r.json);
  return cnpj ? { estado: 'confirmado', titularCnpj: cnpj } : { estado: 'sem_titular' };
}

// Quantos domínios .br este CNPJ tem registrados. 0 = não adianta varrer
// candidato nenhum. null = indeterminado (RDAP fora) -> varre assim mesmo.
export async function contarDominios(cnpj: string): Promise<number | null> {
  const r = await get(`entity/${cnpj.replace(/\D/g, '')}`);
  if (!r.ok) return r.naoExiste ? 0 : null;
  const n = (r.json as { nicbr_domainCount?: unknown }).nicbr_domainCount;
  return typeof n === 'number' ? n : null;
}

// --- geração de candidatos -------------------------------------------------

// A base da Receita vem em CAIXA ALTA e sem acento, com o tipo societário colado
// no fim ("MALINSKI MADEIRAS LTDA") e frequentemente com a sigla depois de um
// hífen ("FEDERACAO RONDONIENSE DE TIRO ESPORTIVO E CACA - FROTEC").
const SOCIETARIO = /\b(LTDA|EIRELI|EPP|ME|MEI|S\/?A|CIA|SOCIEDADE ANONIMA|EM RECUPERACAO JUDICIAL|FILIAL|MATRIZ)\b/g;
// Palavras que quase nunca entram no domínio ("INDUSTRIA E COMERCIO DE ALIMENTOS"
// -> "alimentos"). Removidas só na 2ª rodada de candidatos, nunca na 1ª.
const GENERICAS = /\b(INDUSTRIA|INDUSTRIAL|COMERCIO|COMERCIAL|IMPORTACAO|EXPORTACAO|DISTRIBUIDORA|REPRESENTACOES|PARTICIPACOES|EMPREENDIMENTOS|SERVICOS|TRANSPORTES|DE|DA|DO|DAS|DOS|E)\b/g;

// Tem que rodar ANTES do filtro [^A-Z0-9], sen\u00e3o "Ind\u00fastria A\u00e7\u00e3o" perde as
// letras acentuadas em vez de virar "industriaacao". A base da Receita j\u00e1 vem
// sem acento, mas nome fantasia de cadastro manual n\u00e3o.
function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function slug(s: string): string {
  return semAcento(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MAX_CANDIDATOS = 6;

// Provedores gratuitos: 83% dos e-mails da base RFB caem aqui (gmail sozinho é
// mais da metade). O domínio deles não diz nada sobre a empresa.
const EMAIL_GRATUITO = new Set([
  'gmail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br',
  'yahoo.com', 'yahoo.com.br', 'live.com', 'msn.com', 'aol.com', 'icloud.com',
  'me.com', 'bol.com.br', 'uol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com',
  'r7.com', 'zipmail.com.br', 'oi.com.br', 'superig.com.br', 'globomail.com',
  'protonmail.com', 'proton.me', 'gmail.com.br', 'yahoo.com.mx',
]);

// Domínio do e-mail que a empresa declarou na Receita. É o melhor candidato que
// existe — não é palpite derivado do nome, é dado do próprio cadastro.
//
// Não filtra contabilidade (contabilizei.com.br e maismei.com.br estão entre os
// domínios mais comuns da base) porque não precisa: o domínio ainda passa pela
// confirmação por CNPJ no registro.br, e o CNPJ do contador não bate com o da
// empresa. O filtro aqui é só dos provedores gratuitos, que gastariam consulta à toa.
export function dominioDeEmail(email?: string | null): string | null {
  const dom = (email ?? '').trim().toLowerCase().split('@')[1];
  if (!dom) return null;
  const limpo = dom.replace(/[^a-z0-9.-]/g, '').replace(/\.+$/, '');
  if (!limpo.includes('.') || EMAIL_GRATUITO.has(limpo)) return null;
  return limpo;
}

// Ordem importa: o que é mais provável de ser o domínio vem primeiro, porque
// cada candidato custa uma requisição e a varredura para no primeiro que bate.
// Nome fantasia antes de razão social — é ele que vira marca, e marca vira domínio.
export function candidatosDominio(razaoSocial: string, nomeFantasia?: string | null): string[] {
  const out: string[] = [];
  for (const bruto of [nomeFantasia, razaoSocial]) {
    if (!bruto) continue;
    const base = semAcento(bruto).toUpperCase()
      .replace(/\s*-\s*/g, ' ')
      .replace(SOCIETARIO, ' ')
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!base) continue;
    out.push(slug(base));
    const enxuto = base.replace(GENERICAS, ' ').replace(/\s+/g, ' ').trim();
    if (!enxuto) continue;
    out.push(slug(enxuto));
    const palavras = enxuto.split(' ');
    if (palavras.length >= 2) out.push(slug(palavras.slice(0, 2).join('')));
    out.push(slug(palavras[0]!));
  }
  // 3 chars é o mínimo do registro.br; acima de 40 não é nome, é frase.
  return [...new Set(out)].filter((c) => c.length >= 3 && c.length <= 40).slice(0, MAX_CANDIDATOS);
}
