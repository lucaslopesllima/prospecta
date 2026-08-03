// Lógica de domínio do WhatsApp compartilhada entre a rota (envio pela UI) e o
// webhook (recebimento da Evolution): nome da instância, upsert de conversa e
// inserção de mensagem com dedup. SQL cru via db.ts, sempre filtrando org_id.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query, withClient } from './db.ts';
import * as evo from './evolution.ts';
import { isDemoOrg } from './demo.ts';
import { broadcast } from './ws.ts';

// Instância por org. Determinística → o webhook reverte instance_name → org.
export function instanceName(orgId: number): string {
  return `org_${orgId}`;
}

// Garante a linha de settings da org e devolve o instance_name.
export async function ensureSettings(orgId: number): Promise<string> {
  const name = instanceName(orgId);
  await query(
    `INSERT INTO org_whatsapp_settings (org_id, instance_name)
     VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING`,
    [orgId, name],
  );
  return name;
}

export async function setStatus(orgId: number, status: string, numero?: string | null): Promise<void> {
  await query(
    `UPDATE org_whatsapp_settings
        SET status = $2, numero = COALESCE($3, numero), updated_at = now()
      WHERE org_id = $1`,
    [orgId, status, numero ?? null],
  );
}

// Invalidação do cache local da foto: a URL do CDN é só a origem — quando ela
// muda (contato trocou a foto), os bytes cacheados não valem mais e são zerados
// pra rebaixar na próxima leitura de /chats/:id/foto.
const FOTO_CACHE_RESET = `
  foto_path = CASE WHEN foto_url IS DISTINCT FROM $3 THEN NULL ELSE foto_path END,
  foto_b64  = CASE WHEN foto_url IS DISTINCT FROM $3 THEN NULL ELSE foto_b64 END,
  foto_mime = CASE WHEN foto_url IS DISTINCT FROM $3 THEN NULL ELSE foto_mime END,
  foto_at   = CASE WHEN foto_url IS DISTINCT FROM $3 THEN NULL ELSE foto_at END`;

// Atualiza a foto de perfil da conversa (best-effort, vinda do CDN do WhatsApp).
export async function updateFoto(orgId: number, jid: string, url: string | null): Promise<void> {
  await query(
    `UPDATE whatsapp_chats SET foto_url = $3, ${FOTO_CACHE_RESET} WHERE org_id = $1 AND remote_jid = $2`,
    [orgId, jid, url],
  );
}

// Idem, mas casa pelo id da conversa — usado quando o jid veio de um alias
// (@lid conciliado) e pode não ser o remote_jid primário.
export async function updateFotoById(orgId: number, chatId: string, url: string | null): Promise<void> {
  await query(
    `UPDATE whatsapp_chats SET foto_url = $3, ${FOTO_CACHE_RESET} WHERE org_id = $1 AND id = $2`,
    [orgId, chatId, url],
  );
}

// Hosts de onde o app aceita baixar foto de perfil. A URL vem da Evolution (não
// é entrada do usuário, mas também não é confiável): sem allowlist o endpoint
// vira um SSRF — a URL apontaria pra rede interna do compose (evolution, db) e o
// app buscaria por ela. Só https e só CDN da Meta.
function fotoHostPermitido(u: URL): boolean {
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'whatsapp.net' || h.endsWith('.whatsapp.net')
      || h === 'fbcdn.net' || h.endsWith('.fbcdn.net');
}

const FOTO_MAX_BYTES = 2 * 1024 * 1024; // avatar é sempre pequeno (~dezenas de KB)
const FOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Baixa os bytes da foto de perfil do CDN. Devolve null quando a URL não é
// aceitável, expirou (403/404 — comum: o param `oe` da URL do pps caduca), não é
// imagem ou estoura o teto de tamanho. Nunca lança por falha de rede.
export async function downloadFoto(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!fotoHostPermitido(u)) return null;
  try {
    const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!FOTO_MIMES.has(mime)) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > FOTO_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > FOTO_MAX_BYTES) return null;
    return { buf, mime };
  } catch { return null; }
}

