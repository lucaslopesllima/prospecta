// Fase 1: tabelas de preço (CRUD, vigência, itens) e pedidos de venda
// (numeração por org, resolução de preço, máquina de estados, permissão por
// vendedor, importação de faturamento CSV). Sempre com teste de isolamento.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, register, bearer, mail, makeCompany, closeAll, type Session } from './helpers.ts';
import { one } from '../src/db.ts';

let app: FastifyInstance;
let a: Session;       // org A (admin)
let b: Session;       // org B (admin, tenta invadir)
let rep: Session;     // vendedor da org A
let repA: number;     // representada da org A
let repB: number;     // representada da org B
let prod1: number;    // catálogo A com preço
let prod2: number;    // catálogo A sem preço
let prodB: number;    // catálogo da org B

const inj = (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown):
  ReturnType<FastifyInstance['inject']> =>
  app.inject({ method, url, headers: bearer(s.token), payload });

beforeAll(async () => {
  app = await makeApp();
  a = await register(app, 'orders.a');
  b = await register(app, 'orders.b');

  // vendedor (rep) na org A
  const email = mail('orders.rep');
  const created = await inj(a, 'POST', '/api/users', { nome: 'Vendedor', email, senha: 'provisoria1' });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, senha: 'provisoria1' } });
  expect(login.statusCode).toBe(200);
  rep = login.json() as Session;

  repA = Number(((await inj(a, 'POST', '/api/represented', { nome: 'Indústria A' })).json() as { empresa: { id: number } }).empresa.id);
  repB = Number(((await inj(b, 'POST', '/api/represented', { nome: 'Indústria B' })).json() as { empresa: { id: number } }).empresa.id);
  prod1 = Number(((await inj(a, 'POST', '/api/catalog', { nome: 'Produto 1', preco: 100 })).json() as { item: { id: number } }).item.id);
  prod2 = Number(((await inj(a, 'POST', '/api/catalog', { nome: 'Produto 2' })).json() as { item: { id: number } }).item.id);
  prodB = Number(((await inj(b, 'POST', '/api/catalog', { nome: 'Produto B', preco: 5 })).json() as { item: { id: number } }).item.id);
});
afterAll(async () => { await closeAll(app); });

interface Table { id: number; nome: string; ativo: boolean; itens: number; items: { catalog_item_id: number | string; preco: string }[] }
interface Order {
  id: number; numero: number; status: string; total: string; frete: string;
  nf_numero: string | null; emitido_em: string | null; faturado_em: string | null;
  owner_user_id: number | string | null; validade: string | null;
  items: { descricao_snapshot: string; total: string; preco_unit: string }[];
}

const mkTable = async (s: Session, extra: Record<string, unknown> = {}): Promise<Table> => {
  const r = await inj(s, 'POST', '/api/price-tables', {
    represented_id: repA, nome: 'Tabela', vigencia_inicio: '2026-01-01', ...extra,
  });
  expect(r.statusCode).toBe(201);
  return (r.json() as { table: Table }).table;
};

