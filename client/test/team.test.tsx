// Equipe (admin): lista, criação com senha provisória, papel/ativo, reset de senha.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Team } from '../src/pages/Team.tsx';
import { api, ApiError } from '../src/lib/api.ts';
import { useAuth } from '../src/lib/auth.tsx';

vi.mock('../src/lib/auth.tsx', () => ({ useAuth: vi.fn() }));
vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn() }));
import { toast } from '../src/lib/toast.tsx';
import { confirmDialog } from '../src/lib/confirm.ts';
const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);
const toastMock = vi.mocked(toast);
const confirmMock = vi.mocked(confirmDialog);

function setCan(can: (code: string) => boolean): void {
  useAuthMock.mockReturnValue({
    user: { id: 1, email: ME.email, role: 'admin', org_id: 1 },
    loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can, isOffice: true,
  });
}

const ME = { id: 1, nome: 'Admin', email: 'adm@org.com', role: 'admin' as const, ativo: true, must_change_password: false };
const REP = { id: 2, nome: 'Vendedor', email: 'rep@org.com', role: 'rep' as const, ativo: true, must_change_password: true };

beforeEach(() => {
  vi.mocked(m.get).mockReset();
  vi.mocked(m.post).mockReset();
  vi.mocked(m.patch).mockReset();
  vi.mocked(m.del).mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  setCan(() => true);
  // a página também busca /api/groups (seletor de grupo RBAC; vazio = sem coluna)
  m.get.mockImplementation(async (p: string) =>
    p === '/api/groups' ? { groups: [] } : { users: [ME, REP] });
});

