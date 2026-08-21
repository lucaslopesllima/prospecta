import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { pool } from '../src/db.ts';

const run = Date.now();
const ownerEmail = `leads.owner.${run}@teste.com`;
let app: FastifyInstance;
let ownerToken: string;
let otherToken: string;
let leadId: string;

async function register(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { org_nome: `Org ${email}`, email, senha: 'senha123' },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { token: string }).token;
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp({ logger: false, leadsAdminEmail: ownerEmail });
  await app.ready();
  ownerToken = await register(ownerEmail);
  otherToken = await register(`leads.other.${run}@teste.com`);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('pedidos de demonstração', () => {
  it('formulário público salva pedido normalizado', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/leads',
      payload: {
        nome: ' Maria Silva ', email: 'MARIA@EMPRESA.COM', telefone: ' (11) 99999-9999 ',
        empresa: ' Empresa Exemplo ', mensagem: ' Quero conhecer o sistema. ',
      },
    });
    expect(response.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/leads', headers: auth(ownerToken) });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { leads: Array<{ id: string; email: string; nome: string; status: string }> };
    const lead = body.leads.find((item) => item.email === 'maria@empresa.com');
    expect(lead).toMatchObject({ nome: 'Maria Silva', status: 'novo' });
    leadId = lead!.id;
  });

  it('bloqueia leitura para qualquer outro login', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/leads', headers: auth(otherToken) });
    expect(response.statusCode).toBe(403);
  });

  it('login autorizado atualiza status', async () => {
    const response = await app.inject({
      method: 'PATCH', url: `/api/leads/${leadId}`, headers: auth(ownerToken), payload: { status: 'contatado' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { lead: { status: string } }).lead.status).toBe('contatado');
  });
});
