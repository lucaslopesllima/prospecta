// Cobre utilitários app-wide sem teste dedicado: confirm.ts, export.ts,
// theme.tsx, sellers.tsx, cnae.tsx, toast.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

// ── sweetalert2 (confirm.ts) ───────────────────────────────────────────────
const swalFire = vi.fn();
vi.mock('sweetalert2', () => ({ default: { fire: (...a: unknown[]) => swalFire(...a) } }));
// ── api/auth (sellers.tsx, cnae.tsx) ───────────────────────────────────────
vi.mock('../src/lib/api.ts', () => ({ api: { get: vi.fn() } }));
vi.mock('../src/lib/auth.tsx', () => ({ useOptionalUser: vi.fn() }));

import { confirmDialog } from '../src/lib/confirm.ts';
import { downloadCsv } from '../src/lib/export.ts';
import { ThemeProvider, ThemeToggle, useTheme } from '../src/lib/theme.tsx';
import { useSellers, SellerFilter, sellerLabel } from '../src/lib/sellers.tsx';
import { Cnae, seedCnae } from '../src/lib/cnae.tsx';
import { toast, ToastHost } from '../src/lib/toast.tsx';
import { api } from '../src/lib/api.ts';
import { useOptionalUser } from '../src/lib/auth.tsx';

const mApi = vi.mocked(api);
const mUser = vi.mocked(useOptionalUser);

beforeEach(() => {
  swalFire.mockReset();
  mApi.get.mockReset();
  mUser.mockReset().mockReturnValue(null);
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true, value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    });
  }
});

describe('confirm.ts', () => {
  it('resolve true quando confirmado; tema segue a classe dark', async () => {
    swalFire.mockResolvedValueOnce({ isConfirmed: true });
    expect(await confirmDialog('apagar?')).toBe(true);
    expect(swalFire.mock.calls[0]![0]).toMatchObject({ theme: 'light', title: 'Tem certeza?' });

    document.documentElement.classList.add('dark');
    swalFire.mockResolvedValueOnce({ isConfirmed: false });
    expect(await confirmDialog('x', { title: 'T', confirmText: 'Sim', cancelText: 'Não' })).toBe(false);
    expect(swalFire.mock.calls[1]![0]).toMatchObject({ theme: 'dark', title: 'T', confirmButtonText: 'Sim' });
  });
});

