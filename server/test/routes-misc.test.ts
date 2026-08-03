// Perfil-alvo + municípios, CNAE, companies (+geocode), account, users (reset),
// auditoria (filtros) e recomendação (município, filtros, exclusão do funil).
// fetch global mockado por URL: nominatim/brasilapi p/ geocode.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { query, one } from '../src/db.ts';
import { makeApp, register, bearer, mail, makeCompany, closeAll, type Session } from './helpers.ts';

const SP = 3550308; // São Paulo (seed IBGE)

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

let app: FastifyInstance;
let a: Session;
let b: Session;

beforeAll(async () => {
  app = await makeApp();
  a = await register(app, 'misc.a');
  b = await register(app, 'misc.b');
  await query(`INSERT INTO enabled_regions (uf, regiao) VALUES ('SP','SE'::regiao_br)
               ON CONFLICT (uf) DO NOTHING`);
});
afterAll(async () => { vi.unstubAllGlobals(); await closeAll(app); });

const inj = (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown):
  ReturnType<FastifyInstance['inject']> =>
  app.inject({ method, url, headers: bearer(s.token), payload });

describe('municipios', () => {
  it('busca/labels/ufs/by-uf de municípios', async () => {
    const all = await inj(a, 'GET', '/api/municipios');
    expect((all.json() as { municipios: unknown[] }).municipios.length).toBeGreaterThan(100);

    const search = await inj(a, 'GET', '/api/municipios/search?q=sao paulo');
    expect((search.json() as { municipios: { id: number }[] }).municipios.some((m) => m.id === SP)).toBe(true);

    const labels = await inj(a, 'GET', `/api/municipios/labels?ids=${SP},abc`);
    expect((labels.json() as { municipios: { nome: string }[] }).municipios[0]!.nome).toBe('São Paulo');
    const empty = await inj(a, 'GET', '/api/municipios/labels?ids=abc');
    expect((empty.json() as { municipios: unknown[] }).municipios).toHaveLength(0);

    const ufs = await inj(a, 'GET', '/api/municipios/ufs');
    expect((ufs.json() as { ufs: { uf: string }[] }).ufs.some((u) => u.uf === 'SP')).toBe(true);

    const byUf = await inj(a, 'GET', '/api/municipios/by-uf?uf=sp');
    expect((byUf.json() as { municipios: { id: number }[] }).municipios.some((m) => m.id === SP)).toBe(true);
  });
});

describe('cnae', () => {
  it('search resolve por sinônimo e descrição, agrupado por divisão', async () => {
    const r = await inj(a, 'GET', '/api/cnae/search?q=roupa');
    const grupos = (r.json() as { grupos: { divisao: number; itens: { codigo: number }[] }[] }).grupos;
    expect(grupos.length).toBeGreaterThan(0);
    expect(grupos.flatMap((g) => g.itens.map((i) => i.codigo))).toContain(4781400);
  });

  it('labels resolve códigos; vazio sem códigos válidos', async () => {
    const r = await inj(a, 'GET', '/api/cnae/labels?codes=4781400,xx');
    expect((r.json() as { labels: { codigo: number }[] }).labels[0]!.codigo).toBe(4781400);
    const empty = await inj(a, 'GET', '/api/cnae/labels?codes=zz');
    expect((empty.json() as { labels: unknown[] }).labels).toHaveLength(0);
  });
});

