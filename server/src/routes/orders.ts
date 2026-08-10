import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query, one, withClient } from '../db.ts';
import { requireAuth, requirePermission } from '../auth.ts';
import { audit, pick } from '../audit.ts';
import { invalidOrgRef } from '../orgRefs.ts';
import { scopeOwner } from '../scope.ts';
import { createCommissionForOrder, cancelCommissionForOrder } from '../commissions.ts';
import { orgTaxDefaults, TAX_FIELDS } from './tax.ts';

type TaxField = (typeof TAX_FIELDS)[number];

// Pedidos de venda (Fase 1). Cotação = pedido com status='cotacao' + validade;
// conversão é transição de status. Total SEMPRE recalculado server-side a
// partir dos itens — o client não manda total. Itens guardam snapshot de
// descrição/preço: catálogo e tabela de preço mudam, pedido emitido não.

const SELECT = `
  SELECT o.id, o.numero, o.relationship_id, o.company_id, o.represented_id,
         o.owner_user_id, o.price_table_id, o.status, o.validade,
         o.condicao_pagamento, o.transportadora, o.carrier_id, o.frete, o.observacoes, o.total,
         o.nf_numero, o.emitido_em, o.faturado_em, o.created_at, o.updated_at, o.contact_id,
         c.razao_social AS company_nome, c.cnpj AS company_cnpj,
         r.nome AS represented_nome,
         u.email AS owner_email, u.nome AS owner_nome,
         tc.nome AS carrier_nome,
         ct.nome AS contact_nome
  FROM orders o
  JOIN companies c ON c.id = o.company_id
  JOIN represented_companies r ON r.id = o.represented_id
  LEFT JOIN users u ON u.id = o.owner_user_id
  LEFT JOIN carriers tc ON tc.id = o.carrier_id
  LEFT JOIN contacts ct ON ct.id = o.contact_id`;

// Campos de cabeçalho editáveis (POST e PATCH).
const FIELDS = ['relationship_id', 'company_id', 'represented_id', 'price_table_id',
  'validade', 'condicao_pagamento', 'transportadora', 'carrier_id', 'frete', 'observacoes', 'contact_id'] as const;

// Máquina de estados: fluxo feliz cotacao→rascunho→enviado→faturado→entregue;
// cancelado de qualquer status não-terminal; sem voltar de faturado.
const TRANSITIONS: Record<string, string[]> = {
  cotacao: ['rascunho', 'cancelado'],
  rascunho: ['enviado', 'cancelado'],
  enviado: ['faturado', 'cancelado'],
  faturado: ['entregue', 'cancelado'],
  entregue: [],
  cancelado: [],
};

// Só rascunho/cotação são editáveis — depois de enviado o pedido é imutável
// (exceto transições de status).
const EDITABLE = new Set(['cotacao', 'rascunho']);

// Total do pedido = soma crua dos itens (numeric, sem arredondar) + frete.
// Sempre recalculado no banco a partir de order_items.total (coluna GENERATED).
const RECOMPUTE_TOTAL =
  `UPDATE orders SET total = COALESCE((SELECT SUM(total) FROM order_items WHERE order_id = $1), 0) + frete,
     updated_at = now() WHERE id = $1`;

const ITEM_SCHEMA = {
  type: 'object',
  required: ['qtd'],
  properties: {
    catalog_item_id: { type: ['integer', 'null'] },
    descricao: { type: ['string', 'null'] },
    unidade_medida: { type: ['string', 'null'] },
    qtd: { type: 'number', exclusiveMinimum: 0 },
    preco_unit: { type: ['number', 'null'], minimum: 0 },
    desconto_pct: { type: 'number', minimum: 0, maximum: 100 },
    icms_pct: { type: 'number', minimum: 0, maximum: 100 },
    ipi_pct: { type: 'number', minimum: 0, maximum: 100 },
    st_pct: { type: 'number', minimum: 0, maximum: 100 },
    pis_pct: { type: 'number', minimum: 0, maximum: 100 },
    cofins_pct: { type: 'number', minimum: 0, maximum: 100 },
    iss_pct: { type: 'number', minimum: 0, maximum: 100 },
  },
} as const;

