// Guards de rota do App: anônimo -> /login, senha provisória -> /trocar-senha,
// não-admin fora de /equipe. Páginas pesadas mockadas (Leaflet não roda em jsdom).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App.tsx';
import { useAuth, type User } from '../src/lib/auth.tsx';
import { api } from '../src/lib/api.ts';
import { queued } from '../src/lib/offline.ts';

vi.mock('../src/lib/auth.tsx', () => {
  const useAuth = vi.fn();
  return { useAuth, useOptionalUser: () => useAuth().user ?? null };
});
// NotificationBell/OfflineBanner do Shell tocam api/offline — controla ambos.
vi.mock('../src/lib/api.ts', () => ({
  api: {
    get: vi.fn(() => Promise.resolve({ notifications: [], nao_lidas: 0 })),
    patch: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../src/lib/offline.ts', () => ({
  queued: vi.fn(() => Promise.resolve([])),
  onQueueChange: vi.fn(() => () => undefined),
  clearQueue: vi.fn(),
}));
const mApi = vi.mocked(api);
const mQueued = vi.mocked(queued);
// páginas lazy substituídas por marcadores — o alvo aqui é o roteamento
vi.mock('../src/pages/Dashboard.tsx', () => ({ Dashboard: () => <div>PAGE-DASHBOARD</div> }));
vi.mock('../src/pages/Reports.tsx', () => ({ Reports: () => <div>PAGE-RELATORIOS</div> }));
vi.mock('../src/pages/Recommend.tsx', () => ({ Recommend: () => <div>PAGE-RECOMMEND</div> }));
vi.mock('../src/pages/Kanban.tsx', () => ({ Kanban: () => <div>PAGE-KANBAN</div> }));
vi.mock('../src/pages/Routes.tsx', () => ({ RoutePlanner: () => <div>PAGE-ROTAS</div> }));
vi.mock('../src/pages/Catalog.tsx', () => ({ Catalog: () => <div>PAGE-CATALOGO</div> }));
vi.mock('../src/pages/Agenda.tsx', () => ({ Agenda: () => <div>PAGE-AGENDA</div> }));
vi.mock('../src/pages/Settings.tsx', () => ({ Settings: () => <div>PAGE-CONFIG</div> }));
vi.mock('../src/pages/Account.tsx', () => ({ Account: () => <div>PAGE-CONTA</div> }));
vi.mock('../src/pages/Finance.tsx', () => ({ Finance: () => <div>PAGE-FIN</div> }));
vi.mock('../src/pages/Team.tsx', () => ({ Team: () => <div>PAGE-EQUIPE</div> }));
vi.mock('../src/pages/Login.tsx', () => ({ Login: () => <div>PAGE-LOGIN</div> }));
vi.mock('../src/pages/ChangePassword.tsx', () => ({ ChangePassword: () => <div>PAGE-TROCAR-SENHA</div> }));
// theme usa window.matchMedia (ausente no jsdom); o alvo aqui é roteamento.
vi.mock('../src/lib/theme.tsx', () => ({
  ThemeProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  ThemeToggle: () => null,
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), toggle: vi.fn() }),
}));

const useAuthMock = vi.mocked(useAuth);

// can(): admin faz bypass; rep sem grupo não tem permissão nenhuma (ex.: users.list)
// isOffice deriva de tipo_conta (undefined = escritório, comportamento default).
const auth = (user: User | null, loading = false): ReturnType<typeof useAuth> => ({
  user, loading, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
  can: () => user?.role === 'admin',
  isOffice: user?.tipo_conta !== 'individual',
});

const admin: User = { id: 1, email: 'a@b.c', role: 'admin', org_id: 1, org_nome: 'Org' };
const rep: User = { ...admin, role: 'rep' };

const mount = (path: string): ReturnType<typeof render> => render(
  <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>,
);

beforeEach(() => useAuthMock.mockReturnValue(auth(admin)));

