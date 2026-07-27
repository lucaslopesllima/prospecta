import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './whatsapp-theme.css';
import { useSearchParams } from 'react-router-dom';
import { api, getToken, ApiError } from '../lib/api.ts';
import { toast } from '../lib/toast.tsx';
import { Btn, Card, Popover, SafeButton, Spinner, cn } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { isEmail, maskPhone } from '../lib/format.ts';
import { CompanySearch } from '../lib/companySearch.tsx';
import { OrderModal } from '../lib/orderModal.tsx';
import { useAuth } from '../lib/auth.tsx';
import type { Contact, CompanyHit, WaChat, WaMessage, WaRecorrencia, WaSchedule, WaStatus } from '../lib/types.ts';
import { confirmDialog } from '../lib/confirm.ts';

// base64 do QR pode vir cru ou já como data URL — normaliza p/ <img src>.
function qrSrc(b64: string): string {
  return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
}

function hora(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Separador de data estilo WhatsApp: Hoje / Ontem / dd/mm/aaaa.
function dayLabel(iso: string): string {
  const d = new Date(iso); const now = new Date();
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  if (same(d, now)) return 'Hoje';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (same(d, y)) return 'Ontem';
  return d.toLocaleDateString('pt-BR');
}

function nomeChat(c: WaChat): string {
  if (c.contact_nome) return c.contact_nome;
  if (c.nome) return c.nome;
  if (c.remote_jid.endsWith('@g.us')) return 'Grupo';
  return c.numero ? maskPhone(c.numero) : c.remote_jid.split('@')[0];
}

// Identificadores do contato: telefone e/ou LID (após conciliar, os dois).
function chatIdent(c: WaChat): string {
  const parts: string[] = [];
  if (c.numero) parts.push(maskPhone(c.numero));
  if (c.lid) parts.push('LID');
  return parts.join(' · ') || c.remote_jid.split('@')[0];
}

// Fallback do avatar: SVG com a inicial do nome (evita imagem quebrada quando a
// conversa não tem foto ou o download falha).
function avatarFallback(c: WaChat): string {
  const ch = (nomeChat(c).trim()[0] ?? '?').toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='100%' height='100%' fill='#25D366'/><text x='50%' y='52%' dy='.35em' text-anchor='middle' font-size='38' fill='white' font-family='sans-serif'>${ch}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Cache de blobs de avatar, por (conversa, URL de origem) — a mesma foto aparece
// na lista, no cabeçalho e nos detalhes, e a lista re-renderiza a cada mensagem:
// sem cache seria um fetch por render. Vive só na aba; teto simples pra não
// segurar blob de conversa nenhuma indefinidamente.
const AVATAR_CACHE_MAX = 300;
const avatarCache = new Map<string, string>();
const avatarPending = new Map<string, Promise<string | null>>();

function avatarKey(c: WaChat): string { return `${c.id}:${c.foto_url ?? ''}`; }

// Baixa a foto pelo proxy do app (same-origin: passa na CSP, sem hotlink no CDN
// do WhatsApp). Header Authorization — o token não vai na URL.
async function fetchAvatar(c: WaChat): Promise<string | null> {
  const key = avatarKey(c);
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const flying = avatarPending.get(key);
  if (flying) return flying;
  const token = getToken();
  const p = fetch(`/api/whatsapp/chats/${c.id}/foto`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => {
      const url = URL.createObjectURL(b);
      if (avatarCache.size >= AVATAR_CACHE_MAX) {
        const oldest = avatarCache.keys().next().value;
        if (oldest !== undefined) { URL.revokeObjectURL(avatarCache.get(oldest)!); avatarCache.delete(oldest); }
      }
      avatarCache.set(key, url);
      return url;
    })
    .catch(() => null)
    .finally(() => avatarPending.delete(key));
  avatarPending.set(key, p);
  return p;
}

// Avatar da conversa: mostra a inicial enquanto carrega (ou se não houver foto) e
// troca pelo blob quando chega. Sem foto_url nem tenta o fetch.
const ChatAvatar = memo(function ChatAvatar({ chat, className }: { chat: WaChat; className: string }): ReactNode {
  const key = avatarKey(chat);
  const [src, setSrc] = useState<string | null>(() => avatarCache.get(key) ?? null);
  useEffect(() => {
    if (!chat.foto_url) { setSrc(null); return; }
    const cached = avatarCache.get(key);
    if (cached) { setSrc(cached); return; }
    let alive = true;
    void fetchAvatar(chat).then((u) => { if (alive) setSrc(u); });
    return () => { alive = false; };
    // `key` já resume (id, foto_url); `chat` inteiro mudaria a cada mensagem nova.
  }, [key, chat.foto_url]);
  return <img src={src ?? avatarFallback(chat)} alt="" className={className} />;
});

// Busca a mídia autenticada pelo header Authorization e devolve um blob URL. Sem
// token na query: o JWT não vaza na barra de endereço, histórico, logs de proxy
// nem em link compartilhado. Revoga o blob ao desmontar. Retorna '' enquanto carrega.
function useAuthedMedia(m: WaMessage): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (m.tipo === 'texto') return;
    let objUrl = '';
    let cancelled = false;
    const token = getToken();
    fetch(`/api/whatsapp/messages/${m.id}/media`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => { if (!cancelled) { objUrl = URL.createObjectURL(b); setUrl(objUrl); } })
      .catch(() => undefined);
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [m.id, m.tipo]);
  return url;
}

// Abre a mídia (documento/vídeo) numa aba nova via fetch autenticado + blob, sem
// expor o token na URL. Best-effort: erro só notifica.
async function openMedia(m: WaMessage): Promise<void> {
  try {
    const token = getToken();
    const r = await fetch(`/api/whatsapp/messages/${m.id}/media`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) throw new Error(String(r.status));
    const objUrl = URL.createObjectURL(await r.blob());
    window.open(objUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
  } catch { toast.error('Não foi possível abrir a mídia.'); }
}

function detectType(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(new Error('falha ao ler arquivo'));
    r.readAsDataURL(file);
  });
}

// Painel de conexão: mostra QR e faz polling do estado até conectar.
function ConnectPanel({ onConnected }: { onConnected: () => void }): React.JSX.Element {
  const { can } = useAuth();
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ qr: string | null; status: WaStatus }>('/api/whatsapp/connect');
      setQr(r.qr);
      if (r.status === 'conectado') { onConnected(); return; }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao conectar');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!qr) return;
    const t = setInterval(() => {
      void api.get<{ status: WaStatus }>('/api/whatsapp/connection')
        .then((r) => { if (r.status === 'conectado') { clearInterval(t); onConnected(); } })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [qr, onConnected]);

  return (
    <div className="grid h-full place-items-center p-6">
      <Card className="flex max-w-sm flex-col items-center gap-4 p-8 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-50 text-emerald-600">
          <Icon name="phone" size={24} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ink-800">Conectar WhatsApp</h2>
          <p className="mt-1 text-sm text-ink-500">
            Abra o WhatsApp no celular → <b>Aparelhos conectados</b> → <b>Conectar</b> e leia o QR.
          </p>
        </div>
        {qr ? (
          <img src={qrSrc(qr)} alt="QR Code" className="h-56 w-56 rounded-xl border border-ink-200" />
        ) : can('whatsapp.connect') ? (
          <Btn onClick={() => start()} disabled={busy} icon="phone">
            {busy ? 'Gerando QR…' : 'Gerar QR Code'}
          </Btn>
        ) : (
          <p className="text-xs text-ink-400">Você não tem permissão para conectar o WhatsApp.</p>
        )}
        {qr && <p className="text-xs text-ink-400">Aguardando leitura…</p>}
      </Card>
    </div>
  );
}

// Tique de status (saída), como no WhatsApp Web: relógio enquanto envia,
// ✓ enviado, ✓✓ entregue, ✓✓ azul lido, exclamação vermelha se falhou.
function Tick({ m }: { m: WaMessage }): React.JSX.Element | null {
  if (!m.from_me) return null;
  if (m.status === 'pendente') {
    return <Icon name="clock" size={14} strokeWidth={2} className="shrink-0" />;
  }
  if (m.status === 'falhou') {
    return <Icon name="alertCircle" size={15} strokeWidth={2} className="shrink-0" style={{ color: '#f15c6d' }} aria-label="Falha ao enviar" />;
  }
  const two = m.status === 'entregue' || m.status === 'lido';
  return (
    <Icon name={two ? 'checkCheck' : 'check'} size={16} strokeWidth={2}
      className="shrink-0" style={{ color: m.status === 'lido' ? '#53bdeb' : undefined }} />
  );
}

// Insere uma mensagem mantendo a ordem (momento, id) — a mesma do servidor.
// Só anexar no fim erra quando o webhook entrega fora de ordem (reentrega,
// sincronia do celular): a mensagem antiga apareceria como a mais recente.
// Balões otimistas (id negativo, ainda sem confirmação) ficam sempre no fim.
function insertMsg(ms: WaMessage[], m: WaMessage): WaMessage[] {
  if (ms.some((x) => x.id === m.id)) return ms;
  const antes = (a: WaMessage): boolean => (a.id < 0 ? false : a.momento !== m.momento ? a.momento < m.momento : a.id < m.id);
  let i = ms.length;
  while (i > 0 && !antes(ms[i - 1])) i--;
  return [...ms.slice(0, i), m, ...ms.slice(i)];
}

// Rótulo curto pra citar uma mensagem numa nota (texto ou tipo da mídia).
function quotePreview(m: WaMessage): string {
  if (m.tipo === 'imagem') return '📷 Imagem';
  if (m.tipo === 'video') return '🎬 Vídeo';
  if (m.tipo === 'audio') return '🎧 Áudio';
  if (m.tipo !== 'texto') return `📎 ${m.file_name ?? 'Documento'}`;
  return m.corpo ?? '';
}
function quoteAutor(m: WaMessage): string {
  if (m.internal) return `Nota${m.sender_nome ? ` · ${m.sender_nome}` : ''}`;
  return m.from_me ? (m.sender_nome || 'Atendente') : 'Contato';
}