const HEADER_PROPS = {
  relationship_id: { type: ['integer', 'null'] },
  company_id: { type: 'integer' },
  represented_id: { type: 'integer' },
  price_table_id: { type: ['integer', 'null'] },
  validade: { type: ['string', 'null'] },
  condicao_pagamento: { type: ['string', 'null'] },
  transportadora: { type: ['string', 'null'] },
  carrier_id: { type: ['integer', 'null'] },
  frete: { type: 'number', minimum: 0 },
  observacoes: { type: ['string', 'null'] },
  contact_id: { type: ['integer', 'null'] },
} as const;

// Impostos copiados por item. Alíquota ausente no payload cai no default da org.
interface ItemInput {
  catalog_item_id?: number | null;
  descricao?: string | null;
  unidade_medida?: string | null;
  qtd: number;
  preco_unit?: number | null;
  desconto_pct?: number;
  icms_pct?: number;
  ipi_pct?: number;
  st_pct?: number;
  pis_pct?: number;
  cofins_pct?: number;
  iss_pct?: number;
}

interface ResolvedItem {
  catalog_item_id: number | null;
  descricao_snapshot: string;
  unidade_medida_snapshot: string | null;
  qtd: number;
  // preço cru: número do payload OU string vinda do banco (numeric). Mantido sem
  // Number() pra não passar por float — o cálculo do total é feito no banco.
  preco_unit: number | string;
  desconto_pct: number;
  icms_pct: number;
  ipi_pct: number;
  st_pct: number;
  pis_pct: number;
  cofins_pct: number;
  iss_pct: number;
}

// Resolve itens do payload: preço explícito > tabela de preço > catálogo;
// descrição explícita > nome do catálogo. Valida teto de desconto da tabela.
// Retorna string de erro ou a lista pronta para INSERT.
async function resolveItems(
  orgId: number,
  priceTableId: number | null,
  items: ItemInput[],
): Promise<string | ResolvedItem[]> {
  const catIds = items.map((i) => i.catalog_item_id).filter((v): v is number => v != null);
  // preço guardado como string crua (numeric do banco) — sem Number(), pra não
  // introduzir float. O total é calculado no banco (coluna GENERATED).
  const catalog = new Map<number, { nome: string; preco: string | null; unidade_medida: string | null; tax: Record<TaxField, string | null> }>();
  if (catIds.length > 0) {
    const rows = await query<Record<string, string | null> & { id: string; nome: string; preco: string | null }>(
      `SELECT id, nome, preco, unidade_medida, ${TAX_FIELDS.join(', ')} FROM catalog_items WHERE org_id = $1 AND id = ANY($2)`,
      [orgId, catIds],
    );
    for (const r of rows) catalog.set(Number(r.id), {
      nome: r.nome, preco: r.preco, unidade_medida: r.unidade_medida ?? null,
      tax: Object.fromEntries(TAX_FIELDS.map((k) => [k, r[k]])) as Record<TaxField, string | null>,
    });
  }
  const tablePrices = new Map<number, { preco: string; desconto_max_pct: number | null }>();
  if (priceTableId != null) {
    const rows = await query<{ catalog_item_id: string; preco: string; desconto_max_pct: string | null }>(
      'SELECT catalog_item_id, preco, desconto_max_pct FROM price_table_items WHERE price_table_id = $1',
      [priceTableId],
    );
    for (const r of rows) {
      tablePrices.set(Number(r.catalog_item_id), {
        preco: r.preco,
        // só usado p/ comparar com o desconto pedido (validação), não entra em cálculo gravado.
        desconto_max_pct: r.desconto_max_pct === null ? null : Number(r.desconto_max_pct),
      });
    }
  }

  // alíquotas: explícito no item > produto (se o produto define ALGUM imposto) >
  // default da org. Produto sem nenhum imposto definido cai inteiro no default.
  // A UI já preenche; este fallback cobre API/import. Explícito 0 permanece 0.
  const taxDef = await orgTaxDefaults(orgId);

  const out: ResolvedItem[] = [];
  for (const it of items) {
    const cat = it.catalog_item_id != null ? catalog.get(it.catalog_item_id) : undefined;
    if (it.catalog_item_id != null && !cat) return 'catalog_item_id inválido';
    const fromTable = it.catalog_item_id != null ? tablePrices.get(it.catalog_item_id) : undefined;
    const preco = it.preco_unit ?? fromTable?.preco ?? cat?.preco ?? null;
    if (preco == null) return 'item sem preço (informe preco_unit ou use item do mostruário/tabela com preço)';
    const descricao = it.descricao ?? cat?.nome ?? null;
    if (descricao == null) return 'item sem descrição (informe descricao ou catalog_item_id)';
    const desconto = it.desconto_pct ?? 0;
    if (fromTable?.desconto_max_pct != null && desconto > fromTable.desconto_max_pct) {
      return `desconto acima do máximo da tabela (${fromTable.desconto_max_pct}%)`;
    }
    // produto define imposto? então é a base; senão usa o default da org.
    const prodHasTax = cat != null && TAX_FIELDS.some((k) => cat.tax[k] != null);
    const tax = Object.fromEntries(TAX_FIELDS.map((k) => [k,
      it[k] ?? (prodHasTax ? Number(cat!.tax[k] ?? 0) : (taxDef[k] ?? 0)),
    ])) as Record<TaxField, number>;
    // unidade respeita o cadastro do produto; item livre pode informar no payload.
    const unidade = it.unidade_medida ?? cat?.unidade_medida ?? null;
    out.push({
      catalog_item_id: it.catalog_item_id ?? null,
      descricao_snapshot: descricao,
      unidade_medida_snapshot: unidade,
      qtd: it.qtd,
      preco_unit: preco,
      desconto_pct: desconto,
      ...tax,
    });
  }
  return out;
}