describe('Team', () => {
  it('lista usuários, marca (você) e badge de senha provisória', async () => {
    render(<Team />);
    expect(await screen.findByText('rep@org.com')).toBeInTheDocument();
    expect(screen.getByText('(você)')).toBeInTheDocument();
    expect(screen.getByText('Senha provisória')).toBeInTheDocument();
    // ações não aparecem na própria linha
    expect(screen.getAllByRole('button', { name: 'Desativar' })).toHaveLength(1);
  });

  it('cria usuário pelo formulário e recarrega', async () => {
    m.post.mockResolvedValueOnce({ user: {} });
    render(<Team />);
    await screen.findByText('rep@org.com');

    await userEvent.click(screen.getByRole('button', { name: /Novo usuário/ }));
    const form = document.querySelector('form')!;
    const inputs = form.querySelectorAll('input');
    await userEvent.type(inputs[0]!, 'Novo Vendedor');
    await userEvent.type(inputs[1]!, 'novo@org.com');
    await userEvent.type(inputs[2]!, 'provisoria1');
    await userEvent.click(screen.getByRole('button', { name: 'Criar usuário' }));

    expect(m.post).toHaveBeenCalledWith('/api/users',
      { nome: 'Novo Vendedor', email: 'novo@org.com', senha: 'provisoria1', role: 'rep', group_id: null });
    // recarregou a lista (2ª chamada a /api/users; /api/groups não conta)
    const userCalls = (): number => m.get.mock.calls.filter((c) => c[0] === '/api/users').length;
    await waitFor(() => expect(userCalls()).toBe(2));
  });

  it('erro da API ao criar aparece na tela', async () => {
    m.post.mockRejectedValueOnce(new ApiError(409, 'email já cadastrado'));
    render(<Team />);
    await screen.findByText('rep@org.com');
    await userEvent.click(screen.getByRole('button', { name: /Novo usuário/ }));
    const inputs = document.querySelector('form')!.querySelectorAll('input');
    await userEvent.type(inputs[0]!, 'X');
    await userEvent.type(inputs[1]!, 'rep@org.com');
    await userEvent.type(inputs[2]!, 'provisoria1');
    await userEvent.click(screen.getByRole('button', { name: 'Criar usuário' }));
    expect(await screen.findByText('email já cadastrado')).toBeInTheDocument();
  });

  it('desativar chama PATCH ativo=false; troca de papel chama PATCH role', async () => {
    m.patch.mockResolvedValue({});
    render(<Team />);
    await screen.findByText('rep@org.com');

    await userEvent.click(screen.getByRole('button', { name: 'Desativar' }));
    expect(m.patch).toHaveBeenCalledWith('/api/users/2', { ativo: false });

    const selects = screen.getAllByRole('combobox');
    // primeiro select é o do admin (desabilitado), segundo é o do rep
    expect(selects[0]).toBeDisabled();
    await userEvent.selectOptions(selects[1]!, 'admin');
    expect(m.patch).toHaveBeenCalledWith('/api/users/2', { role: 'admin' });
  });

  it('redefinir senha usa modal; cancelar não chama API', async () => {
    render(<Team />);
    await screen.findByText('rep@org.com');
    // abre o modal e cancela — nenhuma chamada
    await userEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(m.post).not.toHaveBeenCalled();

    // reabre, digita senha provisória válida e confirma
    await userEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    m.post.mockResolvedValueOnce({ ok: true });
    await userEvent.type(screen.getByPlaceholderText('Nova senha provisória'), 'novaprov1');
    await userEvent.click(screen.getByRole('button', { name: 'Redefinir' }));
    expect(m.post).toHaveBeenCalledWith('/api/users/2/password', { senha: 'novaprov1' });
  });

  it('erro ao carregar equipe mostra mensagem', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/groups') return { groups: [] };
      throw new ApiError(500, 'falha no servidor');
    });
    render(<Team />);
    expect(await screen.findByText('falha no servidor')).toBeInTheDocument();
  });

  it('erro genérico (não-ApiError) ao carregar usa fallback', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/groups') return { groups: [] };
      throw new Error('boom');
    });
    render(<Team />);
    expect(await screen.findByText('Erro ao carregar equipe')).toBeInTheDocument();
  });

  it('erro ao trocar papel (PATCH) aparece na tela', async () => {
    m.patch.mockRejectedValueOnce(new ApiError(400, 'não pode mudar papel'));
    render(<Team />);
    await screen.findByText('rep@org.com');
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[1]!, 'admin');
    expect(await screen.findByText('não pode mudar papel')).toBeInTheDocument();
  });

  it('redefinir senha com erro dispara toast.error', async () => {
    render(<Team />);
    await screen.findByText('rep@org.com');
    await userEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    m.post.mockRejectedValueOnce(new ApiError(400, 'senha fraca'));
    await userEvent.type(screen.getByPlaceholderText('Nova senha provisória'), 'novaprov1');
    await userEvent.click(screen.getByRole('button', { name: 'Redefinir' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('senha fraca'));
  });

  it('cancelar formulário fecha (botão Cancelar)', async () => {
    render(<Team />);
    await screen.findByText('rep@org.com');
    await userEvent.click(screen.getByRole('button', { name: /Novo usuário/ }));
    expect(screen.getByRole('button', { name: 'Criar usuário' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('button', { name: 'Criar usuário' })).not.toBeInTheDocument();
  });

  it('usuário inativo: badge Desativado e botão Reativar', async () => {
    const INATIVO = { id: 3, nome: 'Fulano', email: 'fulano@org.com', role: 'rep' as const, ativo: false, must_change_password: false };
    m.get.mockImplementation(async (p: string) => p === '/api/groups' ? { groups: [] } : { users: [ME, INATIVO] });
    m.patch.mockResolvedValue({});
    render(<Team />);
    await screen.findByText('fulano@org.com');
    expect(screen.getByText('Desativado')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reativar' }));
    expect(m.patch).toHaveBeenCalledWith('/api/users/3', { ativo: true });
  });

  it('coluna/seletor de grupo quando há grupos; troca grupo e cria com grupo', async () => {
    const groups = [{ id: 5, nome: 'Grupo A', is_admin: false, permissions: [], created_at: '' }];
    m.get.mockImplementation(async (p: string) => p === '/api/groups' ? { groups } : { users: [ME, REP] });
    m.patch.mockResolvedValue({});
    m.post.mockResolvedValue({ user: {} });
    render(<Team />);
    await screen.findByText('rep@org.com');
    // troca de grupo do REP na tabela: comboboxes = [ME.role, ME.group, REP.role, REP.group]
    const combos = screen.getAllByRole('combobox');
    await userEvent.selectOptions(combos[3]!, 'Grupo A');
    expect(m.patch).toHaveBeenCalledWith('/api/users/2', { group_id: 5 });
    // cria usuário selecionando grupo no formulário
    await userEvent.click(screen.getByRole('button', { name: /Novo usuário/ }));
    const form = document.querySelector('form')!;
    const inputs = form.querySelectorAll('input');
    await userEvent.type(inputs[0]!, 'Novo');
    await userEvent.type(inputs[1]!, 'novo@org.com');
    await userEvent.type(inputs[2]!, 'provisoria1');
    const formSelects = form.querySelectorAll('select');
    await userEvent.selectOptions(formSelects[0]!, 'admin'); // role
    await userEvent.selectOptions(formSelects[1]!, 'Grupo A'); // group
    await userEvent.click(screen.getByRole('button', { name: 'Criar usuário' }));
    expect(m.post).toHaveBeenCalledWith('/api/users',
      { nome: 'Novo', email: 'novo@org.com', senha: 'provisoria1', role: 'admin', group_id: 5 });
  });

  it('seletor de grupos some quando /api/groups falha (403)', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/groups') throw new ApiError(403, 'sem permissão');
      return { users: [ME, REP] };
    });
    render(<Team />);
    await screen.findByText('rep@org.com');
    // sem coluna "Grupo"
    expect(screen.queryByText('Grupo')).not.toBeInTheDocument();
  });

  it('editar nome inline salva (Enter) e não salva quando inalterado (Esc/blur)', async () => {
    m.patch.mockResolvedValue({});
    render(<Team />);
    await screen.findByText('rep@org.com');
    // edita e salva com Enter
    await userEvent.click(screen.getByRole('button', { name: /Vendedor/ }));
    const input = screen.getByLabelText('Editar nome de rep@org.com');
    await userEvent.clear(input);
    await userEvent.type(input, 'Vendedor Novo{Enter}');
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/users/2', { nome: 'Vendedor Novo' }));

    m.patch.mockClear();
    // reabre e cancela com Escape (sem alteração)
    await userEvent.click(screen.getByRole('button', { name: /Vendedor/ }));
    const input2 = screen.getByLabelText('Editar nome de rep@org.com');
    await userEvent.type(input2, 'X{Escape}');
    expect(m.patch).not.toHaveBeenCalled();

    // reabre e sai por blur sem mudar o nome → não chama patch
    await userEvent.click(screen.getByRole('button', { name: /Vendedor/ }));
    const input3 = screen.getByLabelText('Editar nome de rep@org.com');
    input3.focus();
    await userEvent.tab();
    expect(m.patch).not.toHaveBeenCalled();
  });

  it('permissões negadas: sem botões de ação, nomes só-leitura e selects desabilitados', async () => {
    setCan(() => false);
    render(<Team />);
    await screen.findByText('rep@org.com');
    expect(screen.queryByRole('button', { name: /Novo usuário/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desativar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redefinir senha' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transferir carteira' })).not.toBeInTheDocument();
    // nome vira texto (sem botão de edição) e mostra (você) na própria linha
    expect(screen.queryByRole('button', { name: /Vendedor/ })).not.toBeInTheDocument();
    expect(screen.getByText('(você)')).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    selects.forEach((s) => expect(s).toBeDisabled());
  });

  it('transferir carteira: abre modal, transfere e conclui; fecha por X e overlay', async () => {
    m.post.mockResolvedValueOnce({ transferred: 4 });
    render(<Team />);
    await screen.findByText('rep@org.com');
    await userEvent.click(screen.getByRole('button', { name: 'Transferir carteira' }));
    // seleciona destino (último combobox = o do modal) e transfere
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects.at(-1)!, String(ME.id));
    await userEvent.click(screen.getByRole('button', { name: 'Transferir' }));
    expect(m.post).toHaveBeenCalledWith('/api/relationships/transfer', { from_user_id: 2, to_user_id: 1 });
    expect(await screen.findByText(/registro\(s\) transferido/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    expect(screen.queryByText(/registro\(s\) transferido/)).not.toBeInTheDocument();
  });

  it('transferir carteira: erro da API e fechar pelo X', async () => {
    m.post.mockRejectedValueOnce(new ApiError(400, 'não deu'));
    render(<Team />);
    await screen.findByText('rep@org.com');
    await userEvent.click(screen.getByRole('button', { name: 'Transferir carteira' }));
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects.at(-1)!, String(ME.id));
    await userEvent.click(screen.getByRole('button', { name: 'Transferir' }));
    expect(await screen.findByText('não deu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByText('não deu')).not.toBeInTheDocument();
  });
});

describe('Team — Metas', () => {
  const progress = [
    { id: 1, user_id: 2, represented_id: 1, competencia: '2026-07', valor_meta: '1000', realizado: 1200, pct: 120, vendedor_nome: 'Ana', vendedor_email: 'ana@x', represented_nome: 'Rep A' },
    { id: 2, user_id: 3, represented_id: null, competencia: '2026-07', valor_meta: '1000', realizado: 700, pct: 70, vendedor_nome: null, vendedor_email: 'b@x', represented_nome: null },
    { id: 3, user_id: 4, represented_id: null, competencia: '2026-07', valor_meta: '1000', realizado: 300, pct: 30, vendedor_nome: 'Carla', vendedor_email: 'c@x', represented_nome: null },
    { id: 4, user_id: 5, represented_id: null, competencia: '2026-07', valor_meta: '1000', realizado: 0, pct: null, vendedor_nome: 'Davi', vendedor_email: 'd@x', represented_nome: null },
  ];
  const metasGet = (over?: Partial<Record<'goals' | 'users' | 'represented', unknown>>) =>
    async (p: string): Promise<unknown> => {
      if (p === '/api/groups') return { groups: [] }; // Usuarios monta antes de trocar de aba
      if (p.startsWith('/api/goals/progress')) return over?.goals ?? { progress };
      if (p === '/api/users') return over?.users ?? { users: [ME, { ...REP, ativo: false }] };
      if (p === '/api/represented') return over?.represented ?? { empresas: [{ id: 1, nome: 'Rep A', ativo: true }, { id: 2, nome: 'Rep B', ativo: false }] };
      return {};
    };

  const goToMetas = async (): Promise<void> => {
    render(<Team />);
    await userEvent.click(screen.getByRole('button', { name: /Metas/ }));
  };

  it('lista progresso das metas com as faixas de cor e cria uma nova meta', async () => {
    m.get.mockImplementation(metasGet());
    m.post.mockResolvedValue({ goal: {} });
    await goToMetas();
    expect(await screen.findByText('Ana')).toBeInTheDocument();
    expect(screen.getAllByText('Meta global').length).toBeGreaterThan(0); // represented_nome null
    expect(screen.getByText('b@x')).toBeInTheDocument(); // vendedor_nome null → email

    // troca a competência (recarrega)
    fireEvent.change(screen.getByLabelText('Competência'), { target: { value: '2026-05' } });
    await waitFor(() => expect(m.get.mock.calls.some((c) => String(c[0]).includes('competencia=2026-05'))).toBe(true));

    // preenche o formulário
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[0]!, String(ME.id)); // vendedor (só ativos)
    await userEvent.selectOptions(selects[1]!, '1'); // representada
    const valor = screen.getByRole('textbox');
    await userEvent.type(valor, '500');
    await userEvent.click(screen.getByRole('button', { name: /Definir meta/ }));
    expect(m.post).toHaveBeenCalledWith('/api/goals', { user_id: 1, represented_id: 1, competencia: '2026-05', valor_meta: 500 });
  });

  it('erro ao criar meta mostra mensagem e toast', async () => {
    m.get.mockImplementation(metasGet());
    m.post.mockRejectedValueOnce(new ApiError(409, 'meta duplicada'));
    await goToMetas();
    await screen.findByText('Ana');
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[0]!, String(ME.id));
    await userEvent.type(screen.getByRole('textbox'), '500');
    await userEvent.click(screen.getByRole('button', { name: /Definir meta/ }));
    expect(await screen.findByText('meta duplicada')).toBeInTheDocument();
    expect(toastMock.error).toHaveBeenCalledWith('meta duplicada');
  });

  it('erro ao carregar metas mostra mensagem', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/groups') return { groups: [] };
      if (p.startsWith('/api/goals/progress')) throw new ApiError(500, 'falha metas');
      if (p === '/api/users') return { users: [] };
      if (p === '/api/represented') return { empresas: [] };
      return {};
    });
    await goToMetas();
    expect(await screen.findByText('falha metas')).toBeInTheDocument();
  });

  it('sem metas mostra estado vazio; users/represented com falha são silenciosos', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/goals/progress')) return { progress: [] };
      throw new ApiError(500, 'x'); // users e represented falham → catch(()=>undefined)
    });
    await goToMetas();
    expect(await screen.findByText('Sem metas no mês')).toBeInTheDocument();
  });

  it('excluir meta: confirma e chama DELETE; erro dispara toast', async () => {
    m.get.mockImplementation(metasGet());
    confirmMock.mockResolvedValue(true);
    m.del.mockResolvedValueOnce({ deleted: true });
    await goToMetas();
    await screen.findByText('Ana');
    const del = screen.getAllByRole('button', { name: 'Excluir meta' });
    await userEvent.click(del[0]!);
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/goals/1'));

    // erro no delete
    m.del.mockRejectedValueOnce(new ApiError(400, 'não excluiu'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir meta' })[1]!);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('não excluiu'));
  });

  it('excluir meta cancelado no confirm não chama DELETE', async () => {
    m.get.mockImplementation(metasGet());
    confirmMock.mockResolvedValue(false);
    await goToMetas();
    await screen.findByText('Ana');
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir meta' })[0]!);
    expect(m.del).not.toHaveBeenCalled();
  });

  it('sem permissão de goals.create esconde o formulário; sem goals.delete esconde excluir', async () => {
    m.get.mockImplementation(metasGet());
    setCan(() => false);
    await goToMetas();
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: /Definir meta/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir meta' })).not.toBeInTheDocument();
  });
});