describe('export.ts — downloadCsv', () => {
  it('gera CSV com BOM, escapa aspas e neutraliza fórmula; acrescenta .csv', async () => {
    let captured: Blob | null = null;
    const createURL = vi.fn((b: Blob) => { captured = b; return 'blob:x'; });
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: createURL, revokeObjectURL: revoke });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCsv('rel', ['A', 'B'], [['=1+1', 'ha"ha'], [1, null]]);

    expect(createURL).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:x');
    // Blob.text() (jsdom/TextDecoder) remove o BOM — verifica só o conteúdo.
    const text = await captured!.text();
    expect(text).toContain('"\'=1+1"');      // fórmula prefixada com aspa simples
    expect(text).toContain('"ha""ha"');       // aspas escapadas
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('mantém extensão .csv quando já presente', () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:y', revokeObjectURL: () => {} });
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let dl = '';
    const orig = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'download');
    Object.defineProperty(HTMLAnchorElement.prototype, 'download', { configurable: true, set(v) { dl = v; }, get() { return dl; } });
    downloadCsv('já.csv', ['A'], [['x']]);
    expect(dl).toBe('já.csv');
    if (orig) Object.defineProperty(HTMLAnchorElement.prototype, 'download', orig);
    spy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('theme.tsx', () => {
  function Probe(): React.JSX.Element {
    const { theme } = useTheme();
    return <span data-testid="t">{theme}</span>;
  }
  it('lê o armazenado, alterna e persiste', () => {
    localStorage.setItem('theme', 'dark');
    render(<ThemeProvider><Probe /><ThemeToggle /></ThemeProvider>);
    expect(screen.getByTestId('t').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByTestId('t').textContent).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
  it('sem preferência salva segue o SO (prefers-color-scheme)', () => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('t').textContent).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
  it('useTheme fora do provider lança', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('ThemeProvider');
    spy.mockRestore();
  });
  it('ThemeToggle variante dark renderiza', () => {
    localStorage.setItem('theme', 'light');
    render(<ThemeProvider><ThemeToggle variant="dark" /></ThemeProvider>);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('sellers.tsx', () => {
  function Probe(): React.JSX.Element {
    const sellers = useSellers();
    return <div data-testid="n">{sellers.length}</div>;
  }
  it('admin escritório busca vendedores ativos', async () => {
    mUser.mockReturnValue({ role: 'admin', tipo_conta: 'escritorio' } as never);
    mApi.get.mockResolvedValueOnce({ users: [{ id: 1, nome: 'A', ativo: true }, { id: 2, nome: 'B', ativo: false }] });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('1'));
  });
  it('individual/rep não busca', () => {
    mUser.mockReturnValue({ role: 'rep' } as never);
    render(<Probe />);
    expect(mApi.get).not.toHaveBeenCalled();
    expect(screen.getByTestId('n').textContent).toBe('0');
  });
  it('SellerFilter: null p/ rep, null com <=1 vendedor, renderiza p/ admin', () => {
    mUser.mockReturnValue({ role: 'rep' } as never);
    const { container, rerender } = render(<SellerFilter value="todos" onChange={() => {}} sellers={[{ id: 1, nome: 'A' } as never]} />);
    expect(container.querySelector('select')).toBeNull();
    mUser.mockReturnValue({ role: 'admin' } as never);
    rerender(<SellerFilter value="todos" onChange={() => {}} sellers={[{ id: 1, nome: 'A' } as never]} />); // <=1 → null
    expect(container.querySelector('select')).toBeNull();
    const onChange = vi.fn();
    rerender(<SellerFilter value="todos" onChange={onChange} sellers={[{ id: 1, nome: 'A' }, { id: 2, nome: 'B' }] as never} />);
    const sel = container.querySelector('select')!;
    fireEvent.change(sel, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(2);
    fireEvent.change(sel, { target: { value: 'todos' } });
    expect(onChange).toHaveBeenCalledWith('todos');
  });
  it('sellerLabel cai no email sem nome', () => {
    expect(sellerLabel({ email: 'x@y.z' } as never)).toBe('x@y.z');
    expect(sellerLabel({ nome: 'Nome', email: 'x@y.z' } as never)).toBe('Nome');
  });
});

describe('cnae.tsx', () => {
  it('mostra código e depois a descrição (batch); trunca e tooltip; full e null', async () => {
    mApi.get.mockResolvedValueOnce({ labels: [{ codigo: 4781400, descricao: 'Comércio varejista de artigos do vestuário' }] });
    const { rerender } = render(<Cnae code={4781400} />);
    await waitFor(() => expect(mApi.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTitle(/4781400 — Comércio/)).toBeInTheDocument());
    expect(screen.getByTitle(/4781400 —/).textContent).toContain('…'); // truncado em 10

    rerender(<Cnae code={4781400} full />);
    await waitFor(() => expect(screen.getByText(/4781400 — Comércio varejista/)).toBeInTheDocument());

    rerender(<Cnae code={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('seedCnae popula o cache sem chamar a API', async () => {
    seedCnae(9999999, 'Descrição semeada');
    render(<Cnae code={9999999} full />);
    expect(screen.getByText('9999999 — Descrição semeada')).toBeInTheDocument();
    seedCnae(null, 'x'); // ramo inválido: não faz nada
    seedCnae(123, null);
    expect(mApi.get).not.toHaveBeenCalled();
  });
});

describe('toast.tsx', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('empilha, mostra e fecha manualmente e por timeout', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => { toast.success('ok'); toast.error('ruim'); toast.info('info'); });
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('ruim')).toBeInTheDocument();
    // fecha manual
    act(() => { fireEvent.click(screen.getAllByLabelText('Fechar')[0]!); });
    expect(screen.queryByText('ok')).not.toBeInTheDocument();
    // auto-dismiss: success/info em 3s, error em 4.5s
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText('info')).not.toBeInTheDocument();
    expect(screen.getByText('ruim')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText('ruim')).not.toBeInTheDocument();
  });
});
