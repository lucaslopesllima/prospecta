import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { one, query, withClient } from '../db.ts';
import { requireAuth, requirePermission, authorizeToken, AuthError } from '../auth.ts';
import { invalidOrgRef } from '../orgRefs.ts';
import { audit } from '../audit.ts';
import { isDemoOrg } from '../demo.ts';
import * as evo from '../evolution.ts';
import { mediaEnabled, saveMedia, saveAvatar, mediaStream } from '../mediaStore.ts';
import { addConn, removeConn, broadcast } from '../ws.ts';
import {
  ensureSettings, setStatus, instanceName, upsertChat, insertMessage,
  CHAT_LABELS_SQL, relationshipForCompany, numeroToJid, mergeChats, deleteChat, syncGroupNames,
  normalizeNumero, jidToNumero, findChatByNumero, scheduleWhatsappTx, insertWhatsappSeries,
  downloadFoto, updateFotoById,
  WA_RECORRENCIAS, applySenderPrefix,
} from '../whatsapp.ts';
import type { WaRecorrencia } from '../whatsapp.ts';

// Cadência inferida pelo intervalo entre duas ocorrências consecutivas de uma
// série (as linhas materializadas guardam recorrencia=null; a frequência fica
// implícita no espaçamento). Usado ao regenerar sem a frequência explícita.
function inferRecorrencia(d0: Date, d1: Date): WaRecorrencia | null {
  const dias = Math.round((d1.getTime() - d0.getTime()) / 86_400_000);
  if (dias <= 1) return 'diaria';
  if (dias <= 10) return 'semanal';
  if (dias <= 45) return 'mensal';
  return 'anual';
}