describe('companies', () => {
  it('GET :id devolve cadastro completo + sócios; 404 quando não existe', async () => {
    const cid = await makeCompany({ municipioId: SP, lat: -23.55, lon: -46.63 });
    const r = await inj(a, 'GET', `/api/companies/${cid}`);
    const j = r.json() as { company: { cidade: string }; socios: unknown[] };
    expect(j.company.cidade).toBe('São Paulo');
    expect(Array.isArray(j.socios)).toBe(true);

    expect((await inj(a, 'GET', '/api/companies/999999999')).statusCode).toBe(404);
  });

  // Aviso "provável contabilidade": o contato só é sinalizado quando está em
  // contato_compartilhado (telefone/e-mail que se repete em 4+ CNPJs raiz).
  it('GET :id marca contato compartilhado (contabilidade) e ignora o exclusivo', async () => {
    const tel = `11${Date.now() % 1_000_000_000}`.slice(0, 11);
    const email = `contab.${Date.now()}@escritorio.com.br`;
    const cid = await makeCompany({ municipioId: SP });
    await query('UPDATE companies SET telefone1 = $2, telefone2 = $3, email = $4 WHERE id = $1',
      [cid, tel, '1140028922', email]);
    await query(
      `INSERT INTO contato_compartilhado (tipo, valor, empresas) VALUES ('telefone',$1,37), ('email',$2,52)
       ON CONFLICT (tipo, valor) DO UPDATE SET empresas = EXCLUDED.empresas`,
      [tel, email],
    );

    const r = await inj(a, 'GET', `/api/companies/${cid}`);
    const j = r.json() as { compartilhado: { telefone1: number | null; telefone2: number | null; email: number | null } };
    expect(j.compartilhado.telefone1).toBe(37);
    expect(j.compartilhado.email).toBe(52);
    expect(j.compartilhado.telefone2).toBeNull(); // não está na tabela -> exclusivo
  });

  it('GET :id sem telefone/e-mail não sinaliza nada', async () => {
    const cid = await makeCompany({ municipioId: SP });
    await query('UPDATE companies SET telefone1 = NULL, telefone2 = NULL, email = NULL WHERE id = $1', [cid]);
    const r = await inj(a, 'GET', `/api/companies/${cid}`);
    const j = r.json() as { compartilhado: Record<string, number | null> };
    expect(j.compartilhado).toEqual({ telefone1: null, telefone2: null, email: null });
  });

  it('geocode: cache -> geocodificação -> fallback centroide; 404', async () => {
    const cid = await makeCompany({ municipioId: SP, lat: -23.55, lon: -46.63 });

    // sem endereço e fetch falhando -> cai no centroide do município (não cacheia)
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const fallback = await inj(a, 'GET', `/api/companies/${cid}/geocode`);
    const fb = fallback.json() as { geocode: { precisao: string; cached: boolean } };
    expect(fb.geocode.precisao).toBe('municipio');
    expect(fb.geocode.cached).toBe(false);

    // com geocode bem-sucedido -> grava cache
    await query(`UPDATE companies SET logradouro = 'Rua A', numero = '10', cep = '01001000' WHERE id = $1`, [cid]);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true, json: async () => ([{ lat: '-23.51', lon: '-46.61', addresstype: 'building' }]),
    });
    const fresh = await inj(a, 'GET', `/api/companies/${cid}/geocode`);
    const fr = fresh.json() as { geocode: { precisao: string; cached: boolean } };
    expect(fr.geocode).toMatchObject({ precisao: 'rua', cached: false });

    // segunda chamada vem do cache, sem rede
    fetchMock.mockClear();
    const cached = await inj(a, 'GET', `/api/companies/${cid}/geocode`);
    expect((cached.json() as { geocode: { cached: boolean } }).geocode.cached).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    expect((await inj(a, 'GET', '/api/companies/999999999/geocode')).statusCode).toBe(404);
  });

  it('search: por CNPJ (prefixo) e por razão social', async () => {
    // uf/cnae fora da janela do recommend (região não habilitada) p/ não poluir
    // o pool e empurrar o alvo daquele teste para fora do limit.
    const cid = await makeCompany({ uf: 'AC', regiao: 'N', cnae: 1111111, razao: 'Transportes Zeta Ltda' });
    const cnpj = (await one<{ cnpj: string }>('SELECT cnpj FROM companies WHERE id = $1', [cid]))!.cnpj;

    // por CNPJ (prefixo de dígitos)
    const byCnpj = await inj(a, 'GET', `/api/companies/search?q=${cnpj.slice(0, 8)}`);
    expect(byCnpj.statusCode).toBe(200);
    expect((byCnpj.json() as { companies: { id: number }[] }).companies.some((c) => Number(c.id) === cid)).toBe(true);

    // por razão social (trigram ILIKE)
    const byNome = await inj(a, 'GET', '/api/companies/search?q=Zeta Ltda');
    const hit = (byNome.json() as { companies: { id: number; cnpj: string; razao_social: string }[] }).companies.find((c) => Number(c.id) === cid);
    expect(hit).toBeDefined();
    expect(hit!.razao_social).toBe('Transportes Zeta Ltda');

    // q < 2 chars → 400 (schema)
    expect((await inj(a, 'GET', '/api/companies/search?q=a')).statusCode).toBe(400);
  });
});

