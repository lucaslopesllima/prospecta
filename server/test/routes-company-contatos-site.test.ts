// GET /api/companies/:id/contatos-site — raspagem dos contatos publicados no
// site. A extração é testada em contatos-site.test.ts; aqui só o contrato da
// rota: auth, URL recebida do modal e não-persistência.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { buscarContatosNoSite } = vi.hoisted(() => ({ buscarContatosNoSite: vi.fn() }));
vi.mock('../src/contatos_site.ts', () => ({ buscarContatosNoSite }));

const { makeApp, register, bearer, makeCompany, closeAll } = await import('./helpers.ts');
const { query } = await import('../src/db.ts');

let app: FastifyInstance;
let s: Awaited<ReturnType<typeof register>>;
beforeAll(async () => { app = await makeApp(); s = await register(app, 'co-cts'); });
beforeEach(() => buscarContatosNoSite.mockReset());
afterAll(() => closeAll(app));

const comSite = (): Promise<number> => makeCompany({ razao: 'ACME LTDA' });

const buscar = (id: number, token = s.token, siteUrl = 'https://www.acme.com.br/') =>
  app.inject({
    method: 'GET',
    url: `/api/companies/${id}/contatos-site?site_url=${encodeURIComponent(siteUrl)}`,
    headers: bearer(token),
  });

const contato = {
  nome: 'Silvio Zanon', cargo: 'Gerente', rotulo: 'Departamento Técnico',
  email: 'silvio@acme.com.br', telefone: '4935417021', whatsapp: '49988321048',
  origem: 'https://www.acme.com.br/contato',
};

describe('GET /api/companies/:id/contatos-site', () => {
  it('devolve os contatos achados e as páginas lidas', async () => {
    const id = await comSite();
    buscarContatosNoSite.mockResolvedValueOnce({
      contatos: [contato], paginas: ['https://www.acme.com.br/', 'https://www.acme.com.br/contato'],
    });
    const r = await buscar(id);
    expect(r.statusCode).toBe(200);
    expect(r.json().contatos).toEqual([contato]);
    expect(r.json().paginas).toHaveLength(2);
    // Raspa URL enviada pelo modal, sem consultar cache.
    expect(buscarContatosNoSite).toHaveBeenCalledWith('https://www.acme.com.br/');
  });

  // O ponto do desenho: só o site fica no banco. O que a raspagem achou vive na
  // tela, e vira registro apenas pelo POST /api/contacts do que foi escolhido.
  it('não persiste nada do que raspou', async () => {
    const id = await comSite();
    buscarContatosNoSite.mockResolvedValueOnce({ contatos: [contato], paginas: ['https://www.acme.com.br/'] });
    await buscar(id);
    const linhas = await query<{ n: string }>(
      'SELECT count(*) AS n FROM contacts WHERE email = $1', [contato.email],
    );
    expect(Number(linhas[0]!.n)).toBe(0);
  });

  it('site nenhum encontrado -> lista vazia, não erro', async () => {
    const id = await comSite();
    buscarContatosNoSite.mockResolvedValueOnce({ contatos: [], paginas: ['https://www.acme.com.br/'] });
    const r = await buscar(id);
    expect(r.statusCode).toBe(200);
    expect(r.json().contatos).toEqual([]);
  });

  it('URL ausente -> 400, sem chamar a raspagem', async () => {
    const id = await makeCompany();
    const r = await app.inject({
      method: 'GET', url: `/api/companies/${id}/contatos-site`, headers: bearer(s.token),
    });
    expect(r.statusCode).toBe(400);
    expect(buscarContatosNoSite).not.toHaveBeenCalled();
  });

  it('empresa inexistente -> 404', async () => {
    expect((await buscar(999_999_999)).statusCode).toBe(404);
    expect(buscarContatosNoSite).not.toHaveBeenCalled();
  });

  it('sem token -> 401', async () => {
    const id = await comSite();
    const r = await app.inject({
      method: 'GET',
      url: `/api/companies/${id}/contatos-site?site_url=${encodeURIComponent('https://www.acme.com.br/')}`,
    });
    expect(r.statusCode).toBe(401);
    expect(buscarContatosNoSite).not.toHaveBeenCalled();
  });
});