describe('price tables: CRUD + itens + isolamento', () => {
  it('cria com itens, lista, detalha e filtra por representada', async () => {
    const t = await mkTable(a, { items: [{ catalog_item_id: prod1, preco: 90, desconto_max_pct: 10 }] });
    expect(t.itens).toBe(1);
    expect(t.items).toHaveLength(1);
    expect(Number(t.items[0]!.preco)).toBe(90);

    const list = (await inj(a, 'GET', `/api/price-tables?represented_id=${repA}`)).json() as { tables: Table[] };
    expect(list.tables.some((x) => Number(x.id) === Number(t.id))).toBe(true);
    const all = (await inj(a, 'GET', '/api/price-tables')).json() as { tables: Table[] };
    expect(all.tables.length).toBeGreaterThan(0);

    const det = await inj(a, 'GET', `/api/price-tables/${t.id}`);
    expect(det.statusCode).toBe(200);
    expect(((det.json() as { table: Table }).table.items)).toHaveLength(1);

    // org B não enxerga nem detalha
    const listB = (await inj(b, 'GET', '/api/price-tables')).json() as { tables: Table[] };
    expect(listB.tables.some((x) => Number(x.id) === Number(t.id))).toBe(false);
    expect((await inj(b, 'GET', `/api/price-tables/${t.id}`)).statusCode).toBe(404);
  });

  it('valida FKs por org: representada e catálogo alheios -> 400', async () => {
    const r1 = await inj(a, 'POST', '/api/price-tables', { represented_id: repB, nome: 'X', vigencia_inicio: '2026-01-01' });
    expect(r1.statusCode).toBe(400);
    const r2 = await inj(a, 'POST', '/api/price-tables', {
      represented_id: repA, nome: 'X', vigencia_inicio: '2026-01-01',
      items: [{ catalog_item_id: prodB, preco: 1 }],
    });
    expect(r2.statusCode).toBe(400);
  });

  it('PATCH campos, 400 vazio, 404 cross-org; PUT items substitui tudo', async () => {
    const t = await mkTable(a);
    expect((await inj(a, 'PATCH', `/api/price-tables/${t.id}`, {})).statusCode).toBe(400);
    expect((await inj(b, 'PATCH', `/api/price-tables/${t.id}`, { nome: 'inv' })).statusCode).toBe(404);
    expect((await inj(a, 'PATCH', `/api/price-tables/${t.id}`, { represented_id: repB })).statusCode).toBe(400);

    const up = await inj(a, 'PATCH', `/api/price-tables/${t.id}`, { nome: 'Nova', ativo: false, vigencia_fim: '2026-12-31' });
    expect(up.statusCode).toBe(200);
    expect((up.json() as { table: Table }).table.nome).toBe('Nova');

    const put = await inj(a, 'PUT', `/api/price-tables/${t.id}/items`, {
      items: [{ catalog_item_id: prod1, preco: 80 }, { catalog_item_id: prod2, preco: 50, desconto_max_pct: 5 }],
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { items: unknown[] }).items).toHaveLength(2);

    const put2 = await inj(a, 'PUT', `/api/price-tables/${t.id}/items`, { items: [{ catalog_item_id: prod2, preco: 55 }] });
    expect((put2.json() as { items: unknown[] }).items).toHaveLength(1);

    expect((await inj(a, 'PUT', `/api/price-tables/${t.id}/items`, { items: [{ catalog_item_id: prodB, preco: 1 }] })).statusCode).toBe(400);
    expect((await inj(b, 'PUT', `/api/price-tables/${t.id}/items`, { items: [] })).statusCode).toBe(404);
  });

  it('active devolve a tabela vigente certa (vigência + ativo) e null sem vigente', async () => {
    const repX = Number(((await inj(a, 'POST', '/api/represented', { nome: 'Vigência' })).json() as { empresa: { id: number } }).empresa.id);
    // expirada, inativa, futura e a vigente
    await inj(a, 'POST', '/api/price-tables', { represented_id: repX, nome: 'Expirada', vigencia_inicio: '2025-01-01', vigencia_fim: '2025-12-31' });
    await inj(a, 'POST', '/api/price-tables', { represented_id: repX, nome: 'Inativa', vigencia_inicio: '2026-01-01', ativo: false });
    await inj(a, 'POST', '/api/price-tables', { represented_id: repX, nome: 'Futura', vigencia_inicio: '2099-01-01' });
    const vigente = await inj(a, 'POST', '/api/price-tables', {
      represented_id: repX, nome: 'Vigente', vigencia_inicio: '2026-01-01',
      items: [{ catalog_item_id: prod1, preco: 77 }],
    });
    const vid = Number(((vigente.json() as { table: Table }).table).id);

    const act = await inj(a, 'GET', `/api/price-tables/active?represented_id=${repX}`);
    expect(act.statusCode).toBe(200);
    const tab = (act.json() as { table: Table | null }).table;
    expect(Number(tab!.id)).toBe(vid);
    expect(tab!.items).toHaveLength(1);

    const repY = Number(((await inj(a, 'POST', '/api/represented', { nome: 'Sem tabela' })).json() as { empresa: { id: number } }).empresa.id);
    const none = await inj(a, 'GET', `/api/price-tables/active?represented_id=${repY}`);
    expect((none.json() as { table: null }).table).toBeNull();
  });

  it('DELETE: cross-org 404, dono apaga', async () => {
    const t = await mkTable(a);
    expect((await inj(b, 'DELETE', `/api/price-tables/${t.id}`)).statusCode).toBe(404);
    expect((await inj(a, 'DELETE', `/api/price-tables/${t.id}`)).statusCode).toBe(200);
    expect((await inj(a, 'GET', `/api/price-tables/${t.id}`)).statusCode).toBe(404);
  });
});

