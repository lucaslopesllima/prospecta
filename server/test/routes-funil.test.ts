// Funil: relationships (lista/filtros, POST com defaults e validações, PATCH
// transacional com syncs N:N, DELETE) + board do kanban.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, register, bearer, makeCompany, closeAll, type Session } from './helpers.ts';

let app: FastifyInstance;
let a: Session;
let b: Session;

beforeAll(async () => {
  app = await makeApp();
  a = await register(app, 'funil.a');
  b = await register(app, 'funil.b');
});
afterAll(async () => { await closeAll(app); });

const inj = (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown):
  ReturnType<FastifyInstance['inject']> =>
  app.inject({ method, url, headers: bearer(s.token), payload });

interface Rel { id: number; stage_id: number | null; status: string; notas: string | null }

async function addRel(s: Session, companyId: number, extra: Record<string, unknown> = {}): Promise<Rel> {
  const r = await inj(s, 'POST', '/api/relationships', { company_id: companyId, ...extra });
  expect(r.statusCode).toBe(201);
  return (r.json() as { relationship: Rel }).relationship;
}

describe('POST /api/relationships', () => {
  it('empresa inexistente -> 404; duplicada -> 409; stage default = primeiro da org', async () => {
    expect((await inj(a, 'POST', '/api/relationships', { company_id: 999_999_999 })).statusCode).toBe(404);

    const cid = await makeCompany();
    const rel = await addRel(a, cid);
    const stages = (await inj(a, 'GET', '/api/stages')).json() as { stages: { id: number; ordem: number }[] };
    expect(rel.stage_id).toBe(stages.stages[0]!.id);

    const dup = await inj(a, 'POST', '/api/relationships', { company_id: cid });
    expect(dup.statusCode).toBe(409);
  });

  it('stage explícito é validado pela org', async () => {
    const cid = await makeCompany();
    const stagesB = (await inj(b, 'GET', '/api/stages')).json() as { stages: { id: number }[] };
    const inv = await inj(a, 'POST', '/api/relationships', { company_id: cid, stage_id: stagesB.stages[0]!.id });
    expect(inv.statusCode).toBe(400);

    const stagesA = (await inj(a, 'GET', '/api/stages')).json() as { stages: { id: number }[] };
    const ok = await addRel(a, cid, { stage_id: stagesA.stages[1]!.id, notas: 'criada', valor_estimado: 100 });
    expect(ok.stage_id).toBe(stagesA.stages[1]!.id);
  });

  it('FKs de outra org -> 400 (representada / marca / cenário / ação / owner)', async () => {
    const cid = await makeCompany();
    const repB = (await inj(b, 'POST', '/api/represented', { nome: 'B Rep' })).json() as { empresa: { id: number } };
    const r = await inj(a, 'POST', '/api/relationships', { company_id: cid, represented_id: repB.empresa.id });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain('represented_id');

    expect((await inj(a, 'POST', '/api/relationships',
      { company_id: cid, owner_user_id: b.user.id })).statusCode).toBe(400);
  });
});

describe('GET /api/relationships', () => {
  it('filtros stage/status/q + paginação; isolado por org', async () => {
    const cid = await makeCompany({ razao: 'Filtravel Comercio LTDA', fantasia: 'Loja Filtravel' });
    const rel = await addRel(a, cid, { status: 'cliente' });

    const byStatus = await inj(a, 'GET', '/api/relationships?status=cliente&limit=200&offset=0');
    const found = (byStatus.json() as { relationships: { id: number }[] }).relationships;
    expect(found.some((x) => x.id === rel.id)).toBe(true);

    const byQ = await inj(a, 'GET', '/api/relationships?q=Filtravel');
    expect((byQ.json() as { relationships: { id: number }[] }).relationships.some((x) => x.id === rel.id)).toBe(true);

    const byStage = await inj(a, 'GET', `/api/relationships?stage_id=${rel.stage_id}`);
    expect(byStage.statusCode).toBe(200);

    const fromB = await inj(b, 'GET', '/api/relationships?q=Filtravel');
    expect((fromB.json() as { relationships: unknown[] }).relationships).toHaveLength(0);
  });
});