// Define o nome da conversa (usado p/ o subject do grupo, que o webhook não traz).
export async function updateNome(orgId: number, chatId: string, nome: string): Promise<void> {
  await query('UPDATE whatsapp_chats SET nome = $3 WHERE org_id = $1 AND id = $2', [orgId, chatId, nome]);
}

// Sincroniza em massa o nome (subject) dos grupos existentes no espelho —
// conserta de uma vez os que pegaram nome de participante. Só ATUALIZA conversas
// já existentes (não cria). Devolve quantas linhas corrigiu.
export async function syncGroupNames(orgId: number): Promise<number> {
  const groups = await evo.fetchAllGroups(instanceName(orgId));
  let n = 0;
  for (const g of groups) {
    if (!g.id || !g.id.endsWith('@g.us') || !g.subject) continue;
    const r = await query(
      `UPDATE whatsapp_chats SET nome = $3, foto_url = COALESCE(foto_url, $4)
        WHERE org_id = $1 AND remote_jid = $2 RETURNING id`,
      [orgId, g.id, g.subject, g.pictureUrl ?? null],
    );
    if (r.length) n++;
  }
  return n;
}

export async function orgByInstance(name: string): Promise<number | null> {
  const r = await one<{ org_id: string }>(
    'SELECT org_id FROM org_whatsapp_settings WHERE instance_name = $1', [name],
  );
  return r ? Number(r.org_id) : null;
}

// Prefixo opcional "*Nome*:\n" no texto que sai pro contato — só o payload da
// Evolution; o corpo guardado/prévia continuam crus (o app já rotula o remetente
// no balão). Aplica quando a org ligou include_sender_name, há autor e há texto
// (mídia sem legenda passa reto). Uma consulta só traz o flag e o nome (mesmo
// COALESCE do balão). Devolve o texto cru quando desligado/sem autor/sem texto.
export async function applySenderPrefix(
  orgId: number, userId: number | null, text: string | null,
): Promise<string | null> {
  if (!text || userId == null) return text ?? null;
  const r = await one<{ include: boolean; nome: string | null }>(
    `SELECT s.include_sender_name AS include, COALESCE(u.nome, o.nome, u.email) AS nome
       FROM org_whatsapp_settings s
       LEFT JOIN users u ON u.id = $2
       LEFT JOIN organizations o ON o.id = u.org_id
      WHERE s.org_id = $1`,
    [orgId, userId],
  );
  if (!r?.include || !r.nome) return text;
  return `*${r.nome}*:\n${text}`;
}

// '5511999999999@s.whatsapp.net' -> '5511999999999'. Grupos (@g.us) passam cru.
export function jidToNumero(jid: string): string {
  return jid.split('@')[0]?.replace(/[^0-9]/g, '') ?? '';
}

// Telefone da base (DDD+numero, às vezes com máscara) -> dígitos com DDI 55.
// Sem DDI (<=11 dígitos) assume Brasil. Já com 55 na frente, mantém.
export function normalizeNumero(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.length <= 11) return `55${d}`;
  return d;
}

export function numeroToJid(numero: string): string {
  return `${normalizeNumero(numero)}@s.whatsapp.net`;
}

// Chave de comparação de telefone tolerante ao nono dígito BR: DDI 55 + DDD +
// últimos 8 dígitos (o 9 na frente do celular cai fora). Fora desse formato,
// compara os dígitos crus.
export function numeroKey(raw: string): string {
  const d = normalizeNumero(raw);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `55${d.slice(2, 4)}${d.slice(-8)}`;
  return d;
}

// ---------------------------------------------------------------------------
// Conferência "este número existe no WhatsApp?" (Evolution /chat/whatsappNumbers)
//
// O telefone que a RFB publica é o do estabelecimento e, em boa parte da base,
// é o da contabilidade — número que ninguém da empresa atende. Conferir se ele
// ao menos existe no WhatsApp é o filtro mais barato que temos (não custa nada
// além da chamada à instância já conectada da org).
//
// Semântica de três estados, e ela importa:
//   true  -> existe        (mantém o atalho de conversa)
//   false -> não existe    (o número vira texto puro na UI)
//   null  -> indeterminado (Evolution fora, desligada ou org demo) -> NÃO nega
// Indeterminado nunca pode virar "não existe": a integração cair não pode tirar
// do representante um atalho que funcionava.
const CHECK_TTL_DIAS = 90;

