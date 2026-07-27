import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../db.ts';
import { requireAuth, requirePermission } from '../auth.ts';

// Relatórios (Fase 4): vendas agregadas, curva ABC de clientes, mapa de
// cobertura (potencial RFB vs. clientes por município) e perdas por motivo de
// descarte. Escopo por carteira: rep vê só os próprios; admin tudo + ?user_id.

function ownerClause(req: FastifyRequest, userIdQ: number | undefined, col: string, params: unknown[]): string {
  if (req.auth!.role !== 'admin') { params.push(req.auth!.userId); return ` AND ${col} = $${params.length}`; }
  if (userIdQ !== undefined) { params.push(userIdQ); return ` AND ${col} = $${params.length}`; }
  return '';
}

// Período padrão dos relatórios de venda: últimos 12 meses até hoje.
function range(q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  let from = q.from;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 12);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}

const GROUPS = {
  vendedor: { sel: 'u.id AS chave, COALESCE(u.nome, u.email) AS label', join: 'LEFT JOIN users u ON u.id = o.owner_user_id', grp: 'u.id, u.nome, u.email', ord: 'total DESC' },
  representada: { sel: 'rc.id AS chave, rc.nome AS label', join: 'JOIN represented_companies rc ON rc.id = o.represented_id', grp: 'rc.id, rc.nome', ord: 'total DESC' },
  mes: { sel: "to_char(date_trunc('month', o.faturado_em), 'YYYY-MM') AS chave, to_char(date_trunc('month', o.faturado_em), 'YYYY-MM') AS label", join: '', grp: "date_trunc('month', o.faturado_em)", ord: 'chave' },
} as const;