describe('account', () => {
  it('GET/PATCH dados da org + email; duplicado 409; endereço invalida origem', async () => {
    const got = await inj(a, 'GET', '/api/account');
    expect((got.json() as { user: { id: number } }).user.id).toBe(a.user.id);

    const newMail = mail('conta');
    // trocar email exige a senha atual (senha do register() nos helpers)
    const up = await inj(a, 'PATCH', '/api/account',
      { nome: 'Org Renomeada', email: newMail, senha_atual: 'senha123', cidade: 'São Paulo', uf: 'SP' });
    expect((up.json() as { user: { email: string } }).user.email).toBe(newMail);

    // sem senha atual -> 400
    const semSenha = await inj(a, 'PATCH', '/api/account', { email: mail('outro') });
    expect(semSenha.statusCode).toBe(400);

    // email de outro usuário -> 409
    const dup = await inj(a, 'PATCH', '/api/account', { email: `${b.user.id}.${newMail}`, senha_atual: 'senha123' });
    expect(dup.statusCode).toBe(200); // email diferente passa
    const taken = await inj(b, 'PATCH', '/api/account', { email: `${b.user.id}.${newMail}`, senha_atual: 'senha123' });
    expect(taken.statusCode).toBe(409);

    // endereço mudou -> origem cacheada zera
    await query('UPDATE organizations SET origem_lat = 1, origem_lon = 1 WHERE id = $1', [a.user.org_id]);
    await inj(a, 'PATCH', '/api/account', { logradouro: 'Rua Nova' });
    const org = await one<{ origem_lat: number | null }>(
      'SELECT origem_lat FROM organizations WHERE id = $1', [a.user.org_id]);
    expect(org!.origem_lat).toBeNull();
  });

  it('origem: sem endereço -> null; geocode ok -> cacheia; cache -> retorna direto; falha -> null', async () => {
    const fresh = await register(app, 'origem');

    // org recém-criada não tem endereço
    expect(((await inj(fresh, 'GET', '/api/account/origem')).json() as { origem: null }).origem).toBeNull();

    await inj(fresh, 'PATCH', '/api/account', { logradouro: 'Av. B', numero: '1', cidade: 'São Paulo', uf: 'SP' });

    // geocode falha (nominatim + brasilapi sem cep) -> null
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(((await inj(fresh, 'GET', '/api/account/origem')).json() as { origem: null }).origem).toBeNull();

    // geocode ok -> retorna e cacheia
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true, json: async () => ([{ lat: '-23.5', lon: '-46.6', addresstype: 'building' }]),
    });
    const ok = (await inj(fresh, 'GET', '/api/account/origem')).json() as { origem: { cached: boolean } };
    expect(ok.origem.cached).toBe(false);
    const again = (await inj(fresh, 'GET', '/api/account/origem')).json() as { origem: { cached: boolean } };
    expect(again.origem.cached).toBe(true);
  });

  it('troca de senha: atual errada -> 400', async () => {
    const r = await inj(a, 'POST', '/api/account/password',
      { senha_atual: 'erradíssima', nova_senha: 'novasenha1' });
    expect(r.statusCode).toBe(400);
  });
});

