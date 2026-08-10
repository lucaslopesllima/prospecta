// Carteiras (admin): agrupa clientes por vendedor, troca vendedor, move clientes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Carteiras } from '../src/pages/Carteiras.tsx';
import { api, ApiError } from '../src/lib/api.ts';
import { useAuth } from '../src/lib/auth.tsx';
import type { Cliente } from '../src/lib/types.ts';

vi.mock('../src/lib/auth.tsx', () => ({ useAuth: vi.fn() }));
vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn(async () => true) }));
import { toast } from '../src/lib/toast.tsx';

const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);
const toastMock = vi.mocked(toast);

const cli = (over: Partial<Cliente> & { id: number; company_id: number }): Cliente => ({
  status: 'cliente', ativo: true, valor_estimado: null, notas: null,
  owner_user_id: null, represented_id: null, representada: null, updated_at: '',
  contatos: [], razao_social: 'RS', nome_fantasia: null, cnpj: '11222333000181',
  cnae_principal: 0, municipio_id: null, uf: 'SP', ...over,
});

const USERS = [
  { id: 2, nome: 'Ana', email: 'ana@x', role: 'rep', ativo: true },
  { id: 3, nome: null, email: 'bruno@x', role: 'rep', ativo: false },
  { id: 4, nome: 'Carla', email: 'carla@x', role: 'rep', ativo: true },
];
const CLIENTES = [
  cli({ id: 10, company_id: 100, owner_user_id: 2, razao_social: 'RS1', nome_fantasia: 'NF1', valor_estimado: '1000', representada: 'Rep A', uf: 'SP' }),
  cli({ id: 11, company_id: 101, owner_user_id: 3, razao_social: 'RS2', uf: '' }),
  cli({ id: 12, company_id: 102, owner_user_id: null, razao_social: 'RS3', nome_fantasia: 'NF3', valor_estimado: '500', uf: 'RJ' }),
  cli({ id: 13, company_id: 103, owner_user_id: 999, razao_social: 'RS4', cnpj: '99888777000166' }),
];
const ORDERS = [
  { id: 1, status: 'faturado', owner_user_id: 2, total: '2000', company_id: 100 },
  { id: 2, status: 'entregue', owner_user_id: null, total: '300', company_id: 102 },
  { id: 3, status: 'cotacao', owner_user_id: 2, total: '999', company_id: 100 },
];

function mockData(over?: { users?: unknown; clientes?: unknown; orders?: unknown }): void {
  m.get.mockImplementation(async (p: string) => {
    if (p === '/api/users') return over?.users ?? { users: USERS };
    if (p.startsWith('/api/relationships')) return over?.clientes ?? { relationships: CLIENTES };
    if (p === '/api/orders') return over?.orders ?? { orders: ORDERS };
    return {};
  });
}

function setCan(can: (c: string) => boolean): void {
  useAuthMock.mockReturnValue({
    user: { id: 1, email: 'a@x', role: 'admin', org_id: 1 },
    loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can, isOffice: true,
  });
}

beforeEach(() => {
  vi.mocked(m.get).mockReset();
  vi.mocked(m.post).mockReset();
  vi.mocked(m.patch).mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  setCan(() => true);
  mockData();
});