export function reportRoutes(app: FastifyInstance): void {
  // Vendas agregadas por vendedor | representada | mês.
  app.get('/api/reports/sales', {
    preHandler: [requireAuth, requirePermission('reports.sales')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          group_by: { type: 'string', enum: ['vendedor', 'representada', 'mes'] },
          from: { type: 'string' },
          to: { type: 'string' },
          user_id: { type: 'integer' },
        },
      },
    },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const q = req.query as { group_by?: 'vendedor' | 'representada' | 'mes'; from?: string; to?: string; user_id?: number };
    const g = GROUPS[q.group_by ?? 'mes'];
    const { from, to } = range(q);
    const params: unknown[] = [orgId, from, to];
    const owner = ownerClause(req, q.user_id, 'o.owner_user_id', params);
    const rows = await query(
      `SELECT ${g.sel}, COALESCE(sum(o.total), 0) AS total, count(*)::int AS qtd
       FROM orders o ${g.join}
       WHERE o.org_id = $1 AND o.status IN ('faturado','entregue')
         AND o.faturado_em >= $2::date AND o.faturado_em < ($3::date + 1)${owner}
       GROUP BY ${g.grp}
       ORDER BY ${g.ord}`,
      params,
    );
    return { group_by: q.group_by ?? 'mes', from, to, rows };
  });

  // Curva ABC de clientes por faturamento nos últimos N meses (default 12).
  app.get('/api/reports/abc', {
    preHandler: [requireAuth, requirePermission('reports.abc')],
    schema: {
      querystring: {
        type: 'object',
        properties: { meses: { type: 'integer', minimum: 1, maximum: 60 }, user_id: { type: 'integer' } },
      },
    },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const q = req.query as { meses?: number; user_id?: number };
    const meses = q.meses ?? 12;
    const params: unknown[] = [orgId, meses];
    const owner = ownerClause(req, q.user_id, 'o.owner_user_id', params);
    const rows = await query<{ company_id: string; razao_social: string; nome_fantasia: string | null; total: string }>(
      `SELECT o.company_id, c.razao_social, c.nome_fantasia, sum(o.total) AS total
       FROM orders o JOIN companies c ON c.id = o.company_id
       WHERE o.org_id = $1 AND o.status IN ('faturado','entregue')
         AND o.faturado_em >= date_trunc('month', current_date) - make_interval(months => $2)${owner}
       GROUP BY o.company_id, c.razao_social, c.nome_fantasia
       HAVING sum(o.total) > 0
       ORDER BY total DESC`,
      params,
    );
    const grand = rows.reduce((s, r) => s + Number(r.total), 0);
    let acc = 0;
    const clientes = rows.map((r) => {
      const total = Number(r.total);
      acc += total;
      const cumPct = grand > 0 ? (acc / grand) * 100 : 0;
      const classe = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
      return {
        company_id: Number(r.company_id),
        razao_social: r.razao_social,
        nome_fantasia: r.nome_fantasia,
        total,
        share: grand > 0 ? Math.round((total / grand) * 1000) / 10 : 0,
        classe,
      };
    });
    return { meses, total: grand, clientes };
  });

  // Mapa de cobertura: por município do território, potencial (empresas ativas
  // na base RFB) vs. clientes já conquistados (relationships status='cliente').
  app.get('/api/reports/coverage', {
    preHandler: [requireAuth, requirePermission('reports.coverage')],
    schema: { querystring: { type: 'object', properties: { user_id: { type: 'integer' }, munis: { type: 'string' } } } },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const q = req.query as { user_id?: number; munis?: string };
    // território vem do filtro da tela de busca (csv de ids de município).
    const municipios = (q.munis ?? '').split(/[,\s]+/).map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (municipios.length === 0) return { municipios: [] };

    const params: unknown[] = [orgId, municipios];
    const owner = ownerClause(req, q.user_id, 'r.owner_user_id', params);
    // Contagens set-based (um GROUP BY por fonte) em vez de subquery
    // correlacionada por município — evita N varreduras em companies.
    const rows = await query(
      `SELECT m.id, m.nome, m.uf,
              ST_Y(m.geom::geometry) AS lat, ST_X(m.geom::geometry) AS lon,
              COALESCE(pot.qtd, 0)::int AS potencial,
              COALESCE(cli.qtd, 0)::int AS clientes
       FROM municipios m
       LEFT JOIN (
         SELECT c.municipio_id, count(*) AS qtd
         FROM companies c
         WHERE c.municipio_id = ANY($2::int[]) AND c.situacao_cadastral = 'ativa'
           AND c.source <> 'demo' -- fictícias da base de demo não são mercado potencial
         GROUP BY c.municipio_id
       ) pot ON pot.municipio_id = m.id
       LEFT JOIN (
         SELECT c2.municipio_id, count(*) AS qtd
         FROM company_relationships r
         JOIN companies c2 ON c2.id = r.company_id
         WHERE r.org_id = $1 AND r.status = 'cliente'
           AND c2.municipio_id = ANY($2::int[])${owner}
         GROUP BY c2.municipio_id
       ) cli ON cli.municipio_id = m.id
       WHERE m.id = ANY($2::int[])
       ORDER BY m.uf, m.nome`,
      params,
    );
    return { municipios: rows };
  });

  // Perdas por motivo de descarte (relacionamentos status='descartado').
  app.get('/api/reports/descartes', {
    preHandler: [requireAuth, requirePermission('reports.descartes')],
    schema: { querystring: { type: 'object', properties: { user_id: { type: 'integer' } } } },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const q = req.query as { user_id?: number };
    const params: unknown[] = [orgId];
    const owner = ownerClause(req, q.user_id, 'r.owner_user_id', params);
    const rows = await query(
      `SELECT COALESCE(NULLIF(trim(r.motivo_descarte), ''), '(sem motivo)') AS motivo,
              count(*)::int AS qtd
       FROM company_relationships r
       WHERE r.org_id = $1 AND r.status = 'descartado'${owner}
       GROUP BY motivo
       ORDER BY qtd DESC`,
      params,
    );
    return { motivos: rows };
  });
}
