// Tiny fetch wrapper. Native fetch, no axios. Adds Bearer token, parses JSON, throws on error.
const TOKEN_KEY = 'rs_token';

// Espera de digitação de TODA busca que consulta o servidor (CNAE, municípios,
// prospecção, CompanySearch, filtro de empresa em Pedidos). Um número só p/ o
// app responder no mesmo ritmo em toda tela — antes eram 250/300/350ms soltos.
// Filtro que roda em memória (catálogo, clientes, conversas) NÃO usa: sem rede,
// esperar só atrasaria a digitação.
export const BUSCA_DEBOUNCE_MS = 300;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RequestOpts {
  // passe o signal de um AbortController no cleanup do useEffect — resposta de
  // página abandonada não chega a tocar o estado.
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts?.signal,
  });

  if (res.status === 401) {
    setToken(null);
    if (location.pathname !== '/login') location.href = '/login';
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? data?.message ?? `Erro ${res.status}`);
  }
  return data as T;
}

// Cache leve em memória p/ GETs de dados de referência (TTL 60s): devolve a
// mesma promise enquanto fresca (deduplica chamadas concorrentes idênticas) e
// é invalidado quando qualquer mutação toca o mesmo recurso. Nada de auth
// passa por aqui — só o allowlist abaixo.
const CACHE_TTL_MS = 60_000;
const CACHEABLE_PREFIXES = [
  '/api/represented', '/api/catalog', '/api/users', '/api/stages',
  '/api/carriers', '/api/price-tables', '/api/cnae', '/api/private-labels',
];
const cache = new Map<string, { promise: Promise<unknown>; expira: number }>();

// Prefixo cacheável do path (query string fora da comparação). null = não cacheia.
function cachePrefix(path: string): string | null {
  const clean = path.split('?')[0];
  return CACHEABLE_PREFIXES.find((p) => clean === p || clean.startsWith(`${p}/`)) ?? null;
}

// Sem prefixo, limpa tudo; com prefixo, só as entradas daquele recurso.
function invalidate(prefix?: string): void {
  if (!prefix) { cache.clear(); return; }
  for (const key of [...cache.keys()]) {
    const clean = key.split('?')[0];
    if (clean === prefix || clean.startsWith(`${prefix}/`)) cache.delete(key);
  }
}

function cachedGet<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && hit.expira > Date.now()) return hit.promise as Promise<T>;
  // Signal omitido de propósito: a promise é compartilhada, então o abort de um
  // consumidor não pode derrubar os demais.
  const p = request<T>('GET', path);
  cache.set(path, { promise: p, expira: Date.now() + CACHE_TTL_MS });
  // Erro não fica cacheado — a próxima chamada tenta de novo.
  p.catch(() => { if (cache.get(path)?.promise === p) cache.delete(path); });
  return p;
}

// Mutação: depois de resolver (ou falhar), invalida o cache do recurso tocado.
async function mutate<T>(method: string, path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
  try {
    return await request<T>(method, path, body, opts);
  } finally {
    const prefix = cachePrefix(path);
    if (prefix) invalidate(prefix);
  }
}

export const api = {
  get: <T>(p: string, o?: RequestOpts) => (cachePrefix(p) ? cachedGet<T>(p) : request<T>('GET', p, undefined, o)),
  post: <T>(p: string, b?: unknown, o?: RequestOpts) => mutate<T>('POST', p, b, o),
  put: <T>(p: string, b?: unknown, o?: RequestOpts) => mutate<T>('PUT', p, b, o),
  patch: <T>(p: string, b?: unknown, o?: RequestOpts) => mutate<T>('PATCH', p, b, o),
  del: <T>(p: string, o?: RequestOpts) => mutate<T>('DELETE', p, undefined, o),
  invalidate,
};
