// Empresas da base de demonstração (companies.source = 'demo', migração 073) não
// podem aparecer em nenhuma superfície de DESCOBERTA — o pool `companies` é
// global, então uma empresa fictícia da demo estaria, sem filtro, sugerida na
// prospecção de todos os outros tenants (docs/DEMO_DATA.md §3).
//
// São três pontos, e cada um pega o vazamento por um caminho diferente:
// recomendação (score), busca por nome/CNPJ (autopreencher cadastro) e contagem
// de mercado potencial do mapa de cobertura. O contraponto está em cada caso: a
// empresa 'rfb' equivalente, criada no mesmo município e CNAE, tem que continuar
// aparecendo — senão o filtro estaria simplesmente quebrando a busca.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, register, bearer, makeCompany, closeAll, type Session } from './helpers.ts';
import { query } from '../src/db.ts';

const CAMPINAS = 3509502;
const CNAE_PADARIA = 4721102;

let app: FastifyInstance;
let a: Session;
let idDemo = 0;
let idReal = 0;
let nomeDemo = '';
let nomeReal = '';
let cnpjDemo = '';

const inj = (s: Session, url: string): ReturnType<FastifyInstance['inject']> =>
  app.inject({ method: 'GET', url, headers: bearer(s.token) });

beforeAll(async () => {
  app = await makeApp();
  a = await register(app, 'demo.source');

  // Par idêntico (mesmo município, mesmo CNAE, mesmo porte): a única diferença é
  // a origem, então qualquer resultado que traga uma e não a outra é o filtro.
  const marca = `Panificadora Filtro ${Date.now()}`;
  nomeDemo = `${marca} Demo`;
  nomeReal = `${marca} Real`;
  idDemo = await makeCompany({
    municipioId: CAMPINAS, cnae: CNAE_PADARIA, lat: -22.9, lon: -47.06, razao: nomeDemo,
  });
  idReal = await makeCompany({
    municipioId: CAMPINAS, cnae: CNAE_PADARIA, lat: -22.9, lon: -47.06, razao: nomeReal,
  });
  await query("UPDATE companies SET source = 'demo' WHERE id = $1", [idDemo]);
  cnpjDemo = (await query<{ cnpj: string }>('SELECT cnpj FROM companies WHERE id = $1', [idDemo]))[0]!.cnpj.trim();
});
afterAll(async () => {
  await query('DELETE FROM companies WHERE id = ANY($1::bigint[])', [[idDemo, idReal]]);
  await closeAll(app);
});

describe('companies.source = demo fica fora da descoberta', () => {
  it('recommend não sugere empresa de demo, mas sugere a equivalente real', async () => {
    const r = await inj(a, `/api/recommend?munis=${CAMPINAS}&cnae=${CNAE_PADARIA}&limit=100`);
    expect(r.statusCode).toBe(200);
    const ids = (r.json() as { results: { id: number }[] }).results.map((x) => Number(x.id));
    expect(ids).not.toContain(idDemo);
    expect(ids).toContain(idReal);
  });

  it('busca por nome não devolve empresa de demo', async () => {
    const r = await inj(a, `/api/companies/search?q=${encodeURIComponent(nomeReal.slice(0, 24))}`);
    expect(r.statusCode).toBe(200);
    const ids = (r.json() as { companies: { id: number }[] }).companies.map((x) => Number(x.id));
    expect(ids).not.toContain(idDemo);
    expect(ids).toContain(idReal);
  });

  it('busca por CNPJ exato da empresa de demo não devolve nada', async () => {
    const r = await inj(a, `/api/companies/search?q=${cnpjDemo}`);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { companies: unknown[] }).companies).toHaveLength(0);
  });

  it('empresa de demo não conta como mercado potencial no mapa de cobertura', async () => {
    const antes = await contarPotencial();
    await query("UPDATE companies SET source = 'rfb' WHERE id = $1", [idDemo]);
    const comAsDuas = await contarPotencial();
    await query("UPDATE companies SET source = 'demo' WHERE id = $1", [idDemo]);
    // A única coisa que mudou foi a origem daquela linha: o potencial tem que
    // subir exatamente 1 quando ela deixa de ser demo.
    expect(comAsDuas - antes).toBe(1);
  });

  // A empresa de demo continua legível por id — a tela de cliente da própria org
  // de demonstração depende disso. O filtro é de descoberta, não de leitura.
  it('detalhe por id continua acessível', async () => {
    const r = await inj(a, `/api/companies/${idDemo}`);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { company: { source: string } }).company.source).toBe('demo');
  });
});

async function contarPotencial(): Promise<number> {
  const r = await inj(a, `/api/reports/coverage?munis=${CAMPINAS}`);
  const rows = (r.json() as { municipios: { id: number; potencial: number }[] }).municipios;
  return rows.find((x) => Number(x.id) === CAMPINAS)?.potencial ?? 0;
}