// Flecha de ações do balão (aparece no hover), estilo WhatsApp Web. Hoje só
// "Criar nota" (pendurada nesta mensagem). Estado de aberto é local ao balão.
function MsgActions({ m, onNote }: { m: WaMessage; onNote: (m: WaMessage) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="absolute right-1 top-0.5">
      <button ref={btnRef} aria-label="Ações da mensagem" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn('grid h-5 w-6 place-items-center rounded transition',
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          'text-[var(--wa-muted)] hover:bg-black/10 dark:hover:bg-white/10')}>
        <Icon name="chevronRight" size={16} className="rotate-90" />
      </button>
      {/* Portal: o canvas de mensagens rola (overflow-y-auto) e cortava o menu
          das últimas mensagens. */}
      <Popover open={open} anchorRef={btnRef} onClose={close} width={160} className="text-sm">
        <button role="menuitem" onClick={() => { setOpen(false); onNote(m); }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-700 hover:bg-ink-100 dark:text-ink-200">
          <Icon name="pencil" size={15} /> Criar nota
        </button>
      </Popover>
    </div>
  );
}

// Balão de mensagem nativo (texto ou mídia), cores via vars --wa-* (tema-aware).
// React.memo por id+status: mensagem nova (ou tique atualizado) re-renderiza só
// o próprio balão, não o thread inteiro.
const MessageBubble = memo(function MessageBubble({ m, onImage, onNote, quoted, attached, parentFromMe }: {
  m: WaMessage; onImage: (url: string) => void; onNote?: (m: WaMessage) => void; quoted?: WaMessage;
  attached?: boolean; parentFromMe?: boolean;
}): React.JSX.Element {
  const url = useAuthedMedia(m);
  // Nota interna: balão âmbar, sem tique/status, com selo. Nunca vai ao contato.
  if (m.internal) {
    const balloon = (
      <div className="relative max-w-full rounded-[7.5px] border border-amber-300 bg-amber-100 px-[9px] py-[6px] text-[14.2px] leading-[19px] text-amber-900 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-100">
        {onNote && <MsgActions m={m} onNote={onNote} />}
        <div className="mb-0.5 flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          <Icon name="pencil" size={12} /> Nota interna{m.sender_nome ? ` · ${m.sender_nome}` : ''}
        </div>
        {/* Fora da posição pendurada (nota solta ou alvo fora da janela): mostra o
            trecho citado. Pendurada não precisa — já vem colada na mensagem. */}
        {!attached && quoted && (
          <div className="mb-1 rounded border-l-[3px] border-amber-500 bg-amber-200/50 px-2 py-1 text-[12.5px] dark:bg-amber-400/10">
            <div className="font-medium text-amber-800 dark:text-amber-200">{quoteAutor(quoted)}</div>
            <div className="line-clamp-2 break-words text-amber-900/80 dark:text-amber-100/80">{quotePreview(quoted)}</div>
          </div>
        )}
        <span className="whitespace-pre-wrap break-words">{m.corpo}</span>
        <span className="float-right -mb-[3px] ml-2 mt-[7px] text-[11px] text-amber-700/80 dark:text-amber-300/70">{hora(m.momento)}</span>
      </div>
    );
    // Pendurada: entra logo abaixo da mensagem-alvo, do mesmo lado, ligada por um
    // conector em L que desce da mensagem de cima e curva até o balão da nota.
    // -mt-2 sobe o conector pra encostar na borda de baixo da mensagem.
    if (attached) {
      return (
        <div className={cn('group relative -mt-2 flex px-[5%] pb-1', parentFromMe ? 'justify-end' : 'justify-start')}>
          <div className={cn('flex max-w-[80%] items-stretch', parentFromMe ? 'flex-row-reverse' : '')}>
            {/* Coluna do conector: box ocupa a largura toda (inset-x-0) pra a barra
                horizontal encostar no balão de um lado e a vertical na mensagem. */}
            <div className="relative w-3.5 shrink-0">
              <div className={cn('absolute inset-x-0 top-0 h-6 border-amber-400/80',
                parentFromMe ? 'rounded-br-[10px] border-b-2 border-r-2' : 'rounded-bl-[10px] border-b-2 border-l-2')} />
            </div>
            <div className="min-w-0">{balloon}</div>
          </div>
        </div>
      );
    }
    return (
      <div className="group relative flex justify-end px-[5%] py-0.5">
        <div className="max-w-[75%]">{balloon}</div>
      </div>
    );
  }
  let media: ReactNode = null;
  if (m.tipo === 'imagem') {
    media = url ? <img src={url} alt="" className="block max-w-[240px] cursor-pointer rounded-md" onClick={() => onImage(url)} /> : null;
  } else if (m.tipo === 'video') {
    media = url ? <video src={url} controls className="block max-w-[260px] rounded-md" /> : null;
  } else if (m.tipo === 'audio') {
    media = url ? <audio src={url} controls className="max-w-[240px]" /> : null;
  } else if (m.tipo !== 'texto') {
    media = (
      <SafeButton type="button" onClick={() => openMedia(m)} className="flex items-center gap-2 text-[var(--wa-ink)] underline-offset-2 hover:underline">
        <Icon name="mail" size={18} /> {m.file_name ?? 'arquivo'}
      </SafeButton>
    );
  }
  return (
    <div className={cn('group relative flex px-[5%] py-0.5', m.from_me ? 'justify-end' : 'justify-start')}>
      <div className={cn('relative max-w-[75%] rounded-[7.5px] px-[9px] py-[6px] text-[14.2px] leading-[19px] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]',
        m.from_me ? 'bg-[var(--wa-out)]' : 'bg-[var(--wa-in)]', 'text-[var(--wa-ink)]')}>
        {onNote && <MsgActions m={m} onNote={onNote} />}
        {/* Nome do atendente que enviou (como o nome do remetente em grupos). */}
        {m.from_me && m.sender_nome && (
          <div className="text-[12.8px] font-medium leading-[18px] text-[var(--wa-green)]">{m.sender_nome}</div>
        )}
        {media}
        {m.tipo === 'texto'
          ? <span className="whitespace-pre-wrap break-words">{m.corpo}</span>
          : m.corpo && <div className="mt-1 whitespace-pre-wrap break-words">{m.corpo}</div>}
        {/* Hora + tique inline no fim da última linha, como no WhatsApp Web:
            float faz caber na mesma linha se houver espaço, senão desce sozinho. */}
        <span className="float-right -mb-[3px] ml-2 mt-[7px] flex items-center gap-1 text-[11px] text-[var(--wa-muted)]">
          {hora(m.momento)} <Tick m={m} />
        </span>
      </div>
    </div>
  );
}, (prev, next) => prev.m.id === next.m.id && prev.m.status === next.m.status
  && prev.quoted?.id === next.quoted?.id && prev.onNote === next.onNote
  && prev.attached === next.attached && prev.parentFromMe === next.parentFromMe);

// Miniatura de mídia no painel "Mídia, links e docs" — usa o mesmo fetch
// autenticado (blob URL, sem token na URL). Componente próprio porque o hook não
// pode ser chamado dentro do map.
function MediaThumb({ m, onImage }: { m: WaMessage; onImage: (url: string) => void }): React.JSX.Element {
  const url = useAuthedMedia(m);
  return (
    <SafeButton onClick={() => { if (m.tipo === 'imagem') { if (url) onImage(url); return undefined; } return openMedia(m); }}
      className="relative aspect-square overflow-hidden rounded-lg bg-ink-100">
      {m.tipo === 'imagem' && url
        ? <img src={url} alt="" className="h-full w-full object-cover" />
        : <span className="grid h-full w-full place-items-center text-ink-400"><Icon name="eye" size={20} /></span>}
    </SafeButton>
  );
}

const inputCls = 'w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200';

// Shell de modal (mesmo padrão de sampleModal): overlay + card centralizado.
function Overlay({ title, onClose, children, bodyClassName }: { title: string; onClose: () => void; children: ReactNode; bodyClassName?: string }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-ink-200 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 p-4">
          <h2 className="text-base font-semibold text-ink-800">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><Icon name="x" size={18} /></button>
        </div>
        <div className={cn('space-y-3 overflow-auto p-4', bodyClassName)}>{children}</div>
      </div>
    </div>
  );
}