// Título do compromisso espelho de WhatsApp (mesmo formato usado na criação).
function waTitulo(alvo: string, text: string): string {
  return `WhatsApp p/ ${alvo}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
}

// Sincronização de nomes de grupo já feita nesta sessão (por org) — roda uma vez
// ao abrir a lista de conversas, conserta grupos com nome de participante.
const groupsSynced = new Set<number>();

// Content-types que podem ser servidos inline (renderizados no browser). O mime da
// mídia vem do metadata do contato remoto (não confiável) — qualquer coisa fora
// desta lista vira octet-stream + attachment para nunca executar como HTML/JS.
const INLINE_MEDIA_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav',
  'video/mp4', 'video/3gpp', 'video/webm', 'video/quicktime',
  'application/pdf',
]);
function safeMediaType(mime: string | null): { type: string; inline: boolean } {
  const m = ((mime ?? '').split(';')[0] ?? '').trim().toLowerCase();
  if (INLINE_MEDIA_MIME.has(m)) return { type: m, inline: true };
  return { type: 'application/octet-stream', inline: false };
}

// Rebaixa a URL atual da foto de perfil na Evolution (grupo tem endpoint próprio).
// Usado quando não há URL guardada ou a guardada expirou.
async function refreshFotoUrl(orgId: number, jid: string): Promise<string | null> {
  // Org demo: as fotos vêm do cache semeado (foto_b64/foto_path). Sem instância
  // real, rebaixar a URL só renderia erro — segue sem foto.
  if (await isDemoOrg(orgId)) return null;
  const inst = instanceName(orgId);
  if (jid.endsWith('@g.us')) return (await evo.groupInfo(inst, jid)).pictureUrl;
  return evo.profilePicture(inst, jidToNumero(jid));
}

// 'open' (Evolution) -> 'conectado' etc. Normaliza p/ o vocabulário do front.
function mapState(state: string | null): string {
  if (state === 'open') return 'conectado';
  if (state === 'connecting') return 'conectando';
  return 'desconectado';
}

export function whatsappRoutes(app: FastifyInstance): void {
  // Stream ao vivo: o browser abre ws://…/api/whatsapp/ws?token=JWT (o header
  // Authorization não vai em WebSocket do browser, então o token vem na query).
  app.get('/api/whatsapp/ws', { websocket: true }, (socket: WebSocket, req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) { socket.close(1008, 'sem token'); return; }
    // authorizeToken (não verifyToken cru): valida ativo/token_version/permissão —
    // sem isso um usuário desativado ou sem whatsapp.view abriria o stream da org.
    authorizeToken(token, 'whatsapp.view').then(
      (claims) => {
        addConn(claims.orgId, socket);
        socket.on('close', () => removeConn(claims.orgId, socket));
      },
      () => socket.close(1008, 'não autorizado'),
    );
  });

  // Estado da conexão da org (cria a linha de settings na primeira visita).
  app.get('/api/whatsapp/status', { preHandler: [requireAuth, requirePermission('whatsapp.view')] }, async (req) => {
    const orgId = req.auth!.orgId;
    await ensureSettings(orgId);
    const s = await one<{ status: string; numero: string | null; updated_at: string; include_sender_name: boolean }>(
      'SELECT status, numero, updated_at, include_sender_name FROM org_whatsapp_settings WHERE org_id = $1', [orgId],
    );
    // Org demo: sempre habilitada e conectada. Sem isso o front cai no painel de
    // QR (ou no aviso de integração desligada) e as conversas semeadas nunca
    // aparecem — a demo não tem instância na Evolution. Ver demo.ts.
    const demo = await isDemoOrg(orgId);
    return {
      enabled: demo || evo.evolutionEnabled(),
      status: demo ? 'conectado' : (s?.status ?? 'desconectado'),
      numero: s?.numero ?? null,
      include_sender_name: s?.include_sender_name ?? false,
    };
  });

  // Preferências de envio da org (admin). Hoje só o flag de prefixar o texto com o
  // nome de quem enviou — reusa whatsapp.connect (mesmo nível de config da conexão).
  app.patch('/api/whatsapp/settings', {
    preHandler: [requireAuth, requirePermission('whatsapp.connect')],
    schema: {
      body: { type: 'object', required: ['include_sender_name'], properties: { include_sender_name: { type: 'boolean' } } },
    },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    await ensureSettings(orgId);
    const { include_sender_name } = req.body as { include_sender_name: boolean };
    await query(
      'UPDATE org_whatsapp_settings SET include_sender_name = $2, updated_at = now() WHERE org_id = $1',
      [orgId, include_sender_name],
    );
    await audit(req, 'org_whatsapp_settings', orgId, 'update', { include_sender_name });
    return { ok: true };
  });

  // Inicia conexão: cria a instância (idempotente) e devolve o QR pra leitura.
  app.post('/api/whatsapp/connect', { preHandler: [requireAuth, requirePermission('whatsapp.connect')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const name = await ensureSettings(orgId);
    // Org demo já é "conectada" por definição — criar instância de verdade
    // colocaria a base de demonstração falando com números reais.
    if (await isDemoOrg(orgId)) return reply.code(409).send({ error: 'conta de demonstração: o WhatsApp já está ativo em modo demo' });
    try {
      try { await evo.createInstance(name); } catch { /* já existe: segue pro connect */ }
      // O Baileys gera o QR de forma assíncrona (~1-3s após o create). A 1ª
      // chamada de connect pode vir sem base64 (count:0) — repesca até o QR ficar
      // pronto ou a instância já estar conectada.
      let qr = await evo.connect(name);
      for (let i = 0; i < 6 && !qr.base64 && qr.state !== 'open'; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        qr = await evo.connect(name);
      }
      await setStatus(orgId, qr.state === 'open' ? 'conectado' : 'conectando');
      await audit(req, 'org_whatsapp_settings', orgId, 'connect', { instance: name });
      return { qr: qr.base64, code: qr.code, status: mapState(qr.state) };
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'falha ao conectar' });
    }
  });

  // Repesca o estado real na Evolution (o front chama em polling enquanto o QR
  // está aberto, até virar 'conectado').
  app.get('/api/whatsapp/connection', { preHandler: [requireAuth, requirePermission('whatsapp.view')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    await ensureSettings(orgId);
    // Org demo: responde conectado sem consultar a Evolution. É este endpoint
    // que o front usa para confirmar o estado real — na VPS, onde a Evolution
    // está no ar para as orgs reais, a consulta voltaria desconectado.
    if (await isDemoOrg(orgId)) return { status: 'conectado' };
    try {
      const state = await evo.connectionState(instanceName(orgId));
      const status = mapState(state);
      await setStatus(orgId, status);
      return { status };
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'falha ao consultar' });
    }
  });

  app.post('/api/whatsapp/disconnect', { preHandler: [requireAuth, requirePermission('whatsapp.connect')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    // Desconectar na demo só serviria para o visitante quebrar a própria tela
    // (cairia no QR e não teria como voltar).
    if (await isDemoOrg(orgId)) return reply.code(409).send({ error: 'conta de demonstração: não é possível desconectar' });
    try {
      await evo.logout(instanceName(orgId));
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      // logout pode falhar se já estava fora — segue zerando o status local.
    }
    await setStatus(orgId, 'desconectado', null);
    await audit(req, 'org_whatsapp_settings', orgId, 'disconnect', {});
    return { ok: true };
  });

  // Lista de conversas (lateral) com rótulos do vínculo, mais recentes primeiro.
  app.get('/api/whatsapp/chats', { preHandler: [requireAuth, requirePermission('whatsapp.view')] }, async (req) => {
    const orgId = req.auth!.orgId;
    const chats = await query(
      `${CHAT_LABELS_SQL}
        WHERE ch.org_id = $1
        ORDER BY ch.last_message_at DESC NULLS LAST
        LIMIT 200`,
      [orgId],
    );
    // Conserta nomes de grupo em massa, uma vez por sessão (não bloqueia a
    // resposta; ao terminar avisa o front pra recarregar a lista). Org demo não
    // tem grupos na Evolution para consultar — os nomes semeados já são finais.
    if (!groupsSynced.has(orgId) && !(await isDemoOrg(orgId))) {
      groupsSynced.add(orgId);
      syncGroupNames(orgId).then(
        (n) => { if (n > 0) broadcast(orgId, 'chat-foto', { chat_id: 0 }); },
        () => groupsSynced.delete(orgId), // falhou (desconectado?) — tenta de novo depois
      );
    }
    return { chats };
  });

  // Mensagens de uma conversa (ordem cronológica). Zera não-lidas localmente e
  // dispara confirmação de leitura (ticks azuis) pro contato no WhatsApp.
  // Com ?peek=1 ("espiar"), devolve as mensagens sem confirmar leitura nem zerar
  // o contador — o contato não fica sabendo que a conversa foi lida.
  app.get('/api/whatsapp/chats/:id/messages', { preHandler: [requireAuth, requirePermission('whatsapp.view')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const peek = (req.query as { peek?: string }).peek === '1';
    const chat = await one<{ id: string; remote_jid: string; nao_lidas: number }>(
      'SELECT id, remote_jid, nao_lidas FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    // Ordem: (momento, id). O momento sozinho não basta — o timestamp do WhatsApp
    // é em segundos, então mensagens da mesma rajada empatam e sairiam em ordem
    // arbitrária; o id (identity) desempata na ordem de gravação.
    // A janela é das 500 MAIS RECENTES (subselect DESC), devolvida em ordem
    // cronológica: com ORDER BY ... ASC LIMIT 500 direto, uma conversa longa
    // abriria mostrando as 500 mais antigas e escondendo as de hoje.
    const messages = await query<{ id: string; evolution_id: string | null; from_me: boolean }>(
      `SELECT * FROM (
         SELECT m.id, m.evolution_id, m.from_me, m.tipo, m.corpo, m.status, m.momento, m.mime, m.file_name, m.internal, m.reply_to_id,
                COALESCE(u.nome, o.nome, u.email) AS sender_nome
           FROM whatsapp_messages m
           LEFT JOIN users u ON u.id = m.sender_user_id
           LEFT JOIN organizations o ON o.id = u.org_id
          WHERE m.chat_id = $1 AND m.org_id = $2
          ORDER BY m.momento DESC, m.id DESC
          LIMIT 500
       ) t ORDER BY t.momento, t.id`,
      [chatId, orgId],
    );
    // Confirma leitura no WhatsApp só se havia não-lidas (evita chamada à toa).
    // Espiando, pula tudo: nem ticks azuis nem zerar o contador.
    if (!peek) {
      if (chat.nao_lidas > 0) {
        const reads = messages
          .filter((m) => !m.from_me && m.evolution_id)
          .slice(-30)
          .map((m) => ({ id: m.evolution_id as string, remoteJid: chat.remote_jid, fromMe: false }));
        evo.markRead(instanceName(orgId), reads).catch(() => undefined); // best-effort
      }
      await query('UPDATE whatsapp_chats SET nao_lidas = 0 WHERE id = $1 AND org_id = $2', [chatId, orgId]);
    }
    return { messages };
  });

  // Marca conversa como lida sem refazer o fetch das mensagens. Usado quando uma
  // mensagem chega numa conversa já aberta (zera o contador no servidor pra não
  // reaparecer no próximo loadChats) e confirma leitura (ticks azuis) no WhatsApp.
  app.post('/api/whatsapp/chats/:id/read', { preHandler: [requireAuth, requirePermission('whatsapp.view')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const chat = await one<{ id: string; remote_jid: string; nao_lidas: number }>(
      'SELECT id, remote_jid, nao_lidas FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    if (chat.nao_lidas > 0) {
      const reads = await query<{ evolution_id: string | null }>(
        `SELECT evolution_id FROM whatsapp_messages
          WHERE chat_id = $1 AND org_id = $2 AND from_me = false AND evolution_id IS NOT NULL
          ORDER BY momento DESC, id DESC LIMIT 30`,
        [chatId, orgId],
      );
      const payload = reads.map((m) => ({ id: m.evolution_id as string, remoteJid: chat.remote_jid, fromMe: false }));
      if (payload.length) evo.markRead(instanceName(orgId), payload).catch(() => undefined); // best-effort
    }
    await query('UPDATE whatsapp_chats SET nao_lidas = 0 WHERE id = $1 AND org_id = $2', [chatId, orgId]);
    return { ok: true };
  });

  // Proxy de mídia: <img>/<audio>/<video>/<a> apontam pra cá (?token=JWT, já que
  // tag de mídia não manda header Authorization). Serve do disco (media_path) ou
  // do base64 legado; na 1ª vez baixa da Evolution e cacheia (disco se habilitado,
  // senão base64 na linha).
  // compress:false — binário já vai íntegro (comprimir mídia só queima CPU e
  // atrapalha o content-length do stream).
  app.get('/api/whatsapp/messages/:id/media', { compress: false }, async (req, reply) => {
    // Token pelo header Authorization (preferido — não vaza na URL/histórico/logs);
    // fallback pra ?token= por compat (fetch autenticado do client usa o header).
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as { token?: string }).token;
    if (!token) return reply.code(401).send({ error: 'sem token' });
    let orgId: number;
    // authorizeToken: valida ativo/token_version/whatsapp.view (verifyToken cru
    // deixava usuário desativado/sem permissão baixar mídia da org por 7 dias).
    try { orgId = (await authorizeToken(token, 'whatsapp.view')).orgId; }
    catch (e) { return reply.code(e instanceof AuthError ? 403 : 401).send({ error: 'não autorizado' }); }
    const id = (req.params as { id: string }).id;
    const m = await one<{ evolution_id: string | null; from_me: boolean; tipo: string; mime: string | null; file_name: string | null; media_b64: string | null; media_path: string | null; remote_jid: string }>(
      `SELECT m.evolution_id, m.from_me, m.tipo, m.mime, m.file_name, m.media_b64, m.media_path, c.remote_jid
         FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id
        WHERE m.id = $1 AND m.org_id = $2`,
      [id, orgId],
    );
    if (!m || m.tipo === 'texto') return reply.code(404).send({ error: 'sem mídia' });

    // Mídia é imutável por mensagem: cache privado de 1 dia + ETag pelo id da
    // mensagem — revalidação vira 304 sem reler o arquivo. Headers só nas
    // respostas de mídia (304/200) pra não cachear resposta de erro.
    const etag = `"wa-media-${id}"`;
    const cacheHeaders = (): void => {
      reply.header('etag', etag);
      reply.header('cache-control', 'private, max-age=86400, immutable');
      // nosniff: impede o browser de reinterpretar o corpo como HTML/JS ignorando o
      // content-type que sanitizamos abaixo.
      reply.header('x-content-type-options', 'nosniff');
    };
    // Sanitiza o content-type: o mime vem do metadata do contato remoto (não
    // confiável). Servir cru + inline permitia XSS armazenado (mime text/html com
    // JS executa na origem do app, com o token na URL). Fora da allowlist →
    // octet-stream + attachment (download, nunca renderiza).
    const applyType = (rawMime: string | null): string => {
      const safe = safeMediaType(rawMime);
      const fname = m.file_name ? m.file_name.replace(/[\r\n"]/g, '') : null;
      const disp = safe.inline ? 'inline' : 'attachment';
      reply.header('content-disposition', fname ? `${disp}; filename="${fname}"` : disp);
      return safe.type;
    };
    if (req.headers['if-none-match'] === etag) {
      cacheHeaders();
      return reply.code(304).send();
    }

    let buf: Buffer | null = null;
    let mime = m.mime;
    // 1) disco (preferido): streama direto, sem carregar o arquivo inteiro em
    // memória. Arquivo sumido cai pro rebaixar abaixo.
    if (m.media_path) {
      try {
        const { stream, size } = await mediaStream(m.media_path);
        cacheHeaders();
        reply.header('content-length', size);
        return reply.type(applyType(mime)).send(stream);
      } catch { /* cai pros fallbacks */ }
    }
    // 2) base64 legado na linha.
    if (!buf && m.media_b64) buf = Buffer.from(m.media_b64, 'base64');
    // 3) 1ª vez: baixa da Evolution e persiste.
    if (!buf) {
      if (!m.evolution_id) return reply.code(404).send({ error: 'mídia indisponível' });
      try {
        const got = await evo.getMediaBase64(instanceName(orgId), { id: m.evolution_id, remoteJid: m.remote_jid, fromMe: m.from_me });
        mime = mime ?? got.mimetype ?? null;
        if (mediaEnabled()) {
          const rel = await saveMedia(orgId, id, got.base64, mime, m.file_name);
          await query('UPDATE whatsapp_messages SET media_path = $2, mime = COALESCE(mime,$3) WHERE id = $1', [id, rel, mime]);
        } else {
          await query('UPDATE whatsapp_messages SET media_b64 = $2, mime = COALESCE(mime,$3) WHERE id = $1', [id, got.base64, mime]);
        }
        buf = Buffer.from(got.base64, 'base64');
      } catch (e) {
        if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
        return reply.code(502).send({ error: 'falha ao baixar mídia' });
      }
    }
    cacheHeaders();
    return reply.type(applyType(mime)).send(buf);
  });

  // Proxy da foto de perfil da conversa. O client NÃO aponta o <img> pro CDN do
  // WhatsApp: a CSP do app (helmet, app.ts) só libera imagens da própria origem,
  // as URLs do pps caducam (param `oe`) e o hotlink vazaria o IP do usuário pro
  // CDN da Meta. Aqui o app baixa os bytes uma vez, cacheia (disco ou base64 na
  // linha, igual à mídia) e serve same-origin. URL caduca → rebaixa a URL na
  // Evolution e tenta de novo. compress:false: JPEG/PNG já vêm comprimidos.
  app.get('/api/whatsapp/chats/:id/foto', { compress: false }, async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as { token?: string }).token;
    if (!token) return reply.code(401).send({ error: 'sem token' });
    let orgId: number;
    try { orgId = (await authorizeToken(token, 'whatsapp.view')).orgId; }
    catch (e) { return reply.code(e instanceof AuthError ? 403 : 401).send({ error: 'não autorizado' }); }
    const id = (req.params as { id: string }).id;
    const chat = await one<{ id: string; remote_jid: string; numero: string | null; foto_url: string | null; foto_path: string | null; foto_b64: string | null; foto_mime: string | null }>(
      `SELECT id, remote_jid, numero, foto_url, foto_path, foto_b64, foto_mime
         FROM whatsapp_chats WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });

    // ETag pela URL de origem: mudou a foto no WhatsApp → muda a URL → muda o
    // ETag. no-cache (revalida sempre) porque o path da requisição é fixo: com
    // max-age o browser serviria a foto antiga até expirar.
    const etag = `"wa-foto-${id}-${createHash('sha1').update(chat.foto_url ?? '').digest('hex').slice(0, 16)}"`;
    const serve = (buf: Buffer | ReadStream, mime: string | null, size?: number): unknown => {
      reply.header('etag', etag);
      reply.header('cache-control', 'private, no-cache');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-disposition', 'inline');
      if (size !== undefined) reply.header('content-length', size);
      // Allowlist estreita: só os formatos que aceitamos ao baixar (whatsapp.ts).
      const safe = mime && ['image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : 'application/octet-stream';
      return reply.type(safe).send(buf);
    };
    if (req.headers['if-none-match'] === etag && (chat.foto_path || chat.foto_b64)) {
      reply.header('etag', etag);
      reply.header('cache-control', 'private, no-cache');
      return reply.code(304).send();
    }

    // 1) cache em disco (preferido) → 2) base64 na linha.
    if (chat.foto_path) {
      try {
        const { stream, size } = await mediaStream(chat.foto_path);
        return serve(stream, chat.foto_mime, size);
      } catch { /* arquivo sumiu: rebaixa abaixo */ }
    }
    if (chat.foto_b64) return serve(Buffer.from(chat.foto_b64, 'base64'), chat.foto_mime);

    // 3) sem cache: baixa da URL conhecida; se falhar (URL expirada ou ausente),
    // pede a URL atual pra Evolution e tenta uma vez mais.
    let got = chat.foto_url ? await downloadFoto(chat.foto_url) : null;
    if (!got) {
      const fresh = await refreshFotoUrl(orgId, chat.remote_jid).catch(() => null);
      if (!fresh) return reply.code(404).send({ error: 'sem foto' });
      await updateFotoById(orgId, chat.id, fresh);
      got = await downloadFoto(fresh);
      if (!got) return reply.code(404).send({ error: 'sem foto' });
    }
    // Persiste o cache (best-effort: falha de escrita não impede servir agora).
    try {
      if (mediaEnabled()) {
        const rel = await saveAvatar(orgId, chat.id, got.buf, got.mime);
        await query('UPDATE whatsapp_chats SET foto_path = $2, foto_mime = $3, foto_at = now() WHERE id = $1', [chat.id, rel, got.mime]);
      } else {
        await query('UPDATE whatsapp_chats SET foto_b64 = $2, foto_mime = $3, foto_at = now() WHERE id = $1', [chat.id, got.buf.toString('base64'), got.mime]);
      }
    } catch { /* segue e serve os bytes mesmo sem cachear */ }
    return serve(got.buf, got.mime);
  });

  // Envia texto numa conversa existente. Persiste a mensagem própria, atualiza a
  // prévia da conversa e empurra pro WebSocket (espelho nas outras abas).
  app.post('/api/whatsapp/chats/:id/send', {
    preHandler: [requireAuth, requirePermission('whatsapp.send')],
    schema: {
      body: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const { text } = req.body as { text: string };
    const chat = await one<{ remote_jid: string; numero: string | null }>(
      'SELECT remote_jid, numero FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    if (!chat.numero && chat.remote_jid.endsWith('@lid')) {
      return reply.code(422).send({ error: 'Contato sem número de telefone (LID — o WhatsApp ocultou o número). Concilie esta conversa com a de telefone do mesmo contato para poder enviar.' });
    }
    try {
      // Prefixa só o texto que sai pro contato (quando a org liga o flag); o corpo
      // guardado e a prévia ficam crus — o app já rotula o remetente no balão.
      const outgoing = await applySenderPrefix(orgId, req.auth!.userId, text) ?? text;
      // Org demo: circuito fechado — a mensagem é gravada e espelhada no WS
      // como qualquer outra, mas nada é entregue a um número real. Sem
      // evolution_id (não existe mensagem lá fora para deduplicar depois).
      const sent = await isDemoOrg(orgId)
        ? null
        : await evo.sendText(instanceName(orgId), chat.numero || chat.remote_jid, outgoing);
      const evolutionId = sent?.key?.id ?? null;
      const msg = await insertMessage(orgId, chatId, { evolutionId, fromMe: true, corpo: text, status: 'enviado', senderUserId: req.auth!.userId });
      await upsertChat(orgId, chat.remote_jid, { preview: text, incNaoLidas: false });
      if (msg) broadcast(orgId, 'message', { chat_id: Number(chatId), message: msg });
      return { message: msg };
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'falha ao enviar' });
    }
  });

  // Nota interna: balão que fica só na conversa (visível a toda a organização),
  // NUNCA enviado ao contato — sem chamada à Evolution, sem evolution_id e sem
  // mexer na prévia da conversa. Só exige whatsapp.view (anotar não é enviar).
  app.post('/api/whatsapp/chats/:id/note', {
    preHandler: [requireAuth, requirePermission('whatsapp.view')],
    // replyToId (id do balão citado) fica fora do schema de propósito: chega no
    // body e é validado contra o banco abaixo (existência na conversa).
    schema: {
      body: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } } },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const { text, replyToId } = req.body as { text: string; replyToId?: number | string | null };
    const chat = await one<{ id: string }>(
      'SELECT id FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    // Só ancora se a mensagem citada existir nesta conversa (id otimista/negativo
    // ou de outra conversa vira nota solta, sem âncora quebrada).
    let replyTo: number | null = null;
    if (replyToId != null && Number(replyToId) > 0) {
      const ref = await one<{ id: string }>(
        'SELECT id FROM whatsapp_messages WHERE id = $1 AND chat_id = $2 AND org_id = $3', [Number(replyToId), chatId, orgId],
      );
      if (ref) replyTo = Number(ref.id);
    }
    const msg = await insertMessage(orgId, chatId, { fromMe: true, corpo: text, internal: true, senderUserId: req.auth!.userId, replyToId: replyTo });
    if (msg) broadcast(orgId, 'message', { chat_id: Number(chatId), message: msg });
    return { message: msg };
  });

  // Envia mídia (anexo): base64 vindo do upload do navegador. Cacheia o próprio
  // base64 na linha pra exibir de imediato sem rebaixar da Evolution.
  app.post('/api/whatsapp/chats/:id/send-media', {
    preHandler: [requireAuth, requirePermission('whatsapp.send')],
    // Anexo chega como base64 num JSON — o limite padrão de body (1MB) barraria
    // qualquer mídia real. 15MB cobre os anexos aceitos pelo front.
    bodyLimit: 15 * 1024 * 1024,
    schema: {
      body: {
        type: 'object',
        required: ['media', 'mediatype'],
        properties: {
          media: { type: 'string', minLength: 1 },          // base64 sem prefixo data:
          mediatype: { type: 'string', enum: ['image', 'video', 'document', 'audio'] },
          mimetype: { type: ['string', 'null'] },
          fileName: { type: ['string', 'null'] },
          caption: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const b = req.body as { media: string; mediatype: 'image' | 'video' | 'document' | 'audio'; mimetype?: string | null; fileName?: string | null; caption?: string | null };
    const chat = await one<{ remote_jid: string; numero: string | null }>(
      'SELECT remote_jid, numero FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    if (!chat.numero && chat.remote_jid.endsWith('@lid')) {
      return reply.code(422).send({ error: 'Contato sem número de telefone (LID). Concilie com a conversa de telefone do contato para poder enviar.' });
    }
    const dest = chat.numero || chat.remote_jid;
    const name = instanceName(orgId);
    try {
      // Legenda que vai pro contato leva o prefixo do remetente (quando ligado);
      // corpo guardado fica cru. Áudio não tem legenda.
      const outCaption = await applySenderPrefix(orgId, req.auth!.userId, b.caption ?? null);
      // Org demo: só persiste o anexo (mesma regra do envio de texto).
      const sent = await isDemoOrg(orgId)
        ? null
        : b.mediatype === 'audio'
          ? await evo.sendAudio(name, dest, b.media)
          : await evo.sendMedia(name, dest, {
              mediatype: b.mediatype, media: b.media,
              mimetype: b.mimetype ?? undefined, fileName: b.fileName ?? undefined, caption: outCaption ?? undefined,
            });
      const tipo = b.mediatype === 'image' ? 'imagem' : b.mediatype === 'video' ? 'video' : b.mediatype === 'audio' ? 'audio' : 'documento';
      // Com disco habilitado grava o binário no volume; senão cacheia o base64 na
      // linha (pra exibir de imediato sem rebaixar da Evolution).
      const disk = mediaEnabled();
      const msg = await insertMessage(orgId, chatId, {
        evolutionId: sent?.key?.id ?? null, fromMe: true, tipo, corpo: b.caption ?? null,
        status: 'enviado', mime: b.mimetype ?? null, fileName: b.fileName ?? null,
        mediaB64: disk ? null : b.media, senderUserId: req.auth!.userId,
      });
      if (msg && disk) {
        const rel = await saveMedia(orgId, msg.id, b.media, b.mimetype ?? null, b.fileName ?? null);
        await query('UPDATE whatsapp_messages SET media_path = $2 WHERE id = $1', [msg.id, rel]);
      }
      await upsertChat(orgId, chat.remote_jid, { preview: b.caption || `[${tipo}]`, incNaoLidas: false });
      if (msg) broadcast(orgId, 'message', { chat_id: Number(chatId), message: msg });
      return { message: msg };
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'falha ao enviar mídia' });
    }
  });

  // Vincula (ou desvincula) a conversa a uma empresa da base. Resolve o
  // relationship do funil daquela empresa, se existir. Habilita "criar pedido".
  app.patch('/api/whatsapp/chats/:id/link', {
    preHandler: [requireAuth, requirePermission('whatsapp.link')],
    schema: { body: { type: 'object', properties: { company_id: { type: ['integer', 'null'] } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const { company_id } = req.body as { company_id?: number | null };
    const chat = await one<{ id: string }>('SELECT id FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId]);
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    let relId: string | null = null;
    if (company_id != null) { const r = await relationshipForCompany(orgId, company_id); relId = r?.id ?? null; }
    await query('UPDATE whatsapp_chats SET company_id = $3, relationship_id = $4 WHERE id = $1 AND org_id = $2',
      [chatId, orgId, company_id ?? null, relId]);
    await audit(req, 'whatsapp_chat', chatId, 'link', { company_id: company_id ?? null });
    const out = await one(`${CHAT_LABELS_SQL} WHERE ch.id = $1 AND ch.org_id = $2`, [chatId, orgId]);
    return { chat: out };
  });

  // Vincula (ou desvincula) a conversa a um contato (pessoa) da base. Usado pelo
  // "Salvar contato": a conversa passa a exibir o nome do contato e o vínculo
  // persiste, mesmo sem empresa vinculada. contact_id=null desfaz.
  app.patch('/api/whatsapp/chats/:id/contact', {
    preHandler: [requireAuth, requirePermission('whatsapp.link')],
    schema: { body: { type: 'object', properties: { contact_id: { type: ['integer', 'null'] } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const { contact_id } = req.body as { contact_id?: number | null };
    const chat = await one<{ id: string }>('SELECT id FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId]);
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    if (contact_id != null) {
      const ct = await one<{ id: string }>('SELECT id FROM contacts WHERE id = $1 AND org_id = $2', [contact_id, orgId]);
      if (!ct) return reply.code(400).send({ error: 'contato inválido' });
    }
    await query('UPDATE whatsapp_chats SET contact_id = $3 WHERE id = $1 AND org_id = $2', [chatId, orgId, contact_id ?? null]);
    await audit(req, 'whatsapp_chat', chatId, 'link_contact', { contact_id: contact_id ?? null });
    const out = await one(`${CHAT_LABELS_SQL} WHERE ch.id = $1 AND ch.org_id = $2`, [chatId, orgId]);
    return { chat: out };
  });

  // Informa o telefone de um contato que chegou só como LID (número oculto).
  // Grava o número no contato e registra o jid de telefone como alias da conversa
  // — assim o envio passa a funcionar (sai pelo número).
  //
  // A validação no WhatsApp (whatsappNumbers) é best-effort: confirma existência
  // e traz o jid canônico quando dá. Só bloqueia (422) quando a Evolution
  // responde e afirma que o número não existe. Se a Evolution estiver instável
  // (ex.: socket sem `onWhatsApp` -> 400) NÃO trava a confirmação — o usuário
  // informou o número explicitamente e o envio ainda vai tentar por ele.
  app.patch('/api/whatsapp/chats/:id/numero', {
    preHandler: [requireAuth, requirePermission('whatsapp.link')],
    schema: { body: { type: 'object', required: ['numero'], properties: { numero: { type: 'string', minLength: 8 } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const { numero } = req.body as { numero: string };
    const chat = await one<{ id: string }>('SELECT id FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId]);
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    const digits = normalizeNumero(numero);
    if (digits.length < 12) return reply.code(400).send({ error: 'número inválido (use DDD + número)' });
    let jid = `${digits}@s.whatsapp.net`;
    // Org demo: aceita o número como informado (não há instância para conferir
    // se ele existe no WhatsApp, e o envio nunca sai daqui mesmo).
    const demo = await isDemoOrg(orgId);
    try {
      const res = demo ? [] : await evo.whatsappNumbers(instanceName(orgId), [digits]);
      const hit = res.find((r) => r.exists);
      if (hit?.jid) jid = hit.jid;
      // Só nega quando a Evolution devolveu resultado e nenhum existe. Resposta
      // vazia = não confirmou nem negou; segue com o jid montado.
      else if (res.length > 0) return reply.code(422).send({ error: 'número não encontrado no WhatsApp' });
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      // Falha transiente da Evolution não bloqueia: salva com o jid montado.
      app.log.warn({ err: e, orgId, chatId }, 'whatsappNumbers falhou; salvando número sem validação');
    }
    await query('UPDATE whatsapp_chats SET numero = $3 WHERE id = $1 AND org_id = $2', [chatId, orgId, jidToNumero(jid)]);
    await query(
      `INSERT INTO whatsapp_chat_jids (org_id, jid, chat_id, tipo)
         VALUES ($1, $2, $3, 'phone') ON CONFLICT (org_id, jid) DO NOTHING`,
      [orgId, jid, chatId],
    );
    await audit(req, 'whatsapp_chat', chatId, 'set-numero', { numero: jidToNumero(jid) });
    const out = await one(`${CHAT_LABELS_SQL} WHERE ch.id = $1 AND ch.org_id = $2`, [chatId, orgId]);
    return { chat: out };
  });

  // Dados do grupo (painel de detalhes): descrição + participantes.
  app.get('/api/whatsapp/chats/:id/group', { preHandler: [requireAuth, requirePermission('whatsapp.view')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const id = (req.params as { id: string }).id;
    const chat = await one<{ remote_jid: string; nome: string | null }>(
      'SELECT remote_jid, nome FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [id, orgId],
    );
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    if (!chat.remote_jid.endsWith('@g.us')) return reply.code(400).send({ error: 'conversa não é um grupo' });
    // Org demo: descrição e participantes moram na Evolution, que não existe
    // aqui. Devolve o que a base tem, sem 502 no painel de detalhes.
    if (await isDemoOrg(orgId)) {
      return { subject: chat.nome ?? 'Grupo', desc: null, size: 0, participants: [] };
    }
    try {
      const g = await evo.groupDetails(instanceName(orgId), chat.remote_jid);
      const participants = g.participants.map((p) => ({ numero: jidToNumero(p.id), jid: p.id, admin: p.admin }));
      return { subject: g.subject, desc: g.desc, size: g.size, participants };
    } catch (e) {
      if (e instanceof evo.EvolutionDisabledError) return reply.code(503).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'falha ao buscar grupo' });
    }
  });

  // Concilia duas conversas do mesmo contato (telefone + @lid) numa só. `id` é a
  // conversa que permanece (primária); `other_id` é absorvida e removida.
  app.post('/api/whatsapp/chats/:id/merge', {
    preHandler: [requireAuth, requirePermission('whatsapp.link')],
    schema: { body: { type: 'object', required: ['other_id'], properties: { other_id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const id = (req.params as { id: string }).id;
    const { other_id } = req.body as { other_id: number };
    if (String(other_id) === String(id)) return reply.code(400).send({ error: 'selecione outra conversa' });
    try {
      await mergeChats(orgId, Number(id), Number(other_id));
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'falha ao conciliar' });
    }
    await audit(req, 'whatsapp_chat', id, 'merge', { other_id });
    broadcast(orgId, 'merged', { chat_id: Number(id), removed_id: Number(other_id) });
    const out = await one(`${CHAT_LABELS_SQL} WHERE ch.id = $1 AND ch.org_id = $2`, [id, orgId]);
    return { chat: out };
  });

  // Apaga a conversa (espelho local): mensagens, aliases e agendamentos somem
  // por ON DELETE CASCADE. Avisa as outras abas pelo WebSocket.
  app.delete('/api/whatsapp/chats/:id', { preHandler: [requireAuth, requirePermission('whatsapp.link')] }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const id = (req.params as { id: string }).id;
    const ok = await deleteChat(orgId, Number(id));
    if (!ok) return reply.code(404).send({ error: 'conversa não encontrada' });
    await audit(req, 'whatsapp_chat', id, 'delete', {});
    broadcast(orgId, 'chat-removed', { chat_id: Number(id) });
    return { ok: true };
  });

  // Abre/retoma uma conversa a partir de uma empresa do funil (ação no Kanban).
  // Cria o chat para o telefone informado e já vincula empresa + relationship.
  app.post('/api/whatsapp/chats/from-company', {
    preHandler: [requireAuth, requirePermission('whatsapp.send')],
    schema: {
      body: {
        type: 'object', required: ['company_id', 'numero'],
        properties: { company_id: { type: 'integer' }, numero: { type: 'string', minLength: 8 }, nome: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { company_id, numero, nome: nomeBody } = req.body as { company_id: number; numero: string; nome?: string };
    const jid = numeroToJid(numero);
    if (jid.replace(/[^0-9]/g, '').length < 12) return reply.code(400).send({ error: 'número inválido' });
    const co = await one<{ razao_social: string; nome_fantasia: string | null }>(
      'SELECT razao_social, nome_fantasia FROM companies WHERE id = $1', [company_id],
    );
    // Nome explícito (ex.: conversa iniciada por um contato vinculado) tem prioridade
    // sobre o nome da empresa, pra a conversa exibir o contato e não a empresa.
    const nome = nomeBody?.trim() || (co ? (co.nome_fantasia || co.razao_social) : null);
    // Retoma conversa existente do mesmo telefone (tolerante ao nono dígito /
    // @lid) sem renomear nem mexer no histórico; só cria quando não há nenhuma.
    const existing = await findChatByNumero(orgId, numero);
    const chat = existing ?? await upsertChat(orgId, jid, { nome, incNaoLidas: false });
    const rel = await relationshipForCompany(orgId, company_id);
    await query('UPDATE whatsapp_chats SET company_id = $3, relationship_id = $4 WHERE id = $1 AND org_id = $2',
      [chat.id, orgId, company_id, rel?.id ?? null]);
    const out = await one(`${CHAT_LABELS_SQL} WHERE ch.id = $1 AND ch.org_id = $2`, [chat.id, orgId]);
    return reply.code(201).send({ chat: out });
  });

  // Agenda uma mensagem de texto pra uma conversa (envio pelo processador).
  app.post('/api/whatsapp/chats/:id/schedule', {
    preHandler: [requireAuth, requirePermission('whatsapp.schedule')],
    schema: {
      body: {
        type: 'object', required: ['text', 'agendado_para'],
        properties: {
          text: { type: 'string', minLength: 1 },
          agendado_para: { type: 'string', minLength: 10 },
          recorrencia: { type: ['string', 'null'], enum: [...WA_RECORRENCIAS, null] },
          quantidade: { type: 'integer', minimum: 1, maximum: 60 },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const chatId = (req.params as { id: string }).id;
    const { text, agendado_para, recorrencia, quantidade } = req.body as { text: string; agendado_para: string; recorrencia?: WaRecorrencia | null; quantidade?: number };
    const chat = await one<{ remote_jid: string; nome: string | null; numero: string | null; company_id: string | null }>(
      'SELECT remote_jid, nome, numero, company_id FROM whatsapp_chats WHERE id = $1 AND org_id = $2', [chatId, orgId]);
    if (!chat) return reply.code(404).send({ error: 'conversa não encontrada' });
    // Mesmo bloqueio do envio interativo: LID sem número não tem destinatário.
    if (!chat.numero && chat.remote_jid.endsWith('@lid')) {
      return reply.code(422).send({ error: 'Contato sem número de telefone (LID — o WhatsApp ocultou o número). Concilie esta conversa com a de telefone do mesmo contato para poder agendar.' });
    }
    const when = new Date(agendado_para);
    if (Number.isNaN(when.getTime())) return reply.code(400).send({ error: 'data inválida' });

    // Espelha na Agenda: compromisso 'whatsapp' + agendamento, numa transação só.
    const alvo = chat.nome || chat.numero || chat.remote_jid.split('@')[0];
    const titulo = `WhatsApp p/ ${alvo}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
    const row = await scheduleWhatsappTx(orgId, {
      chatId, remoteJid: chat.remote_jid, companyId: chat.company_id, contactId: null,
      ownerUserId: req.auth!.userId, text, when, titulo, recorrencia: recorrencia ?? null, quantidade,
    });
    return reply.code(201).send({ schedule: row });
  });

  // Agenda uma mensagem de WhatsApp direto pela Agenda (sem conversa aberta): o
  // destino vem de um número livre; empresa/contato são vínculos opcionais que
  // rotulam a conversa e o compromisso espelho. Cria/retoma a conversa e agenda.
  app.post('/api/whatsapp/chats/schedule-direct', {
    preHandler: [requireAuth, requirePermission('whatsapp.schedule')],
    schema: {
      body: {
        type: 'object', required: ['numero', 'text', 'agendado_para'],
        properties: {
          numero: { type: 'string', minLength: 8 },
          text: { type: 'string', minLength: 1 },
          agendado_para: { type: 'string', minLength: 10 },
          recorrencia: { type: ['string', 'null'], enum: [...WA_RECORRENCIAS, null] },
          quantidade: { type: 'integer', minimum: 1, maximum: 60 },
          company_id: { type: ['integer', 'null'] },
          contact_id: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const b = req.body as { numero: string; text: string; agendado_para: string; recorrencia?: WaRecorrencia | null; quantidade?: number; company_id?: number | null; contact_id?: number | null };
    const badRef = await invalidOrgRef(orgId, b, ['contact_id']);
    if (badRef) return reply.code(400).send({ error: `${badRef} inválido` });
    const jid = numeroToJid(b.numero);
    if (jid.replace(/[^0-9]/g, '').length < 12) return reply.code(400).send({ error: 'número inválido' });
    const when = new Date(b.agendado_para);
    if (Number.isNaN(when.getTime())) return reply.code(400).send({ error: 'data inválida' });

    // Nome da conversa: contato vinculado > empresa > (fica sem nome, usa o número).
    let nome: string | null = null;
    if (b.contact_id != null) {
      const ct = await one<{ nome: string }>('SELECT nome FROM contacts WHERE id = $1 AND org_id = $2', [b.contact_id, orgId]);
      nome = ct?.nome ?? null;
    }
    if (!nome && b.company_id != null) {
      const co = await one<{ razao_social: string; nome_fantasia: string | null }>(
        'SELECT razao_social, nome_fantasia FROM companies WHERE id = $1', [b.company_id]);
      nome = co ? (co.nome_fantasia || co.razao_social) : null;
    }
    const chat = await upsertChat(orgId, jid, { nome, incNaoLidas: false });
    // Vincula empresa + relationship (igual ao from-company) quando houver empresa.
    if (b.company_id != null) {
      const rel = await relationshipForCompany(orgId, b.company_id);
      await query('UPDATE whatsapp_chats SET company_id = $3, relationship_id = COALESCE($4, relationship_id) WHERE id = $1 AND org_id = $2',
        [chat.id, orgId, b.company_id, rel?.id ?? null]);
    }
    const alvo = nome || chat.numero || jid.split('@')[0];
    const titulo = `WhatsApp p/ ${alvo}: ${b.text.length > 60 ? `${b.text.slice(0, 60)}…` : b.text}`;
    const row = await scheduleWhatsappTx(orgId, {
      chatId: chat.id, remoteJid: chat.remote_jid, companyId: b.company_id ?? chat.company_id,
      contactId: b.contact_id ?? null, ownerUserId: req.auth!.userId, text: b.text, when, titulo,
      recorrencia: b.recorrencia ?? null, quantidade: b.quantidade,
    });
    return reply.code(201).send({ schedule: row });
  });

  // Agendamentos pendentes (opcionalmente de uma conversa).
  app.get('/api/whatsapp/schedules', {
    preHandler: [requireAuth, requirePermission('whatsapp.view')],
    schema: { querystring: { type: 'object', properties: { chat_id: { type: 'integer' } } } },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const { chat_id } = req.query as { chat_id?: number };
    // Inclui pendentes E os já processados (enviado/erro/expirado) p/ o modal
    // mostrar o histórico riscado; só esconde os cancelados.
    const where = ['org_id = $1', "status <> 'cancelado'"];
    const params: unknown[] = [orgId];
    if (chat_id != null) { params.push(chat_id); where.push(`chat_id = $${params.length}`); }
    const schedules = await query(
      `SELECT id, chat_id, corpo, agendado_para, status, recorrencia, serie_id FROM whatsapp_schedules
        WHERE ${where.join(' AND ')} ORDER BY agendado_para LIMIT 200`,
      params,
    );
    return { schedules };
  });

  // Edita um agendamento pendente. scope='serie' aplica na série inteira (linhas
  // pendentes com o mesmo serie_id); 'one' só nesta ocorrência. Mudar
  // recorrencia/quantidade REGENERA as ocorrências pendentes (apaga e recria a
  // série a partir de agendado_para ou da 1ª pendente).
  app.patch('/api/whatsapp/schedules/:id', {
    preHandler: [requireAuth, requirePermission('whatsapp.schedule')],
    schema: {
      body: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['one', 'serie'] },
          text: { type: 'string', minLength: 1 },
          agendado_para: { type: 'string', minLength: 10 },
          recorrencia: { type: 'string', enum: [...WA_RECORRENCIAS] },
          quantidade: { type: 'integer', minimum: 2, maximum: 60 },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const id = (req.params as { id: string }).id;
    const b = req.body as { scope?: 'one' | 'serie'; text?: string; agendado_para?: string; recorrencia?: WaRecorrencia; quantidade?: number };
    const cur = await one<{
      serie_id: string | null; status: string; chat_id: string | null; remote_jid: string; corpo: string;
      agendado_para: string; owner_user_id: string | null; act_company: string | null; act_contact: string | null;
      chat_jid: string | null; chat_numero: string | null; chat_nome: string | null; chat_company: string | null;
    }>(
      `SELECT s.serie_id, s.status, s.chat_id, s.remote_jid, s.corpo, s.agendado_para, s.owner_user_id,
              a.company_id AS act_company, a.contact_id AS act_contact,
              ch.remote_jid AS chat_jid, ch.numero AS chat_numero, ch.nome AS chat_nome, ch.company_id AS chat_company
         FROM whatsapp_schedules s
         LEFT JOIN activities a ON a.id = s.activity_id AND a.org_id = s.org_id
         LEFT JOIN whatsapp_chats ch ON ch.id = s.chat_id AND ch.org_id = s.org_id
        WHERE s.id = $1 AND s.org_id = $2`, [id, orgId]);
    if (!cur) return reply.code(404).send({ error: 'agendamento não encontrado' });
    if (cur.status !== 'pendente') return reply.code(409).send({ error: 'agendamento já processado' });

    const scope = b.scope ?? 'one';
    const serieMode = scope === 'serie' && cur.serie_id != null;
    const alvo = cur.chat_nome || cur.chat_numero || (cur.chat_jid ?? cur.remote_jid).split('@')[0] || '';
    // Regenera quando muda a quantidade, ou quando já é série e muda a frequência.
    // Frequência isolada num agendamento avulso não vira série por acidente.
    const regen = b.quantidade !== undefined || (cur.serie_id != null && b.recorrencia !== undefined);

    // Alvos pendentes: a série inteira (serie) ou só esta ocorrência.
    const alvos = serieMode
      ? await query<{ id: string; activity_id: string | null; agendado_para: string }>(
        `SELECT id, activity_id, agendado_para FROM whatsapp_schedules
          WHERE org_id = $1 AND serie_id = $2 AND status = 'pendente' ORDER BY agendado_para`, [orgId, cur.serie_id])
      : [{ id, activity_id: null as string | null, agendado_para: cur.agendado_para }];

    if (regen) {
      // Regenera a série: apaga as ocorrências pendentes-alvo + compromissos e
      // recria N a partir da base, mantendo o serie_id (ou criando um novo).
      const base = b.agendado_para ? new Date(b.agendado_para) : new Date(alvos[0]!.agendado_para);
      if (Number.isNaN(base.getTime())) return reply.code(400).send({ error: 'data inválida' });
      const text = b.text ?? cur.corpo;
      const rec = b.recorrencia
        ?? (alvos.length >= 2 ? inferRecorrencia(new Date(alvos[0]!.agendado_para), new Date(alvos[1]!.agendado_para)) : null);
      if (!rec) return reply.code(400).send({ error: 'informe a frequência (recorrencia) para regenerar' });
      const qtd = b.quantidade ?? Math.max(2, alvos.length);
      const created = await withClient(async (c) => {
        await c.query('BEGIN');
        try {
          const actIds = alvos.map((a) => a.activity_id).filter((x): x is string => x != null);
          await c.query(`DELETE FROM whatsapp_schedules WHERE org_id = $1 AND id = ANY($2::bigint[])`, [orgId, alvos.map((a) => a.id)]);
          if (actIds.length) await c.query(`DELETE FROM activities WHERE org_id = $1 AND id = ANY($2::bigint[])`, [orgId, actIds]);
          const first = await insertWhatsappSeries(c, orgId, {
            chatId: cur.chat_id ?? id, remoteJid: cur.chat_jid ?? cur.remote_jid,
            companyId: cur.act_company ?? cur.chat_company, contactId: cur.act_contact,
            ownerUserId: cur.owner_user_id, text, when: base, titulo: waTitulo(alvo, text),
            recorrencia: rec, quantidade: qtd, serieId: cur.serie_id ?? undefined,
          });
          await c.query('COMMIT');
          return first;
        } catch (e) { await c.query('ROLLBACK'); throw e; }
      });
      return { schedule: created };
    }

    // Edição simples (sem regenerar): texto e/ou data.
    if (b.text === undefined && b.agendado_para === undefined) {
      return reply.code(400).send({ error: 'nada para atualizar' });
    }
    const novaData = b.agendado_para ? new Date(b.agendado_para) : null;
    if (novaData && Number.isNaN(novaData.getTime())) return reply.code(400).send({ error: 'data inválida' });
    // Mudar a data só faz sentido numa ocorrência (cada uma tem a sua).
    const aplicaData = novaData && !serieMode;
    await withClient(async (c) => {
      await c.query('BEGIN');
      try {
        for (const a of alvos) {
          if (b.text !== undefined) {
            await c.query('UPDATE whatsapp_schedules SET corpo = $3, updated_at = now() WHERE id = $1 AND org_id = $2', [a.id, orgId, b.text]);
          }
          if (aplicaData) {
            await c.query('UPDATE whatsapp_schedules SET agendado_para = $3, updated_at = now() WHERE id = $1 AND org_id = $2', [a.id, orgId, novaData!.toISOString()]);
          }
          if (a.activity_id != null && (b.text !== undefined || aplicaData)) {
            const sets: string[] = []; const p: unknown[] = [];
            if (b.text !== undefined) { p.push(waTitulo(alvo, b.text)); sets.push(`titulo = $${p.length}`); }
            if (aplicaData) { p.push(novaData!.toISOString()); sets.push(`start_at = $${p.length}`); }
            p.push(a.activity_id, orgId);
            await c.query(`UPDATE activities SET ${sets.join(', ')} WHERE id = $${p.length - 1} AND org_id = $${p.length}`, p);
          }
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    });
    const updated = await one('SELECT id, chat_id, corpo, agendado_para, status, recorrencia, serie_id FROM whatsapp_schedules WHERE id = $1 AND org_id = $2', [id, orgId]);
    return { schedule: updated };
  });

  // Cancela um agendamento pendente. scope='serie' cancela a série inteira.
  app.delete('/api/whatsapp/schedules/:id', {
    preHandler: [requireAuth, requirePermission('whatsapp.schedule')],
    schema: { querystring: { type: 'object', properties: { scope: { type: 'string', enum: ['one', 'serie'] } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const id = (req.params as { id: string }).id;
    const scope = (req.query as { scope?: string }).scope ?? 'one';
    const cur = await one<{ serie_id: string | null }>(
      "SELECT serie_id FROM whatsapp_schedules WHERE id = $1 AND org_id = $2 AND status = 'pendente'", [id, orgId]);
    if (!cur) return reply.code(404).send({ error: 'agendamento não encontrado' });
    const cond = scope === 'serie' && cur.serie_id != null
      ? { sql: 'org_id = $1 AND serie_id = $2', params: [orgId, cur.serie_id] }
      : { sql: 'org_id = $1 AND id = $2', params: [orgId, id] };
    const rows = await query<{ activity_id: string | null }>(
      `UPDATE whatsapp_schedules SET status = 'cancelado', updated_at = now()
        WHERE ${cond.sql} AND status = 'pendente' RETURNING activity_id`, cond.params);
    // Cancelou → remove os compromissos espelho da Agenda.
    const actIds = rows.map((r) => r.activity_id).filter((x): x is string => x != null);
    if (actIds.length) await query('DELETE FROM activities WHERE org_id = $1 AND id = ANY($2::bigint[])', [orgId, actIds]);
    return { ok: true, canceladas: rows.length };
  });
}
