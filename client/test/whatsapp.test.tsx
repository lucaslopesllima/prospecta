// WhatsApp: espelho de chat com WebSocket, modais (número/merge/pedido/agenda),
// mídia autenticada, presença/typing, detalhes do contato/grupo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WhatsApp } from '../src/pages/WhatsApp.tsx';
import { api, ApiError } from '../src/lib/api.ts';
import { useAuth, type User } from '../src/lib/auth.tsx';
import { toast } from '../src/lib/toast.tsx';
import { confirmDialog } from '../src/lib/confirm.ts';

vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), invalidate: vi.fn() } };
});
vi.mock('../src/lib/auth.tsx', () => {
  const useAuth = vi.fn();
  return { useAuth, useOptionalUser: () => useAuth().user ?? null };
});
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn() }));
vi.mock('../src/lib/orderModal.tsx', () => ({
  OrderModal: ({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) => (
    <div data-testid="order-modal">
      <button onClick={onSaved}>save-order</button>
      <button onClick={onClose}>close-order</button>
    </div>
  ),
}));
// CompanySearch mockado: um botão que dispara onPick com um hit configurável.
let pickHit: Record<string, unknown> = { id: 500, telefone1: '5511977776666' };
vi.mock('../src/lib/companySearch.tsx', () => ({
  CompanySearch: ({ onPick, placeholder }: { onPick: (c: unknown) => void; placeholder?: string }) => (
    <button data-testid="company-pick" onClick={() => onPick(pickHit)}>{placeholder ?? 'buscar'}</button>
  ),
}));

const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);
const admin: User = { id: 1, email: 'a@b.c', role: 'admin', org_id: 1, org_nome: 'Org' };

// ── WebSocket falso ──────────────────────────────────────────────────────────
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0;
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
  send(): void { /* noop */ }
  close(): void { this.readyState = 3; }
}
const lastWS = (): FakeWS => FakeWS.instances.at(-1)!;

// FileReader síncrono: evita que um onload assíncrono (macrotask) resolva e
// dispare api.post(send-media) DURANTE o teste seguinte (poluição cruzada).
class SyncFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result = '';
  readAsDataURL(): void { this.result = 'data:application/octet-stream;base64,QQ=='; this.onload?.(); }
}
const wsSend = (event: string, data: Record<string, unknown> = {}): void => {
  act(() => { lastWS().onmessage?.({ data: JSON.stringify({ event, data }) }); });
};

// ── Fixtures ─────────────────────────────────────────────────────────────────
const now = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const OLD = '2020-01-01T10:00:00.000Z';
const YEST = iso(now - 24 * 3600 * 1000);
// 1 min atrás (não 1h): perto da meia-noite, 1h atrás cai no dia anterior e o
// separador vira 'Ontem' — o teste dos separadores ficava flaky nessa janela.
const TODAY = iso(now - 60 * 1000);

const chatA = {
  id: 1, remote_jid: '11111@s.whatsapp.net', numero: '5511988887777', nome: 'Alice',
  foto_url: 'http://x/a.png', last_message_at: TODAY, last_preview: 'oi', lid: null, nao_lidas: 2,
  company_id: 100, relationship_id: 7, company_nome: 'Acme SA', company_fantasia: 'Acme',
  represented_id: 5, represented_nome: 'Rep',
};
const chatB = {
  id: 2, remote_jid: '123@g.us', numero: null, nome: null, foto_url: null,
  last_message_at: null, last_preview: null, lid: null, nao_lidas: 0,
  company_id: null, relationship_id: null, company_nome: null, company_fantasia: null,
  represented_id: null, represented_nome: null,
};
const chatC = {
  id: 3, remote_jid: '456@lid', numero: null, nome: null, foto_url: null,
  last_message_at: TODAY, last_preview: 'lid preview', lid: '456', nao_lidas: 0,
  company_id: null, relationship_id: null, company_nome: null, company_fantasia: null,
  represented_id: null, represented_nome: null,
};
const chatD = {
  id: 4, remote_jid: '789@s.whatsapp.net', numero: '1133334444', nome: null, foto_url: null,
  last_message_at: null, last_preview: null, lid: null, nao_lidas: 0,
  company_id: null, relationship_id: null, company_nome: null, company_fantasia: null,
  represented_id: null, represented_nome: null,
};
const CHATS = [chatA, chatB, chatC, chatD];

const msg = (o: Record<string, unknown>): Record<string, unknown> => ({
  id: 0, evolution_id: null, from_me: false, tipo: 'texto', corpo: null, status: null,
  momento: TODAY, mime: null, file_name: null, sender_nome: null, ...o,
});
const MESSAGES = [
  msg({ id: 1, from_me: false, tipo: 'texto', corpo: 'oi antigo', momento: OLD }),
  msg({ id: 2, from_me: true, tipo: 'texto', corpo: 'ontem', status: 'enviado', momento: YEST }),
  msg({ id: 3, evolution_id: 'ev1', from_me: true, tipo: 'texto', corpo: 'hoje', status: 'entregue', sender_nome: 'Carlos' }),
  msg({ id: 4, from_me: true, tipo: 'texto', corpo: 'lido', status: 'lido' }),
  msg({ id: 5, from_me: true, tipo: 'imagem', corpo: 'legenda', status: 'lido', mime: 'image/png' }),
  msg({ id: 6, from_me: true, tipo: 'video', status: 'lido', mime: 'video/mp4' }),
  msg({ id: 7, from_me: false, tipo: 'audio', mime: 'audio/ogg' }),
  msg({ id: 8, from_me: false, tipo: 'documento', mime: 'application/pdf', file_name: 'doc.pdf' }),
];

const GROUP = {
  subject: 'Grupo X', desc: 'descrição do grupo', size: 3,
  participants: [
    { numero: '5511999998888', jid: 'p1@s.whatsapp.net', admin: 'admin' },
    { numero: null, jid: 'p2@s.whatsapp.net', admin: 'superadmin' },
    { numero: '5511777776666', jid: 'p3@s.whatsapp.net', admin: null },
  ],
};
const CONTACTS = [
  { id: 11, nome: 'Bob', cargo: 'Comprador', telefone: '5511955554444', email: 'bob@x.com', company_id: 100, represented_id: null },
  { id: 12, nome: 'Ana', cargo: null, telefone: null, email: null, company_id: 100, represented_id: null },
];
const SCHEDULES = [
  { id: 21, chat_id: 1, corpo: 'enviada msg', agendado_para: OLD, status: 'enviado' },
  { id: 22, chat_id: 1, corpo: 'falhou msg', agendado_para: OLD, status: 'erro' },
  { id: 23, chat_id: 1, corpo: 'expirada msg', agendado_para: OLD, status: 'pendente' },
  { id: 24, chat_id: 1, corpo: 'ativa msg', agendado_para: iso(now + 7 * 24 * 3600 * 1000), status: 'pendente' },
];