// Visualizador de imagem em tela cheia (estilo WhatsApp Web): fundo escuro,
// fecha no clique fora / botão / Esc, com atalho pra abrir o original.
function ImageLightbox({ url, onClose }: { url: string | null; onClose: () => void }): React.JSX.Element | null {
  useEffect(() => {
    if (!url) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [url, onClose]);
  if (!url) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <a href={url} target="_blank" rel="noreferrer" title="Abrir original" onClick={(e) => e.stopPropagation()}
        className="absolute right-16 top-4 grid h-10 w-10 place-items-center rounded-full text-white/80 transition hover:bg-white/10">
        <Icon name="download" size={20} />
      </a>
      <button onClick={onClose} aria-label="Fechar" className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full text-white/80 transition hover:bg-white/10">
        <Icon name="x" size={22} />
      </button>
      <img src={url} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// Balões com separadores de data entre dias (usado na conversa e no espiar).
function messageList(messages: WaMessage[], onImage: (url: string) => void, onNote?: (m: WaMessage) => void): ReactNode[] {
  const items: ReactNode[] = [];
  // Resolve a mensagem citada por uma nota olhando o próprio thread carregado.
  const byId = new Map(messages.map((x) => [Number(x.id), x]));
  // Notas penduradas: agrupa por mensagem-alvo presente na janela carregada.
  // Elas saem da ordem cronológica pra aparecer coladas na mensagem de origem.
  const notesByTarget = new Map<number, WaMessage[]>();
  const attached = new Set<number>();
  for (const m of messages) {
    if (!m.internal || m.reply_to_id == null) continue;
    const tid = Number(m.reply_to_id);
    if (!byId.has(tid)) continue; // alvo fora da janela: nota fica solta (cronológica)
    const arr = notesByTarget.get(tid) ?? [];
    arr.push(m);
    notesByTarget.set(tid, arr);
    attached.add(Number(m.id));
  }
  let lastDay = '';
  for (const m of messages) {
    if (attached.has(Number(m.id))) continue; // renderizada abaixo do alvo
    const day = new Date(m.momento).toDateString();
    if (day !== lastDay) {
      items.push(
        <div key={`sep-${m.id}`} className="my-2.5 flex justify-center">
          <span className="rounded-lg bg-[var(--wa-sep)] px-3 py-1 text-[12.5px] uppercase text-[var(--wa-muted)] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
            {dayLabel(m.momento)}
          </span>
        </div>,
      );
      lastDay = day;
    }
    const quoted = m.internal && m.reply_to_id != null ? byId.get(Number(m.reply_to_id)) : undefined;
    items.push(<MessageBubble key={m.id} m={m} onImage={onImage} onNote={onNote} quoted={quoted} />);
    // Notas penduradas nesta mensagem, logo abaixo, do mesmo lado do balão.
    const notes = notesByTarget.get(Number(m.id));
    if (notes) {
      for (const nt of notes) {
        items.push(<MessageBubble key={nt.id} m={nt} onImage={onImage} onNote={onNote} attached parentFromMe={m.from_me} />);
      }
    }
  }
  return items;
}

// Espiar: mostra a conversa num modal, sem confirmar leitura pro contato (sem
// ticks azuis, contador da lista fica) e sem trocar a conversa ativa. O ✓✓
// confirma a leitura e fecha; o X fecha mantendo a conversa como não lida.
function PeekModal({ chat, messages, onClose, onRead, onImage }: {
  chat: WaChat; messages: WaMessage[]; onClose: () => void; onRead: () => void; onImage: (url: string) => void;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div className="wa flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-ink-200 bg-[var(--wa-panel)] shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-[var(--wa-border)] bg-[var(--wa-panel)] px-4 py-2.5">
          <ChatAvatar chat={chat} className="h-10 w-10 shrink-0 rounded-full object-cover" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-[var(--wa-ink)]">{nomeChat(chat)}</span>
            <span className="flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400">
              <Icon name="eye" size={12} /> Espiando — leitura não confirmada
            </span>
          </span>
          <button title="Marcar como lida (envia a confirmação de leitura ao contato)" onClick={onRead}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sky-600 hover:bg-[var(--wa-hover)]">
            <Icon name="checkCheck" size={18} />
          </button>
          <button onClick={onClose} aria-label="Fechar"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)]">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="wa-canvas min-h-0 flex-1 overflow-y-auto py-3">
          {messageList(messages, onImage)}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}

// Vincula a conversa a uma empresa da base (habilita "criar pedido" + funil).
function LinkModal({ chatId, current, onClose, onLinked }: { chatId: number; current: WaChat; onClose: () => void; onLinked: (c: WaChat) => void }): React.JSX.Element {
  const link = async (companyId: number | null): Promise<void> => {
    try {
      const r = await api.patch<{ chat: WaChat }>(`/api/whatsapp/chats/${chatId}/link`, { company_id: companyId });
      onLinked(r.chat);
      toast.success(companyId ? 'Conversa vinculada.' : 'Vínculo removido.');
      onClose();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao vincular'); }
  };
  return (
    <Overlay title="Vincular a uma empresa" onClose={onClose} bodyClassName="min-h-[420px]">
      <p className="text-sm text-ink-500">Vincule a conversa a uma empresa da base para criar pedidos e ver o cliente no funil.</p>
      <CompanySearch onPick={(c: CompanyHit) => void link(c.id)} />
      {current.company_id != null && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-ink-200 px-3 py-2">
          <span className="min-w-0 truncate text-sm text-ink-700">{current.company_fantasia || current.company_nome}</span>
          <SafeButton onClick={() => link(null)} className="shrink-0 text-xs font-semibold text-rose-600 hover:underline">Remover</SafeButton>
        </div>
      )}
    </Overlay>
  );
}

// Agenda mensagens de texto + lista/cancela pendentes da conversa.
const RECORRENCIA_LABEL: Record<WaRecorrencia, string> = {
  diaria: 'Diária', semanal: 'Semanal', mensal: 'Mensal', anual: 'Anual',
};

// ISO -> valor de <input type="datetime-local"> no fuso local.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ScheduleModal({ chat, onClose, onChanged }: { chat: WaChat; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState<WaSchedule | null>(null);
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [repete, setRepete] = useState(false);
  const [recorrencia, setRecorrencia] = useState<WaRecorrencia>('diaria');
  const [quantidade, setQuantidade] = useState(4);
  const [scope, setScope] = useState<'one' | 'serie'>('serie'); // padrão: série inteira
  const [list, setList] = useState<WaSchedule[]>([]);
  const load = (): void => {
    void api.get<{ schedules: WaSchedule[] }>(`/api/whatsapp/schedules?chat_id=${chat.id}`)
      .then((r) => setList(r.schedules)).catch(() => undefined);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const reset = (): void => {
    setEditing(null); setText(''); setWhen(''); setRepete(false); setRecorrencia('diaria'); setQuantidade(4); setScope('serie');
  };
  // Abre a edição de um agendamento pendente. Série: 'repete' liga a opção de
  // regenerar datas (frequência/quantidade); ocorrência avulsa só edita texto/data.
  const startEdit = (s: WaSchedule): void => {
    setEditing(s); setText(s.corpo); setWhen(toLocalInput(s.agendado_para));
    setRepete(false); setScope(s.serie_id ? 'serie' : 'one');
  };

  const submit = async (): Promise<void> => {
    const t = text.trim();
    if (!t || !when) { toast.error('Preencha mensagem e data.'); return; }
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) { toast.error('Data inválida.'); return; }
    if (repete && (quantidade < 2 || quantidade > 60)) { toast.error('Quantidade deve ser de 2 a 60.'); return; }
    try {
      if (editing) {
        // repete on em edição = regenerar as datas (frequência/quantidade novas).
        const body: Record<string, unknown> = { scope, text: t };
        if (repete) { body.recorrencia = recorrencia; body.quantidade = quantidade; body.agendado_para = d.toISOString(); }
        else if (scope === 'one') { body.agendado_para = d.toISOString(); }
        await api.patch(`/api/whatsapp/schedules/${editing.id}`, body);
        toast.success('Agendamento atualizado.');
      } else {
        if (d.getTime() < Date.now()) { toast.error('Escolha uma data futura.'); return; }
        await api.post(`/api/whatsapp/chats/${chat.id}/schedule`, {
          text: t, agendado_para: d.toISOString(),
          recorrencia: repete ? recorrencia : null, quantidade: repete ? quantidade : 1,
        });
        toast.success(repete ? `${quantidade} mensagens agendadas.` : 'Mensagem agendada.');
      }
      reset(); load(); onChanged();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao salvar'); }
  };
  const cancel = async (id: number, sc: 'one' | 'serie'): Promise<void> => {
    if (sc === 'serie' && !(await confirmDialog('Cancelar toda a série de agendamentos?'))) return;
    try { await api.del(`/api/whatsapp/schedules/${id}?scope=${sc}`); load(); onChanged(); } catch { toast.error('Falha ao cancelar'); }
  };

  const emSerie = editing != null && editing.serie_id != null;
  return (
    <Overlay title={editing ? 'Editar agendamento' : 'Agendar mensagem'} onClose={onClose}>
      <textarea value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Mensagem…" className={inputCls} />
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls} />
      {emSerie && (
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink-500">Aplicar em</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'one' | 'serie')} className={inputCls}>
            <option value="serie">Toda a série</option>
            <option value="one">Só esta ocorrência</option>
          </select>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={repete} onChange={(e) => setRepete(e.target.checked)} className="h-4 w-4 accent-brand-600" />
        {editing ? 'Alterar frequência/quantidade (recria as datas)' : 'Repetir'}
      </label>
      {repete && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-500">Frequência</label>
              <select value={recorrencia} onChange={(e) => setRecorrencia(e.target.value as WaRecorrencia)} className={inputCls}>
                {(Object.keys(RECORRENCIA_LABEL) as WaRecorrencia[]).map((r) => (
                  <option key={r} value={r}>{RECORRENCIA_LABEL[r]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-500">Quantidade</label>
              <input type="number" min={2} max={60} value={quantidade}
                onChange={(e) => setQuantidade(Math.max(2, Math.min(60, Number(e.target.value) || 2)))}
                className={inputCls} />
            </div>
          </div>
          {when && (
            <p className="text-xs text-ink-400">
              {editing ? 'Recria' : 'Cria'} {quantidade} agendamentos ({RECORRENCIA_LABEL[recorrencia].toLowerCase()}), todos visíveis na Agenda.
            </p>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Btn onClick={() => submit()} icon={editing ? 'check' : 'clock'}>{editing ? 'Salvar' : 'Agendar'}</Btn>
        {editing && <Btn variant="ghost" onClick={reset}>Cancelar edição</Btn>}
      </div>
      {list.length > 0 && (
        <div className="border-t border-ink-100 pt-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Agendadas</p>
          <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
          {list.map((s) => {
            // Passou do horário (ou já processada) → riscada e inativa; só pendente
            // futura pode ser editada/cancelada.
            const passou = new Date(s.agendado_para).getTime() <= Date.now();
            const ativa = s.status === 'pendente' && !passou;
            const rotulo = s.status === 'enviado' ? 'enviada' : s.status === 'erro' ? 'falhou' : passou ? 'expirada' : null;
            return (
              <div key={s.id} className={cn('flex items-center justify-between gap-2 rounded-lg px-3 py-2',
                editing?.id === s.id ? 'bg-brand-50 ring-1 ring-brand-200' : ativa ? 'bg-ink-50' : 'bg-ink-50/60 opacity-60')}>
                <div className="min-w-0">
                  <p className={cn('truncate text-sm', ativa ? 'text-ink-700' : 'text-ink-500 line-through')}>{s.corpo}</p>
                  <p className="text-[11px] text-ink-400">
                    {new Date(s.agendado_para).toLocaleString('pt-BR')}
                    {s.serie_id ? ' · série' : ''}
                    {rotulo ? ` · ${rotulo}` : ''}
                  </p>
                </div>
                {ativa && (
                  <div className="flex shrink-0 items-center gap-2">
                    <SafeButton onClick={() => startEdit(s)} className="text-xs font-semibold text-brand-600 hover:underline">Editar</SafeButton>
                    <SafeButton onClick={() => cancel(s.id, 'one')} className="text-xs font-semibold text-rose-600 hover:underline">Cancelar</SafeButton>
                    {s.serie_id && (
                      <SafeButton onClick={() => cancel(s.id, 'serie')} className="text-xs font-semibold text-rose-500 hover:underline">Série</SafeButton>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </div>
      )}
    </Overlay>
  );
}

// Concilia a conversa atual (primária) com outra do mesmo contato (telefone+LID).
function MergeModal({ current, chats, onClose, onMerged }: { current: WaChat; chats: WaChat[]; onClose: () => void; onMerged: () => void }): React.JSX.Element {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const opts = useMemo(() => {
    const s = q.trim().toLowerCase();
    return chats.filter((c) => c.id !== current.id)
      .filter((c) => !s || nomeChat(c).toLowerCase().includes(s) || (c.numero ?? '').includes(s) || (c.lid ?? '').includes(s));
  }, [chats, current, q]);
  const merge = async (other: WaChat): Promise<void> => {
    if (!(await confirmDialog(`Conciliar "${nomeChat(other)}" em "${nomeChat(current)}"? As mensagens serão unificadas e a outra conversa removida.`))) return;
    setBusy(true);
    try {
      await api.post(`/api/whatsapp/chats/${current.id}/merge`, { other_id: other.id });
      toast.success('Conversas conciliadas.');
      onMerged(); onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao conciliar');
    } finally { setBusy(false); }
  };
  return (
    <Overlay title="Conciliar conversas" onClose={onClose}>
      <p className="text-sm text-ink-500">
        Una a conversa de telefone com a de <b>@lid</b> do mesmo contato. <b>{nomeChat(current)}</b> permanece e absorve a escolhida.
      </p>
      <input value={q} maxLength={120} onChange={(e) => setQ(e.target.value)} placeholder="Buscar conversa…" className={inputCls} />
      <div className="max-h-72 space-y-1 overflow-auto">
        {opts.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-400">Nenhuma outra conversa.</p>
        ) : opts.map((c) => (
          <SafeButton key={c.id} disabled={busy} onClick={() => merge(c)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-ink-100 px-3 py-2 text-left transition hover:bg-ink-50 disabled:opacity-50">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink-800">{nomeChat(c)}</span>
              <span className="block truncate text-[11px] text-ink-400">{chatIdent(c)}</span>
            </span>
            <Icon name="arrowRight" size={15} className="shrink-0 text-ink-400" />
          </SafeButton>
        ))}
      </div>
    </Overlay>
  );
}

// Nova conversa: procura um contato/empresa cadastrado no sistema (base) e abre
// a conversa pelo telefone cadastrado (from-company já cria/vincula o chat).
function NewChatModal({ onClose, onOpened }: { onClose: () => void; onOpened: (chatId: number) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const start = async (c: CompanyHit): Promise<void> => {
    const numero = c.telefone1 || c.telefone2;
    if (!numero) { toast.error('Contato sem telefone cadastrado.'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ chat: { id: number } }>('/api/whatsapp/chats/from-company', { company_id: c.id, numero });
      onOpened(r.chat.id);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao abrir conversa');
    } finally { setBusy(false); }
  };
  return (
    <Overlay title="Nova conversa" onClose={onClose}>
      <p className="text-sm text-ink-500">Procure um contato cadastrado no sistema (CNPJ ou nome) para iniciar a conversa pelo telefone cadastrado.</p>
      <div className={busy ? 'pointer-events-none opacity-50' : ''}>
        <CompanySearch onPick={(c: CompanyHit) => void start(c)} placeholder="Buscar contato por CNPJ ou nome…" />
      </div>
    </Overlay>
  );
}

// Informa/confirma o telefone de um contato que chegou só como LID (número
// oculto). Valida no WhatsApp e grava o número — habilita o envio.
function NumberModal({ chatId, onClose, onSet }: { chatId: number; onClose: () => void; onSet: (c: WaChat) => void }): React.JSX.Element {
  const [numero, setNumero] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = async (): Promise<void> => {
    const n = numero.replace(/\D/g, '');
    if (n.length < 10) { toast.error('Informe o número com DDD.'); return; }
    setBusy(true);
    try {
      const r = await api.patch<{ chat: WaChat }>(`/api/whatsapp/chats/${chatId}/numero`, { numero: n });
      onSet(r.chat);
      toast.success('Número confirmado.');
      onClose();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao confirmar número'); }
    finally { setBusy(false); }
  };
  return (
    <Overlay title="Informar número do contato" onClose={onClose}>
      <p className="text-sm text-ink-500">
        Este contato chegou como <b>LID</b> (número oculto pelo WhatsApp). Informe o telefone com DDD
        para confirmar o destinatário e habilitar o envio.
      </p>
      <input value={numero} onChange={(e) => setNumero(maskPhone(e.target.value))} inputMode="tel"
        placeholder="(11) 98765-4321" className={inputCls} autoFocus />
      <Btn onClick={() => confirm()} disabled={busy} icon="check">{busy ? 'Confirmando…' : 'Confirmar número'}</Btn>
    </Overlay>
  );
}

// Cria/edita um contato vinculado à empresa da conversa. Novo contato já vem com
// o telefone do WhatsApp pré-preenchido (relaciona o contato ao número do chat).
function ContactFormModal({ companyId, contact, defaultPhone, onClose, onSaved, onDeleted }: {
  companyId: number | null; contact: Contact | null; defaultPhone?: string | null;
  onClose: () => void; onSaved: (c: Contact) => void; onDeleted: (id: number) => void;
}): React.JSX.Element {
  const [nome, setNome] = useState(contact?.nome ?? '');
  const [cargo, setCargo] = useState(contact?.cargo ?? '');
  const [telefone, setTelefone] = useState(contact?.telefone ?? (defaultPhone ? maskPhone(defaultPhone) : ''));
  const [email, setEmail] = useState(contact?.email ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    const n = nome.trim();
    if (!n) { toast.error('Informe o nome.'); return; }
    const em = email.trim();
    if (em && !isEmail(em)) { toast.error('E-mail inválido.'); return; }
    setBusy(true);
    try {
      const body = {
        nome: n, cargo: cargo.trim() || null, telefone: telefone.trim() || null,
        email: email.trim() || null, company_id: companyId,
      };
      const r = contact
        ? await api.patch<{ contact: Contact }>(`/api/contacts/${contact.id}`, body)
        : await api.post<{ contact: Contact }>('/api/contacts', body);
      toast.success(contact ? 'Contato atualizado.' : 'Contato criado.');
      onSaved(r.contact);
      onClose();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao salvar contato'); }
    finally { setBusy(false); }
  };

  const remove = async (): Promise<void> => {
    if (!contact || !(await confirmDialog(`Excluir o contato "${contact.nome}"?`))) return;
    setBusy(true);
    try {
      await api.del(`/api/contacts/${contact.id}`);
      toast.success('Contato excluído.');
      onDeleted(contact.id);
      onClose();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao excluir'); }
    finally { setBusy(false); }
  };

  return (
    <Overlay title={contact ? 'Editar contato' : 'Novo contato'} onClose={onClose}>
      <input value={nome} maxLength={120} onChange={(e) => setNome(e.target.value)} placeholder="Nome *" className={inputCls} autoFocus />
      <input value={cargo} maxLength={120} onChange={(e) => setCargo(e.target.value)} placeholder="Cargo" className={inputCls} />
      <input value={telefone} onChange={(e) => setTelefone(maskPhone(e.target.value))} inputMode="tel" placeholder="Telefone" className={inputCls} />
      <input value={email} maxLength={160} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="E-mail" className={inputCls} />
      <div className="flex items-center justify-between gap-2">
        {contact ? (
          <SafeButton onClick={() => remove()} disabled={busy} className="text-xs font-semibold text-rose-600 hover:underline disabled:opacity-50">Excluir</SafeButton>
        ) : <span />}
        <Btn onClick={() => save()} disabled={busy} icon="check">{busy ? 'Salvando…' : 'Salvar'}</Btn>
      </div>
    </Overlay>
  );
}

interface GroupParticipant { numero: string; jid: string; admin: string | null }
interface GroupData { subject: string | null; desc: string | null; size: number | null; participants: GroupParticipant[] }

// Painel lateral de dados do contato/grupo (estilo WhatsApp Web): avatar grande,
// identificadores, empresa vinculada, mídia compartilhada e — em grupo —
// descrição + participantes.
function ContactDetails({ chat, messages, onClose, onLink, onOrder, onNumber, onOpenContact, onChatUpdate }: {
  chat: WaChat; messages: WaMessage[]; onClose: () => void;
  onLink: () => void; onOrder: () => void; onNumber: () => void;
  onOpenContact: (chatId: number) => void;
  onChatUpdate: (chat: WaChat) => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const isGroup = chat.remote_jid.endsWith('@g.us');
  const [group, setGroup] = useState<GroupData | null>(null);
  useEffect(() => {
    if (!isGroup) return;
    void api.get<GroupData>(`/api/whatsapp/chats/${chat.id}/group`).then(setGroup).catch(() => undefined);
  }, [chat.id, isGroup]);

  const [lightbox, setLightbox] = useState<string | null>(null);
  // Contatos da empresa vinculada (cria/edita aqui mesmo). Só carrega quando há empresa.
  const [contatos, setContatos] = useState<Contact[]>([]);
  // `link`: quando true, ao salvar o contato também vincula a conversa a ele
  // (fluxo "Salvar contato"). O CRUD da lista de contatos da empresa usa false.
  const [contactModal, setContactModal] = useState<{ contact: Contact | null; link: boolean } | null>(null);
  useEffect(() => {
    if (isGroup || chat.company_id == null) { setContatos([]); return; }
    void api.get<{ contacts: Contact[] }>(`/api/contacts?company_id=${chat.company_id}`)
      .then((r) => setContatos(r.contacts)).catch(() => undefined);
  }, [chat.company_id, isGroup]);

  // Abre (cria/vincula) uma conversa com um contato vinculado pelo telefone dele.
  const startContactChat = async (ct: Contact): Promise<void> => {
    if (!ct.telefone || chat.company_id == null) { toast.error('Contato sem telefone cadastrado.'); return; }
    try {
      const r = await api.post<{ chat: { id: number } }>('/api/whatsapp/chats/from-company', { company_id: chat.company_id, numero: ct.telefone, nome: ct.nome });
      onOpenContact(r.chat.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao abrir conversa');
    }
  };

  const media = useMemo(() => messages.filter((m) => m.tipo === 'imagem' || m.tipo === 'video'), [messages]);
  const needsNumber = !chat.numero && chat.remote_jid.endsWith('@lid');

  // Este número já está salvo como contato (da empresa vinculada)? Compara só
  // dígitos, ignorando código de país/máscara. Sem empresa, `contatos` fica
  // vazio, então o botão "Salvar contato" aparece com o número já preenchido.
  const savedContact = useMemo(() => {
    const cd = (chat.numero ?? '').replace(/\D/g, '');
    if (!cd) return undefined;
    return contatos.find((c) => {
      const td = (c.telefone ?? '').replace(/\D/g, '');
      if (!td) return false;
      const n = Math.min(td.length, cd.length, 11);
      return td.slice(-n) === cd.slice(-n);
    });
  }, [contatos, chat.numero]);
  const canSaveContact = !isGroup && !!chat.numero && chat.contact_id == null && !savedContact && can('whatsapp.link');
  const saveContact = (): void => setContactModal({ contact: null, link: true });

  // Edita o contato vinculado à conversa direto pelo cabeçalho — busca os dados
  // completos (pode não estar em `contatos` quando não há empresa vinculada).
  const editLinkedContact = async (): Promise<void> => {
    if (chat.contact_id == null) return;
    try {
      const r = await api.get<{ contact: Contact }>(`/api/contacts/${chat.contact_id}`);
      setContactModal({ contact: r.contact, link: false });
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao carregar contato'); }
  };

  return (
   <>
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-ink-200 bg-surface shadow-pop animate-[toastIn_.18s_ease-out] md:static md:z-auto md:w-96 md:max-w-sm md:shrink-0 md:shadow-none">
      <div className="flex items-center gap-3 bg-[var(--wa-panel)] px-4 py-3">
        <button onClick={onClose} aria-label="Fechar" className="grid h-8 w-8 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-black/5 dark:hover:bg-white/10">
          <Icon name="x" size={18} />
        </button>
        <span className="text-base font-semibold text-[var(--wa-ink)]">{isGroup ? 'Dados do grupo' : 'Dados do contato'}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto bg-[var(--wa-bg)] pb-6">
        {/* Identidade */}
        <div className="flex flex-col items-center gap-2 bg-surface px-6 py-6">
          <ChatAvatar chat={chat} className="h-32 w-32 rounded-full object-cover" />
          <h2 className="text-xl font-semibold text-ink-900">{nomeChat(chat)}</h2>
          <p className="text-sm text-ink-500">{isGroup ? (group?.size ? `${group.size} participantes` : 'Grupo') : chatIdent(chat)}</p>
          {needsNumber && can('whatsapp.link') && (
            <button onClick={onNumber} className="mt-1 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100">
              Informar número
            </button>
          )}
          {!isGroup && chat.contact_id != null && can('whatsapp.link') && (
            <button onClick={() => void editLinkedContact()}
              className="mt-1 inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-emerald-600 hover:bg-emerald-50">
              <Icon name="pencil" size={13} /> Editar contato
            </button>
          )}
        </div>

        {isGroup && group?.desc && (
          <div className="bg-surface px-6 py-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Descrição</p>
            <p className="whitespace-pre-wrap text-sm text-ink-700">{group.desc}</p>
          </div>
        )}

        {/* Empresa (domínio Rovva) */}
        {!isGroup && (
          <div className="bg-surface px-6 py-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Empresa</p>
            {chat.company_id != null ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-ink-800">
                  <Icon name="building" size={16} className="text-ink-400" />
                  <span className="truncate">{chat.company_fantasia || chat.company_nome}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn size="sm" icon="plus" onClick={onOrder}>Criar pedido</Btn>
                  {canSaveContact && <Btn size="sm" variant="soft" icon="users" onClick={saveContact}>Salvar contato</Btn>}
                  {can('whatsapp.link') && <Btn size="sm" variant="soft" icon="pencil" onClick={onLink}>Trocar</Btn>}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {can('whatsapp.link') && <Btn size="sm" variant="soft" icon="building" onClick={onLink}>Vincular empresa</Btn>}
                {canSaveContact && <Btn size="sm" variant="soft" icon="users" onClick={saveContact}>Salvar contato</Btn>}
              </div>
            )}
          </div>
        )}

        {/* Contatos da empresa (cria/edita) — exige empresa vinculada */}
        {!isGroup && chat.company_id != null && (
          <div className="bg-surface px-6 py-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Contatos</p>
              <button onClick={() => setContactModal({ contact: null, link: false })}
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:underline">
                <Icon name="plus" size={13} /> Novo
              </button>
            </div>
            {contatos.length === 0 ? (
              <p className="text-sm text-ink-400">Nenhum contato.</p>
            ) : (
              <div className="space-y-1.5">
                {contatos.map((ct) => (
                  <div key={ct.id}
                    className="flex items-center gap-1 rounded-lg border border-ink-100 px-3 py-2 transition hover:bg-ink-50">
                    <button onClick={() => setContactModal({ contact: ct, link: false })}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink-700">{ct.nome}{ct.cargo ? ` · ${ct.cargo}` : ''}</span>
                        {(ct.telefone || ct.email) && (
                          <span className="block truncate text-[11px] text-ink-400">
                            {[ct.telefone && maskPhone(ct.telefone), ct.email].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                      <Icon name="pencil" size={14} className="shrink-0 text-ink-400" />
                    </button>
                    {ct.telefone && (
                      <SafeButton type="button" title="Iniciar conversa no WhatsApp" aria-label="Iniciar conversa"
                        onClick={() => startContactChat(ct)}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-emerald-600 transition hover:bg-emerald-50">
                        <Icon name="whatsapp" size={15} />
                      </SafeButton>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mídia compartilhada */}
        <div className="bg-surface px-6 py-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Mídia, links e docs</p>
          {media.length === 0 ? (
            <p className="text-sm text-ink-400">Nenhuma mídia.</p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {media.slice(-18).reverse().map((m) => (
                <MediaThumb key={m.id} m={m} onImage={setLightbox} />
              ))}
            </div>
          )}
        </div>

        {/* Participantes do grupo */}
        {isGroup && (
          <div className="bg-surface px-6 py-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
              Participantes{group ? ` (${group.participants.length})` : ''}
            </p>
            {!group ? (
              <p className="text-sm text-ink-400">Carregando…</p>
            ) : (
              <div className="space-y-1.5">
                {group.participants.map((p) => (
                  <div key={p.jid} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink-700">{p.numero ? maskPhone(p.numero) : p.jid.split('@')[0]}</span>
                    {p.admin && <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600">{p.admin === 'superadmin' ? 'dono' : 'admin'}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
    {contactModal && (
      <ContactFormModal companyId={chat.company_id} contact={contactModal.contact} defaultPhone={chat.numero}
        onClose={() => setContactModal(null)}
        onSaved={(c) => {
          setContatos((xs) => (xs.some((x) => x.id === c.id) ? xs.map((x) => (x.id === c.id ? c : x)) : [...xs, c]));
          // "Salvar contato": grava o vínculo na conversa (persiste + passa a
          // exibir o nome do contato na lista/cabeçalho).
          if (contactModal.link) {
            void api.patch<{ chat: WaChat }>(`/api/whatsapp/chats/${chat.id}/contact`, { contact_id: c.id })
              .then((r) => onChatUpdate(r.chat))
              .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Falha ao vincular contato à conversa'));
          } else if (Number(c.id) === Number(chat.contact_id)) {
            // Editou o contato já vinculado: reflete o novo nome no cabeçalho/lista.
            onChatUpdate({ ...chat, contact_nome: c.nome });
          }
        }}
        onDeleted={(id) => {
          setContatos((xs) => xs.filter((x) => x.id !== id));
          // FK ON DELETE SET NULL: o vínculo caiu no banco; reflete no cabeçalho.
          if (Number(id) === Number(chat.contact_id)) onChatUpdate({ ...chat, contact_id: null, contact_nome: null });
        }} />
    )}
    <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />
   </>
  );
}

export function WhatsApp(): React.JSX.Element {
  const { can, user } = useAuth();
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [chats, setChats] = useState<WaChat[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  // "Espiar": conversa aberta num modal sem confirmar leitura (nem ticks azuis
  // nem zerar o contador) e sem trocar a conversa ativa.
  const [peekChat, setPeekChat] = useState<WaChat | null>(null);
  const [peekMessages, setPeekMessages] = useState<WaMessage[]>([]);
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [noteMode, setNoteMode] = useState(false); // compõe nota interna, não envio
  const [noteReplyTo, setNoteReplyTo] = useState<WaMessage | null>(null); // nota pendurada numa msg
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [busca, setBusca] = useState('');
  const [typingJid, setTypingJid] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [numberOpen, setNumberOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sp] = useSearchParams();
  const activeRef = useRef<number | null>(null);
  const chatsRef = useRef<WaChat[]>([]);
  // Debounce da recarga da lista quando chega mensagem de conversa desconhecida.
  const reloadChatsT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const listContentRef = useRef<HTMLDivElement>(null);
  const openedParam = useRef(false);
  const peekIdRef = useRef<number | null>(null);
  activeRef.current = activeId;
  chatsRef.current = chats;
  peekIdRef.current = peekChat?.id ?? null;

  const loadStatus = (): Promise<void> =>
    api.get<{ enabled: boolean; status: WaStatus }>('/api/whatsapp/status')
      .then(async (r) => {
        setEnabled(r.enabled);
        // O status do /status vem do cache no banco, que pode estar defasado nos
        // dois sentidos: sessão derrubada no aparelho sem o webhook chegar (cache
        // 'conectado', real morto) ou instância viva na Evolution com cache
        // 'desconectado' (webhook perdido, server reiniciado). Confirma sempre o
        // estado real (/connection); se a consulta falhar (ex.: instância nunca
        // criada), fica com o cache.
        if (r.enabled) {
          const live = await api.get<{ status: WaStatus }>('/api/whatsapp/connection').catch(() => ({ status: r.status }));
          setStatus(live.status);
        } else {
          setStatus(r.status);
        }
      })
      .catch(() => { setStatus('desconectado'); });

  const loadChats = (): Promise<void> =>
    api.get<{ chats: WaChat[] }>('/api/whatsapp/chats').then((r) => setChats(r.chats)).catch(() => undefined);

  useEffect(() => { void loadStatus(); }, []);
  useEffect(() => { if (status === 'conectado') void loadChats(); }, [status]);

  // Abertura direta vinda do funil (/whatsapp?chat=ID), uma vez só.
  useEffect(() => {
    if (openedParam.current) return;
    const c = sp.get('chat');
    // id vem bigint do pg => string em runtime; coage os dois lados e abre com o id real.
    const target = c ? chats.find((x) => Number(x.id) === Number(c)) : null;
    if (target) { openChat(target.id); openedParam.current = true; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, sp]);

  const openChat = (id: number): void => {
    setActiveId(id);
    // Zera as mensagens da conversa anterior: sem isso a lista antiga fica na
    // tela até a resposta chegar e o scroll ancora no lugar errado.
    if (activeRef.current !== id) setMessages([]);
    void api.get<{ messages: WaMessage[] }>(`/api/whatsapp/chats/${id}/messages`)
      .then((r) => setMessages(r.messages)).catch(() => undefined);
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, nao_lidas: 0 } : c)));
  };

  // Espiar: carrega as mensagens com ?peek=1 (servidor não confirma leitura nem
  // zera o contador) e mostra num modal, sem mexer na conversa ativa.
  const openPeek = (c: WaChat): void => {
    setPeekChat(c);
    setPeekMessages([]);
    void api.get<{ messages: WaMessage[] }>(`/api/whatsapp/chats/${c.id}/messages?peek=1`)
      .then((r) => setPeekMessages(r.messages)).catch(() => undefined);
  };

  // "Marcar como lida" no modal de espiar: confirma a leitura (ticks azuis),
  // zera o contador na lista e fecha o modal.
  const peekRead = (): void => {
    const id = peekIdRef.current;
    if (id == null) return;
    void api.post(`/api/whatsapp/chats/${id}/read`, {}).catch(() => undefined);
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, nao_lidas: 0 } : c)));
    setPeekChat(null);
  };

  // Remove a conversa do espelho local (mensagens/agendamentos vão junto).
  const delChat = async (chat: WaChat): Promise<void> => {
    if (!(await confirmDialog(`Apagar a conversa com "${nomeChat(chat)}"? As mensagens serão removidas deste painel.`))) return;
    try {
      await api.del(`/api/whatsapp/chats/${chat.id}`);
      setChats((cs) => cs.filter((c) => c.id !== chat.id));
      if (activeRef.current === chat.id) { setActiveId(null); setMessages([]); }
      toast.success('Conversa apagada.');
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao apagar'); }
  };

  // Desconecta/remove a sessão do WhatsApp (logout na Evolution) e volta pro QR.
  const disconnect = async (): Promise<void> => {
    if (!(await confirmDialog('Desconectar o WhatsApp desta conta? Será preciso ler o QR Code de novo para reconectar.'))) return;
    try {
      await api.post('/api/whatsapp/disconnect');
      setStatus('desconectado');
      setChats([]); setActiveId(null); setMessages([]);
      toast.success('WhatsApp desconectado.');
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Falha ao desconectar'); }
  };

  // Rede de segurança: revalida a conexão real na Evolution enquanto conectado.
  // O webhook 'status' já reflete quedas em tempo real, mas se ele não chegar
  // (Evolution reiniciou, socket caiu) o polling detecta e cai pro painel de QR.
  useEffect(() => {
    if (status !== 'conectado') return;
    const t = setInterval(() => {
      void api.get<{ status: WaStatus }>('/api/whatsapp/connection')
        .then((r) => { if (r.status !== 'conectado') setStatus(r.status); })
        .catch(() => undefined);
    }, 30000);
    return () => clearInterval(t);
  }, [status]);

  // Aplica uma mensagem recém-chegada no item da lista (contador, prévia,
  // horário, topo) sem recarregar a lista inteira.
  const patchChatItem = (chatId: number | undefined, m: WaMessage, patch?: Partial<WaChat>): void => {
    setChats((cs) => {
      const idx = cs.findIndex((c) => Number(c.id) === Number(chatId));
      if (idx === -1) return cs;
      const cur = cs[idx];
      const upd: WaChat = {
        ...cur,
        nao_lidas: patch?.nao_lidas != null ? Number(patch.nao_lidas) : (m.from_me ? 0 : cur.nao_lidas + 1),
        last_preview: patch?.last_preview ?? (m.corpo ?? `[${m.tipo === 'texto' ? 'mídia' : m.tipo}]`),
        last_message_at: patch?.last_message_at ?? m.momento,
      };
      return [upd, ...cs.slice(0, idx), ...cs.slice(idx + 1)];
    });
  };

  // some o "digitando…" sozinho se parar de chegar presença.
  useEffect(() => {
    if (!typingJid) return;
    const t = setTimeout(() => setTypingJid(null), 6000);
    return () => clearTimeout(t);
  }, [typingJid]);

  // WebSocket: espelho ao vivo. Reconecta sozinho ao cair.
  useEffect(() => {
    if (status !== 'conectado') return;
    const token = getToken();
    if (!token) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = (): void => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/whatsapp/ws?token=${encodeURIComponent(token)}`);
      ws.onmessage = (ev) => {
        let msg: { event: string; data: { chat_id?: number; removed_id?: number; message?: WaMessage; chat?: Partial<WaChat>; status?: WaStatus; evolution_id?: string; remote_jid?: string; typing?: boolean } };
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        if (msg.event === 'status') { setStatus(msg.data.status ?? 'desconectado'); return; }
        if (msg.event === 'chat-foto') { void loadChats(); return; }
        if (msg.event === 'chat-removed') {
          const rid = msg.data.chat_id;
          setChats((cs) => cs.filter((c) => Number(c.id) !== Number(rid)));
          if (Number(activeRef.current) === Number(rid)) { setActiveId(null); setMessages([]); }
          return;
        }
        if (msg.event === 'merged') {
          void loadChats();
          if (Number(activeRef.current) === Number(msg.data.removed_id) && msg.data.chat_id != null) { setActiveId(msg.data.chat_id); }
          return;
        }
        if (msg.event === 'presence') { setTypingJid(msg.data.typing ? (msg.data.remote_jid ?? null) : null); return; }
        if (msg.event === 'message-status') {
          setMessages((ms) => ms.map((m) => (m.evolution_id === msg.data.evolution_id ? { ...m, status: msg.data.status as string } : m)));
          return;
        }
        if (msg.event === 'message' && msg.data.message) {
          const m = msg.data.message;
          const chatId = msg.data.chat_id;
          // Modal de espiar aberto nessa conversa: mensagem nova entra no modal
          // (sem confirmar leitura — os branches abaixo cuidam da lista).
          if (peekIdRef.current != null && Number(chatId) === Number(peekIdRef.current)) {
            setPeekMessages((ms) => insertMsg(ms, m));
          }
          if (Number(chatId) === Number(activeRef.current)) {
            setMessages((ms) => insertMsg(ms, m));
            // Nota interna não é mensagem recebida: não confirma leitura nem recarrega.
            if (m.internal) return;
            // Conversa aberta: confirma leitura no servidor e só então recarrega a
            // lista já zerada (evita que loadChats traga o contador de volta).
            void api.post(`/api/whatsapp/chats/${chatId}/read`, {})
              .then(loadChats).catch(() => loadChats());
          } else if (m.internal) {
            // Nota numa conversa fechada: não mexe na prévia/contador da lista;
            // aparece quando a conversa for aberta (vem no GET das mensagens).
            return;
          } else if (chatsRef.current.some((c) => Number(c.id) === Number(chatId))) {
            // Conversa fechada mas já listada: aplica o payload direto no item
            // (contador, prévia, horário, topo) — sem recarregar a lista inteira.
            patchChatItem(chatId, m, msg.data.chat);
          } else {
            // Conversa ainda fora da lista (nova): reconciliação com debounce —
            // uma rajada de mensagens vira uma recarga só.
            clearTimeout(reloadChatsT.current);
            reloadChatsT.current = setTimeout(() => { void loadChats(); }, 2000);
          }
        }
      };
      ws.onclose = () => { if (!stop) retry = setTimeout(connect, 3000); };
    };
    connect();
    return () => { stop = true; clearTimeout(retry); clearTimeout(reloadChatsT.current); ws?.close(); };
  }, [status]);

  // c.id é STRING (bigint em SELECT direto) e activeId pode ser NUMBER — vem assim
  // do payload WS de 'merged'. Sem coagir, a conversa aberta some da tela quando os
  // chats de telefone e @lid se conciliam sozinhos durante a ingestão do webhook.
  const active = useMemo(() => chats.find((c) => Number(c.id) === Number(activeId)) ?? null, [chats, activeId]);
  // Contato só-LID (sem número): não dá pra enviar até informar o telefone.
  const needsNumber = !!active && !active.numero && active.remote_jid.endsWith('@lid');
  const filtered = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => nomeChat(c).toLowerCase().includes(q) || (c.numero ?? '').includes(q));
  }, [chats, busca]);

  // "Criar pedido" abre o modal de pedido in-place (sem sair da conversa),
  // pré-preenchido com a empresa vinculada.
  const orderPrefill = useMemo(() => (active?.company_id == null ? null : {
    company_id: active.company_id,
    represented_id: active.represented_id,
    relationship_id: active.relationship_id,
    company_label: active.company_fantasia || active.company_nome || undefined,
  }), [active]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || activeId == null) return;
    if (needsNumber) { setNumberOpen(true); return; } // pede o número antes de enviar
    setDraft('');
    // Otimista, como no WhatsApp Web: o balão entra na conversa na hora (relógio),
    // e a chamada à API acontece depois. Id temporário negativo não colide com os
    // ids reais do banco.
    const tempId = -Date.now();
    const temp: WaMessage = {
      id: tempId, evolution_id: null, from_me: true, tipo: 'texto', corpo: text,
      status: 'pendente', momento: new Date().toISOString(), mime: null, file_name: null,
      sender_nome: user?.nome || user?.org_nome || user?.email || null,
    };
    setMessages((ms) => [...ms, temp]);
    try {
      const r = await api.post<{ message: WaMessage | null }>(`/api/whatsapp/chats/${activeId}/send`, { text });
      setMessages((ms) => {
        // Troca o balão temporário pelo registro real; se o WebSocket já entregou
        // a mensagem real nesse meio-tempo, só remove o temporário.
        const rest = ms.filter((x) => x.id !== tempId);
        if (!r.message) return rest.length === ms.length ? ms : [...rest, { ...temp, status: 'enviado' }];
        return insertMsg(rest, r.message);
      });
      void loadChats();
    } catch (e) {
      // Mantém o balão na conversa marcado como falha (exclamação vermelha).
      setMessages((ms) => ms.map((x) => (x.id === tempId ? { ...x, status: 'falhou' } : x)));
      toast.error(e instanceof ApiError ? e.message : 'Falha ao enviar');
    }
  };

  // Nota interna: grava o balão só no app (não chama Evolution). Otimista como o
  // envio; sem loadChats porque a nota não mexe na prévia da conversa.
  // Entra no modo nota já pendurada numa mensagem (menu de ações do balão) e foca
  // o compositor. Setters são estáveis → callback estável (não invalida o memo).
  const startNote = useCallback((m: WaMessage): void => {
    setNoteMode(true);
    setNoteReplyTo(m);
    setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  const sendNote = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || activeId == null) return;
    const replyTo = noteReplyTo;
    setDraft('');
    setNoteReplyTo(null);
    setNoteMode(false); // fecha o compositor de nota depois de criar
    const tempId = -Date.now();
    const temp: WaMessage = {
      id: tempId, evolution_id: null, from_me: true, tipo: 'texto', corpo: text,
      status: null, momento: new Date().toISOString(), mime: null, file_name: null,
      sender_nome: user?.nome || user?.org_nome || user?.email || null, internal: true,
      reply_to_id: replyTo ? replyTo.id : null,
    };
    setMessages((ms) => [...ms, temp]);
    try {
      const r = await api.post<{ message: WaMessage | null }>(`/api/whatsapp/chats/${activeId}/note`,
        { text, replyToId: replyTo ? replyTo.id : null });
      setMessages((ms) => {
        const rest = ms.filter((x) => x.id !== tempId);
        if (!r.message) return rest.length === ms.length ? ms : [...rest, temp];
        return insertMsg(rest, r.message);
      });
    } catch (e) {
      setMessages((ms) => ms.filter((x) => x.id !== tempId));
      toast.error(e instanceof ApiError ? e.message : 'Falha ao salvar nota');
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || activeId == null) return;
    if (needsNumber) { setNumberOpen(true); return; } // pede o número antes de enviar
    if (f.size > 16 * 1024 * 1024) { toast.error('Arquivo acima de 16MB.'); return; }
    try {
      const media = await fileToBase64(f);
      const r = await api.post<{ message: WaMessage | null }>(`/api/whatsapp/chats/${activeId}/send-media`, {
        media, mediatype: detectType(f.type), mimetype: f.type || null, fileName: f.name, caption: null,
      });
      if (r.message) setMessages((ms) => insertMsg(ms, r.message!));
      void loadChats();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha ao enviar arquivo');
    }
  };

  // Lista com separadores de data entre dias.
  const listItems = useMemo(() => messageList(messages, setLightbox, startNote), [messages, startNote]);

  // Rola pro fim ao trocar de conversa ou chegar mensagem. scrollTop direto (e
  // antes da pintura) em vez de scrollIntoView: o scrollIntoView também rolava
  // ancestrais e às vezes parava antes da última mensagem.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.scrollTop = canvas.scrollHeight;
  }, [messages, activeId]);

  // Mídia (imagens) carrega depois do scroll inicial e empurra a lista pra baixo.
  // Enquanto o usuário estiver no fim (não rolou pra cima), qualquer crescimento
  // do conteúdo re-ancora na última mensagem.
  useEffect(() => {
    const canvas = canvasRef.current;
    const content = listContentRef.current;
    if (!canvas || !content || activeId == null || typeof ResizeObserver === 'undefined') return;
    let stick = true;
    canvas.scrollTop = canvas.scrollHeight; // ancora na abertura da conversa
    const onScroll = (): void => {
      stick = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 80;
    };
    canvas.addEventListener('scroll', onScroll);
    const ro = new ResizeObserver(() => { if (stick) canvas.scrollTop = canvas.scrollHeight; });
    ro.observe(content);
    return () => { canvas.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [activeId]);

  if (status === null) return <Spinner label="Carregando…" />;
  if (!enabled) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Card className="max-w-sm p-8 text-center text-sm text-ink-500">
          Integração WhatsApp não configurada no servidor (defina <code>EVOLUTION_API_URL</code> e
          <code> EVOLUTION_API_KEY</code>).
        </Card>
      </div>
    );
  }
  if (status !== 'conectado') {
    return <ConnectPanel onConnected={() => { setStatus('conectado'); }} />;
  }

  const isTyping = !!active && typingJid === active.remote_jid;

  return (
    <div className="h-full">
      <input ref={fileRef} type="file" hidden onChange={(e) => void onFile(e)} />
      <div className="wa relative flex h-full overflow-hidden">
        {/* coluna de conversas — vira tela cheia no mobile quando não há chat aberto */}
        <div className={cn('w-full shrink-0 flex-col border-r border-[var(--wa-border)] bg-[var(--wa-sidebar)] md:flex md:w-[360px]',
          active ? 'hidden md:flex' : 'flex')}>
          <div className="flex items-center justify-between gap-2 bg-[var(--wa-panel)] px-4 py-2.5">
            <span className="text-base font-semibold text-[var(--wa-ink)]">Conversas</span>
            <div className="flex shrink-0 items-center gap-0.5">
              <button title="Nova conversa" onClick={() => setNewChatOpen(true)}
                className="grid h-9 w-9 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)]">
                <Icon name="pencil" size={18} />
              </button>
              {can('whatsapp.connect') && (
                <button title="Desconectar WhatsApp" aria-label="Desconectar WhatsApp" onClick={() => void disconnect()}
                  className="grid h-9 w-9 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                  <Icon name="logout" size={18} />
                </button>
              )}
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center gap-2 rounded-lg bg-[var(--wa-panel)] px-3 py-1.5">
              <Icon name="search" size={16} className="shrink-0 text-[var(--wa-muted)]" />
              <input value={busca} maxLength={120} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar conversa…"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--wa-ink)] outline-none placeholder:text-[var(--wa-muted)]" />
              {busca && (
                <button onClick={() => setBusca('')} aria-label="Limpar" className="shrink-0 text-[var(--wa-muted)] hover:text-[var(--wa-ink)]">
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-[var(--wa-muted)]">Nenhuma conversa.</p>
            ) : filtered.map((c) => (
              <button key={c.id} onClick={() => openChat(c.id)}
                className={cn('group flex w-full items-center gap-3 border-b border-[var(--wa-border)] px-3 py-2.5 text-left transition-colors',
                  Number(c.id) === Number(activeId) ? 'bg-[var(--wa-active)]' : 'hover:bg-[var(--wa-hover)]')}>
                <ChatAvatar chat={c} className="h-12 w-12 shrink-0 rounded-full object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-[var(--wa-ink)]">{nomeChat(c)}</span>
                    {c.last_message_at && <span className="shrink-0 text-[11px] text-[var(--wa-muted)]">{hora(c.last_message_at)}</span>}
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-[var(--wa-muted)]">{c.last_preview ?? ''}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {/* Espiar: abre a conversa num modal sem confirmar leitura. span
                          com role de botão porque o item inteiro já é um <button>. */}
                      <span role="button" tabIndex={0} title="Espiar (ler sem confirmar a leitura)" aria-label="Espiar conversa"
                        onClick={(e) => { e.stopPropagation(); openPeek(c); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openPeek(c); } }}
                        className="hidden h-5 w-5 place-items-center rounded-full text-[var(--wa-muted)] hover:text-[var(--wa-ink)] group-hover:grid">
                        <Icon name="eye" size={15} />
                      </span>
                      {c.nao_lidas > 0 && (
                        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--wa-green)] px-1.5 text-[11px] font-bold text-white">{c.nao_lidas}</span>
                      )}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* coluna do chat */}
        <div className={cn('min-w-0 flex-1 flex-col', active ? 'flex' : 'hidden md:flex')}>
          {active ? (
            <>
              <div className="flex items-center gap-2 border-b border-[var(--wa-border)] bg-[var(--wa-panel)] px-3 py-2">
                <button onClick={() => { setActiveId(null); setMessages([]); }} aria-label="Voltar"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)] md:hidden">
                  <Icon name="chevronLeft" size={20} />
                </button>
                <button onClick={() => setDetailsOpen(true)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <ChatAvatar chat={active} className="h-10 w-10 shrink-0 rounded-full object-cover" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold text-[var(--wa-ink)]">{nomeChat(active)}</span>
                      {active.agendamentos_pendentes > 0 && (
                        <span title="Há mensagens agendadas para este contato"
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                          <Icon name="clock" size={11} />
                          {active.agendamentos_pendentes > 1 ? `${active.agendamentos_pendentes} mensagens agendadas` : 'Mensagem agendada'}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-[var(--wa-muted)]">
                      {isTyping ? 'digitando…'
                        : needsNumber ? 'número oculto (LID) — informe o telefone'
                        : active.company_id != null ? (active.company_fantasia || active.company_nome || '')
                        : chatIdent(active)}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5">
                  {needsNumber && can('whatsapp.link') && (
                    <button title="Informar número do contato" onClick={() => setNumberOpen(true)}
                      className="grid h-9 w-9 place-items-center rounded-full text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10">
                      <Icon name="phone" size={18} />
                    </button>
                  )}
                  {active.company_id != null && (
                    <button title="Criar pedido" onClick={() => setOrderOpen(true)}
                      className="grid h-9 w-9 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)]">
                      <Icon name="plus" size={18} />
                    </button>
                  )}
                  {can('whatsapp.link') && (
                    <button title="Conciliar conversas (telefone + LID)" onClick={() => setMergeOpen(true)}
                      className="grid h-9 w-9 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)]">
                      <Icon name="layers" size={18} />
                    </button>
                  )}
                  {can('whatsapp.schedule') && (
                    <button title="Agendar mensagem" onClick={() => setSchedOpen(true)}
                      className="grid h-9 w-9 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)]">
                      <Icon name="clock" size={18} />
                    </button>
                  )}
                  {can('whatsapp.link') && (
                    <button title={active.company_id != null ? 'Empresa vinculada' : 'Vincular empresa'} onClick={() => setLinkOpen(true)}
                      className={cn('grid h-9 w-9 place-items-center rounded-full hover:bg-[var(--wa-hover)]', active.company_id != null ? 'text-emerald-600' : 'text-[var(--wa-muted)]')}>
                      <Icon name="users" size={18} />
                    </button>
                  )}
                  <SafeButton title="Apagar conversa" onClick={() => delChat(active)}
                    className="grid h-9 w-9 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                    <Icon name="trash" size={18} />
                  </SafeButton>
                </div>
              </div>

              <div ref={canvasRef} className="wa-canvas min-h-0 flex-1 overflow-y-auto py-3">
                <div ref={listContentRef}>
                  {listItems}
                  {isTyping && (
                    <div className="flex justify-start px-[5%] py-0.5">
                      <div className="rounded-lg bg-[var(--wa-in)] px-3 py-2 text-[13px] italic text-[var(--wa-muted)] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">digitando…</div>
                    </div>
                  )}
                  <div ref={listEndRef} />
                </div>
              </div>

              {/* Barra de digitação compacta no mobile (metade da altura): tela pequena
                  precisa do espaço pras mensagens. A partir de md volta ao tamanho cheio. */}
              {/* Sem env(safe-area-inset-bottom): no PWA iOS o inset do home
                  indicator sobrava como faixa vazia sob a barra de digitação.
                  A barra fica só na altura dos ícones. */}
              <div className={cn('px-2 pt-1 pb-1 md:px-3 md:pt-2 md:pb-2',
                noteMode ? 'bg-amber-100 dark:bg-amber-400/15' : 'bg-[var(--wa-panel)]')}>
                {/* Chip da mensagem citada: a nota vai pendurada nela. */}
                {noteMode && noteReplyTo && (
                  <div className="mb-1.5 flex items-start gap-2 rounded-lg border-l-[3px] border-amber-500 bg-amber-200/60 px-2.5 py-1.5 dark:bg-amber-400/10">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold text-amber-800 dark:text-amber-200">Nota em resposta a {quoteAutor(noteReplyTo)}</div>
                      <div className="line-clamp-2 break-words text-[12.5px] text-amber-900/80 dark:text-amber-100/80">{quotePreview(noteReplyTo)}</div>
                    </div>
                    <button onClick={() => setNoteReplyTo(null)} aria-label="Soltar a mensagem citada"
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-amber-700 hover:bg-amber-300/50 dark:text-amber-300">
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                {/* Alterna entre enviar mensagem e criar nota interna (só a equipe vê). */}
                <button onClick={() => { setNoteMode((v) => { if (v) setNoteReplyTo(null); return !v; }); }} aria-pressed={noteMode}
                  title={noteMode ? 'Modo nota interna (clique para voltar a enviar)' : 'Nota interna (não enviada ao contato)'}
                  className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full md:h-10 md:w-10',
                    noteMode ? 'bg-amber-400/30 text-amber-700 dark:text-amber-300' : 'text-[var(--wa-muted)] hover:bg-[var(--wa-hover)]')}>
                  <Icon name="pencil" size={20} />
                </button>
                {!noteMode && can('whatsapp.send') && (
                  <button onClick={() => fileRef.current?.click()} aria-label="Anexar"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wa-muted)] hover:bg-[var(--wa-hover)] md:h-10 md:w-10">
                    <Icon name="paperclip" size={20} />
                  </button>
                )}
                <textarea ref={composerRef} value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)} rows={1} autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (noteMode) void sendNote(); else if (can('whatsapp.send')) void send(); } }}
                  placeholder={noteMode ? 'Nota interna — só a equipe vê…' : 'Digite uma mensagem…'}
                  className={cn('max-h-24 min-h-[28px] min-w-0 flex-1 resize-none rounded-lg px-3 py-1 text-sm leading-tight outline-none md:max-h-32 md:min-h-[40px] md:py-2 md:leading-normal',
                    noteMode ? 'bg-amber-50 text-amber-900 placeholder:text-amber-700/60 dark:bg-amber-400/10 dark:text-amber-100' : 'bg-[var(--wa-in)] text-[var(--wa-ink)] placeholder:text-[var(--wa-muted)]')} />
                {(noteMode || can('whatsapp.send')) && (
                  <SafeButton onClick={() => (noteMode ? sendNote() : send())} aria-label={noteMode ? 'Salvar nota' : 'Enviar'}
                    className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-[var(--wa-hover)] md:h-10 md:w-10',
                      noteMode ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--wa-green)]')}>
                    <Icon name={noteMode ? 'check' : 'send'} size={20} />
                  </SafeButton>
                )}
                </div>
              </div>
            </>
          ) : (
            <div className="wa-canvas grid h-full place-items-center text-sm text-[var(--wa-muted)]">
              Selecione uma conversa
            </div>
          )}
        </div>

        {active && detailsOpen && (
          <ContactDetails chat={active} messages={messages} onClose={() => setDetailsOpen(false)}
            onLink={() => { setDetailsOpen(false); setLinkOpen(true); }}
            onOrder={() => { setDetailsOpen(false); setOrderOpen(true); }}
            onNumber={() => { setDetailsOpen(false); setNumberOpen(true); }}
            onOpenContact={(id) => { setDetailsOpen(false); void loadChats().then(() => openChat(id)); }}
            onChatUpdate={(c) => setChats((cs) => cs.map((x) => (x.id === c.id ? c : x)))} />
        )}
      </div>
      {active && linkOpen && (
        <LinkModal chatId={active.id} current={active} onClose={() => setLinkOpen(false)}
          onLinked={(c) => setChats((cs) => cs.map((x) => (x.id === c.id ? c : x)))} />
      )}
      {active && schedOpen && <ScheduleModal chat={active} onClose={() => setSchedOpen(false)} onChanged={() => void loadChats()} />}
      {active && mergeOpen && (
        <MergeModal current={active} chats={chats} onClose={() => setMergeOpen(false)} onMerged={() => void loadChats()} />
      )}
      {orderOpen && orderPrefill && (
        <OrderModal prefill={orderPrefill} onClose={() => setOrderOpen(false)} onSaved={() => setOrderOpen(false)} />
      )}
      {newChatOpen && (
        <NewChatModal onClose={() => setNewChatOpen(false)}
          onOpened={(id) => { void loadChats().then(() => openChat(id)); }} />
      )}
      {active && numberOpen && (
        <NumberModal chatId={active.id} onClose={() => setNumberOpen(false)}
          onSet={(c) => setChats((cs) => cs.map((x) => (x.id === c.id ? c : x)))} />
      )}
      {peekChat && (
        <PeekModal chat={peekChat} messages={peekMessages} onClose={() => setPeekChat(null)}
          onRead={peekRead} onImage={setLightbox} />
      )}
      <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