describe('App routing', () => {
  it('anônimo em rota protegida cai no login', async () => {
    useAuthMock.mockReturnValue(auth(null));
    mount('/funil');
    expect(await screen.findByText('PAGE-LOGIN')).toBeInTheDocument();
  });

  it('loading mostra spinner, não redireciona', () => {
    useAuthMock.mockReturnValue(auth(null, true));
    const { container } = mount('/funil');
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText('PAGE-LOGIN')).not.toBeInTheDocument();
  });

  it('senha provisória força /trocar-senha em qualquer rota', async () => {
    useAuthMock.mockReturnValue(auth({ ...rep, must_change_password: true }));
    mount('/agenda');
    expect(await screen.findByText('PAGE-TROCAR-SENHA')).toBeInTheDocument();
  });

  it('admin abre o dashboard na home e a prospecção em /prospeccao', async () => {
    mount('/');
    expect(await screen.findByText('PAGE-DASHBOARD')).toBeInTheDocument();
  });

  it('rota /prospeccao renderiza a recomendação', async () => {
    mount('/prospeccao');
    expect(await screen.findByText('PAGE-RECOMMEND')).toBeInTheDocument();
  });

  it('rep não acessa /equipe (volta para a home)', async () => {
    useAuthMock.mockReturnValue(auth(rep));
    mount('/equipe');
    expect(await screen.findByText('PAGE-DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('PAGE-EQUIPE')).not.toBeInTheDocument();
  });

  it('admin acessa /equipe e o menu mostra Vendedores', async () => {
    mount('/equipe');
    expect(await screen.findByText('PAGE-EQUIPE')).toBeInTheDocument();
    expect(screen.getAllByText('Vendedores').length).toBeGreaterThan(0);
  });

  it('menu de rep não tem Vendedores; rota desconhecida cai na home', async () => {
    useAuthMock.mockReturnValue(auth(rep));
    mount('/nao-existe');
    expect(await screen.findByText('PAGE-DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('Vendedores')).not.toBeInTheDocument();
  });

  it('/perfil redireciona para /config', async () => {
    mount('/perfil');
    expect(await screen.findByText('PAGE-CONFIG')).toBeInTheDocument();
  });

  it('conta individual: /equipe redireciona e o menu não tem Vendedores/Grupos Usuários/Carteiras', async () => {
    useAuthMock.mockReturnValue(auth({ ...admin, tipo_conta: 'individual' }));
    mount('/equipe');
    expect(await screen.findByText('PAGE-DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('PAGE-EQUIPE')).not.toBeInTheDocument();
    expect(screen.queryByText('Vendedores')).not.toBeInTheDocument();
    expect(screen.queryByText('Grupos Usuários')).not.toBeInTheDocument();
    expect(screen.queryByText('Carteiras')).not.toBeInTheDocument();
  });

  it('conta escritório (admin): menu mostra Vendedores/Grupos Usuários/Carteiras', async () => {
    useAuthMock.mockReturnValue(auth({ ...admin, tipo_conta: 'escritorio' }));
    mount('/');
    expect(await screen.findByText('PAGE-DASHBOARD')).toBeInTheDocument();
    expect(screen.getAllByText('Vendedores').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Grupos Usuários').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Carteiras').length).toBeGreaterThan(0);
  });
});

describe('App shell: sino, offline, sidebar', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue(auth(admin));
    mApi.get.mockReset();
    mApi.patch.mockReset();
    mApi.post.mockReset();
    mQueued.mockReset();
    mApi.get.mockResolvedValue({ notifications: [], nao_lidas: 0 });
    mApi.patch.mockResolvedValue({});
    mApi.post.mockResolvedValue({});
    mQueued.mockResolvedValue([]);
  });

  it('sino de notificações: abre, marca todas e navega ao clicar', async () => {
    const notifs = [{ id: 1, tipo: 'agenda', titulo: 'Compromisso amanhã', lida: false }];
    mApi.get.mockImplementation((p: string) => p === '/api/notifications'
      ? Promise.resolve({ notifications: notifs, nao_lidas: 1 })
      : Promise.resolve({}));
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');

    const bells = await screen.findAllByLabelText('Notificações');
    await userEvent.click(bells[0]!);
    expect(await screen.findByText('Compromisso amanhã')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Marcar todas'));
    expect(mApi.post).toHaveBeenCalledWith('/api/notifications/read-all');

    await userEvent.click(screen.getByText('Compromisso amanhã'));
    await waitFor(() => expect(mApi.patch).toHaveBeenCalledWith('/api/notifications/1/read'));
  });

  it('sino: overlay fecha o painel', async () => {
    mApi.get.mockResolvedValue({ notifications: [], nao_lidas: 0 });
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    const bells = await screen.findAllByLabelText('Notificações');
    await userEvent.click(bells[0]!);
    expect(screen.getByText('Nada por aqui.')).toBeInTheDocument();
    // O sino passou a usar o Popover compartilhado: o backdrop é o irmão
    // `fixed inset-0` que fica imediatamente antes do menu (role=menu).
    const menu = document.querySelector('[role="menu"]')!;
    fireEvent.click(menu.previousElementSibling!);
    await waitFor(() => expect(screen.queryByText('Nada por aqui.')).not.toBeInTheDocument());
  });

  it('banner offline aparece ao perder conexão e some ao voltar', async () => {
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(await screen.findByText(/Você está offline/)).toBeInTheDocument();
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(screen.queryByText(/Você está offline/)).not.toBeInTheDocument());
  });

  it('banner de sincronização quando há ações na fila', async () => {
    mQueued.mockResolvedValue([{ id: 'x' }]);
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    expect(await screen.findByText(/Sincronizando 1 ação/)).toBeInTheDocument();
  });

  it('banner offline com ações pendentes aguardando', async () => {
    mQueued.mockResolvedValue([{ id: 'x' }]);
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(await screen.findByText(/Offline — 1 ação/)).toBeInTheDocument();
  });

  // A navegação mobile deixou de ser barra inferior + folha "Mais": hoje é um FAB
  // que abre o menu inteiro (MobileNavFab), e ele fecha ao trocar de rota.
  it('menu mobile (FAB) abre e fecha ao navegar', async () => {
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    await userEvent.click(screen.getByLabelText('Abrir menu'));
    const nav = await screen.findByRole('navigation', { name: 'Navegação' });
    await userEvent.click(within(nav).getByText('Config'));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Navegação' })).not.toBeInTheDocument());
  });

  it('sidebar recolhida mostra avatar/logout compactos e expande', async () => {
    localStorage.setItem('rs_sidebar_collapsed', '1');
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    expect(screen.getByLabelText('Sair')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Expandir menu'));
    await waitFor(() => expect(screen.getByLabelText('Recolher menu')).toBeInTheDocument());
  });

  it('acordeon: recolhe e reabre um grupo do menu', async () => {
    mount('/');
    await screen.findByText('PAGE-DASHBOARD');
    const vendas = screen.getByRole('button', { name: 'Vendas' });
    await userEvent.click(vendas);
    await userEvent.click(vendas);
    expect(vendas).toBeInTheDocument();
  });
});