const mkOrder = async (s: Session, extra: Record<string, unknown> = {}): Promise<Order> => {
  const cid = await makeCompany();
  const r = await inj(s, 'POST', '/api/orders', { company_id: cid, represented_id: repA, ...extra });
  expect(r.statusCode).toBe(201);
  return (r.json() as { order: Order }).order;
};

describe('orders: criação, numeração e resolução de preço', () => {
  it('numero é sequencial por org e independente entre orgs', async () => {
    const o1 = await mkOrder(a);
    const o2 = await mkOrder(a);
    expect(o2.numero).toBe(o1.numero + 1);

    const cidB = await makeCompany();
    const oB = await inj(b, 'POST', '/api/orders', { company_id: cidB, represented_id: repB });
    expect((oB.json() as { order: Order }).order.numero).toBe(1);
  });

  it('preço vem da tabela > catálogo; preco_unit explícito vence; total = itens + frete', async () => {
    const t = await mkTable(a, { items: [{ catalog_item_id: prod1, preco: 90, desconto_max_pct: 10 }] });
    const o = await mkOrder(a, {
      price_table_id: Number(t.id),
      frete: 25.5,
      items: [
        { catalog_item_id: prod1, qtd: 2 },                          // 2 × 90 (tabela)
        { catalog_item_id: prod1, qtd: 1, preco_unit: 200 },         // explícito vence
        { descricao: 'Serviço avulso', qtd: 1, preco_unit: 50, desconto_pct: 10, ipi_pct: 5, st_pct: 5 },
      ],
    });
    // 180 + 200 + 50×0.9×1.10 = 180 + 200 + 49.5 = 429.5 + frete 25.5 = 455
    expect(Number(o.total)).toBe(455);
    expect(o.items).toHaveLength(3);
    expect(o.items[0]!.descricao_snapshot).toBe('Produto 1'); // snapshot do catálogo

    // sem tabela: cai no preço do catálogo
    const o2 = await mkOrder(a, { items: [{ catalog_item_id: prod1, qtd: 1 }] });
    expect(Number(o2.total)).toBe(100);
  });

  it('400: item sem preço, sem descrição, catálogo alheio, desconto acima do teto, FK alheia', async () => {
    const cid = await makeCompany();
    const post = (payload: Record<string, unknown>): ReturnType<FastifyInstance['inject']> =>
      inj(a, 'POST', '/api/orders', { company_id: cid, represented_id: repA, ...payload });

    expect((await post({ items: [{ catalog_item_id: prod2, qtd: 1 }] })).statusCode).toBe(400);      // prod2 sem preço
    expect((await post({ items: [{ qtd: 1, preco_unit: 10 }] })).statusCode).toBe(400);              // sem descrição
    expect((await post({ items: [{ catalog_item_id: prodB, qtd: 1, preco_unit: 1 }] })).statusCode).toBe(400);
    expect((await post({ represented_id: repB })).statusCode).toBe(400);
    expect((await post({ price_table_id: 999_999 })).statusCode).toBe(400);

    const t = await mkTable(a, { items: [{ catalog_item_id: prod1, preco: 90, desconto_max_pct: 10 }] });
    const over = await post({ price_table_id: Number(t.id), items: [{ catalog_item_id: prod1, qtd: 1, desconto_pct: 20 }] });
    expect(over.statusCode).toBe(400);
    expect((over.json() as { error: string }).error).toContain('desconto');
  });

  it('400: tabela de preço de outra representada da mesma org (create e patch)', async () => {
    const cid = await makeCompany();
    const repA2 = Number(((await inj(a, 'POST', '/api/represented', { nome: 'Indústria A2' })).json() as { empresa: { id: number } }).empresa.id);
    const tA2 = await mkTable(a, { represented_id: repA2, items: [{ catalog_item_id: prod1, preco: 90 }] });

    // create: pedido da repA com tabela da repA2 → mismatch
    const r = await inj(a, 'POST', '/api/orders', { company_id: cid, represented_id: repA, price_table_id: Number(tA2.id) });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain('representada');

    // patch: pedido válido sem tabela, depois aponta para a tabela divergente → 400
    const ok = await mkOrder(a);
    const patch = await inj(a, 'PATCH', `/api/orders/${ok.id}`, { price_table_id: Number(tA2.id) });
    expect(patch.statusCode).toBe(400);
    expect((patch.json() as { error: string }).error).toContain('representada');

    // patch trocando representada E tabela juntas (coerentes) → ok
    const okMove = await inj(a, 'PATCH', `/api/orders/${ok.id}`, { represented_id: repA2, price_table_id: Number(tA2.id) });
    expect(okMove.statusCode).toBe(200);
  });

  it('GET lista com filtros; GET :id com itens; cross-org 404', async () => {
    const o = await mkOrder(a, { items: [{ catalog_item_id: prod1, qtd: 1 }] });

    const byStatus = (await inj(a, 'GET', '/api/orders?status=rascunho')).json() as {
      orders: Order[]; page: { total: number; aberto: number; faturado: number };
    };
    expect(byStatus.orders.some((x) => Number(x.id) === Number(o.id))).toBe(true);
    expect(byStatus.page.total).toBeGreaterThanOrEqual(1);
    expect(byStatus.page.aberto).toBeGreaterThanOrEqual(0);
    const byRepr = (await inj(a, 'GET', `/api/orders?represented_id=${repA}&owner_user_id=${a.user.id}&from=2026-01-01&to=2099-01-01`)).json() as { orders: Order[] };
    expect(byRepr.orders.some((x) => Number(x.id) === Number(o.id))).toBe(true);
    const none = (await inj(a, 'GET', '/api/orders?status=entregue')).json() as { orders: Order[] };
    expect(none.orders.some((x) => Number(x.id) === Number(o.id))).toBe(false);

    const det = await inj(a, 'GET', `/api/orders/${o.id}`);
    expect(det.statusCode).toBe(200);
    expect((det.json() as { order: Order }).order.items).toHaveLength(1);
    expect((await inj(b, 'GET', `/api/orders/${o.id}`)).statusCode).toBe(404);

    // org B não lista pedidos da org A
    const listB = (await inj(b, 'GET', '/api/orders')).json() as { orders: Order[] };
    expect(listB.orders.some((x) => Number(x.id) === Number(o.id))).toBe(false);
  });
});

