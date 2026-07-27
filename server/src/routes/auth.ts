import type { FastifyInstance } from 'fastify';
import { pool, query, one } from '../db.ts';
import { hashPassword, verifyPassword, verifyAgainstDummy, signToken, requireAuth } from '../auth.ts';
import { ensureDefaultGroups } from '../seedGroups.ts';
import { config } from '../config.ts';

const DEFAULT_STAGES = [
  'Prospecção', 'Conscientização', 'Interesse', 'Avaliação', 'Negociação', 'Compra', 'Fidelização',
];

export function authRoutes(app: FastifyInstance): void {
  // Brute force / abuso: register e login são os únicos endpoints sem token,
  // limitados por IP (trustProxy já está ligado no buildApp).
  const authLimit = {
    rateLimit: { max: app.authRateLimitMax, timeWindow: config.authRateLimitWindow },
  };

  // TEMPORÁRIO: cadastro público bloqueado. A rota inteira está comentada abaixo;
  // o client também esconde o botão "Criar conta" (client/src/pages/Login.tsx).
  // Para reabrir, descomentar o bloco e remover este handler 403.
  app.post('/api/auth/register', { config: authLimit }, async (_req, reply) =>
    reply.code(403).send({ error: 'cadastro temporariamente indisponível' }));

  /*
  // Register a new tenant (org + admin user + default kanban stages + empty target profile).
  app.post('/api/auth/register', {
    config: authLimit,
    schema: {
      body: {
        type: 'object',
        required: ['org_nome', 'email', 'senha'],
        properties: {
          org_nome: { type: 'string', minLength: 1 },
          email: { type: 'string', minLength: 3 },
          senha: { type: 'string', minLength: 6 },
          tipo_conta: { type: 'string', enum: ['escritorio', 'individual'], default: 'escritorio' },
        },
      },
    },
  }, async (req, reply) => {
    const { org_nome, email, senha, tipo_conta } = req.body as {
      org_nome: string; email: string; senha: string; tipo_conta: 'escritorio' | 'individual';
    };
    const normEmail = email.trim().toLowerCase();

    const existing = await one('SELECT id FROM users WHERE email = $1', [normEmail]);
    if (existing) return reply.code(409).send({ error: 'email já cadastrado' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const org = (await client.query(
        'INSERT INTO organizations (nome, tipo_conta) VALUES ($1,$2) RETURNING id',
        [org_nome, tipo_conta],
      )).rows[0];
      const senhaHash = await hashPassword(senha);
      const user = (await client.query(
        'INSERT INTO users (org_id, email, senha_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, role',
        [org.id, normEmail, senhaHash, 'admin'],
      )).rows[0];
      for (let i = 0; i < DEFAULT_STAGES.length; i++) {
        await client.query('INSERT INTO stages (org_id, nome, ordem) VALUES ($1,$2,$3)', [org.id, DEFAULT_STAGES[i], i + 1]);
      }
      // Semeia os grupos padrão da nova org e filia o admin ao grupo Administrador.
      const adminGroupId = await ensureDefaultGroups(org.id, client);
      await client.query('UPDATE users SET group_id = $1 WHERE id = $2', [adminGroupId, user.id]);
      await client.query('COMMIT');
      const token = await signToken({ userId: user.id, orgId: org.id, role: user.role, tokenVersion: 0 });
      return reply.code(201).send({
        token,
        user: { id: user.id, email: normEmail, role: user.role, org_id: org.id, org_nome, tipo_conta, is_admin: true, permissions: [] },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
  */

  app.post('/api/auth/login', {
    config: authLimit,
    schema: {
      body: {
        type: 'object',
        required: ['email', 'senha'],
        properties: { email: { type: 'string' }, senha: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { email, senha } = req.body as { email: string; senha: string };
    const user = await one<{
      id: number; org_id: number; senha_hash: string; role: string; token_version: number;
      nome: string | null; ativo: boolean; must_change_password: boolean;
      is_admin: boolean | null; permissions: string[] | null;
      group_id: number | null; group_nome: string | null;
      org_nome: string; tipo_conta: string;
    }>(
      `SELECT u.id, u.org_id, u.senha_hash, u.role, u.nome, u.ativo, u.must_change_password,
              u.token_version, u.group_id, g.is_admin, g.permissions, g.nome AS group_nome,
              o.nome AS org_nome, o.tipo_conta
         FROM users u
         JOIN organizations o ON o.id = u.org_id
         LEFT JOIN permission_groups g ON g.id = u.group_id
        WHERE u.email = $1`,
      [email.trim().toLowerCase()],
    );
    if (!user) {
      // scrypt roda mesmo sem usuário — resposta com o mesmo custo de uma senha errada.
      await verifyAgainstDummy(senha);
      return reply.code(401).send({ error: 'credenciais inválidas' });
    }
    if (!(await verifyPassword(senha, user.senha_hash))) {
      return reply.code(401).send({ error: 'credenciais inválidas' });
    }
    if (!user.ativo) return reply.code(403).send({ error: 'usuário desativado' });
    const token = await signToken({
      userId: user.id, orgId: user.org_id, role: user.role, tokenVersion: user.token_version,
    });
    return {
      token,
      user: {
        id: user.id, email: email.trim().toLowerCase(), role: user.role, org_id: user.org_id,
        org_nome: user.org_nome, tipo_conta: user.tipo_conta,
        nome: user.nome, must_change_password: user.must_change_password,
        group_id: user.group_id, group_nome: user.group_nome,
        is_admin: user.role === 'admin' || user.is_admin === true,
        permissions: user.permissions ?? [],
      },
    };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const { userId, orgId } = req.auth!;
    const user = await one<{ role: string; is_admin: boolean | null; permissions: string[] | null }>(
      `SELECT u.id, u.email, u.nome, u.role, u.must_change_password, u.group_id,
              g.nome AS group_nome, g.is_admin, g.permissions,
              o.nome AS org_nome, o.id AS org_id, o.tipo_conta
         FROM users u
         JOIN organizations o ON o.id = u.org_id
         LEFT JOIN permission_groups g ON g.id = u.group_id
        WHERE u.id = $1 AND u.org_id = $2`,
      [userId, orgId],
    );
    if (!user) return { user: null };
    return {
      user: {
        ...user,
        is_admin: user.role === 'admin' || user.is_admin === true,
        permissions: user.permissions ?? [],
      },
    };
  });
}