describe('PATCH /api/relationships/:id', () => {
  it('atualiza campos + sincroniza contatos/catálogo na mesma transação', async () => {
    const cid = await makeCompany();
    const rel = await addRel(a, cid);
    const ct = (await inj(a, 'POST', '/api/contacts', { nome: 'Contato Funil' })).json() as { contact: { id: number } };
    const item = (await inj(a, 'POST', '/api/catalog', { nome: 'Item Funil' })).json() as { item: { id: number } };

    const up = await inj(a, 'PATCH', `/api/relationships/${rel.id}`, {
      notas: 'avançou', status: 'cliente',
      contato_ids: [ct.contact.id], catalogo_ids: [item.item.id],
    });
    expect(up.statusCode).toBe(200);
    expect((up.json() as { relationship: { notas: string } }).relationship.notas).toBe('avançou');

    // labels agregados aparecem na lista
    const list = await inj(a, 'GET', '/api/relationships');
    const mine = (list.json() as { relationships: { id: number; contatos: { id: number }[]; catalogo: { id: number }[] }[] })
      .relationships.find((x) => x.id === rel.id)!;
    expect(mine.contatos.map((c) => Number(c.id))).toEqual([Number(ct.contact.id)]);
    expect(mine.catalogo.map((c) => Number(c.id))).toEqual([Number(item.item.id)]);

    // só contato_ids (sem sets) cai no SELECT + sync; array vazio limpa
    const clear = await inj(a, 'PATCH', `/api/relationships/${rel.id}`, { contato_ids: [], catalogo_ids: [] });
    expect(clear.statusCode).toBe(200);
  });

  it('body vazio 400; cross-org 404 (com e sem sets); FK alheia 400', async () => {
    const cid = await makeCompany();
    const rel = await addRel(a, cid);

    expect((await inj(a, 'PATCH', `/api/relationships/${rel.id}`, {})).statusCode).toBe(400);
    expect((await inj(b, 'PATCH', `/api/relationships/${rel.id}`, { notas: 'inv' })).statusCode).toBe(404);
    expect((await inj(b, 'PATCH', `/api/relationships/${rel.id}`, { contato_ids: [] })).statusCode).toBe(404);

    const repB = (await inj(b, 'POST', '/api/represented', { nome: 'B Rep 2' })).json() as { empresa: { id: number } };
    expect((await inj(a, 'PATCH', `/api/relationships/${rel.id}`,
      { represented_id: repB.empresa.id })).statusCode).toBe(400);
  });

  it('erro de banco no meio da transação -> ROLLBACK e 500 (data inválida)', async () => {
    const cid = await makeCompany();
    const rel = await addRel(a, cid, { notas: 'antes' });
    // '9999-99-99' passa no schema (string) mas estoura no cast ::date do Postgres
    const r = await inj(a, 'PATCH', `/api/relationships/${rel.id}`,
      { notas: 'depois', data_contato: '9999-99-99', contato_ids: [] });
    expect(r.statusCode).toBe(500);
    // rollback: nada foi aplicado
    const list = await inj(a, 'GET', '/api/relationships');
    const mine = (list.json() as { relationships: { id: number; notas: string }[] })
      .relationships.find((x) => x.id === rel.id)!;
    expect(mine.notas).toBe('antes');
  });
});

describe('POST /api/relationships (erro não-unique)', () => {
  it('erro de cast não vira 409 — propaga 500', async () => {
    const cid = await makeCompany();
    const r = await inj(a, 'POST', '/api/relationships', { company_id: cid, data_contato: '9999-99-99' });
    expect(r.statusCode).toBe(500);
  });
});

describe('DELETE + /api/kanban', () => {
  it('delete 404/ok; kanban traz stages e cards com labels org-scoped', async () => {
    const cid = await makeCompany();
    const rep = (await inj(a, 'POST', '/api/represented', { nome: 'Rep Kanban' })).json() as { empresa: { id: number } };
    const rel = await addRel(a, cid, { represented_id: rep.empresa.id });

    const board = await inj(a, 'GET', '/api/kanban');
    const j = board.json() as { stages: unknown[]; cards: { id: number; representada: string | null }[] };
    expect(j.stages.length).toBeGreaterThan(0);
    const card = j.cards.find((c) => c.id === rel.id)!;
    expect(card.representada).toBe('Rep Kanban');

    expect((await inj(b, 'DELETE', `/api/relationships/${rel.id}`)).statusCode).toBe(404);
    expect((await inj(a, 'DELETE', `/api/relationships/${rel.id}`)).statusCode).toBe(200);
  });

  // O card carrega as private labels da EMPRESA (vínculo em private_label_companies)
  // — é o que alimenta o filtro por private label no funil.
  it('card traz as private labels da empresa, org-scoped', async () => {
    const cid = await makeCompany();
    const rel = await addRel(a, cid, {});
    const lbl = (await inj(a, 'POST', '/api/private-labels', { nome: 'Label Funil', cor: '#ff0000' }))
      .json() as { label: { id: number } };
    expect((await inj(a, 'PUT', `/api/companies/${cid}/private-labels`, { label_ids: [lbl.label.id] })).statusCode).toBe(200);

    const j = (await inj(a, 'GET', '/api/kanban')).json() as {
      cards: { id: number; private_labels: { id: number | string; nome: string }[] }[];
    };
    const card = j.cards.find((c) => c.id === rel.id)!;
    expect(card.private_labels.map((l) => l.nome)).toEqual(['Label Funil']);

    // outra org não enxerga o vínculo, mesmo sendo a mesma empresa da base global
    const relB = await addRel(b, cid, {});
    const jb = (await inj(b, 'GET', '/api/kanban')).json() as {
      cards: { id: number; private_labels: unknown[] }[];
    };
    expect(jb.cards.find((c) => c.id === relB.id)!.private_labels).toEqual([]);
  });
});