describe('orders: edição e permissão por vendedor', () => {
  it('PATCH cabeçalho + itens recalcula total; 400 vazio; 404 cross-org', async () => {
    const o = await mkOrder(a, { items: [{ catalog_item_id: prod1, qtd: 1 }] });
    expect((await inj(a, 'PATCH', `/api/orders/${o.id}`, {})).statusCode).toBe(400);
    expect((await inj(b, 'PATCH', `/api/orders/${o.id}`, { frete: 1 })).statusCode).toBe(404);
    expect((await inj(a, 'PATCH', `/api/orders/${o.id}`, { represented_id: repB })).statusCode).toBe(400);
    expect((await inj(a, 'PATCH', `/api/orders/${o.id}`, { items: [{ qtd: 1, preco_unit: 5 }] })).statusCode).toBe(400); // sem descrição

    const up = await inj(a, 'PATCH', `/api/orders/${o.id}`, {
      frete: 10, observacoes: 'obs',
      items: [{ descricao: 'Item novo', qtd: 3, preco_unit: 20 }],
    });
    expect(up.statusCode).toBe(200);
    const upd = (up.json() as { order: Order }).order;
    expect(Number(upd.total)).toBe(70); // 60 + 10 frete
    expect(upd.items).toHaveLength(1);

    // só frete (sem itens) também recalcula
    const up2 = await inj(a, 'PATCH', `/api/orders/${o.id}`, { frete: 0 });
    expect(Number((up2.json() as { order: Order }).order.total)).toBe(60);
  });

  it('vendedor edita o próprio rascunho, não o alheio; pedido enviado é imutável', async () => {
    const cid = await makeCompany();
    const own = await inj(rep, 'POST', '/api/orders', {
      company_id: cid, represented_id: repA, items: [{ descricao: 'X', qtd: 1, preco_unit: 10 }],
    });
    expect(own.statusCode).toBe(201);
    const mine = (own.json() as { order: Order }).order;
    expect(Number(mine.owner_user_id)).toBe(Number(rep.user.id));

    expect((await inj(rep, 'PATCH', `/api/orders/${mine.id}`, { observacoes: 'minha' })).statusCode).toBe(200);

    const adminOrder = await mkOrder(a);
    expect((await inj(rep, 'PATCH', `/api/orders/${adminOrder.id}`, { observacoes: 'inv' })).statusCode).toBe(403);
    expect((await inj(rep, 'POST', `/api/orders/${adminOrder.id}/transition`, { status: 'enviado' })).statusCode).toBe(403);
    expect((await inj(rep, 'DELETE', `/api/orders/${adminOrder.id}`)).statusCode).toBe(403);
    // admin mexe no pedido do vendedor
    expect((await inj(a, 'PATCH', `/api/orders/${mine.id}`, { observacoes: 'do admin' })).statusCode).toBe(200);

    await inj(a, 'POST', `/api/orders/${mine.id}/transition`, { status: 'enviado' });
    expect((await inj(rep, 'PATCH', `/api/orders/${mine.id}`, { observacoes: 'tarde' })).statusCode).toBe(409);
  });
});