// Cacheado por número (não por empresa) de propósito: o mesmo telefone se repete
// em milhares de CNPJs na base RFB, então o hit rate é alto e a Evolution é
// poupada. Ver comentário da migração 074.
export async function checkWhatsappNumbers(
  orgId: number, raws: Array<string | null | undefined>,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  // raw -> número normalizado. Fora de 12/13 dígitos (DDI+DDD+8/9) não é
  // telefone conferível: fica indeterminado, sem gastar chamada.
  const alvo = new Map<string, string>();
  for (const raw of raws) {
    if (!raw) continue;
    out.set(raw, null);
    const num = normalizeNumero(raw);
    if (num.length === 12 || num.length === 13) alvo.set(raw, num);
  }
  const nums = [...new Set(alvo.values())];
  if (!nums.length) return out;

  const cached = await query<{ numero: string; existe: boolean }>(
    `SELECT numero, existe FROM whatsapp_number_check
      WHERE numero = ANY($1::text[])
        AND verificado_em > now() - ($2 || ' days')::interval`,
    [nums, String(CHECK_TTL_DIAS)],
  );
  const veredito = new Map<string, boolean>(cached.map((c) => [c.numero, c.existe]));

  const faltando = nums.filter((n) => !veredito.has(n));
  // Org demo não tem instância real na Evolution; integração desligada idem.
  // Os dois casos caem em indeterminado (nada é consultado nem gravado).
  if (faltando.length && evo.evolutionEnabled() && !(await isDemoOrg(orgId))) {
    try {
      const res = await evo.whatsappNumbers(instanceName(orgId), faltando);
      // Casa pela chave tolerante ao nono dígito: a Evolution devolve o jid
      // canônico, que pode ter/não ter o 9 que mandamos.
      const porChave = new Map(res.map((r) => [numeroKey(r.number || jidToNumero(r.jid)), r]));
      for (const n of faltando) {
        const hit = porChave.get(numeroKey(n));
        if (!hit) continue; // não respondeu sobre esse número -> indeterminado
        veredito.set(n, hit.exists);
        await query(
          `INSERT INTO whatsapp_number_check (numero, existe, jid, verificado_em)
             VALUES ($1, $2, $3, now())
           ON CONFLICT (numero) DO UPDATE
             SET existe = EXCLUDED.existe, jid = EXCLUDED.jid, verificado_em = now()`,
          [n, hit.exists, hit.jid || null],
        );
      }
    } catch {
      // Evolution instável/desconectada: segue tudo indeterminado. Sem cache —
      // a próxima abertura do modal tenta de novo.
    }
  }

  for (const [raw, num] of alvo) {
    const v = veredito.get(num);
    if (v !== undefined) out.set(raw, v);
  }
  return out;
}

// Relationship (funil) existente da org para a empresa, se houver.
export async function relationshipForCompany(orgId: number, companyId: number): Promise<{ id: string; represented_id: string | null } | null> {
  return one<{ id: string; represented_id: string | null }>(
    'SELECT id, represented_id FROM company_relationships WHERE org_id = $1 AND company_id = $2 ORDER BY id LIMIT 1',
    [orgId, companyId],
  );
}

// Conversa com rótulos do vínculo (empresa/funil/representada) p/ a UI.
export const CHAT_LABELS_SQL = `
  SELECT ch.id, ch.remote_jid, ch.numero, ch.lid, ch.nome, ch.foto_url, ch.last_message_at, ch.last_preview,
         ch.nao_lidas, ch.company_id, ch.relationship_id, ch.contact_id,
         co.razao_social AS company_nome, co.nome_fantasia AS company_fantasia,
         ct.nome AS contact_nome,
         r.represented_id, rc.nome AS represented_nome,
         (SELECT count(*)::int FROM whatsapp_schedules s
           WHERE s.chat_id = ch.id AND s.status = 'pendente' AND s.agendado_para > now()) AS agendamentos_pendentes
    FROM whatsapp_chats ch
    LEFT JOIN companies co ON co.id = ch.company_id
    LEFT JOIN contacts ct ON ct.id = ch.contact_id AND ct.org_id = ch.org_id
    LEFT JOIN company_relationships r ON r.id = ch.relationship_id
    LEFT JOIN represented_companies rc ON rc.id = r.represented_id AND rc.org_id = ch.org_id`;

