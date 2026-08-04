// GET /api/companies/:id/contatos-site — raspagem dos contatos publicados no
// site. A extração é testada em contatos-site.test.ts; aqui só o contrato da
// rota: auth, dependência do site já descoberto e o não-persistir.
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

const comSite = async (site_url: string | null): Promise<number> => {
  const id = await makeCompany({ razao: 'ACME LTDA' });
  await query(
    `INSERT INTO company_dominio (company_id, dominio, fonte, confianca, site_url, site_status)
       VALUES ($1, 'acme.com.br', 'registrobr', 100, $2, $3)`,
    [id, site_url, site_url ? 'vivo' : 'sem_dns'],
  );
  return id;
};

const buscar = (id: number, token = s.token) =>
  app.inject({ method: 'GET', url: `/api/companies/${id}/contatos-site`, headers: bearer(token) });

const contato = {
  nome: 'Silvio Zanon', cargo: 'Gerente', rotulo: 'Departamento Técnico',
  email: 'silvio@acme.com.br', telefone: '4935417021', whatsapp: '49988321048',
  origem: 'https://www.acme.com.br/contato',
};

describe('GET /api/companies/:id/contatos-site', () => {
  it('devolve os contatos achados e as páginas lidas', async () => {
    const id = await comSite('https://www.acme.com.br/');
    buscarContatosNoSite.mockResolvedValueOnce({
      contatos: [contato], paginas: ['https://www.acme.com.br/', 'https://www.acme.com.br/contato'],
    });
    const r = await buscar(id);
    expect(r.statusCode).toBe(200);
    expect(r.json().contatos).toEqual([contato]);
    expect(r.json().paginas).toHaveLength(2);
    // raspa a URL que a descoberta do site gravou, não o domínio cru
    expect(buscarContatosNoSite).toHaveBeenCalledWith('https://www.acme.com.br/');
  });

  // O ponto do desenho: só o site fica no banco. O que a raspagem achou vive na
  // tela, e vira registro apenas pelo POST /api/contacts do que foi escolhido.
  it('não persiste nada do que raspou', async () => {
    const id = await comSite('https://www.acme.com.br/');
    buscarContatosNoSite.mockResolvedValueOnce({ contatos: [contato], paginas: ['https://www.acme.com.br/'] });
    await buscar(id);
    const linhas = await query<{ n: string }>(
      'SELECT count(*) AS n FROM contacts WHERE email = $1', [contato.email],
    );
    expect(Number(linhas[0]!.n)).toBe(0);
  });

  it('site nenhum encontrado -> lista vazia, não erro', async () => {
    const id = await comSite('https://www.acme.com.br/');
    buscarContatosNoSite.mockResolvedValueOnce({ contatos: [], paginas: ['https://www.acme.com.br/'] });
    const r = await buscar(id);
    expect(r.statusCode).toBe(200);
    expect(r.json().contatos).toEqual([]);
  });

  it('empresa sem site buscado -> 409, sem chamar a raspagem', async () => {
    const id = await makeCompany();
    const r = await buscar(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('busque o site da empresa primeiro');
    expect(buscarContatosNoSite).not.toHaveBeenCalled();
  });

  it('domínio achado mas sem site no ar -> 409', async () => {
    const id = await comSite(null);
    expect((await buscar(id)).statusCode).toBe(409);
    expect(buscarContatosNoSite).not.toHaveBeenCalled();
  });

  it('sem token -> 401', async () => {
    const id = await comSite('https://www.acme.com.br/');
    const r = await app.inject({ method: 'GET', url: `/api/companies/${id}/contatos-site` });
    expect(r.statusCode).toBe(401);
    expect(buscarContatosNoSite).not.toHaveBeenCalled();
  });
});