describe('orders: máquina de estados', () => {
  it('cotação → rascunho → enviado → faturado (NF) → entregue; timestamps e auditoria', async () => {
    const o = await mkOrder(a, { status: 'cotacao', validade: '2026-12-31', items: [{ catalog_item_id: prod1, qtd: 2 }] });
    expect(o.status).toBe('cotacao');
    expect(o.validade).not.toBeNull();

    expect((await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'faturado' })).statusCode).toBe(409);

    const r1 = (await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'rascunho' })).json() as { order: Order };
    expect(r1.order.status).toBe('rascunho');
    const r2 = (await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'enviado' })).json() as { order: Order };
    expect(r2.order.emitido_em).not.toBeNull();
    const r3 = (await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'faturado', nf_numero: 'NF-123' })).json() as { order: Order };
    expect(r3.order.nf_numero).toBe('NF-123');
    expect(r3.order.faturado_em).not.toBeNull();
    expect(Number(r3.order.total)).toBe(200); // total bate com a soma dos itens

    // sem voltar de faturado
    expect((await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'enviado' })).statusCode).toBe(409);
    const r4 = (await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'entregue' })).json() as { order: Order };
    expect(r4.order.status).toBe('entregue');
    expect((await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'cancelado' })).statusCode).toBe(409);

    const competencia = r3.order.faturado_em!.slice(0, 7);
    const realized = (await inj(a, 'GET', `/api/orders?status_group=realizado&competencia=${competencia}`)).json() as {
      orders: Order[]; page: { total: number; faturado: number };
    };
    expect(realized.orders.some((x) => Number(x.id) === Number(o.id))).toBe(true);
    expect(realized.page.total).toBeGreaterThanOrEqual(1);
    expect(realized.page.faturado).toBeGreaterThanOrEqual(200);
    expect((await inj(a, 'GET', '/api/orders?competencia=2026-99')).statusCode).toBe(400);

    const trilha = await one<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE entity = 'order' AND entity_id = $1 AND action = 'transition'",
      [Number(o.id)],
    );
    expect(Number(trilha!.n)).toBe(4);
  });

  it('cancelado vale de qualquer status não-terminal; 404 cross-org', async () => {
    const o = await mkOrder(a);
    expect((await inj(b, 'POST', `/api/orders/${o.id}/transition`, { status: 'cancelado' })).statusCode).toBe(404);
    const r = await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'cancelado' });
    expect((r.json() as { order: Order }).order.status).toBe('cancelado');
    expect((await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'rascunho' })).statusCode).toBe(409);
  });

  it('DELETE só em rascunho/cotação; enviado exige cancelar; cross-org 404', async () => {
    const o = await mkOrder(a);
    expect((await inj(b, 'DELETE', `/api/orders/${o.id}`)).statusCode).toBe(404);
    await inj(a, 'POST', `/api/orders/${o.id}/transition`, { status: 'enviado' });
    expect((await inj(a, 'DELETE', `/api/orders/${o.id}`)).statusCode).toBe(409);
    const o2 = await mkOrder(a);
    expect((await inj(a, 'DELETE', `/api/orders/${o2.id}`)).statusCode).toBe(200);
    expect((await inj(a, 'GET', `/api/orders/${o2.id}`)).statusCode).toBe(404);
  });
});

