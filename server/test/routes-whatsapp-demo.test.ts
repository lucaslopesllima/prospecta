// Modo demo do WhatsApp (organizations.demo, src/demo.ts): a org de
// demonstração não tem instância na Evolution, mas a tela precisa abrir cheia e
// aceitar envio. Contrato coberto aqui: a UI vê "conectado", envio/agendamento
// gravam localmente e NENHUMA chamada chega na Evolution.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, register, bearer, closeAll, type Session } from './helpers.ts';
import { one, query } from '../src/db.ts';

const evoMock = vi.hoisted(() => ({
  evolutionEnabled: vi.fn(() => true),
  createInstance: vi.fn(), connect: vi.fn(), connectionState: vi.fn(), logout: vi.fn(),
  markRead: vi.fn(), getMediaBase64: vi.fn(), fetchAllGroups: vi.fn(async () => []),
  profilePicture: vi.fn(async () => null), groupInfo: vi.fn(async () => ({ subject: null, pictureUrl: null })),
  groupDetails: vi.fn(), sendText: vi.fn(), sendMedia: vi.fn(), sendAudio: vi.fn(), whatsappNumbers: vi.fn(),
}));
vi.mock('../src/evolution.ts', () => ({ ...evoMock, EvolutionDisabledError: class EvolutionDisabledError extends Error {} }));

const { processDueWhatsapp } = await import('../src/whatsappScheduler.ts');
const { resetDemoCache } = await import('../src/demo.ts');

let app: FastifyInstance;
let s: Session;
let org = 0;
let userId = 0;

const inj = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): ReturnType<FastifyInstance['inject']> =>
  app.inject({ method, url, headers: bearer(s.token), payload });
const mkChat = async (jid: string, numero: string | null, nome?: string): Promise<string> =>
  (await one<{ id: string }>(
    'INSERT INTO whatsapp_chats (org_id, remote_jid, numero, nome) VALUES ($1,$2,$3,$4) RETURNING id',
    [org, jid, numero, nome ?? null]))!.id;

beforeAll(async () => {
  app = await makeApp();
  s = await register(app, 'wa-demo');
  org = Number(s.user.org_id);
  userId = Number(s.user.id);
  await query('UPDATE organizations SET demo = true WHERE id = $1', [org]);
  resetDemoCache(); // o register já pode ter aquecido o cache com demo=false
});
afterAll(() => closeAll(app));
beforeEach(() => {
  for (const f of Object.values(evoMock)) (f as ReturnType<typeof vi.fn>).mockReset();
  evoMock.evolutionEnabled.mockReturnValue(true);
  evoMock.fetchAllGroups.mockResolvedValue([]);
});

describe('whatsapp demo — conexão simulada', () => {
  it('status: conectado e habilitado mesmo com a integração desligada', async () => {
    evoMock.evolutionEnabled.mockReturnValue(false);
    const r = await inj('GET', '/api/whatsapp/status');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: true, status: 'conectado' });
  });

  it('connection: conectado sem consultar a Evolution', async () => {
    const r = await inj('GET', '/api/whatsapp/connection');
    expect(r.json()).toEqual({ status: 'conectado' });
    expect(evoMock.connectionState).not.toHaveBeenCalled();
  });

  it('connect/disconnect: 409 e nenhuma instância tocada', async () => {
    expect((await inj('POST', '/api/whatsapp/connect')).statusCode).toBe(409);
    expect((await inj('POST', '/api/whatsapp/disconnect')).statusCode).toBe(409);
    expect(evoMock.createInstance).not.toHaveBeenCalled();
    expect(evoMock.connect).not.toHaveBeenCalled();
    expect(evoMock.logout).not.toHaveBeenCalled();
  });

  it('lista de conversas não tenta sincronizar grupos', async () => {
    await mkChat('5519900000001@s.whatsapp.net', '5519900000001');
    const r = await inj('GET', '/api/whatsapp/chats');
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 30)); // sync seria assíncrono
    expect(evoMock.fetchAllGroups).not.toHaveBeenCalled();
  });

  it('detalhes de grupo saem da base, sem 502', async () => {
    const chat = await mkChat('12036300@g.us', null, 'Compradores Rede Bom Preço');
    const r = await inj('GET', `/api/whatsapp/chats/${chat}/group`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ subject: 'Compradores Rede Bom Preço', desc: null, size: 0, participants: [] });
    expect(evoMock.groupDetails).not.toHaveBeenCalled();
  });

  it('número informado é aceito sem consultar a Evolution', async () => {
    const chat = await mkChat('lid900@lid', null);
    const r = await inj('PATCH', `/api/whatsapp/chats/${chat}/numero`, { numero: '5519998887766' });
    expect(r.statusCode).toBe(200);
    expect(evoMock.whatsappNumbers).not.toHaveBeenCalled();
    const row = await one<{ numero: string }>('SELECT numero FROM whatsapp_chats WHERE id = $1', [chat]);
    expect(row!.numero).toBe('5519998887766');
  });
});