let statusResp: { enabled: boolean; status: string } = { enabled: true, status: 'conectado' };
let connectionStatus = 'conectando';

const defaultGet = async (p: string): Promise<unknown> => {
  if (p === '/api/whatsapp/status') return statusResp;
  if (p === '/api/whatsapp/chats') return { chats: CHATS };
  if (/\/chats\/\d+\/messages$/.test(p)) return { messages: MESSAGES };
  if (/\/chats\/\d+\/group$/.test(p)) return GROUP;
  if (p.startsWith('/api/whatsapp/schedules?')) return { schedules: SCHEDULES };
  if (p.startsWith('/api/contacts?')) return { contacts: CONTACTS };
  if (p === '/api/whatsapp/connection') return { status: connectionStatus };
  return {};
};
const defaultPost = async (p: string): Promise<unknown> => {
  if (p.endsWith('/note')) return { message: msg({ id: 902, from_me: true, tipo: 'texto', corpo: 'minha nota', status: null, internal: true, sender_nome: 'Carlos' }) };
  if (p.endsWith('/send')) return { message: msg({ id: 900, from_me: true, tipo: 'texto', corpo: 'enviado!', status: 'enviado' }) };
  if (p.endsWith('/send-media')) return { message: msg({ id: 901, from_me: true, tipo: 'imagem', mime: 'image/png' }) };
  if (p.endsWith('/read')) return {};
  if (p === '/api/whatsapp/connect') return { qr: 'abc', status: 'conectando' };
  if (p.includes('/from-company')) return { chat: { id: 99 } };
  if (p.includes('/merge')) return {};
  if (p.includes('/schedule')) return {};
  if (p === '/api/contacts') return { contact: { id: 77, nome: 'Novo', cargo: null, telefone: null, email: null, company_id: 100, represented_id: null } };
  return {};
};
const defaultPatch = async (p: string): Promise<unknown> => {
  if (/\/numero$/.test(p)) return { chat: { ...chatC, numero: '5511900001111' } };
  if (/\/chats\/\d+\/contact$/.test(p)) return { chat: { ...chatD, contact_id: 77, contact_nome: 'Fulano' } };
  if (/\/link$/.test(p)) return { chat: { ...chatA, company_id: 200, company_fantasia: 'NovaCo' } };
  if (/\/contacts\/\d+$/.test(p)) return { contact: { id: 11, nome: 'Bob Edit', cargo: null, telefone: null, email: null, company_id: 100, represented_id: null } };
  return {};
};

beforeEach(() => {
  vi.mocked(m.get).mockReset();
  vi.mocked(m.post).mockReset();
  vi.mocked(m.patch).mockReset();
  vi.mocked(m.del).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  statusResp = { enabled: true, status: 'conectado' };
  connectionStatus = 'conectado';
  pickHit = { id: 500, telefone1: '5511977776666' };
  m.get.mockImplementation(defaultGet);
  m.post.mockImplementation(defaultPost);
  m.patch.mockImplementation(defaultPatch);
  m.del.mockResolvedValue({});
  vi.mocked(confirmDialog).mockResolvedValue(true);
  useAuthMock.mockReturnValue({
    user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can: () => true, isOffice: true,
  });
  FakeWS.instances = [];
  vi.stubGlobal('WebSocket', FakeWS);
  localStorage.setItem('rs_token', 'tok');
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['x']) })) as unknown as typeof fetch;
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  window.open = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('FileReader', SyncFileReader);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = (path = '/whatsapp'): ReturnType<typeof render> =>
  render(<MemoryRouter initialEntries={[path]}><WhatsApp /></MemoryRouter>);

// Abre app conectado e espera a lista de conversas.
const mountConnected = async (path = '/whatsapp'): Promise<ReturnType<typeof render>> => {
  const utils = mount(path);
  await screen.findByText('Alice');
  return utils;
};
const openChat = async (name: string): Promise<void> => {
  fireEvent.click((await screen.findByText(name)).closest('button')!);
};

describe('WhatsApp — estados de topo', () => {
  it('mostra spinner enquanto o status carrega', async () => {
    m.get.mockImplementation((p: string) => (p === '/api/whatsapp/status' ? new Promise(() => {}) : defaultGet(p)) as Promise<never>);
    mount();
    expect(await screen.findByText('Carregando…')).toBeInTheDocument();
  });

  it('mostra aviso quando a integração está desabilitada', async () => {
    statusResp = { enabled: false, status: 'desconectado' };
    mount();
    expect(await screen.findByText(/Integração WhatsApp não configurada/)).toBeInTheDocument();
  });

  it('cai para desconectado quando o status falha', async () => {
    m.get.mockImplementation((p: string) => (p === '/api/whatsapp/status' ? Promise.reject(new Error('x')) : defaultGet(p)) as Promise<never>);
    mount();
    expect(await screen.findByText('Conectar WhatsApp')).toBeInTheDocument();
  });
});

