import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth.ts';
import { config } from '../config.ts';
import { one, query } from '../db.ts';

const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';
const STATUSES = ['novo', 'contatado', 'teste_agendado', 'concluido', 'arquivado'] as const;
type LeadStatus = typeof STATUSES[number];

interface LandingLead {
  nome: string;
  email: string;
  telefone: string;
  empresa?: string;
  mensagem?: string;
  website?: string;
}

async function requireLeadsOwner(req: FastifyRequest, reply: FastifyReply, adminEmail: string): Promise<void> {
  const user = await one<{ email: string }>('SELECT email FROM users WHERE id = $1', [req.auth!.userId]);
  if (user?.email.trim().toLowerCase() !== adminEmail) {
    return reply.code(403).send({ error: 'acesso restrito' });
  }
}

export function leadRoutes(app: FastifyInstance, adminEmail = config.leadsAdminEmail): void {
  app.post('/api/leads', {
    config: { rateLimit: { max: config.leadRateLimitMax, timeWindow: config.leadRateLimitWindow } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['nome', 'email', 'telefone'],
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 120 },
          email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 160 },
          telefone: { type: 'string', minLength: 8, maxLength: 30 },
          empresa: { type: 'string', maxLength: 160 },
          mensagem: { type: 'string', maxLength: 1000 },
          website: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const lead = req.body as LandingLead;
    if (lead.website?.trim()) return reply.code(201).send({ ok: true });
    await query(
      `INSERT INTO demo_requests (nome, email, telefone, empresa, mensagem)
       VALUES ($1, $2, $3, $4, $5)`,
      [lead.nome.trim(), lead.email.trim().toLowerCase(), lead.telefone.trim(),
        lead.empresa?.trim() || null, lead.mensagem?.trim() || null],
    );
    return reply.code(201).send({ ok: true });
  });

  const ownerGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireLeadsOwner(req, reply, adminEmail);
  };

  app.get('/api/leads', { preHandler: [requireAuth, ownerGuard] }, async () => {
    const leads = await query(
      `SELECT id, nome, email, telefone, empresa, mensagem, status, created_at, updated_at
         FROM demo_requests ORDER BY created_at DESC`,
    );
    return { leads };
  });

  app.patch('/api/leads/:id', {
    preHandler: [requireAuth, ownerGuard],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
      body: { type: 'object', additionalProperties: false, required: ['status'],
        properties: { status: { type: 'string', enum: [...STATUSES] } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { status } = req.body as { status: LeadStatus };
    const updated = await one(
      `UPDATE demo_requests SET status = $2, updated_at = now() WHERE id = $1
       RETURNING id, nome, email, telefone, empresa, mensagem, status, created_at, updated_at`,
      [id, status],
    );
    if (!updated) return reply.code(404).send({ error: 'pedido não encontrado' });
    return { lead: updated };
  });
}