describe('orders: importação de faturamento (CSV)', () => {
  it('match por CNPJ + valor marca faturado com NF; sem match e linha ruim viram motivo', async () => {
    const cid = await makeCompany();
    const cnpj = (await one<{ cnpj: string }>('SELECT cnpj FROM companies WHERE id = $1', [cid]))!.cnpj;
    const o = await inj(a, 'POST', '/api/orders', {
      company_id: cid, represented_id: repA,
      items: [{ descricao: 'Item', qtd: 1, preco_unit: 1234.56 }],
    });
    const order = (o.json() as { order: Order }).order;
    await inj(a, 'POST', `/api/orders/${order.id}/transition`, { status: 'enviado' });

    const csv = [
      'nf;data;cliente cnpj;valor',
      `NF-1;01/06/2026;${cnpj};1.234,56`,
      `NF-2;2026-06-02;00000000000000;10,00`,
      ';;;',
    ].join('\n');
    const r = await inj(a, 'POST', '/api/orders/import', { csv });
    expect(r.statusCode).toBe(200);
    const res = r.json() as { processadas: number; faturadas: number; results: { order_id: number | null; motivo?: string }[] };
    expect(res.processadas).toBe(3);
    expect(res.faturadas).toBe(1);
    expect(Number(res.results[0]!.order_id)).toBe(Number(order.id));
    expect(res.results[1]!.motivo).toContain('sem pedido');
    expect(res.results[2]!.motivo).toBe('linha inválida');

    const after = (await inj(a, 'GET', `/api/orders/${order.id}`)).json() as { order: Order };
    expect(after.order.status).toBe('faturado');
    expect(after.order.nf_numero).toBe('NF-1');
    expect(after.order.faturado_em).toContain('2026-06-01');
  });

  it('duas linhas iguais consomem pedidos distintos; delimitador vírgula; só admin importa', async () => {
    const cid = await makeCompany();
    const cnpj = (await one<{ cnpj: string }>('SELECT cnpj FROM companies WHERE id = $1', [cid]))!.cnpj;
    const mk = async (): Promise<Order> => {
      const r = await inj(a, 'POST', '/api/orders', {
        company_id: cid, represented_id: repA, items: [{ descricao: 'I', qtd: 1, preco_unit: 500 }],
      });
      const ord = (r.json() as { order: Order }).order;
      await inj(a, 'POST', `/api/orders/${ord.id}/transition`, { status: 'enviado' });
      return ord;
    };
    const o1 = await mk();
    const o2 = await mk();

    const csv = `nf,data,cnpj,valor\nA1,2026-06-10,${cnpj},500\nA2,2026-06-11,${cnpj},500`;
    const r = await inj(a, 'POST', '/api/orders/import', { csv });
    const res = r.json() as { faturadas: number; results: { order_id: number | null }[] };
    expect(res.faturadas).toBe(2);
    expect(new Set(res.results.map((x) => Number(x.order_id))).size).toBe(2);
    expect([Number(o1.id), Number(o2.id)].sort()).toEqual(res.results.map((x) => Number(x.order_id)).sort());

    expect((await inj(a, 'POST', '/api/orders/import', { csv: 'foo;bar\n1;2' })).statusCode).toBe(400);
    expect((await inj(rep, 'POST', '/api/orders/import', { csv })).statusCode).toBe(403);
  });
});