export interface ChatRow {
  id: string; remote_jid: string; numero: string | null; lid: string | null; nome: string | null;
  foto_url: string | null; last_message_at: string | null; last_preview: string | null;
  nao_lidas: number; company_id: string | null; relationship_id: string | null; contact_id: string | null;
}

// Intervalos de recorrência aceitos nos agendamentos de mensagem.
export const WA_RECORRENCIAS = ['diaria', 'semanal', 'mensal', 'anual'] as const;
export type WaRecorrencia = (typeof WA_RECORRENCIAS)[number];

// Compromisso espelho na Agenda + agendamento de WhatsApp, numa transação só.
// Reusado pelo agendamento de dentro da conversa, pelo agendamento direto
// (Agenda) e pelo processador ao criar a próxima ocorrência de uma recorrência.
export const SCHEDULE_MAX_OCORRENCIAS = 60;

interface WhatsappSeriesOpts {
  chatId: string | number; remoteJid: string; companyId: string | number | null;
  contactId: string | number | null; ownerUserId: string | number | null; text: string; when: Date; titulo: string;
  recorrencia?: WaRecorrencia | null; quantidade?: number; serieId?: string | null;
}

// Materializa a série num client de transação já aberto (BEGIN feito por quem
// chama). quantidade > 1 gera N compromissos + N agendamentos com datas
// espaçadas pela recorrência, todos já visíveis na Agenda, compartilhando um
// serie_id (permite editar/cancelar a série inteira depois). Cada linha fica SEM
// recorrência (série finita: o processador não rola de novo). quantidade = 1 é o
// caso normal — envio único, ou a próxima ocorrência criada pelo processador,
// que guarda a recorrência pra rolar. Devolve a 1ª linha criada.
export async function insertWhatsappSeries(c: PoolClient, orgId: number, opts: WhatsappSeriesOpts): Promise<Record<string, unknown>> {
  const rec = opts.recorrencia ?? null;
  const n = rec ? Math.max(1, Math.min(SCHEDULE_MAX_OCORRENCIAS, Math.trunc(opts.quantidade ?? 1))) : 1;
  const rowRec = n > 1 ? null : rec;
  // série só quando há mais de uma ocorrência; reaproveita o serie_id no regen.
  const serieId = n > 1 ? (opts.serieId ?? randomUUID()) : (opts.serieId ?? null);
  let first: Record<string, unknown> | null = null;
  let when = new Date(opts.when);
  for (let i = 0; i < n; i++) {
    const act = (await c.query(
      `INSERT INTO activities (org_id, tipo, titulo, start_at, owner_user_id, company_id, contact_id, status)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, 'pendente') RETURNING id`,
      [orgId, opts.titulo, when.toISOString(), opts.ownerUserId, opts.companyId, opts.contactId],
    )).rows[0] as { id: string };
    const s = (await c.query(
      `INSERT INTO whatsapp_schedules (org_id, chat_id, remote_jid, corpo, agendado_para, owner_user_id, activity_id, recorrencia, serie_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, chat_id, corpo, agendado_para, status, recorrencia, serie_id`,
      [orgId, opts.chatId, opts.remoteJid, opts.text, when.toISOString(), opts.ownerUserId, act.id, rowRec, serieId],
    )).rows[0];
    if (i === 0) first = s;
    if (rec && i < n - 1) when = stepOccurrence(when, rec);
  }
  return first!;
}

export async function scheduleWhatsappTx(orgId: number, opts: WhatsappSeriesOpts): Promise<Record<string, unknown>> {
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const first = await insertWhatsappSeries(c, orgId, opts);
      await c.query('COMMIT');
      return first;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  });
}