const orderItems = (orderId: number): Promise<unknown[]> => query(
  `SELECT id, catalog_item_id, descricao_snapshot, unidade_medida_snapshot, qtd, preco_unit, desconto_pct,
          icms_pct, ipi_pct, st_pct, pis_pct, cofins_pct, iss_pct, total
   FROM order_items WHERE order_id = $1 ORDER BY id`,
  [orderId],
);

async function fullOrder(orderId: number): Promise<Record<string, unknown>> {
  const order = await one<Record<string, unknown>>(`${SELECT} WHERE o.id = $1`, [orderId]);
  return { ...order!, items: await orderItems(orderId) };
}

// Vendedor só mexe no pedido próprio; admin em todos (visibilidade plena de
// carteira é a Fase 3 — aqui só a regra de escrita).
const canWrite = (req: FastifyRequest, ownerUserId: number | null): boolean =>
  req.auth!.role === 'admin' || ownerUserId === req.auth!.userId;

interface OrderRow {
  id: number; status: string; owner_user_id: string | null;
  price_table_id: string | null; represented_id: string | null; frete: string; numero: number;
}

const findOrder = (id: number, orgId: number): Promise<OrderRow | null> =>
  one<OrderRow>('SELECT id, status, owner_user_id, price_table_id, represented_id, frete, numero FROM orders WHERE id = $1 AND org_id = $2', [id, orgId]);

// Integridade: a tabela de preço escolhida tem de ser global (sem representada)
// ou da MESMA representada do pedido — senão aplicaria preços/teto de desconto
// da representada errada. org já validado por invalidOrgRef; aqui só a representada.
async function priceTableMismatch(orgId: number, priceTableId: number | null, representedId: number | null): Promise<boolean> {
  if (priceTableId == null || representedId == null) return false;
  const pt = await one<{ represented_id: string | null }>(
    'SELECT represented_id FROM price_tables WHERE id = $1 AND org_id = $2', [priceTableId, orgId],
  );
  return !!pt && pt.represented_id !== null && Number(pt.represented_id) !== Number(representedId);
}