// Erro de banco no meio da transação (overflow numeric) precisa fazer ROLLBACK
// e propagar 500 — sem deixar pedido/itens órfãos.
describe('orders/price-tables: ROLLBACK em erro de transação', () => {
  const OVERFLOW = 1e15; // estoura numeric(16,2) (máx 14 dígitos inteiros)
  let company: number;
  beforeAll(async () => { company = await makeCompany(); await inj(a, 'POST', '/api/relationships', { company_id: company }); });

  it('create: item com preço gigante -> overflow -> ROLLBACK 500, sem pedido criado', async () => {
    const antes = (await inj(a, 'GET', '/api/orders')).json() as { orders: { id: number }[] };
    const r = await inj(a, 'POST', '/api/orders', {
      company_id: company, represented_id: repA,
      items: [{ descricao: 'Estouro', qtd: 1, preco_unit: OVERFLOW }],
    });
    expect(r.statusCode).toBe(500);
    const depois = (await inj(a, 'GET', '/api/orders')).json() as { orders: { id: number }[] };
    expect(depois.orders.length).toBe(antes.orders.length); // rollback: nada criado
  });

  it('update: PATCH com price_table_id + itens válidos, depois itens com overflow -> ROLLBACK 500', async () => {
    const ok = await inj(a, 'POST', '/api/orders', {
      company_id: company, represented_id: repA,
      items: [{ descricao: 'Normal', qtd: 1, preco_unit: 10 }],
    });
    const id = Number((ok.json() as { order: { id: number } }).order.id);

    // cobre o ramo price_table_id presente no PATCH + recálculo
    const upd = await inj(a, 'PATCH', `/api/orders/${id}`, {
      price_table_id: null, items: [{ descricao: 'Dois', qtd: 2, preco_unit: 30 }],
    });
    expect(upd.statusCode).toBe(200);
    expect(Number((upd.json() as { order: { total: string } }).order.total)).toBe(60);

    const boom = await inj(a, 'PATCH', `/api/orders/${id}`, {
      items: [{ descricao: 'Estouro', qtd: 1, preco_unit: OVERFLOW }],
    });
    expect(boom.statusCode).toBe(500);
    // pedido intacto (itens antigos preservados pelo rollback)
    const after = (await inj(a, 'GET', `/api/orders/${id}`)).json() as { order: { total: string } };
    expect(Number(after.order.total)).toBe(60);
  });

  it('price-tables replaceItems: preço gigante -> overflow -> ROLLBACK 500', async () => {
    const t = await mkTable(a);
    const r = await inj(a, 'PUT', `/api/price-tables/${t.id}/items`, {
      items: [{ catalog_item_id: prod1, preco: 1e15 }],
    });
    expect(r.statusCode).toBe(500);
    // tabela continua sem itens (rollback)
    const det = (await inj(a, 'GET', `/api/price-tables/${t.id}`)).json() as { table: { items: unknown[] } };
    expect(det.table.items.length).toBe(0);
  });
});