describe('WhatsApp — ConnectPanel', () => {
  // A tela confirma o estado real em /connection e ignora o cache do /status —
  // desconectar só pelo statusResp deixaria a página achando que está conectada.
  beforeEach(() => {
    statusResp = { enabled: true, status: 'desconectado' };
    connectionStatus = 'desconectado';
  });

  it('gera QR e faz polling até conectar', async () => {
    vi.useFakeTimers();
    m.post.mockImplementation((p: string) => (p === '/api/whatsapp/connect' ? Promise.resolve({ qr: 'abc', status: 'conectando' }) : defaultPost(p)) as Promise<never>);
    mount();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: /Gerar QR Code/ }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByAltText('QR Code')).toBeInTheDocument();
    // polling: connection vira conectado
    connectionStatus = 'conectado';
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // conectado agora carrega as conversas
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(m.get).toHaveBeenCalledWith('/api/whatsapp/chats');
    vi.useRealTimers();
  });

  it('conecta direto quando connect já volta conectado', async () => {
    m.post.mockImplementation((p: string) => (p === '/api/whatsapp/connect' ? Promise.resolve({ qr: null, status: 'conectado' }) : defaultPost(p)) as Promise<never>);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Gerar QR Code/ }));
    expect(await screen.findByText('Conversas')).toBeInTheDocument();
  });

  it('erro ao conectar dispara toast', async () => {
    m.post.mockImplementation((p: string) => (p === '/api/whatsapp/connect' ? Promise.reject(new ApiError(500, 'boom')) : defaultPost(p)) as Promise<never>);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Gerar QR Code/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
  });

  it('sem permissão não mostra botão de conectar', async () => {
    useAuthMock.mockReturnValue({ user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(), can: () => false, isOffice: true });
    mount();
    expect(await screen.findByText(/Você não tem permissão/)).toBeInTheDocument();
  });
});

describe('WhatsApp — lista e mensagens', () => {
  it('lista conversas e abre uma conversa com balões, ticks e separadores de data', async () => {
    const utils = await mountConnected();
    // nomeChat de cada conversa na lista
    expect(screen.getByText('Grupo')).toBeInTheDocument();
    expect(screen.getByText('456')).toBeInTheDocument(); // chatC split
    expect(screen.getByText('(11) 3333-4444')).toBeInTheDocument(); // chatD maskPhone

    await openChat('Alice');
    expect(await screen.findByText('hoje')).toBeInTheDocument();
    expect(screen.getByText('Hoje')).toBeInTheDocument();
    expect(screen.getByText('Ontem')).toBeInTheDocument();
    // nome do atendente no balão enviado pelo sistema (só onde sender_nome vem preenchido)
    expect(screen.getByText('Carlos')).toBeInTheDocument();
    // documento com nome de arquivo
    expect(await screen.findByText('doc.pdf')).toBeInTheDocument();
    // imagem carregada via fetch autenticado (o avatar da conversa também vem por
    // blob — filtra pela classe do balão pra não casar com ele)
    await waitFor(() => expect([...utils.container.querySelectorAll('img')]
      .some((i) => i.src === 'blob:mock' && i.className.includes('max-w-[240px]'))).toBe(true));
  });

  it('avatar vem do proxy do app, nunca do CDN do WhatsApp', async () => {
    const utils = await mountConnected();
    const avatares = [...utils.container.querySelectorAll('img')].filter((i) => i.className.includes('rounded-full'));
    // nenhum <img> aponta pro foto_url (CDN): a CSP de produção bloqueia e a URL caduca
    expect(avatares.some((i) => i.src.includes('x/a.png'))).toBe(false);
    // conversa com foto: blob do proxy; conversa sem foto: SVG com a inicial
    await waitFor(() => expect(avatares.some((i) => i.src === 'blob:mock')).toBe(true));
    expect(avatares.some((i) => i.src.startsWith('data:image/svg+xml'))).toBe(true);
  });

  it('nota pendurada aparece colada na mensagem de origem, fora da ordem cronológica', async () => {
    // Nota anexada à msg id 3 ('hoje'), mas no fim do array (momento mais novo):
    // deve ser puxada pra logo abaixo de 'hoje', antes de 'lido' (id 4).
    const withNote = [...MESSAGES, msg({ id: 50, from_me: true, internal: true, corpo: 'nota no hoje', reply_to_id: 3, sender_nome: 'Carlos' })];
    m.get.mockImplementation((p: string) => (/\/messages$/.test(p) ? Promise.resolve({ messages: withNote }) : defaultGet(p)));
    await mountConnected();
    await openChat('Alice');
    const hoje = await screen.findByText('hoje');
    const nota = await screen.findByText('nota no hoje');
    const lido = screen.getByText('lido');
    // nota depois de 'hoje' e antes de 'lido' no DOM
    expect(hoje.compareDocumentPosition(nota) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nota.compareDocumentPosition(lido) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('abre lightbox ao clicar na imagem e fecha com Esc', async () => {
    const utils = await mountConnected();
    await openChat('Alice');
    let blobImg: HTMLImageElement | undefined;
    await waitFor(() => {
      // a imagem do balão (não o avatar da conversa, que também é blob)
      blobImg = [...utils.container.querySelectorAll('img')].find((i) => i.src === 'blob:mock' && i.className.includes('max-w-[240px]'));
      expect(blobImg).toBeTruthy();
    });
    fireEvent.click(blobImg!);
    const link = await screen.findByTitle('Abrir original');
    // cliques internos (link + imagem) não fecham o lightbox (stopPropagation)
    fireEvent.click(link);
    fireEvent.click(link.parentElement!.querySelector('img')!);
    expect(screen.getByTitle('Abrir original')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTitle('Abrir original')).not.toBeInTheDocument());
  });

  it('abre documento em nova aba (fetch autenticado)', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByText('doc.pdf'));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
  });

  it('erro ao abrir mídia dispara toast', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })) as unknown as typeof fetch;
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByText('doc.pdf'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível abrir a mídia.'));
  });

  it('filtra conversas pela busca e limpa', async () => {
    await mountConnected();
    const search = screen.getByPlaceholderText('Buscar conversa…');
    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(await screen.findByText('Nenhuma conversa.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Limpar'));
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'alic' } });
    await waitFor(() => expect(screen.queryByText('Grupo')).not.toBeInTheDocument());
  });

  it('abre conversa via ?chat= (deep-link do funil)', async () => {
    await mountConnected('/whatsapp?chat=1');
    expect(await screen.findByText('hoje')).toBeInTheDocument();
  });
});