// Um passo da recorrência a partir de `from` (sem pular pra frente de now) —
// base da materialização da série. Mensal/anual clampa no último dia do mês
// (31 → 28/29 em fevereiro).
export function stepOccurrence(from: Date, rec: WaRecorrencia): Date {
  const d = new Date(from);
  if (rec === 'diaria') d.setDate(d.getDate() + 1);
  else if (rec === 'semanal') d.setDate(d.getDate() + 7);
  else {
    const day = d.getDate();
    d.setDate(1);
    if (rec === 'mensal') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return d;
}

// Próxima ocorrência estritamente futura: avança a partir da data agendada (não
// de now) pra manter o horário original; se o sistema ficou parado, pula as
// ocorrências perdidas em vez de disparar uma rajada.
export function nextOccurrence(from: Date, rec: WaRecorrencia, now: Date): Date {
  let d = new Date(from);
  do { d = stepOccurrence(d, rec); } while (d.getTime() <= now.getTime());
  return d;
}

const CHAT_COLS = `id, remote_jid, numero, lid, nome, foto_url, last_message_at, last_preview,
                   nao_lidas, company_id, relationship_id, contact_id`;

// Resolve jid -> chat_id pela tabela de aliases (suporta vários jids por contato,
// ex.: telefone + @lid depois de conciliar). null = jid ainda não conhecido.
export async function resolveChatId(orgId: number, jid: string): Promise<string | null> {
  const r = await one<{ chat_id: string }>(
    'SELECT chat_id FROM whatsapp_chat_jids WHERE org_id = $1 AND jid = $2', [orgId, jid],
  );
  return r?.chat_id ?? null;
}

// Conversa existente da org com o mesmo telefone, tolerante ao nono dígito BR —
// pega o caso em que o jid não bate (contato salvo sem o 9, ou conversa @lid
// cujo numero veio por outro caminho) e evita abrir conversa duplicada.
export async function findChatByNumero(orgId: number, numero: string): Promise<ChatRow | null> {
  const key = numeroKey(numero);
  if (!key) return null;
  const rows = await query<ChatRow>(
    `SELECT ${CHAT_COLS} FROM whatsapp_chats
      WHERE org_id = $1 AND numero IS NOT NULL AND right(numero, 8) = right($2, 8)`,
    [orgId, key],
  );
  return rows.find((r) => numeroKey(r.numero!) === key) ?? null;
}

// Aplica nome/preview/horário/não-lidas e devolve a conversa completa.
async function updateChatStats(
  orgId: number, chatId: string,
  opts: { nome?: string | null; preview?: string | null; momento?: string; incNaoLidas?: boolean },
): Promise<ChatRow> {
  const inc = opts.incNaoLidas ? 1 : 0;
  const reset = opts.incNaoLidas ? null : 0; // envio próprio zera não-lidas
  const row = await one<ChatRow>(
    `UPDATE whatsapp_chats SET
       nome = COALESCE($3, nome),
       last_message_at = GREATEST(last_message_at, COALESCE($4::timestamptz, now())),
       last_preview = COALESCE($5, last_preview),
       nao_lidas = COALESCE($6::int, nao_lidas + $7)
     WHERE id = $1 AND org_id = $2
     RETURNING ${CHAT_COLS}`,
    [chatId, orgId, opts.nome ?? null, opts.momento ?? null, opts.preview ?? null, reset, inc],
  );
  return row!;
}

// Registra um jid como alias da conversa e popula numero/lid se ainda faltarem
// (sem sobrescrever o que já houver). Idempotente.
async function registerJid(orgId: number, chatId: string, jid: string): Promise<void> {
  const isLid = jid.endsWith('@lid');
  const isGroup = jid.endsWith('@g.us');
  const tipo = isLid ? 'lid' : isGroup ? 'grupo' : 'phone';
  await query(
    `INSERT INTO whatsapp_chat_jids (org_id, jid, chat_id, tipo)
       VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, jid) DO NOTHING`,
    [orgId, jid, chatId, tipo],
  );
  if (isLid) {
    await query('UPDATE whatsapp_chats SET lid = COALESCE(lid, $3) WHERE org_id = $1 AND id = $2', [orgId, chatId, jid]);
  } else if (!isGroup) {
    await query('UPDATE whatsapp_chats SET numero = COALESCE(numero, $3) WHERE org_id = $1 AND id = $2', [orgId, chatId, jidToNumero(jid)]);
  }
}

// Upsert da conversa resolvendo o jid pelos aliases. `altJid` é o OUTRO jid do
// mesmo contato (telefone <-> @lid) quando o WhatsApp entrega os dois no mesmo
// evento: garante uma única conversa pros dois. Se cada jid já caiu numa conversa
// distinta, concilia (merge) automaticamente — evita o par telefone/lid duplicado.
export async function upsertChat(
  orgId: number,
  jid: string,
  opts: { nome?: string | null; preview?: string | null; momento?: string; incNaoLidas?: boolean } = {},
  altJid?: string | null,
): Promise<ChatRow> {
  const alt = altJid && altJid !== jid ? altJid : null;
  let chatId = await resolveChatId(orgId, jid);
  const altChatId = alt ? await resolveChatId(orgId, alt) : null;

  if (chatId && altChatId && chatId !== altChatId) {
    // Mesmo contato em duas conversas separadas: concilia, mantendo a mais antiga
    // (menor id) como primária. Acontece só uma vez — depois os aliases convergem.
    const keep = Number(chatId) <= Number(altChatId) ? chatId : altChatId;
    const drop = keep === chatId ? altChatId : chatId;
    await mergeChats(orgId, Number(keep), Number(drop));
    chatId = keep;
    // Avisa as abas: a conversa `drop` foi absorvida pela `keep` (some da lista).
    broadcast(orgId, 'merged', { chat_id: Number(keep), removed_id: Number(drop) });
  } else if (chatId == null) {
    chatId = altChatId;
  }

  if (chatId == null) {
    // Cria. Prefere o jid de telefone como remote_jid primário (não oculta número).
    const phoneJid = [jid, alt].find((j) => j?.endsWith('@s.whatsapp.net')) ?? null;
    const lidJid = [jid, alt].find((j) => j?.endsWith('@lid')) ?? null;
    const primaryJid = phoneJid ?? jid;
    const created = await one<{ id: string }>(
      `INSERT INTO whatsapp_chats (org_id, remote_jid, numero, lid)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, remote_jid) DO UPDATE SET remote_jid = EXCLUDED.remote_jid
       RETURNING id`,
      [orgId, primaryJid, phoneJid ? jidToNumero(phoneJid) : null, lidJid],
    );
    chatId = created!.id;
  }

  await registerJid(orgId, chatId, jid);
  if (alt) await registerJid(orgId, chatId, alt);

  return updateChatStats(orgId, chatId, opts);
}

// Concilia duas conversas (ex.: telefone + @lid do mesmo contato): move
// mensagens/agendamentos/aliases da `other` pra `primary` e funde os metadados.
// Tudo numa transação; devolve a conversa primária resultante.
export async function mergeChats(orgId: number, primaryId: number, otherId: number): Promise<ChatRow> {
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const both = await c.query('SELECT id FROM whatsapp_chats WHERE org_id = $1 AND id = ANY($2::bigint[])',
        [orgId, [primaryId, otherId]]);
      if (both.rows.length !== 2) throw new Error('conversa inválida');
      await c.query('UPDATE whatsapp_messages SET chat_id = $1 WHERE chat_id = $2 AND org_id = $3', [primaryId, otherId, orgId]);
      await c.query('UPDATE whatsapp_schedules SET chat_id = $1 WHERE chat_id = $2 AND org_id = $3', [primaryId, otherId, orgId]);
      await c.query('UPDATE whatsapp_chat_jids SET chat_id = $1 WHERE chat_id = $2 AND org_id = $3', [primaryId, otherId, orgId]);
      await c.query(
        `UPDATE whatsapp_chats p SET
           numero = COALESCE(p.numero, o.numero),
           lid = COALESCE(p.lid, o.lid),
           nome = COALESCE(p.nome, o.nome),
           foto_url = COALESCE(p.foto_url, o.foto_url),
           -- cache da foto só continua válido se a URL vencedora for a da primária;
           -- herdando a URL da outra, zera pra rebaixar os bytes na próxima leitura.
           foto_path = CASE WHEN p.foto_url IS NULL THEN NULL ELSE p.foto_path END,
           foto_b64  = CASE WHEN p.foto_url IS NULL THEN NULL ELSE p.foto_b64 END,
           foto_mime = CASE WHEN p.foto_url IS NULL THEN NULL ELSE p.foto_mime END,
           foto_at   = CASE WHEN p.foto_url IS NULL THEN NULL ELSE p.foto_at END,
           company_id = COALESCE(p.company_id, o.company_id),
           relationship_id = COALESCE(p.relationship_id, o.relationship_id),
           last_message_at = GREATEST(p.last_message_at, o.last_message_at),
           last_preview = CASE WHEN COALESCE(o.last_message_at,'-infinity') > COALESCE(p.last_message_at,'-infinity')
                               THEN o.last_preview ELSE p.last_preview END,
           nao_lidas = p.nao_lidas + o.nao_lidas
         FROM whatsapp_chats o
         WHERE p.id = $1 AND o.id = $2 AND p.org_id = $3`,
        [primaryId, otherId, orgId],
      );
      await c.query('DELETE FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [otherId, orgId]);
      const out = await c.query(`SELECT ${CHAT_COLS} FROM whatsapp_chats WHERE id = $1 AND org_id = $2`, [primaryId, orgId]);
      await c.query('COMMIT');
      return out.rows[0] as ChatRow;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

// Apaga a conversa (e, por ON DELETE CASCADE, mensagens/aliases/agendamentos).
// Devolve true se removeu; false se a conversa não existia na org.
export async function deleteChat(orgId: number, chatId: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM whatsapp_chats WHERE id = $1 AND org_id = $2 RETURNING id', [chatId, orgId],
  );
  return rows.length > 0;
}

export interface MessageRow {
  id: string; chat_id: string; evolution_id: string | null; from_me: boolean;
  tipo: string; corpo: string | null; status: string | null; momento: string;
  mime: string | null; file_name: string | null; sender_nome: string | null;
  internal: boolean; reply_to_id: string | null;
}

// Insere a mensagem; ON CONFLICT no índice de dedup evita duplicar reentrega de
// webhook. Devolve a linha inserida, ou null se já existia (não reprocessar).
export async function insertMessage(
  orgId: number,
  chatId: string,
  m: {
    evolutionId?: string | null; fromMe: boolean; tipo?: string; corpo?: string | null;
    status?: string | null; momento?: string; mime?: string | null; fileName?: string | null;
    mediaB64?: string | null; mediaPath?: string | null; senderUserId?: number | null;
    internal?: boolean; replyToId?: number | null;
  },
): Promise<MessageRow | null> {
  // Sem evolution_id (ex.: envio otimista) não há como deduplicar — insere direto.
  if (m.evolutionId) {
    const dup = await one<{ id: string }>(
      'SELECT id FROM whatsapp_messages WHERE org_id = $1 AND evolution_id = $2', [orgId, m.evolutionId],
    );
    if (dup) return null;
  }
  // CTE: a linha inserida volta já com o nome do atendente (join em users),
  // pronta pra resposta da API e pro broadcast do WebSocket.
  return one<MessageRow>(
    `WITH ins AS (
       INSERT INTO whatsapp_messages
         (org_id, chat_id, evolution_id, from_me, tipo, corpo, status, momento, mime, file_name, media_b64, media_path, sender_user_id, internal, reply_to_id)
       VALUES ($1, $2, $3, $4, COALESCE($5,'texto'), $6, $7, COALESCE($8::timestamptz, now()), $9, $10, $11, $12, $13, COALESCE($14, false), $15)
       RETURNING id, chat_id, evolution_id, from_me, tipo, corpo, status, momento, mime, file_name, sender_user_id, internal, reply_to_id
     )
     SELECT ins.id, ins.chat_id, ins.evolution_id, ins.from_me, ins.tipo, ins.corpo, ins.status,
            ins.momento, ins.mime, ins.file_name, ins.internal, ins.reply_to_id, COALESCE(u.nome, o.nome, u.email) AS sender_nome
       FROM ins
       LEFT JOIN users u ON u.id = ins.sender_user_id
       LEFT JOIN organizations o ON o.id = u.org_id`,
    [orgId, chatId, m.evolutionId ?? null, m.fromMe, m.tipo ?? null, m.corpo ?? null,
      m.status ?? null, m.momento ?? null, m.mime ?? null, m.fileName ?? null, m.mediaB64 ?? null, m.mediaPath ?? null,
      m.senderUserId ?? null, m.internal ?? false, m.replyToId ?? null],
  );
}