describe('whatsapp demo — envio em circuito fechado', () => {
  it('texto: grava e espelha, sem evolution_id e sem envio real', async () => {
    const chat = await mkChat('5519900000002@s.whatsapp.net', '5519900000002');
    const r = await inj('POST', `/api/whatsapp/chats/${chat}/send`, { text: 'Bom dia! Fecho a reposição hoje?' });
    expect(r.statusCode).toBe(200);
    expect(evoMock.sendText).not.toHaveBeenCalled();
    const msg = await one<{ corpo: string; evolution_id: string | null; status: string; from_me: boolean }>(
      'SELECT corpo, evolution_id, status, from_me FROM whatsapp_messages WHERE chat_id = $1', [chat]);
    expect(msg).toMatchObject({ corpo: 'Bom dia! Fecho a reposição hoje?', evolution_id: null, status: 'enviado', from_me: true });
    const ch = await one<{ last_preview: string }>('SELECT last_preview FROM whatsapp_chats WHERE id = $1', [chat]);
    expect(ch!.last_preview).toBe('Bom dia! Fecho a reposição hoje?');
  });

  it('mídia: persiste o anexo sem chamar sendMedia/sendAudio', async () => {
    const chat = await mkChat('5519900000003@s.whatsapp.net', '5519900000003');
    const media = Buffer.from('tabela-de-precos').toString('base64');
    const r = await inj('POST', `/api/whatsapp/chats/${chat}/send-media`, {
      media, mediatype: 'document', mimetype: 'application/pdf', fileName: 'tabela.pdf', caption: 'Tabela de julho',
    });
    expect(r.statusCode).toBe(200);
    expect(evoMock.sendMedia).not.toHaveBeenCalled();
    expect(evoMock.sendAudio).not.toHaveBeenCalled();
    const msg = await one<{ tipo: string; file_name: string; evolution_id: string | null }>(
      'SELECT tipo, file_name, evolution_id FROM whatsapp_messages WHERE chat_id = $1', [chat]);
    expect(msg).toMatchObject({ tipo: 'documento', file_name: 'tabela.pdf', evolution_id: null });
  });

  it('agendamento vencido vira mensagem local (sem instância conectada no banco)', async () => {
    const chat = await mkChat('5519900000004@s.whatsapp.net', '5519900000004');
    // settings segue 'desconectado': numa org normal isso travaria o envio.
    await query(
      `INSERT INTO org_whatsapp_settings (org_id, instance_name, status)
       VALUES ($1,$2,'desconectado') ON CONFLICT (org_id) DO UPDATE SET status = 'desconectado'`,
      [org, `org_${org}`],
    );
    const sched = await one<{ id: string }>(
      `INSERT INTO whatsapp_schedules (org_id, chat_id, remote_jid, corpo, agendado_para, owner_user_id)
       VALUES ($1,$2,$3,'Lembrete: amostra do queijo novo',$4,$5) RETURNING id`,
      [org, chat, '5519900000004@s.whatsapp.net', new Date(Date.now() - 60_000).toISOString(), userId],
    );
    const sent = await processDueWhatsapp();
    expect(sent).toBe(1);
    expect(evoMock.sendText).not.toHaveBeenCalled();
    const row = await one<{ status: string }>('SELECT status FROM whatsapp_schedules WHERE id = $1', [sched!.id]);
    expect(row!.status).toBe('enviado');
    const msg = await one<{ corpo: string }>('SELECT corpo FROM whatsapp_messages WHERE chat_id = $1', [chat]);
    expect(msg!.corpo).toBe('Lembrete: amostra do queijo novo');
  });
});

describe('whatsapp fora da demo — nada muda', () => {
  it('org normal continua consultando a Evolution e travando o agendamento', async () => {
    const app2 = await makeApp();
    const s2 = await register(app2, 'wa-nao-demo');
    const org2 = Number(s2.user.org_id);
    evoMock.connectionState.mockResolvedValueOnce('close');
    const r = await app2.inject({ method: 'GET', url: '/api/whatsapp/connection', headers: bearer(s2.token) });
    expect(r.json()).toEqual({ status: 'desconectado' });
    expect(evoMock.connectionState).toHaveBeenCalled();

    const chat = (await one<{ id: string }>(
      'INSERT INTO whatsapp_chats (org_id, remote_jid, numero) VALUES ($1,$2,$3) RETURNING id',
      [org2, '5519900000005@s.whatsapp.net', '5519900000005']))!.id;
    await one(
      `INSERT INTO whatsapp_schedules (org_id, chat_id, remote_jid, corpo, agendado_para, owner_user_id)
       VALUES ($1,$2,$3,'não deve sair',$4,$5) RETURNING id`,
      [org2, chat, '5519900000005@s.whatsapp.net', new Date(Date.now() - 60_000).toISOString(), Number(s2.user.id)],
    );
    await processDueWhatsapp();
    expect(evoMock.sendText).not.toHaveBeenCalled(); // travado: settings 'desconectado'
    const row = await one<{ status: string }>(
      "SELECT status FROM whatsapp_schedules WHERE org_id = $1 AND corpo = 'não deve sair'", [org2]);
    expect(row!.status).toBe('pendente');
    await app2.close();
  });
});