// Escapa para interpolar com segurança no HTML do print (sem libs de template).
const esc = (v: unknown): string => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const brl = (n: unknown): string =>
  Number(n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STATUS_LABEL: Record<string, string> = {
  cotacao: 'Cotação', rascunho: 'Rascunho', enviado: 'Pedido', faturado: 'Pedido faturado',
  entregue: 'Pedido entregue', cancelado: 'Cancelado',
};

interface OrgHeader {
  nome: string; cnpj: string | null; telefone: string | null;
  logradouro: string | null; numero: string | null; bairro: string | null;
  cidade: string | null; uf: string | null; cep: string | null;
}

// Monta o HTML do pedido/cotação (papel timbrado da org + itens + condições).
// Dependency-free: o client abre numa aba e usa window.print() → PDF.
function orderHtml(org: OrgHeader, order: Record<string, unknown>, items: Record<string, unknown>[]): string {
  const isCotacao = order.status === 'cotacao';
  const titulo = isCotacao ? 'Cotação' : (STATUS_LABEL[String(order.status)] ?? 'Pedido');
  const endereco = [org.logradouro, org.numero, org.bairro, org.cidade && `${org.cidade}/${org.uf ?? ''}`, org.cep]
    .filter(Boolean).map(esc).join(', ');
  const rows = items.map((it, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.descricao_snapshot)}</td>
        <td class="r">${esc(it.qtd)}</td>
        <td class="u">${esc(it.unidade_medida_snapshot ?? '')}</td>
        <td class="r">${brl(it.preco_unit)}</td>
        <td class="r">${Number(it.desconto_pct ?? 0)}%</td>
        <td class="r">${brl(it.total)}</td>
      </tr>`).join('');
  const validade = order.validade ? `<p><strong>Validade:</strong> ${esc(order.validade)}</p>` : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>${titulo} nº ${esc(order.numero)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 13px/1.5 system-ui, sans-serif; color: #1a1a2e; margin: 32px; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #4f46e5; padding-bottom: 16px; margin-bottom: 24px; }
  .org h1 { margin: 0 0 4px; font-size: 18px; }
  .org p { margin: 1px 0; font-size: 11px; color: #555; }
  .doc { text-align: right; }
  .doc h2 { margin: 0; font-size: 20px; color: #4f46e5; }
  .doc p { margin: 2px 0; font-size: 12px; }
  .meta { display: flex; gap: 32px; margin-bottom: 20px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th, td { padding: 7px 9px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f3f4f6; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  td.r, th.r { text-align: right; } td.c, th.c { text-align: center; width: 28px; }
  td.u, th.u { text-align: center; white-space: nowrap; }
  tfoot td { font-weight: 700; font-size: 15px; border-top: 2px solid #4f46e5; border-bottom: none; }
  .cond { font-size: 12px; color: #444; }
  @media print { body { margin: 0; } @page { margin: 16mm; } }
</style></head><body>
<header>
  <div class="org">
    <h1>${esc(org.nome)}</h1>
    ${org.cnpj ? `<p>CNPJ: ${esc(org.cnpj)}</p>` : ''}
    ${endereco ? `<p>${endereco}</p>` : ''}
    ${org.telefone ? `<p>Tel: ${esc(org.telefone)}</p>` : ''}
  </div>
  <div class="doc">
    <h2>${titulo}</h2>
    <p>Nº ${esc(order.numero)}</p>
    ${validade}
  </div>
</header>
<div class="meta">
  <div>
    <strong>Cliente</strong><br>${esc(order.company_nome)}<br>
    <span style="color:#666">${esc(order.company_cnpj)}</span>
  </div>
  <div><strong>Representada</strong><br>${esc(order.represented_nome)}</div>
  <div><strong>Vendedor</strong><br>${esc(order.owner_nome ?? order.owner_email ?? '—')}</div>
</div>
<table>
  <thead><tr><th class="c">#</th><th>Descrição</th><th class="r">Qtd</th><th class="u">Un.</th>
    <th class="r">Preço</th><th class="r">Desc.</th><th class="r">Total</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="6" class="r">Total${Number(order.frete ?? 0) > 0 ? ` (frete ${brl(order.frete)})` : ''}</td>
    <td class="r">${brl(order.total)}</td></tr></tfoot>
</table>
<div class="cond">
  ${order.condicao_pagamento ? `<p><strong>Pagamento:</strong> ${esc(order.condicao_pagamento)}</p>` : ''}
  ${order.transportadora || order.carrier_nome ? `<p><strong>Transporte:</strong> ${esc(order.carrier_nome ?? order.transportadora)}</p>` : ''}
  ${order.nf_numero ? `<p><strong>NF:</strong> ${esc(order.nf_numero)}</p>` : ''}
  ${order.observacoes ? `<p><strong>Observações:</strong> ${esc(order.observacoes)}</p>` : ''}
</div>
</body></html>`;
}

export function orderRoutes(app: FastifyInstance): void {
  app.get('/api/orders', {
    preHandler: [requireAuth, requirePermission('orders.list')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: Object.keys(TRANSITIONS) },
          status_group: { type: 'string', enum: ['realizado'] },
          competencia: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
          represented_id: { type: 'integer' },
          owner_user_id: { type: 'integer' },
          q: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const q = req.query as {
      status?: string; status_group?: 'realizado'; competencia?: string; represented_id?: number; owner_user_id?: number;
      q?: string; from?: string; to?: string; limit?: number; offset?: number;
    };
    const { limit = 100, offset = 0 } = q;
    const where: string[] = ['o.org_id = $1'];
    const params: unknown[] = [orgId];
    scopeOwner(req, where, params, 'o.owner_user_id', q.owner_user_id);
    if (q.status) { params.push(q.status); where.push(`o.status = $${params.length}::order_status`); }
    if (q.status_group === 'realizado') where.push("o.status IN ('faturado','entregue')");
    if (q.competencia) {
      params.push(`${q.competencia}-01`);
      where.push(`date_trunc('month', o.faturado_em) = $${params.length}::date`);
    }
    if (q.represented_id !== undefined) { params.push(q.represented_id); where.push(`o.represented_id = $${params.length}`); }
    // Filtro por empresa (cliente): só dígitos vira prefixo de CNPJ; senão ILIKE
    // em razão/fantasia (mesma lógica de /api/companies/search).
    const term = q.q?.trim();
    if (term) {
      const digits = term.replace(/\D/g, '');
      if (digits.length >= 4 && !/[a-zA-Z]/.test(term)) {
        params.push(`${digits}%`);
        where.push(`c.cnpj LIKE $${params.length}`);
      } else {
        params.push(term);
        where.push(`(c.razao_social ILIKE '%' || $${params.length} || '%' OR c.nome_fantasia ILIKE '%' || $${params.length} || '%')`);
      }
    }
    if (q.from) { params.push(q.from); where.push(`o.created_at >= $${params.length}`); }
    if (q.to) { params.push(q.to); where.push(`o.created_at < ($${params.length}::date + 1)`); }
    const aggregateParams = [...params];
    params.push(limit); const limIdx = params.length;
    params.push(offset); const offIdx = params.length;
    const [orders, aggregate] = await Promise.all([
      query(
        `${SELECT} WHERE ${where.join(' AND ')} ORDER BY o.numero DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        params,
      ),
      one<{ total: number; aberto: string; faturado: string }>(
        `SELECT count(*)::int AS total,
                COALESCE(sum(o.total) FILTER (
                  WHERE o.status NOT IN ('faturado','entregue','cancelado')
                ), 0) AS aberto,
                COALESCE(sum(o.total) FILTER (
                  WHERE o.status IN ('faturado','entregue')
                ), 0) AS faturado
         FROM orders o
         JOIN companies c ON c.id = o.company_id
         WHERE ${where.join(' AND ')}`,
        aggregateParams,
      ),
    ]);
    return {
      orders,
      page: {
        total: aggregate?.total ?? 0,
        aberto: Number(aggregate?.aberto ?? 0),
        faturado: Number(aggregate?.faturado ?? 0),
      },
    };
  });

  app.get('/api/orders/:id', {
    preHandler: [requireAuth, requirePermission('orders.read')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const order = await findOrder(id, orgId);
    if (!order) return reply.code(404).send({ error: 'não encontrado' });
    // rep não lê pedido de outro vendedor (404 não vaza existência).
    if (!canWrite(req, order.owner_user_id === null ? null : Number(order.owner_user_id))) {
      return reply.code(404).send({ error: 'não encontrado' });
    }
    return { order: await fullOrder(id) };
  });

  // HTML do pedido/cotação para impressão/PDF (Fase 6.2). Devolve { html } e o
  // client abre numa aba + window.print(); evita dependência de gerador de PDF.
  app.get('/api/orders/:id/print', {
    preHandler: [requireAuth, requirePermission('orders.print')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const order = await findOrder(id, orgId);
    if (!order) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWrite(req, order.owner_user_id === null ? null : Number(order.owner_user_id))) {
      return reply.code(404).send({ error: 'não encontrado' });
    }
    const org = await one<OrgHeader>(
      `SELECT nome, cnpj, telefone, logradouro, numero, bairro, cidade, uf, cep
       FROM organizations WHERE id = $1`, [orgId],
    );
    const full = await fullOrder(id);
    return { html: orderHtml(org!, full, (full.items as Record<string, unknown>[]) ?? []) };
  });

  app.post('/api/orders', {
    preHandler: [requireAuth, requirePermission('orders.create')],
    schema: {
      body: {
        type: 'object',
        required: ['company_id', 'represented_id'],
        properties: {
          ...HEADER_PROPS,
          status: { type: 'string', enum: ['cotacao', 'rascunho'] },
          items: { type: 'array', items: ITEM_SCHEMA },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const b = req.body as Record<string, unknown> & { items?: ItemInput[]; status?: string };
    const badRef = await invalidOrgRef(orgId, b, ['represented_id', 'relationship_id', 'price_table_id', 'carrier_id', 'contact_id']);
    if (badRef) return reply.code(400).send({ error: `${badRef} inválido` });
    if (await priceTableMismatch(orgId, (b.price_table_id as number | undefined) ?? null, Number(b.represented_id))) {
      return reply.code(400).send({ error: 'tabela de preço não pertence à representada do pedido' });
    }
    const resolved = await resolveItems(orgId, (b.price_table_id as number | undefined) ?? null, b.items ?? []);
    if (typeof resolved === 'string') return reply.code(400).send({ error: resolved });
    const frete = (b.frete as number | undefined) ?? 0;

    const newId = await withClient(async (c) => {
      await c.query('BEGIN');
      try {
        // numero sequencial por org: lock por org serializa o MAX+1 — sem isso
        // duas criações simultâneas colidem no UNIQUE(org_id, numero).
        await c.query('SELECT pg_advisory_xact_lock(42, $1)', [orgId]);
        const res = await c.query(
          `INSERT INTO orders (org_id, numero, relationship_id, company_id, represented_id,
             owner_user_id, price_table_id, status, validade, condicao_pagamento,
             transportadora, carrier_id, frete, observacoes, contact_id)
           VALUES ($1, (SELECT COALESCE(MAX(numero),0)+1 FROM orders WHERE org_id = $1),
                   $2, $3, $4, $5, $6, COALESCE($7,'rascunho')::order_status,
                   $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [orgId, b.relationship_id ?? null, b.company_id, b.represented_id,
            req.auth!.userId, b.price_table_id ?? null, b.status ?? null,
            b.validade ?? null, b.condicao_pagamento ?? null, b.transportadora ?? null,
            b.carrier_id ?? null, frete, b.observacoes ?? null, b.contact_id ?? null],
        );
        const id = Number(res.rows[0].id);
        for (const it of resolved) {
          // total NÃO entra no INSERT — é coluna GENERATED (calculada no banco).
          await c.query(
            `INSERT INTO order_items (order_id, catalog_item_id, descricao_snapshot, unidade_medida_snapshot, qtd,
               preco_unit, desconto_pct, icms_pct, ipi_pct, st_pct, pis_pct, cofins_pct, iss_pct)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [id, it.catalog_item_id, it.descricao_snapshot, it.unidade_medida_snapshot, it.qtd, it.preco_unit,
              it.desconto_pct, it.icms_pct, it.ipi_pct, it.st_pct, it.pis_pct, it.cofins_pct, it.iss_pct],
          );
        }
        await c.query(RECOMPUTE_TOTAL, [id]);
        await c.query('COMMIT');
        return id;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    await audit(req, 'order', newId, 'create', pick(b, [...FIELDS, 'status']));
    return reply.code(201).send({ order: await fullOrder(newId) });
  });

  app.patch('/api/orders/:id', {
    preHandler: [requireAuth, requirePermission('orders.update')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        properties: { ...HEADER_PROPS, items: { type: 'array', items: ITEM_SCHEMA } },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const b = req.body as Record<string, unknown> & { items?: ItemInput[] };
    const order = await findOrder(id, orgId);
    if (!order) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWrite(req, order.owner_user_id === null ? null : Number(order.owner_user_id))) {
      return reply.code(403).send({ error: 'pedido de outro vendedor' });
    }
    if (!EDITABLE.has(order.status)) {
      return reply.code(409).send({ error: `pedido ${order.status} não é editável` });
    }
    const badRef = await invalidOrgRef(orgId, b, ['represented_id', 'relationship_id', 'price_table_id', 'carrier_id', 'contact_id']);
    if (badRef) return reply.code(400).send({ error: `${badRef} inválido` });

    // Valida tabela×representada com os valores efetivos (o que o body muda, ou o
    // que o pedido já tinha) — cobre trocar só a tabela OU só a representada.
    const effPriceTable = 'price_table_id' in b
      ? (b.price_table_id as number | null)
      : (order.price_table_id === null ? null : Number(order.price_table_id));
    const effRepresented = 'represented_id' in b
      ? Number(b.represented_id)
      : (order.represented_id === null ? null : Number(order.represented_id));
    if (await priceTableMismatch(orgId, effPriceTable, effRepresented)) {
      return reply.code(400).send({ error: 'tabela de preço não pertence à representada do pedido' });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of FIELDS) {
      if (k in b) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
    }
    if (sets.length === 0 && b.items === undefined) {
      return reply.code(400).send({ error: 'nada para atualizar' });
    }

    let resolved: ResolvedItem[] | null = null;
    if (b.items !== undefined) {
      const priceTableId = 'price_table_id' in b
        ? (b.price_table_id as number | null)
        : (order.price_table_id === null ? null : Number(order.price_table_id));
      const r = await resolveItems(orgId, priceTableId, b.items);
      if (typeof r === 'string') return reply.code(400).send({ error: r });
      resolved = r;
    }

    await withClient(async (c) => {
      await c.query('BEGIN');
      try {
        if (sets.length > 0) {
          await c.query(
            `UPDATE orders SET ${sets.join(', ')}, updated_at = now()
             WHERE id = $${params.length + 1}`,
            [...params, id],
          );
        }
        if (resolved !== null) {
          await c.query('DELETE FROM order_items WHERE order_id = $1', [id]);
          for (const it of resolved) {
            // total NÃO entra no INSERT — é coluna GENERATED (calculada no banco).
            await c.query(
              `INSERT INTO order_items (order_id, catalog_item_id, descricao_snapshot, unidade_medida_snapshot, qtd,
                 preco_unit, desconto_pct, icms_pct, ipi_pct, st_pct, pis_pct, cofins_pct, iss_pct)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [id, it.catalog_item_id, it.descricao_snapshot, it.unidade_medida_snapshot, it.qtd, it.preco_unit,
                it.desconto_pct, it.icms_pct, it.ipi_pct, it.st_pct, it.pis_pct, it.cofins_pct, it.iss_pct],
            );
          }
        }
        // total = soma crua dos itens + frete vigente, sempre recalculado no banco.
        await c.query(RECOMPUTE_TOTAL, [id]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    await audit(req, 'order', id, 'update', pick(b, FIELDS));
    return { order: await fullOrder(id) };
  });

  // Vincula/edita o contato (comprador) do pedido. Diferente do PATCH geral, é
  // permitido em QUALQUER status — é só referência de com quem foi tratado, não
  // muda valor. Usado pela tela de visualização do pedido.
  app.patch('/api/orders/:id/contact', {
    preHandler: [requireAuth, requirePermission('orders.update')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: { type: 'object', required: ['contact_id'], properties: { contact_id: { type: ['integer', 'null'] } } },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const { contact_id } = req.body as { contact_id: number | null };
    const order = await findOrder(id, orgId);
    if (!order) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWrite(req, order.owner_user_id === null ? null : Number(order.owner_user_id))) {
      return reply.code(403).send({ error: 'pedido de outro vendedor' });
    }
    const badRef = await invalidOrgRef(orgId, { contact_id }, ['contact_id']);
    if (badRef) return reply.code(400).send({ error: `${badRef} inválido` });
    await query('UPDATE orders SET contact_id = $1, updated_at = now() WHERE id = $2 AND org_id = $3', [contact_id, id, orgId]);
    await audit(req, 'order', id, 'update', { contact_id });
    return { order: await fullOrder(id) };
  });

  app.post('/api/orders/:id/transition', {
    preHandler: [requireAuth, requirePermission('orders.transition')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: Object.keys(TRANSITIONS) },
          nf_numero: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const { status, nf_numero } = req.body as { status: string; nf_numero?: string | null };
    const order = await findOrder(id, orgId);
    if (!order) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWrite(req, order.owner_user_id === null ? null : Number(order.owner_user_id))) {
      return reply.code(403).send({ error: 'pedido de outro vendedor' });
    }
    if (!(TRANSITIONS[order.status] ?? []).includes(status)) {
      return reply.code(409).send({ error: `transição inválida: ${order.status} → ${status}` });
    }
    await query(
      `UPDATE orders SET status = $2::order_status,
         emitido_em  = CASE WHEN $2 = 'enviado'  THEN now() ELSE emitido_em  END,
         faturado_em = CASE WHEN $2 = 'faturado' THEN now() ELSE faturado_em END,
         nf_numero   = CASE WHEN $2 = 'faturado' THEN COALESCE($3, nf_numero) ELSE nf_numero END,
         updated_at  = now()
       WHERE id = $1`,
      [id, status, nf_numero ?? null],
    );
    // Fase 2: faturar gera a comissão prevista; cancelar pedido faturado
    // cancela a previsão correspondente.
    if (status === 'faturado') await createCommissionForOrder(id);
    if (status === 'cancelado' && order.status === 'faturado') await cancelCommissionForOrder(id);
    await audit(req, 'order', id, 'transition', { de: order.status, para: status, nf_numero: nf_numero ?? null });
    return { order: await fullOrder(id) };
  });

  app.delete('/api/orders/:id', {
    preHandler: [requireAuth, requirePermission('orders.delete')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const order = await findOrder(id, orgId);
    if (!order) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWrite(req, order.owner_user_id === null ? null : Number(order.owner_user_id))) {
      return reply.code(403).send({ error: 'pedido de outro vendedor' });
    }
    if (!EDITABLE.has(order.status)) {
      return reply.code(409).send({ error: `pedido ${order.status} não pode ser excluído (use cancelar)` });
    }
    await query('DELETE FROM orders WHERE id = $1', [id]);
    await audit(req, 'order', id, 'delete');
    return { deleted: true };
  });

  // Importação de faturamento: CSV com colunas nf, data, cnpj, valor (header
  // obrigatório, ',' ou ';'). Match com pedido 'enviado' da org pelo CNPJ do
  // cliente + valor (tolerância 1 centavo); marca faturado + nf_numero.
  // Admin only — fatura pedido de qualquer vendedor.
  app.post('/api/orders/import', {
    preHandler: [requireAuth, requirePermission('orders.import')],
    schema: {
      body: {
        type: 'object',
        required: ['csv'],
        properties: { csv: { type: 'string', minLength: 1, maxLength: 1_000_000 } },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { csv } = req.body as { csv: string };
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const head = lines[0];
    if (head === undefined) return reply.code(400).send({ error: 'csv vazio' });
    const delim = head.includes(';') ? ';' : ',';
    const header = head.split(delim).map((h) => h.trim().toLowerCase());
    const col = (name: string): number => header.findIndex((h) => h.includes(name));
    const iNf = col('nf'); const iData = col('data'); const iCnpj = col('cnpj'); const iValor = col('valor');
    if (iNf < 0 || iData < 0 || iCnpj < 0 || iValor < 0) {
      return reply.code(400).send({ error: 'cabeçalho deve conter colunas nf, data, cnpj, valor' });
    }

    const usados = new Set<number>();
    const results: { linha: number; nf: string; order_id: number | null; motivo?: string }[] = [];
    for (let n = 1; n < lines.length; n++) {
      const f = (lines[n] ?? '').split(delim).map((s) => s.trim());
      const nf = f[iNf] ?? '';
      const cnpj = (f[iCnpj] ?? '').replace(/\D/g, '');
      // valor BR "1.234,56" ou já decimal "1234.56"
      const rawValor = f[iValor] ?? '';
      const valor = Number(rawValor.includes(',') ? rawValor.replace(/\./g, '').replace(',', '.') : rawValor);
      // data ISO (2026-06-01) ou BR (01/06/2026); outro formato → now() no UPDATE
      const rawData = f[iData] ?? '';
      const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawData);
      const data = br ? `${br[3]}-${br[2]}-${br[1]}` : (/^\d{4}-\d{2}-\d{2}/.test(rawData) ? rawData : '');
      if (!nf || !cnpj || !Number.isFinite(valor)) {
        results.push({ linha: n + 1, nf, order_id: null, motivo: 'linha inválida' });
        continue;
      }
      const candidates = await query<{ id: string }>(
        `SELECT o.id FROM orders o JOIN companies c ON c.id = o.company_id
         WHERE o.org_id = $1 AND o.status = 'enviado' AND c.cnpj = $2
           AND abs(o.total - $3) <= 0.01
         ORDER BY o.numero`,
        [orgId, cnpj, valor],
      );
      const match = candidates.map((r) => Number(r.id)).find((oid) => !usados.has(oid));
      if (match === undefined) {
        results.push({ linha: n + 1, nf, order_id: null, motivo: 'sem pedido enviado correspondente' });
        continue;
      }
      usados.add(match);
      await query(
        `UPDATE orders SET status = 'faturado', nf_numero = $2,
           faturado_em = COALESCE($3::timestamptz, now()), updated_at = now()
         WHERE id = $1`,
        [match, nf, data || null],
      );
      await createCommissionForOrder(match);
      await audit(req, 'order', match, 'transition', { de: 'enviado', para: 'faturado', nf_numero: nf, import: true });
      results.push({ linha: n + 1, nf, order_id: match });
    }
    return { processadas: results.length, faturadas: results.filter((r) => r.order_id !== null).length, results };
  });
}