describe('users (admin extra)', () => {
  it('reset de senha derruba sessões do alvo; self-reset 400; 404 cross-org', async () => {
    const created = await inj(a, 'POST', '/api/users',
      { nome: 'Resetável', email: mail('reset'), senha: 'inicial1' });
    const rep = (created.json() as { user: { id: number } }).user;

    const loginR = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: (created.json() as { user: { email: string } }).user.email, senha: 'inicial1' } });
    const repTok = (loginR.json() as { token: string }).token;
    expect((await inj({ token: repTok, user: rep } as Session, 'GET', '/api/auth/me')).statusCode).toBe(200);

    expect((await inj(a, 'POST', `/api/users/${a.user.id}/password`, { senha: 'qualquer1' })).statusCode).toBe(400);
    expect((await inj(b, 'POST', `/api/users/${rep.id}/password`, { senha: 'qualquer1' })).statusCode).toBe(404);

    expect((await inj(a, 'POST', `/api/users/${rep.id}/password`, { senha: 'provis2' })).statusCode).toBe(200);
    // token antigo morreu (token_version++)
    expect((await app.inject({ method: 'GET', url: '/api/auth/me',
      headers: bearer(repTok) })).statusCode).toBe(401);

    // PATCH 404 cross-org + 400 body vazio
    expect((await inj(b, 'PATCH', `/api/users/${rep.id}`, { nome: 'inv' })).statusCode).toBe(404);
    expect((await inj(a, 'PATCH', `/api/users/${rep.id}`, {})).statusCode).toBe(400);
    const promote = await inj(a, 'PATCH', `/api/users/${rep.id}`, { role: 'admin', nome: 'Promovido' });
    expect((promote.json() as { user: { role: string } }).user.role).toBe('admin');

    // criar usuário com email já usado -> 409
    expect((await inj(a, 'POST', '/api/users',
      { nome: 'Dup', email: (created.json() as { user: { email: string } }).user.email, senha: 'x12345' }))
      .statusCode).toBe(409);
    // listagem
    expect((await inj(a, 'GET', '/api/users')).statusCode).toBe(200);
  });
});

describe('audit (filtros)', () => {
  it('filtra por entity/entity_id e pagina', async () => {
    const cid = await makeCompany();
    const created = await inj(a, 'POST', '/api/relationships', { company_id: cid });
    const relId = (created.json() as { relationship: { id: number } }).relationship.id;

    const all = await inj(a, 'GET', '/api/audit?limit=5&offset=0');
    const allBody = all.json() as { entries: unknown[]; total: number };
    expect(allBody.entries.length).toBeGreaterThan(0);
    // total conta o universo filtrado, não só a página — >= itens da página.
    expect(allBody.total).toBeGreaterThanOrEqual(allBody.entries.length);
    const byEntity = await inj(a, 'GET', `/api/audit?entity=relationship&entity_id=${relId}`);
    const byBody = byEntity.json() as { entries: { action: string }[]; total: number };
    expect(byBody.entries[0]!.action).toBe('create');
    expect(byBody.total).toBe(1); // só o create desse relationship
  });
});