describe('Carteiras', () => {
  it('renderiza carteiras, KPIs e o bucket Sem vendedor', async () => {
    render(<Carteiras />);
    expect(await screen.findByRole('button', { name: /Ana/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Carla/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /bruno@x/ })).toBeInTheDocument(); // nome null → email
    expect(screen.getByRole('button', { name: /\(inativo\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sem vendedor/ })).toBeInTheDocument();
    expect(screen.getAllByText('Carteiras').length).toBeGreaterThan(0); // título + KPI
    expect(screen.getByText('Clientes alocados')).toBeInTheDocument();
  });

  it('estado vazio quando não há vendedores nem clientes', async () => {
    mockData({ users: { users: [] }, clientes: { relationships: [] }, orders: { orders: [] } });
    render(<Carteiras />);
    expect(await screen.findByText('Sem vendedores')).toBeInTheDocument();
  });

  it('seleciona carteira de vendedor e mostra clientes/badges', async () => {
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    // cliente C1 com badges (uf, faturado, estimado, representada)
    expect(await screen.findByText('NF1')).toBeInTheDocument();
    expect(screen.getByText('Rep A')).toBeInTheDocument();
    expect(screen.getAllByText(/faturado/).length).toBeGreaterThan(0);
  });

  it('troca de vendedor transfere clientes (POST) e recarrega', async () => {
    m.post.mockResolvedValueOnce({ transferred: 1 });
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    const sel = screen.getByRole('combobox', { name: /Trocar vendedor/ });
    await userEvent.selectOptions(sel, '4');
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/relationships/transfer',
      { from_user_id: 2, to_user_id: 4, ids: [10] }));
  });

  it('troca de vendedor em carteira vazia alerta', async () => {
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Carla/ });
    await userEvent.click(screen.getByRole('button', { name: /Carla/ }));
    const sel = screen.getByRole('combobox', { name: /Trocar vendedor/ });
    await userEvent.selectOptions(sel, '2');
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Carteira sem clientes para transferir.'));
    expect(m.post).not.toHaveBeenCalled();
  });

  it('erro ao trocar vendedor dispara toast', async () => {
    m.post.mockRejectedValueOnce(new ApiError(400, 'sem permissão'));
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Trocar vendedor/ }), '4');
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('sem permissão'));
  });

  it('adicionar clientes: lista candidatos, filtra e move (PATCH)', async () => {
    m.patch.mockResolvedValueOnce({});
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ }); // sel default = Sem vendedor
    await userEvent.click(screen.getByRole('button', { name: /Adicionar clientes/ }));
    // candidatos = clientes de outras carteiras (inclui owner desconhecido → #999)
    expect(await screen.findByText(/#999/)).toBeInTheDocument();
    // filtra por nome
    const busca = screen.getByPlaceholderText(/Buscar cliente/);
    await userEvent.type(busca, 'NF1');
    const add = screen.getAllByRole('button', { name: 'Adicionar' });
    await userEvent.click(add[0]!);
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/relationships/10', { owner_user_id: null }));
  });

  it('picker mostra "nenhum" quando o filtro não casa', async () => {
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    await userEvent.click(screen.getByRole('button', { name: /Adicionar clientes/ }));
    await userEvent.type(screen.getByPlaceholderText(/Buscar cliente/), 'zzzznaoexiste');
    expect(await screen.findByText('Nenhum cliente para adicionar.')).toBeInTheDocument();
  });

  it('mover cliente pelo select da linha (erro reverte)', async () => {
    m.patch.mockRejectedValueOnce(new ApiError(400, 'falhou mover'));
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    const rowSelect = screen.getByRole('combobox', { name: 'Vendedor da carteira' });
    await userEvent.selectOptions(rowSelect, '4');
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/relationships/10', { owner_user_id: 4 }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('falhou mover'));
  });

  it('mover cliente para "Sem vendedor" pelo select da linha', async () => {
    m.patch.mockResolvedValueOnce({});
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    const rowSelect = screen.getByRole('combobox', { name: 'Vendedor da carteira' });
    await userEvent.selectOptions(rowSelect, '');
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/relationships/10', { owner_user_id: null }));
  });

  it('sem permissão: sem ações e selects desabilitados', async () => {
    setCan(() => false);
    render(<Carteiras />);
    await screen.findByRole('button', { name: /Ana/ });
    // seleciona a carteira da Ana (tem cliente com select de linha)
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    expect(screen.queryByRole('button', { name: /Adicionar clientes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Trocar vendedor/ })).not.toBeInTheDocument();
    const rowSelect = screen.getByRole('combobox', { name: 'Vendedor da carteira' });
    expect(rowSelect).toBeDisabled();
    void within;
  });
});