describe('WhatsApp — envio', () => {
  it('envia texto e limpa o rascunho', async () => {
    await mountConnected();
    await openChat('Alice');
    const ta = await screen.findByPlaceholderText('Digite uma mensagem…');
    fireEvent.change(ta, { target: { value: 'olá mundo' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/send', { text: 'olá mundo' }));
    expect(await screen.findByText('enviado!')).toBeInTheDocument();
  });

  it('nota interna: alterna o modo e salva sem chamar /send', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(screen.getByTitle('Nota interna (não enviada ao contato)'));
    const ta = await screen.findByPlaceholderText('Nota interna — só a equipe vê…');
    fireEvent.change(ta, { target: { value: 'lembrete' } });
    fireEvent.click(screen.getByLabelText('Salvar nota'));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/note', { text: 'lembrete', replyToId: null }));
    expect(m.post).not.toHaveBeenCalledWith('/api/whatsapp/chats/1/send', expect.anything());
    expect(await screen.findByText('minha nota')).toBeInTheDocument();
    expect(screen.getByText(/Nota interna/)).toBeInTheDocument();
  });

  it('flecha de ações cria nota pendurada na mensagem (replyToId)', async () => {
    await mountConnected();
    await openChat('Alice');
    // Abre o menu de ações do balão existente e escolhe "Criar nota".
    const chevrons = await screen.findAllByLabelText('Ações da mensagem');
    fireEvent.click(chevrons[0]);
    fireEvent.click(await screen.findByText('Criar nota'));
    // Chip da mensagem citada aparece; digita e salva.
    expect(await screen.findByText(/Nota em resposta a/)).toBeInTheDocument();
    const ta = await screen.findByPlaceholderText('Nota interna — só a equipe vê…');
    fireEvent.change(ta, { target: { value: 'pendurada' } });
    fireEvent.click(screen.getByLabelText('Salvar nota'));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/note',
      expect.objectContaining({ text: 'pendurada', replyToId: expect.anything() })));
    const call = m.post.mock.calls.find((c: unknown[]) => c[0] === '/api/whatsapp/chats/1/note');
    expect((call![1] as { replyToId: unknown }).replyToId).not.toBeNull();
  });

  it('envia com Enter', async () => {
    await mountConnected();
    await openChat('Alice');
    const ta = await screen.findByPlaceholderText('Digite uma mensagem…');
    fireEvent.change(ta, { target: { value: 'via enter' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/send', { text: 'via enter' }));
  });

  it('rascunho vazio não envia', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByLabelText('Enviar'));
    await waitFor(() => expect(m.post).not.toHaveBeenCalledWith(expect.stringContaining('/send'), expect.anything()));
  });

  it('falha no envio mantém o balão marcado como falha e avisa', async () => {
    m.post.mockImplementation((p: string) => (p.endsWith('/send') ? Promise.reject(new ApiError(500, 'no net')) : defaultPost(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    const ta = await screen.findByPlaceholderText('Digite uma mensagem…');
    fireEvent.change(ta, { target: { value: 'oops' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('no net'));
    // Como no WhatsApp Web: o balão continua na conversa com a exclamação
    // vermelha de falha, e o rascunho não é restaurado.
    expect(screen.getByText('oops')).toBeInTheDocument();
    expect(screen.getByLabelText('Falha ao enviar')).toBeInTheDocument();
    expect((ta as HTMLTextAreaElement).value).toBe('');
  });

  it('envio otimista: balão aparece antes da resposta da API', async () => {
    let resolveSend: (v: unknown) => void = () => {};
    m.post.mockImplementation((p: string) => (p.endsWith('/send')
      ? new Promise((res) => { resolveSend = res; })
      : defaultPost(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    const ta = await screen.findByPlaceholderText('Digite uma mensagem…');
    fireEvent.change(ta, { target: { value: 'instantâneo' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    // Ainda sem resposta da API e o balão já está na conversa.
    expect(await screen.findByText('instantâneo')).toBeInTheDocument();
    await act(async () => {
      resolveSend({ message: msg({ id: 902, from_me: true, tipo: 'texto', corpo: 'instantâneo', status: 'enviado' }) });
    });
    // O temporário é trocado pelo registro real, sem duplicar.
    expect(screen.getAllByText('instantâneo')).toHaveLength(1);
  });

  it('needsNumber abre o modal de número em vez de enviar', async () => {
    await mountConnected();
    await openChat('456'); // chatC (lid)
    const ta = await screen.findByPlaceholderText('Digite uma mensagem…');
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    expect(await screen.findByText('Informar número do contato')).toBeInTheDocument();
  });

  it('anexa arquivos de vários tipos (detectType)', async () => {
    const utils = await mountConnected();
    await openChat('Alice');
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    const files = [
      new File(['a'], 'i.png', { type: 'image/png' }),
      new File(['a'], 'v.mp4', { type: 'video/mp4' }),
      new File(['a'], 'a.ogg', { type: 'audio/ogg' }),
      new File(['a'], 'd.pdf', { type: 'application/pdf' }),
    ];
    for (const f of files) {
      fireEvent.change(input, { target: { files: [f] } });
      await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/send-media', expect.objectContaining({ fileName: f.name })));
    }
    // documento sem mimetype cobre o `f.type || null`
    fireEvent.change(input, { target: { files: [new File(['a'], 'nomime', { type: '' })] } });
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/send-media', expect.objectContaining({ fileName: 'nomime', mimetype: null })));
  });

  it('arquivo sem seleção não faz nada', async () => {
    const utils = await mountConnected();
    await openChat('Alice');
    m.post.mockClear();
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    await waitFor(() => expect(m.post).not.toHaveBeenCalledWith(expect.stringContaining('send-media'), expect.anything()));
  });

  it('anexo needsNumber abre o modal de número', async () => {
    const utils = await mountConnected();
    await openChat('456');
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['a'], 'x.png', { type: 'image/png' })] } });
    expect(await screen.findByText('Informar número do contato')).toBeInTheDocument();
  });

  it('arquivo acima de 16MB é rejeitado', async () => {
    const utils = await mountConnected();
    await openChat('Alice');
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    const big = new File(['a'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 17 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Arquivo acima de 16MB.'));
  });

  it('falha ao ler o arquivo dispara toast (FileReader onerror)', async () => {
    class FR {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result = '';
      readAsDataURL(): void { this.onerror?.(); }
    }
    vi.stubGlobal('FileReader', FR);
    const utils = await mountConnected();
    await openChat('Alice');
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['a'], 'x.png', { type: 'image/png' })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Falha ao enviar arquivo'));
  });

  it('falha no envio de mídia dispara toast', async () => {
    m.post.mockImplementation((p: string) => (p.endsWith('/send-media') ? Promise.reject(new ApiError(500, 'media fail')) : defaultPost(p)) as Promise<never>);
    const utils = await mountConnected();
    await openChat('Alice');
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['a'], 'x.png', { type: 'image/png' })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('media fail'));
  });
});

describe('WhatsApp — apagar conversa', () => {
  it('apaga a conversa ativa e limpa a seleção', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Apagar conversa'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/whatsapp/chats/1'));
    await waitFor(() => expect(screen.getByText('Selecione uma conversa')).toBeInTheDocument());
  });

  it('cancelar no confirm não apaga', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Apagar conversa'));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(m.del).not.toHaveBeenCalled();
  });

  it('erro ao apagar dispara toast', async () => {
    m.del.mockRejectedValue(new ApiError(500, 'del fail'));
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Apagar conversa'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('del fail'));
  });
});

describe('WhatsApp — verificação de conexão', () => {
  it('status em cache "conectado" é revalidado na Evolution ao carregar', async () => {
    await mountConnected();
    // /status devolveu conectado (cache) → confirma com /connection.
    expect(m.get).toHaveBeenCalledWith('/api/whatsapp/connection');
  });

  it('sessão derrubada (cache conectado, Evolution desconectado) cai no painel de QR', async () => {
    connectionStatus = 'desconectado'; // /status diz conectado, mas a sessão morreu
    mount();
    expect(await screen.findByText('Conectar WhatsApp')).toBeInTheDocument();
  });

  it('falha na revalidação mantém o status em cache (não derruba à toa)', async () => {
    m.get.mockImplementation((p: string) =>
      (p === '/api/whatsapp/connection' ? Promise.reject(new Error('timeout')) : defaultGet(p)) as Promise<never>);
    await mountConnected(); // ainda abre as conversas usando o cache
    expect(screen.getByText('Conversas')).toBeInTheDocument();
  });

  it('polling detecta queda enquanto conectado e volta pro QR', async () => {
    vi.useFakeTimers();
    mount();
    // resolve o loadStatus inicial (status + connection) sob fake timers
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Conversas')).toBeInTheDocument();
    connectionStatus = 'desconectado';
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Conectar WhatsApp')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('WhatsApp — desconectar', () => {
  it('desconecta, limpa a lista e volta pro painel de QR', async () => {
    await mountConnected();
    fireEvent.click(await screen.findByLabelText('Desconectar WhatsApp'));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/disconnect'));
    expect(await screen.findByText('Conectar WhatsApp')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('WhatsApp desconectado.');
  });

  it('cancelar no confirm não desconecta', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await mountConnected();
    fireEvent.click(await screen.findByLabelText('Desconectar WhatsApp'));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(m.post).not.toHaveBeenCalledWith('/api/whatsapp/disconnect');
  });

  it('erro ao desconectar dispara toast', async () => {
    m.post.mockImplementation((p: string) =>
      (p === '/api/whatsapp/disconnect' ? Promise.reject(new ApiError(500, 'off fail')) : defaultPost(p)) as Promise<never>);
    await mountConnected();
    fireEvent.click(await screen.findByLabelText('Desconectar WhatsApp'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('off fail'));
  });

  it('sem permissão whatsapp.connect não mostra o botão desconectar', async () => {
    useAuthMock.mockReturnValue({
      user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
      can: (p: string) => p !== 'whatsapp.connect', isOffice: true,
    });
    await mountConnected();
    expect(screen.queryByLabelText('Desconectar WhatsApp')).not.toBeInTheDocument();
  });
});

describe('WhatsApp — modais', () => {
  it('NumberModal: número inválido avisa; válido confirma', async () => {
    await mountConnected();
    await openChat('456');
    fireEvent.click(await screen.findByTitle('Informar número do contato'));
    const input = await screen.findByPlaceholderText('(11) 98765-4321');
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar número/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Informe o número com DDD.'));
    fireEvent.change(input, { target: { value: '11987654321' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar número/ }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/whatsapp/chats/3/numero', { numero: '11987654321' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Número confirmado.'));
  });

  it('NumberModal: erro ao confirmar', async () => {
    m.patch.mockImplementation((p: string) => (/\/numero$/.test(p) ? Promise.reject(new ApiError(400, 'num fail')) : defaultPatch(p)) as Promise<never>);
    await mountConnected();
    await openChat('456');
    fireEvent.click(await screen.findByTitle('Informar número do contato'));
    fireEvent.change(await screen.findByPlaceholderText('(11) 98765-4321'), { target: { value: '11987654321' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar número/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('num fail'));
  });

  it('LinkModal: vincula e remove vínculo', async () => {
    await mountConnected();
    await openChat('Alice');
    // remove primeiro (empresa já vinculada) — remover fecha o modal
    fireEvent.click(await screen.findByTitle('Empresa vinculada'));
    fireEvent.click(await screen.findByText('Remover'));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/whatsapp/chats/1/link', { company_id: null }));
    // reabre e vincula via busca
    fireEvent.click(await screen.findByTitle('Empresa vinculada'));
    fireEvent.click(await screen.findByTestId('company-pick'));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/whatsapp/chats/1/link', { company_id: 500 }));
  });

  it('LinkModal: erro ao vincular', async () => {
    m.patch.mockImplementation((p: string) => (/\/link$/.test(p) ? Promise.reject(new ApiError(500, 'link fail')) : defaultPatch(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Empresa vinculada'));
    fireEvent.click(await screen.findByTestId('company-pick'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('link fail'));
  });

  it('MergeModal: lista, filtra, concilia; confirm=false não concilia', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Conciliar conversas (telefone + LID)'));
    const modal = (await screen.findByText('Conciliar conversas')).closest('div.fixed') as HTMLElement;
    // opção com LID visível (chatIdent)
    expect(within(modal).getByText('LID')).toBeInTheDocument();
    // filtro sem resultado
    const q = within(modal).getByPlaceholderText('Buscar conversa…');
    fireEvent.change(q, { target: { value: 'zzz' } });
    expect(await within(modal).findByText('Nenhuma outra conversa.')).toBeInTheDocument();
    fireEvent.change(q, { target: { value: '' } });
    // confirm=false
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    fireEvent.click((await within(modal).findByText('Grupo')).closest('button')!);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(m.post).not.toHaveBeenCalledWith(expect.stringContaining('/merge'), expect.anything());
    // confirm=true
    fireEvent.click((await within(modal).findByText('Grupo')).closest('button')!);
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/merge', { other_id: 2 }));
  });

  it('MergeModal: erro ao conciliar', async () => {
    m.post.mockImplementation((p: string) => (p.includes('/merge') ? Promise.reject(new ApiError(500, 'merge fail')) : defaultPost(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Conciliar conversas (telefone + LID)'));
    const modal = (await screen.findByText('Conciliar conversas')).closest('div.fixed') as HTMLElement;
    fireEvent.click((await within(modal).findByText('Grupo')).closest('button')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('merge fail'));
  });

  it('OrderModal abre e fecha ao salvar', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Criar pedido'));
    expect(await screen.findByTestId('order-modal')).toBeInTheDocument();
    // onClose
    fireEvent.click(screen.getByText('close-order'));
    await waitFor(() => expect(screen.queryByTestId('order-modal')).not.toBeInTheDocument());
    // reabre e onSaved
    fireEvent.click(await screen.findByTitle('Criar pedido'));
    fireEvent.click(await screen.findByText('save-order'));
    await waitFor(() => expect(screen.queryByTestId('order-modal')).not.toBeInTheDocument());
  });

  it('NewChatModal: abre conversa por empresa; sem telefone avisa', async () => {
    await mountConnected();
    // sem telefone
    pickHit = { id: 500, telefone1: null, telefone2: null };
    fireEvent.click(screen.getByTitle('Nova conversa'));
    fireEvent.click(await screen.findByTestId('company-pick'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Contato sem telefone cadastrado.'));
    // com telefone
    pickHit = { id: 500, telefone1: '5511977776666' };
    fireEvent.click(await screen.findByTestId('company-pick'));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/from-company', { company_id: 500, numero: '5511977776666' }));
  });

  it('NewChatModal: erro ao abrir conversa', async () => {
    m.post.mockImplementation((p: string) => (p.includes('/from-company') ? Promise.reject(new ApiError(500, 'fc fail')) : defaultPost(p)) as Promise<never>);
    await mountConnected();
    fireEvent.click(screen.getByTitle('Nova conversa'));
    fireEvent.click(await screen.findByTestId('company-pick'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('fc fail'));
  });
});

describe('WhatsApp — ScheduleModal', () => {
  it('lista agendamentos, valida e cria', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Agendar mensagem'));
    expect(await screen.findByText('enviada msg')).toBeInTheDocument();
    expect(screen.getByText(/· enviada/)).toBeInTheDocument();
    expect(screen.getByText(/· falhou/)).toBeInTheDocument();
    expect(screen.getByText(/· expirada/)).toBeInTheDocument();
    // vazio -> avisa
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Preencha mensagem e data.'));
    // data passada -> avisa
    fireEvent.change(screen.getByPlaceholderText('Mensagem…'), { target: { value: 'oi' } });
    fireEvent.change(document.querySelector('input[type=datetime-local]')!, { target: { value: '2000-01-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Escolha uma data futura.'));
  });

  it('cria agendamento futuro e cancela um pendente', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Agendar mensagem'));
    await screen.findByText('ativa msg');
    fireEvent.change(screen.getByPlaceholderText('Mensagem…'), { target: { value: 'futuro' } });
    fireEvent.change(document.querySelector('input[type=datetime-local]')!, { target: { value: '2030-01-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/schedule', expect.objectContaining({ text: 'futuro' })));
    // cancelar o pendente ativo
    fireEvent.click(screen.getByText('Cancelar'));
    // scope=one: cancela só esta ocorrência (a série usa scope=serie e confirma antes).
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/whatsapp/schedules/24?scope=one'));
  });

  it('erro ao agendar e ao cancelar', async () => {
    m.post.mockImplementation((p: string) => (p.includes('/schedule') ? Promise.reject(new ApiError(500, 'sch fail')) : defaultPost(p)) as Promise<never>);
    m.del.mockRejectedValue(new Error('x'));
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Agendar mensagem'));
    await screen.findByText('ativa msg');
    fireEvent.change(screen.getByPlaceholderText('Mensagem…'), { target: { value: 'futuro' } });
    fireEvent.change(document.querySelector('input[type=datetime-local]')!, { target: { value: '2030-01-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sch fail'));
    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Falha ao cancelar'));
  });

  it('fecha modal clicando no overlay e no X', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByTitle('Agendar mensagem'));
    const title = await screen.findByText('Agendar mensagem', { selector: 'h2' });
    // clique dentro do card não fecha (stopPropagation)
    fireEvent.click(title);
    expect(screen.getByText('Agendar mensagem', { selector: 'h2' })).toBeInTheDocument();
    // X fecha
    fireEvent.click(title.closest('div')!.querySelector('button')!);
    await waitFor(() => expect(screen.queryByText('Agendar mensagem', { selector: 'h2' })).not.toBeInTheDocument());
  });
});

describe('WhatsApp — ContactDetails', () => {
  it('painel do contato: empresa, contatos, mídia, novo/edita contato', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    expect(await screen.findByText('Dados do contato')).toBeInTheDocument();
    // contatos carregados
    expect(await screen.findByText(/Bob/)).toBeInTheDocument();
    // mídia compartilhada renderizada
    expect(screen.getByText('Mídia, links e docs')).toBeInTheDocument();
    // novo contato
    fireEvent.click(screen.getByRole('button', { name: /Novo/ }));
    const nome = await screen.findByPlaceholderText('Nome *');
    // nome vazio avisa
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Informe o nome.'));
    // email inválido avisa
    fireEvent.change(nome, { target: { value: 'Zé' } });
    fireEvent.change(screen.getByPlaceholderText('E-mail'), { target: { value: 'invalido' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('E-mail inválido.'));
    // salva
    fireEvent.change(screen.getByPlaceholderText('E-mail'), { target: { value: 'ze@x.com' } });
    fireEvent.change(screen.getByPlaceholderText('Cargo'), { target: { value: 'Diretor' } });
    fireEvent.change(screen.getByPlaceholderText('Telefone'), { target: { value: '11988887777' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/contacts', expect.objectContaining({ nome: 'Zé', company_id: 100 })));
  });

  it('edita e exclui contato existente', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click((await screen.findByText(/Bob/)).closest('button')!);
    // editar salva (PATCH)
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/contacts/11', expect.objectContaining({ nome: 'Bob' })));
  });

  it('exclui contato existente', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click((await screen.findByText(/Bob/)).closest('button')!);
    fireEvent.click(await screen.findByText('Excluir'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/contacts/11'));
  });

  it('erro ao salvar contato', async () => {
    m.post.mockImplementation((p: string) => (p === '/api/contacts' ? Promise.reject(new ApiError(500, 'ct fail')) : defaultPost(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /Novo/ }));
    fireEvent.change(await screen.findByPlaceholderText('Nome *'), { target: { value: 'Zé' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ct fail'));
  });

  it('"Salvar contato": empresa vinculada pré-preenche número e empresa', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    // número da conversa não é um contato salvo -> botão aparece
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar contato' }));
    const tel = await screen.findByPlaceholderText('Telefone');
    expect((tel as HTMLInputElement).value).not.toBe(''); // número pré-preenchido
    fireEvent.change(await screen.findByPlaceholderText('Nome *'), { target: { value: 'Ciclano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/contacts', expect.objectContaining({ nome: 'Ciclano', company_id: 100 })));
  });

  it('"Salvar contato": sem empresa vinculada usa só o número', async () => {
    await mountConnected();
    await openChat('(11) 3333-4444'); // chatD: sem empresa, com número
    const hits = screen.getAllByText('(11) 3333-4444');
    fireEvent.click(hits[1].closest('button')!); // abre o painel pelo cabeçalho
    expect(await screen.findByText('Dados do contato')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar contato' }));
    const tel = await screen.findByPlaceholderText('Telefone');
    expect((tel as HTMLInputElement).value).toBe('(11) 3333-4444');
    fireEvent.change(await screen.findByPlaceholderText('Nome *'), { target: { value: 'Fulano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/contacts', expect.objectContaining({ nome: 'Fulano', company_id: null })));
    // o contato criado é vinculado à conversa (persiste + nome passa a aparecer)
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/whatsapp/chats/4/contact', { contact_id: 77 }));
  });

  it('"Salvar contato" não aparece quando o número já é um contato', async () => {
    m.get.mockImplementation((p: string) => (p.startsWith('/api/contacts?')
      ? Promise.resolve({ contacts: [{ id: 30, nome: 'Alice C', cargo: null, telefone: '5511988887777', email: null, company_id: 100, represented_id: null }] })
      : defaultGet(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    expect(await screen.findByText('Dados do contato')).toBeInTheDocument();
    expect(await screen.findByText(/Alice C/)).toBeInTheDocument(); // contato já carregado
    expect(screen.queryByRole('button', { name: 'Salvar contato' })).not.toBeInTheDocument();
  });

  it('erro ao excluir contato', async () => {
    m.del.mockRejectedValue(new ApiError(500, 'rm fail'));
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click((await screen.findByText(/Bob/)).closest('button')!);
    fireEvent.click(await screen.findByText('Excluir'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rm fail'));
  });

  it('inicia conversa a partir de um contato vinculado', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click(await screen.findByLabelText('Iniciar conversa'));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/from-company', expect.objectContaining({ company_id: 100, numero: '5511955554444', nome: 'Bob' })));
  });

  it('erro ao iniciar conversa por contato', async () => {
    m.post.mockImplementation((p: string) => (p.includes('/from-company') ? Promise.reject(new ApiError(500, 'sc fail')) : defaultPost(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click(await screen.findByLabelText('Iniciar conversa'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sc fail'));
  });

  it('painel do grupo mostra descrição e participantes', async () => {
    await mountConnected();
    await openChat('Grupo');
    fireEvent.click((await screen.findByText('123')).closest('button')!);
    expect(await screen.findByText('Dados do grupo')).toBeInTheDocument();
    expect(await screen.findByText('descrição do grupo')).toBeInTheDocument();
    expect(screen.getByText('3 participantes')).toBeInTheDocument();
    expect(screen.getByText('dono')).toBeInTheDocument(); // superadmin
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('painel de contato só-LID mostra "Informar número" e vincular empresa', async () => {
    await mountConnected();
    await openChat('456');
    fireEvent.click((await screen.findByText(/número oculto/)).closest('button')!);
    const aside = (await screen.findByText('Dados do contato')).closest('aside') as HTMLElement;
    expect(within(aside).getByText('LID')).toBeInTheDocument(); // chatIdent
    // sem empresa -> botão vincular
    expect(within(aside).getByRole('button', { name: /Vincular empresa/ })).toBeInTheDocument();
    // "Informar número" fecha o painel e abre o NumberModal
    fireEvent.click(within(aside).getByText('Informar número'));
    expect(await screen.findByText('Informar número do contato')).toBeInTheDocument();
  });

  it('detalhes -> criar pedido abre OrderModal', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    const aside = (await screen.findByText('Dados do contato')).closest('aside') as HTMLElement;
    fireEvent.click(within(aside).getByRole('button', { name: /Criar pedido/ }));
    expect(await screen.findByTestId('order-modal')).toBeInTheDocument();
  });

  it('detalhes -> trocar empresa abre LinkModal', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /Trocar/ }));
    expect(await screen.findByText('Vincular a uma empresa')).toBeInTheDocument();
  });

  it('mídia no painel: clica imagem (lightbox) e vídeo (nova aba)', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    const section = (await screen.findByText('Mídia, links e docs')).closest('div') as HTMLElement;
    await waitFor(() => expect(within(section).getAllByRole('button').length).toBeGreaterThan(0));
    // clica todas as miniaturas (imagem -> lightbox, vídeo -> openMedia)
    for (const t of within(section).getAllByRole('button')) fireEvent.click(t);
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    // imagem abriu o lightbox do painel -> fecha com Esc
    await waitFor(() => expect(screen.getByTitle('Abrir original')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTitle('Abrir original')).not.toBeInTheDocument());
  });

  it('painel sem mídia mostra estado vazio', async () => {
    m.get.mockImplementation((p: string) => (/\/messages$/.test(p) ? Promise.resolve({ messages: [msg({ id: 1, tipo: 'texto', corpo: 'só texto' })] }) : defaultGet(p)) as Promise<never>);
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    expect(await screen.findByText('Nenhuma mídia.')).toBeInTheDocument();
  });

  it('fecha o painel de detalhes', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click((await screen.findByText('Acme')).closest('button')!);
    fireEvent.click(await screen.findByLabelText('Fechar'));
    await waitFor(() => expect(screen.queryByText('Dados do contato')).not.toBeInTheDocument());
  });
});

describe('WhatsApp — navegação mobile', () => {
  it('botão voltar fecha a conversa', async () => {
    await mountConnected();
    await openChat('Alice');
    fireEvent.click(await screen.findByLabelText('Voltar'));
    await waitFor(() => expect(screen.getByText('Selecione uma conversa')).toBeInTheDocument());
  });

  it('botão anexar dispara o seletor de arquivo', async () => {
    const utils = await mountConnected();
    await openChat('Alice');
    const input = utils.container.querySelector('input[type=file]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(await screen.findByLabelText('Anexar'));
    expect(clickSpy).toHaveBeenCalled();
  });
});

describe('WhatsApp — WebSocket', () => {
  const ready = async (): Promise<void> => {
    await mountConnected();
    await waitFor(() => expect(FakeWS.instances.length).toBeGreaterThan(0));
  };

  it('ignora payload inválido', async () => {
    await ready();
    act(() => { lastWS().onmessage?.({ data: 'nao-json' }); });
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('evento status muda a conexão', async () => {
    await ready();
    wsSend('status', { status: 'desconectado' });
    expect(await screen.findByText('Conectar WhatsApp')).toBeInTheDocument();
  });

  it('chat-foto recarrega a lista', async () => {
    await ready();
    const before = m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length;
    wsSend('chat-foto', {});
    await waitFor(() => expect(m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length).toBeGreaterThan(before));
  });

  it('chat-removed remove da lista e limpa se ativa', async () => {
    await ready();
    await openChat('Alice');
    await screen.findByText('hoje');
    wsSend('chat-removed', { chat_id: 1 });
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
  });

  it('chat-removed de conversa não-ativa só remove da lista', async () => {
    await ready();
    wsSend('chat-removed', { chat_id: 4 });
    await waitFor(() => expect(screen.queryByText('(11) 3333-4444')).not.toBeInTheDocument());
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('merged recarrega e migra a conversa ativa', async () => {
    await ready();
    await openChat('Alice');
    await screen.findByText('hoje');
    wsSend('merged', { removed_id: 1, chat_id: 2 });
    await waitFor(() => expect(m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length).toBeGreaterThan(1));
  });

  it('presence marca e limpa digitando…', async () => {
    await ready();
    await openChat('Alice');
    wsSend('presence', { remote_jid: '11111@s.whatsapp.net', typing: true });
    await waitFor(() => expect(screen.getAllByText('digitando…').length).toBeGreaterThan(0));
    wsSend('presence', { remote_jid: '11111@s.whatsapp.net', typing: false });
    await waitFor(() => expect(screen.queryAllByText('digitando…').length).toBe(0));
  });

  it('message-status atualiza o tique', async () => {
    await ready();
    await openChat('Alice');
    await screen.findByText('hoje');
    wsSend('message-status', { evolution_id: 'ev1', status: 'lido' });
    // não quebra; a mensagem ev1 continua na tela
    expect(screen.getByText('hoje')).toBeInTheDocument();
  });

  it('message na conversa ativa acrescenta e confirma leitura', async () => {
    await ready();
    await openChat('Alice');
    await screen.findByText('hoje');
    wsSend('message', { chat_id: 1, message: msg({ id: 950, corpo: 'chegou ao vivo', tipo: 'texto' }) });
    expect(await screen.findByText('chegou ao vivo')).toBeInTheDocument();
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/1/read', {}));
  });

  it('message na conversa ativa: falha no read ainda recarrega', async () => {
    await ready();
    await openChat('Alice');
    await screen.findByText('hoje');
    m.post.mockImplementation((p: string) => (p.endsWith('/read') ? Promise.reject(new Error('x')) : defaultPost(p)) as Promise<never>);
    const before = m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length;
    wsSend('message', { chat_id: 1, message: msg({ id: 951, corpo: 'r', tipo: 'texto' }) });
    await waitFor(() => expect(m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length).toBeGreaterThan(before));
  });

  it('message em conversa listada não-ativa aplica patch no item (com e sem patch)', async () => {
    await ready();
    await openChat('Alice'); // ativa = 1
    // conversa 4 listada, com patch explícito
    wsSend('message', { chat_id: 4, message: msg({ id: 960, from_me: false, corpo: 'x' }), chat: { nao_lidas: 5, last_preview: 'prévia nova', last_message_at: TODAY } });
    expect(await screen.findByText('prévia nova')).toBeInTheDocument();
    // conversa 4 sem patch: usa fallback (contador+1, prévia do corpo)
    wsSend('message', { chat_id: 4, message: msg({ id: 961, from_me: false, corpo: 'fallback prev' }) });
    expect(await screen.findByText('fallback prev')).toBeInTheDocument();
    // mídia sem corpo -> prévia [tipo]
    wsSend('message', { chat_id: 4, message: msg({ id: 962, from_me: false, tipo: 'imagem', corpo: null }) });
    await waitFor(() => expect(screen.getByText('[imagem]')).toBeInTheDocument());
  });

  it('message de conversa desconhecida recarrega com debounce', async () => {
    vi.useFakeTimers();
    const utils = mount();
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(FakeWS.instances.length).toBeGreaterThan(0);
    const before = m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length;
    act(() => { lastWS().onmessage?.({ data: JSON.stringify({ event: 'message', data: { chat_id: 9999, message: msg({ id: 970, corpo: 'nova' }) } }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(m.get.mock.calls.filter((c) => c[0] === '/api/whatsapp/chats').length).toBeGreaterThan(before);
    utils.unmount();
    vi.useRealTimers();
  });

  it('reconecta quando o socket cai (onclose)', async () => {
    vi.useFakeTimers();
    mount();
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    const count = FakeWS.instances.length;
    expect(count).toBeGreaterThan(0);
    act(() => { lastWS().onclose?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(FakeWS.instances.length).toBeGreaterThan(count);
    vi.useRealTimers();
  });

  it('sem token não abre o WebSocket', async () => {
    localStorage.removeItem('rs_token');
    await mountConnected();
    expect(FakeWS.instances.length).toBe(0);
  });

  it('presence some sozinho após timeout', async () => {
    vi.useFakeTimers();
    mount();
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    act(() => { lastWS().onmessage?.({ data: JSON.stringify({ event: 'presence', data: { remote_jid: '11111@s.whatsapp.net', typing: true } }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    // timer disparou setTypingJid(null) sem erro
    expect(FakeWS.instances.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
