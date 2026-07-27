// Processador de mensagens WhatsApp agendadas. Mesmo desenho do processDueEmails
// (email.ts): varre pendentes vencidos no boot + a cada minuto, idempotente
// (UPDATE condiciona em status='pendente'). Sem instância conectada na org o
// envio TRAVA (segue pendente) — só falha real de envio vira 'erro'.
import { query, one } from './db.ts';
import { isDemoOrg } from './demo.ts';
import * as evo from './evolution.ts';
import { instanceName, insertMessage, upsertChat, scheduleWhatsappTx, nextOccurrence, applySenderPrefix } from './whatsapp.ts';
import type { WaRecorrencia } from './whatsapp.ts';
import { broadcast } from './ws.ts';

export async function processDueWhatsapp(now = new Date()): Promise<number> {
  // JOIN no chat: numero/remote_jid de lá são autoritativos (o remote_jid do
  // agendamento pode estar defasado após conciliação). chat_id pode ser null
  // (conversa apagada) — cai no remote_jid do próprio agendamento.
  const due = await query<{
    id: string; org_id: string; chat_id: string | null; remote_jid: string; corpo: string; activity_id: string | null;
    agendado_para: string; recorrencia: WaRecorrencia | null; owner_user_id: string | null;
    act_titulo: string | null; act_company_id: string | null; act_contact_id: string | null;
    chat_numero: string | null; chat_remote_jid: string | null;
  }>(
    `SELECT s.id, s.org_id, s.chat_id, s.remote_jid, s.corpo, s.activity_id,
            s.agendado_para, s.recorrencia, s.owner_user_id,
            a.titulo AS act_titulo, a.company_id AS act_company_id, a.contact_id AS act_contact_id,
            ch.numero AS chat_numero, ch.remote_jid AS chat_remote_jid
       FROM whatsapp_schedules s
       LEFT JOIN activities a ON a.id = s.activity_id AND a.org_id = s.org_id
       LEFT JOIN whatsapp_chats ch ON ch.id = s.chat_id AND ch.org_id = s.org_id
      WHERE s.status = 'pendente' AND s.agendado_para <= $1
      ORDER BY s.agendado_para
      LIMIT 500`,
    [now.toISOString()],
  );

  // status de conexão (e marca de demo) por org, cacheado dentro da varredura
  // (promise: dedupe mesmo com consultas concorrentes).
  const conn = new Map<string, Promise<{ ok: boolean; demo: boolean }>>();
  let sent = 0;
  // Concorrência limitada: 5 envios em paralelo por vez, em vez de estritamente
  // sequencial — cada item continua isolado (try/catch).
  const CONCURRENCY = 5;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    await Promise.all(due.slice(i, i + CONCURRENCY).map(async (s) => {
      let stateP = conn.get(s.org_id);
      if (stateP === undefined) {
        // Org demo está sempre "conectada" (circuito fechado, ver demo.ts): o
        // agendamento vence, vira mensagem na conversa e nada sai pra fora.
        stateP = Promise.all([
          one<{ status: string }>('SELECT status FROM org_whatsapp_settings WHERE org_id = $1', [s.org_id]),
          isDemoOrg(s.org_id),
        ]).then(([row, demo]) => ({ ok: demo || row?.status === 'conectado', demo }));
        conn.set(s.org_id, stateP);
      }
      const { ok, demo } = await stateP;
      if (!ok) return; // sem instância conectada: trava (segue pendente)

      const orgId = Number(s.org_id);
      // Destino igual ao envio interativo: número quando houver, senão o jid. LID
      // sem número não tem destinatário válido — marca erro claro (não fica em loop).
      const remoteJid = s.chat_remote_jid ?? s.remote_jid;
      const dest = s.chat_numero || remoteJid;
      if (!s.chat_numero && remoteJid.endsWith('@lid')) {
        await query(
          `UPDATE whatsapp_schedules SET status = 'erro', erro = $2, updated_at = now()
            WHERE id = $1 AND status = 'pendente'`,
          [s.id, 'Contato sem número de telefone (LID). Concilie a conversa com a de telefone para enviar.'],
        );
        return;
      }
      try {
        // Prefixa só o texto enviado (quando a org liga o flag); corpo/prévia crus.
        const ownerId = s.owner_user_id != null ? Number(s.owner_user_id) : null;
        const outgoing = await applySenderPrefix(orgId, ownerId, s.corpo) ?? s.corpo;
        const res = demo ? null : await evo.sendText(instanceName(orgId), dest, outgoing);
        const evolutionId = res?.key?.id ?? null;

        // garante a conversa (caso o chat_id tenha sumido) e espelha a mensagem.
        const chat = await upsertChat(orgId, remoteJid, { preview: s.corpo, incNaoLidas: false });
        const chatId = s.chat_id ?? chat.id;
        const msg = await insertMessage(orgId, chatId, {
          evolutionId, fromMe: true, corpo: s.corpo, status: 'enviado', senderUserId: ownerId,
        });

        const rows = await query(
          `UPDATE whatsapp_schedules SET status = 'enviado', enviado_em = now(), erro = NULL, updated_at = now()
            WHERE id = $1 AND status = 'pendente' RETURNING id`,
          [s.id],
        );
        if (rows.length === 0) return; // já processado por outra varredura
        // Compromisso espelho na Agenda vira 'feito' quando a mensagem sai.
        if (s.activity_id != null) {
          await query("UPDATE activities SET status = 'feito' WHERE id = $1 AND org_id = $2", [s.activity_id, orgId]);
        }
        // Recorrência (modelo rolante): agenda a próxima ocorrência estritamente
        // futura, já com o compromisso espelho na Agenda. Falha aqui não desfaz o
        // envio — loga e a série para (melhor que rajada duplicada).
        if (s.recorrencia != null) {
          try {
            await scheduleWhatsappTx(orgId, {
              chatId, remoteJid, companyId: s.act_company_id, contactId: s.act_contact_id,
              ownerUserId: s.owner_user_id, text: s.corpo,
              when: nextOccurrence(new Date(s.agendado_para), s.recorrencia, now),
              titulo: s.act_titulo ?? `WhatsApp: ${s.corpo.length > 60 ? `${s.corpo.slice(0, 60)}…` : s.corpo}`,
              recorrencia: s.recorrencia,
            });
          } catch (err) {
            console.error(`whatsappScheduler: falha ao criar próxima ocorrência do agendamento ${s.id}:`, err);
          }
        }
        sent++;
        if (msg) broadcast(orgId, 'message', { chat_id: Number(chatId), message: msg });
      } catch (err) {
        // Integração desligada globalmente também trava (não marca erro).
        if (err instanceof evo.EvolutionDisabledError) return;
        await query(
          `UPDATE whatsapp_schedules SET status = 'erro', erro = $2, updated_at = now()
            WHERE id = $1 AND status = 'pendente'`,
          [s.id, err instanceof Error ? err.message : String(err)],
        );
      }
    }));
  }
  return sent;
}
