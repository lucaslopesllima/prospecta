// Cobertura de GET /api/companies/:id/whatsapp — conferência dos telefones da
// empresa no WhatsApp (Evolution /chat/whatsappNumbers), disparada pelo modal
// de detalhes ao abrir.
//
// A regra que importa é a semântica de três estados:
//   true  -> existe        (a UI mantém o atalho de conversa)
//   false -> não existe    (a UI tira o link)
//   null  -> indeterminado (Evolution fora/desligada/org demo) -> a UI NÃO tira
// Indeterminado jamais pode virar `false`: integração instável não pode remover
// um atalho que funcionava.
//
// evolution.ts é mockado — nenhuma chamada real sai.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, register, bearer, makeCompany, uniq, closeAll, type Session } from './helpers.ts';
import { query, one } from '../src/db.ts';
import { resetDemoCache } from '../src/demo.ts';

const { whatsappNumbers, evolutionEnabled } = vi.hoisted(() => ({
  whatsappNumbers: vi.fn(),
  evolutionEnabled: vi.fn(() => true),
}));
vi.mock('../src/evolution.ts', () => ({
  whatsappNumbers, evolutionEnabled,
  EvolutionDisabledError: class extends Error {},
}));

let app: FastifyInstance;
let s: Session;

const get = (sess: Session, url: string): ReturnType<FastifyInstance['inject']> =>
  app.inject({ method: 'GET', url, headers: bearer(sess.token) });

// Empresa com telefones controlados. O número sai de uniq() (timestamp do run +
// sequência) porque whatsapp_number_check é global e PERSISTE entre execuções da
// suíte: número fixo faria o segundo run começar já cacheado e o caso do cache
// vazio passaria a falhar.
const telUnico = (): string => `11${uniq('wa').replace(/\D/g, '').slice(-9)}`;

async function companyComTelefones(): Promise<{ id: number; tel1: string; tel2: string }> {
  const id = await makeCompany();
  const tel1 = telUnico();
  const tel2 = telUnico();
  await query('UPDATE companies SET telefone1 = $2, telefone2 = $3 WHERE id = $1', [id, tel1, tel2]);
  return { id, tel1, tel2 };
}

// Resposta da Evolution no formato real: jid canônico + flag exists.
const evoRes = (numero: string, exists: boolean): { exists: boolean; jid: string; number: string } =>
  ({ exists, jid: `55${numero}@s.whatsapp.net`, number: `55${numero}` });

beforeAll(async () => {
  app = await makeApp();
  s = await register(app, 'co-wa');
});
afterAll(() => closeAll(app));
beforeEach(() => {
  whatsappNumbers.mockReset();
  evolutionEnabled.mockReset().mockReturnValue(true);
  resetDemoCache();
});

describe('GET /api/companies/:id/whatsapp', () => {
  it('devolve o veredito por telefone e cacheia o resultado', async () => {
    const { id, tel1, tel2 } = await companyComTelefones();
    whatsappNumbers.mockResolvedValue([evoRes(tel1, true), evoRes(tel2, false)]);

    const r = await get(s, `/api/companies/${id}/whatsapp`);
    expect(r.statusCode).toBe(200);
    expect(r.json().whatsapp).toEqual({ telefone1: true, telefone2: false });
    expect(whatsappNumbers).toHaveBeenCalledTimes(1);

    // gravado no cache global (por número, sem org_id)
    const row = await one<{ existe: boolean }>(
      'SELECT existe FROM whatsapp_number_check WHERE numero = $1', [`55${tel1}`],
    );
    expect(row?.existe).toBe(true);

    // segunda abertura do modal sai do cache — a Evolution não é chamada de novo
    whatsappNumbers.mockClear();
    const r2 = await get(s, `/api/companies/${id}/whatsapp`);
    expect(r2.json().whatsapp).toEqual({ telefone1: true, telefone2: false });
    expect(whatsappNumbers).not.toHaveBeenCalled();
  });

  it('Evolution instável -> indeterminado (null), sem gravar cache', async () => {
    const { id, tel1 } = await companyComTelefones();
    whatsappNumbers.mockRejectedValue(new Error('socket sem onWhatsApp'));

    const r = await get(s, `/api/companies/${id}/whatsapp`);
    expect(r.statusCode).toBe(200);
    expect(r.json().whatsapp).toEqual({ telefone1: null, telefone2: null });

    const row = await one('SELECT 1 FROM whatsapp_number_check WHERE numero = $1', [`55${tel1}`]);
    expect(row).toBeNull();
  });

  it('número ausente da resposta da Evolution fica indeterminado', async () => {
    const { id, tel1, tel2 } = await companyComTelefones();
    whatsappNumbers.mockResolvedValue([evoRes(tel1, true)]); // não respondeu sobre o tel2

    const r = await get(s, `/api/companies/${id}/whatsapp`);
    expect(r.json().whatsapp).toEqual({ telefone1: true, telefone2: null });
    const row = await one('SELECT 1 FROM whatsapp_number_check WHERE numero = $1', [`55${tel2}`]);
    expect(row).toBeNull();
  });

  it('integração desligada -> indeterminado, sem chamar a Evolution', async () => {
    const { id } = await companyComTelefones();
    evolutionEnabled.mockReturnValue(false);

    const r = await get(s, `/api/companies/${id}/whatsapp`);
    expect(r.json().whatsapp).toEqual({ telefone1: null, telefone2: null });
    expect(whatsappNumbers).not.toHaveBeenCalled();
  });

  it('org demo -> indeterminado, sem chamar a Evolution', async () => {
    const demo = await register(app, 'co-wa-demo');
    await query('UPDATE organizations SET demo = true WHERE id = $1', [demo.user.org_id]);
    resetDemoCache();
    const { id } = await companyComTelefones();

    const r = await get(demo, `/api/companies/${id}/whatsapp`);
    expect(r.json().whatsapp).toEqual({ telefone1: null, telefone2: null });
    expect(whatsappNumbers).not.toHaveBeenCalled();
  });

  it('telefone ausente ou curto demais não gasta chamada', async () => {
    const id = await makeCompany();
    await query("UPDATE companies SET telefone1 = '1234', telefone2 = NULL WHERE id = $1", [id]);

    const r = await get(s, `/api/companies/${id}/whatsapp`);
    expect(r.json().whatsapp).toEqual({ telefone1: null, telefone2: null });
    expect(whatsappNumbers).not.toHaveBeenCalled();
  });

  it('empresa inexistente -> 404', async () => {
    const r = await get(s, '/api/companies/999999999/whatsapp');
    expect(r.statusCode).toBe(404);
  });

  it('exige autenticação', async () => {
    const { id } = await companyComTelefones();
    const r = await app.inject({ method: 'GET', url: `/api/companies/${id}/whatsapp` });
    expect(r.statusCode).toBe(401);
  });
});
