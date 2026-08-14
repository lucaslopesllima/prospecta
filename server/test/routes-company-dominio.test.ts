// GET /api/companies/:id/dominio — descoberta do site próprio sob demanda.
// A descoberta em si é testada em enriquecimento.test.ts; aqui só o contrato da
// rota: auth, 404 e o repasse do resultado.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { descobrirDominio } = vi.hoisted(() => ({ descobrirDominio: vi.fn() }));
vi.mock('../src/enriquecimento.ts', () => ({ descobrirDominio }));

const { makeApp, register, bearer, makeCompany, closeAll } = await import('./helpers.ts');

let app: FastifyInstance;
let s: Awaited<ReturnType<typeof register>>;
beforeAll(async () => { app = await makeApp(); s = await register(app, 'co-dom'); });
beforeEach(() => descobrirDominio.mockClear());
afterAll(() => closeAll(app));

const buscar = (id: number, token = s.token) =>
  app.inject({ method: 'GET', url: `/api/companies/${id}/dominio`, headers: bearer(token) });

describe('GET /api/companies/:id/dominio', () => {
  it('devolve o domínio encontrado', async () => {
    const id = await makeCompany({ razao: 'ACME LTDA', fantasia: 'ACME' });
    const achado = {
      dominio: 'acme.com.br', site_url: 'https://www.acme.com.br/', site_status: 'vivo',
      status: 'achou', fonte: 'registrobr', confianca: 100,
    };
    descobrirDominio.mockResolvedValueOnce(achado);
    const r = await buscar(id);
    expect(r.statusCode).toBe(200);
    expect(r.json().dominio).toEqual(achado);
    // a rota passa o CNPJ e os nomes — é deles que saem os candidatos
    expect(descobrirDominio).toHaveBeenCalledWith(
      expect.objectContaining({ id, razao_social: 'ACME LTDA', nome_fantasia: 'ACME' }),
    );
  });

  it('não encontrado devolve dominio null, não 404', async () => {
    const id = await makeCompany();
    descobrirDominio.mockResolvedValueOnce({
      dominio: null, site_url: null, site_status: null,
      status: 'nao_encontrado', fonte: 'registrobr', confianca: 0,
    });
    const r = await buscar(id);
    expect(r.statusCode).toBe(200);
    expect(r.json().dominio).toMatchObject({ dominio: null, status: 'nao_encontrado' });
  });

  it('empresa inexistente -> 404', async () => {
    const r = await buscar(999_999_999);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('empresa não encontrada');
    expect(descobrirDominio).not.toHaveBeenCalled();
  });

  it('sem token -> 401', async () => {
    const id = await makeCompany();
    const r = await app.inject({ method: 'GET', url: `/api/companies/${id}/dominio` });
    expect(r.statusCode).toBe(401);
  });
});
