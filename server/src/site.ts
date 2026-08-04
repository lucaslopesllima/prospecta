// Resolve a URL que o domínio confirmado no registro.br realmente serve.
//
// Domínio registrado NÃO é sinônimo de site no ar. Medido em 20 domínios
// confirmados por CNPJ: 12 serviam página, 5 não tinham DNS nenhum (registrados
// só para e-mail) e 3 respondiam 403/404. Metade dos que funcionam só atende em
// `www`, e alguns só em http. Daí a sondagem em cadeia.
//
// 403 é caso à parte: italac.com.br devolve 403 para bot e tem site normal no
// navegador. Bloqueio de WAF vira 'bloqueado', nunca 'sem_pagina' — dizer ao
// representante que a empresa não tem site quando tem é pior que não afirmar nada.
import { lookup } from 'node:dns/promises';

// 'vivo'       -> respondeu uma página; `url` é a final (após redirects)
// 'bloqueado'  -> 401/403/429: quase certamente tem site, só não deixou ler
// 'sem_pagina' -> 404/410/5xx ou corpo vazio: domínio aponta pra lugar nenhum
// 'sem_dns'    -> sem A/AAAA: domínio existe só para e-mail / defensivo
export type StatusSite = 'vivo' | 'bloqueado' | 'sem_pagina' | 'sem_dns';

export interface Site { url: string | null; status: StatusSite }

// O domínio vem do registro.br, não do usuário — mas o dono dele é um terceiro
// qualquer, que pode apontar o DNS para a rede interna do compose (db,
// evolution) ou para o metadata da VPS. Sem esta checagem a sondagem é um SSRF.
//
// Resíduo conhecido: o fetch resolve o DNS de novo por conta própria, então uma
// resposta com TTL 0 poderia devolver outro IP entre a checagem e a conexão
// (DNS rebinding). Fechar isso exige dispatcher próprio com o IP fixado; para o
// risco atual (domínio de empresa confirmado por CNPJ) a checagem prévia basta.
function ipPrivado(addr: string): boolean {
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr; // IPv4 mapeado
  const p = v4.split('.').map(Number);
  if (p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = p as [number, number, number, number];
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)     // CGNAT
      || (a === 169 && b === 254)               // link-local / metadata cloud
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)                 // IETF protocol assignments
      || (a === 198 && (b === 18 || b === 19))  // benchmarking
      || a >= 224;                              // multicast + reservado
  }
  const v6 = addr.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd')
      || v6.startsWith('fe80');
}

async function hostSeguro(host: string): Promise<boolean> {
  try {
    const enderecos = await lookup(host, { all: true });
    return enderecos.length > 0 && enderecos.every((e) => !ipPrivado(e.address));
  } catch {
    return false; // sem DNS
  }
}

const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
// Página real tem mais que isso. Corta placeholder de registrar e resposta vazia.
const MIN_BYTES = 300;

// Segue redirect à mão para validar o host de CADA salto — com redirect:'follow'
// o destino final não passaria pela checagem de IP privado.
async function buscar(url: string): Promise<{ status: number; url: string; bytes: number } | null> {
  // Entra como URL já parseada e segue assim: cada salto substitui o objeto, sem
  // reparsear string. Quem constrói o valor inicial é resolverSite, a partir de
  // um domínio que o gerador de candidatos garante ser [a-z0-9.] apenas.
  let u = new URL(url);
  for (let salto = 0; salto <= MAX_REDIRECTS; salto++) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!(await hostSeguro(u.hostname))) return null;

    let res: Response;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RovvaBot/1.0; +https://rovva.tech/bot)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { return null; }

    if (res.status >= 300 && res.status < 400) {
      const destino = res.headers.get('location');
      if (!destino) return { status: res.status, url: u.toString(), bytes: 0 };
      // Location malformado lança aqui, e sem o try a exceção sobe até a rota.
      try { u = new URL(destino, u); } catch { return null; }
      continue;
    }
    // Só o começo do corpo interessa (existe página?), não o HTML inteiro.
    let bytes = 0;
    try {
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
    } catch { /* corpo ilegível não invalida o status */ }
    return { status: res.status, url: u.toString(), bytes };
  }
  return null; // excesso de redirects
}

const BLOQUEIO = new Set([401, 403, 405, 406, 429]);

// Ordem: https apex -> https www -> http apex. Cobre os três arranjos vistos na
// amostra sem estourar o tempo de uma request síncrona.
export async function resolverSite(dominio: string): Promise<Site> {
  const temDns = (await hostSeguro(dominio)) || (await hostSeguro(`www.${dominio}`));
  if (!temDns) return { url: null, status: 'sem_dns' };

  let bloqueado: string | null = null;
  for (const alvo of [`https://${dominio}`, `https://www.${dominio}`, `http://${dominio}`]) {
    const r = await buscar(alvo);
    if (!r) continue;
    if (r.status === 200 && r.bytes >= MIN_BYTES) return { url: r.url, status: 'vivo' };
    if (BLOQUEIO.has(r.status)) bloqueado ??= r.url;
  }
  // WAF barrou em todas as tentativas: tem servidor de pé, então tem site.
  if (bloqueado) return { url: bloqueado, status: 'bloqueado' };
  return { url: null, status: 'sem_pagina' };
}