describe('recommend', () => {
  it('400 sem território; resultados no modo município; exclusão do funil', async () => {
    const solo = await register(app, 'rec');

    // território é obrigatório e vem do request (sem perfil server-side).
    expect((await inj(solo, 'GET', '/api/recommend')).statusCode).toBe(400);
    expect((await inj(solo, 'GET', '/api/recommend?munis=')).statusCode).toBe(400);

    const cid = await makeCompany({
      municipioId: SP, lat: -23.55, lon: -46.63, cnae: 4781400,
      razao: 'Recomendavel Vestuario LTDA', porte: 'pequeno',
    });

    const url = `/api/recommend?munis=${SP}&cnae=4781400&limit=100`;
    const r = await inj(solo, 'GET', url);
    expect(r.statusCode).toBe(200);
    interface Rec { id: string; reason: { cnae_match: string } }
    const results = (r.json() as { results: Rec[] }).results;
    const mine = results.find((x) => Number(x.id) === cid)!;
    expect(mine).toBeDefined();
    expect(mine.reason.cnae_match).toBe('classe');

    // total de empresas do perfil (capado): acompanha o funil.
    interface Page { results: Rec[]; page: { total: number; total_capped: boolean } }
    const antes = (r.json() as Page).page;
    expect(antes.total).toBe(results.length);
    expect(antes.total_capped).toBe(false);

    // entrou no funil -> some da recomendação
    await inj(solo, 'POST', '/api/relationships', { company_id: cid });
    const after = await inj(solo, 'GET', url);
    expect((after.json() as { results: Rec[] }).results.some((x) => Number(x.id) === cid)).toBe(false);
    expect((after.json() as Page).page.total).toBe(antes.total - 1);
  });

  it('filtros server-side (q, cnae-alvo, uf, porte)', async () => {
    const solo = await register(app, 'rec2');
    const cid = await makeCompany({
      municipioId: SP, lat: -23.55, lon: -46.63, cnae: 4781400,
      razao: 'Filtrada Confeccoes LTDA', porte: 'micro',
    });
    const base = `munis=${SP}&cnae=4781400`;

    interface Page { results: { id: string }[] }
    const has = (j: Page): boolean => j.results.some((x) => Number(x.id) === cid);

    expect(has((await inj(solo, 'GET', `/api/recommend?${base}&q=Filtrada Confeccoes&limit=100`)).json() as Page)).toBe(true);
    // q curto (<3) é ignorado — não filtra nada
    expect((await inj(solo, 'GET', `/api/recommend?${base}&q=ab&limit=100`)).statusCode).toBe(200);
    expect(has((await inj(solo, 'GET', `/api/recommend?${base}&limit=100`)).json() as Page)).toBe(true);
    expect(has((await inj(solo, 'GET', `/api/recommend?${base}&porte=micro&limit=100`)).json() as Page)).toBe(true);
    expect(has((await inj(solo, 'GET', `/api/recommend?${base}&porte=demais&limit=100`)).json() as Page)).toBe(false);
    // q com dígitos aciona a busca por prefixo de cnpj
    expect((await inj(solo, 'GET', `/api/recommend?${base}&q=99 999&limit=100`)).statusCode).toBe(200);
  });

  it('faixas de capital social e tempo de vida cortam a base', async () => {
    const solo = await register(app, 'rec3');
    const nova = await makeCompany({
      municipioId: SP, lat: -23.55, lon: -46.63, cnae: 4781400,
      capital: 50_000, abertura: '2024-01-10',
    });
    const antiga = await makeCompany({
      municipioId: SP, lat: -23.55, lon: -46.63, cnae: 4781400,
      capital: 5_000_000, abertura: '1998-03-02',
    });
    const semData = await makeCompany({
      municipioId: SP, lat: -23.55, lon: -46.63, cnae: 4781400, capital: 5_000_000,
    });
    const base = `munis=${SP}&cnae=4781400&limit=100`;

    interface Page { results: { id: string }[] }
    const ids = async (qs: string): Promise<number[]> =>
      ((await inj(solo, 'GET', `/api/recommend?${base}&${qs}`)).json() as Page).results.map((x) => Number(x.id));

    const capAlto = await ids('cap_min=1000000');
    expect(capAlto).toContain(antiga);
    expect(capAlto).not.toContain(nova);

    const capBaixo = await ids('cap_max=100000');
    expect(capBaixo).toContain(nova);
    expect(capBaixo).not.toContain(antiga);

    // >=20 anos: só a antiga (a sem data_inicio_atividade sai quando há faixa)
    const velhas = await ids('idade_min=20');
    expect(velhas).toContain(antiga);
    expect(velhas).not.toContain(nova);
    expect(velhas).not.toContain(semData);

    // <=5 anos: só a nova
    const jovens = await ids('idade_max=5');
    expect(jovens).toContain(nova);
    expect(jovens).not.toContain(antiga);
  });
});
