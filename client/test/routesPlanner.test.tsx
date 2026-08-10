// Planejador de rota: seleção do funil, otimizar, salvar, rotas salvas, veículos.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoutePlanner } from '../src/pages/Routes.tsx';
import { api, ApiError } from '../src/lib/api.ts';
import { useAuth, type User } from '../src/lib/auth.tsx';
import { confirmDialog } from '../src/lib/confirm.ts';
import { loadPartida } from '../src/lib/companyFilter.tsx';
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn() }));
// companyFilter é pesada (mapa/filtros); só loadPartida é usada aqui.
vi.mock('../src/lib/companyFilter.tsx', () => ({ loadPartida: vi.fn(() => null) }));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null, CircleMarker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Polyline: () => null, Tooltip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  useMap: () => ({ fitBounds: vi.fn() }),
}));
vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/auth.tsx', () => {
  const useAuth = vi.fn();
  return { useAuth, useOptionalUser: () => useAuth().user ?? null };
});
const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);

const admin: User = { id: 1, email: 'a@b.c', role: 'admin', org_id: 1, org_nome: 'Org' };

const FUNNEL = [
  { id: 1, company_id: 10, razao_social: 'Alfa LTDA', nome_fantasia: 'Alfa', uf: 'SP', lat: -23.5, lon: -46.6 },
  { id: 2, company_id: 20, razao_social: 'Beta SA', nome_fantasia: null, uf: 'SP', lat: null, lon: null },
];
const VEHICLES = [
  { id: 5, nome: 'Fiorino', placa: null, combustivel: 'flex', consumo_kml: '11', tanque_litros: null, preco_litro: '6.10', ativo: true },
];
const RESULT = {
  origem: { lat: -23.5, lon: -46.6 },
  stops: [{ company_id: 10, seq: 0, razao_social: 'Alfa LTDA', nome_fantasia: 'Alfa', uf: 'SP', cidade: 'São Paulo', lat: -23.5, lon: -46.6, leg_dist_km: 12.3, leg_dur_min: 20 }],
  dist_km: 24.6, dur_min: 41, preco_litro: 6.1, litros: 2.2, custo_total: 13.4,
  geometry: { coordinates: [[-23.5, -46.6]] }, skipped: [],
};

beforeEach(() => {
  vi.mocked(m.get).mockReset();
  vi.mocked(m.post).mockReset();
  vi.mocked(m.del).mockReset();
  useAuthMock.mockReturnValue({
    user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can: () => true,
  });
  m.get.mockImplementation(async (p: string) => {
    if (p.startsWith('/api/relationships')) return { relationships: FUNNEL };
    if (p === '/api/vehicles') return { vehicles: VEHICLES };
    if (p === '/api/routes') return { routes: [] };
    return {};
  });
});

describe('RoutePlanner', () => {
  it('lista empresas do funil, sinaliza quem não tem localização e busca', async () => {
    render(<RoutePlanner />);
    expect(await screen.findByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText(/sem localização/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Buscar empresa…'), 'beta');
    expect(screen.queryByText('Alfa')).not.toBeInTheDocument();
    expect(screen.getByText('Beta SA')).toBeInTheDocument();
  });

  it('otimizar fica desabilitado sem seleção; com seleção chama a API e mostra resultado', async () => {
    m.post.mockResolvedValueOnce(RESULT);
    render(<RoutePlanner />);
    await screen.findByText('Alfa');

    const otimizar = screen.getByRole('button', { name: 'Otimizar rota' });
    expect(otimizar).toBeDisabled();

    await userEvent.click(screen.getByText('Alfa'));
    await userEvent.click(otimizar);
    expect(m.post).toHaveBeenCalledWith('/api/routes/optimize',
      { company_ids: [10], vehicle_id: null, preco_litro: null, origem_lat: null, origem_lon: null });

    expect(await screen.findByText('Sequência de visitas')).toBeInTheDocument();
    expect(screen.getByText(/24,6 km/)).toBeInTheDocument();
    expect(screen.getByText('Retorno à origem').closest('li')).toHaveTextContent('+12,3 km');
  });

  it('erro da API aparece (ex.: sem origem cadastrada)', async () => {
    m.post.mockRejectedValueOnce(new ApiError(400, 'Cadastre o endereço da sua conta para definir a origem da rota.'));
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByText('Alfa'));
    await userEvent.click(screen.getByRole('button', { name: 'Otimizar rota' }));
    expect(await screen.findByText(/Cadastre o endereço/)).toBeInTheDocument();
  });

  it('salvar rota usa modal e persiste; cancelar não chama POST /api/routes', async () => {
    m.post.mockResolvedValueOnce(RESULT); // optimize
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByText('Alfa'));
    await userEvent.click(screen.getByRole('button', { name: 'Otimizar rota' }));
    await screen.findByText('Sequência de visitas');

    // abre o modal de nome e cancela — só o optimize foi chamado
    await userEvent.click(screen.getByRole('button', { name: 'Salvar rota' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(m.post).toHaveBeenCalledTimes(1);

    // reabre, troca o nome e confirma
    m.post.mockResolvedValueOnce({ route: { id: 9 } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar rota' }));
    const nomeInput = screen.getByLabelText('Nome da rota');
    await userEvent.clear(nomeInput);
    await userEvent.type(nomeInput, 'Rota Zona Sul');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' })); // submit do modal
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
    expect(m.post).toHaveBeenLastCalledWith('/api/routes', expect.objectContaining({
      nome: 'Rota Zona Sul', stops: [expect.objectContaining({ company_id: 10, seq: 0 })],
    }));
  });

  it('rotas salvas listam e excluem com confirm', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/relationships')) return { relationships: FUNNEL };
      if (p === '/api/vehicles') return { vehicles: VEHICLES };
      if (p === '/api/routes') return { routes: [{ id: 9, nome: 'Rota Salva', vehicle_id: null, veiculo: null, dist_km: '24.6', dur_min: '41', litros: null, custo_total: null, created_at: '', paradas: '1' }] };
      return {};
    });
    m.del.mockResolvedValueOnce({});
    vi.mocked(confirmDialog).mockResolvedValue(true);
    render(<RoutePlanner />);
    expect(await screen.findByText('Rota Salva')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Excluir'));
    expect(m.del).toHaveBeenCalledWith('/api/routes/9');
  });

  it('aba Veículos lista veículo ativo', async () => {
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Veículos' }));
    expect(await screen.findByText(/Fiorino/)).toBeInTheDocument();
  });

  it('aba Veículos: valida, cria, edita/cancela e remove', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Veículos' }));
    await screen.findByText(/Fiorino/);

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(screen.getByText(/Nome e consumo são obrigatórios/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Fiat Strada 2022'), 'Gol');
    await userEvent.selectOptions(screen.getByDisplayValue('Gasolina'), 'diesel');
    await userEvent.type(screen.getByPlaceholderText('ABC1D23'), 'ABC1D23');
    await userEvent.type(screen.getByPlaceholderText('12,5'), '10');
    await userEvent.type(screen.getByPlaceholderText('55'), '50');
    await userEvent.type(screen.getByPlaceholderText('6,19'), '6,10');
    m.post.mockResolvedValueOnce({ vehicle: { id: 6 } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/vehicles', expect.objectContaining({ nome: 'Gol' })));

    await userEvent.click(screen.getByLabelText('Editar'));
    expect(screen.getByDisplayValue('Fiorino')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    m.del.mockResolvedValueOnce({});
    await userEvent.click(screen.getByLabelText('Excluir'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/vehicles/5'));
  });

  it('aba Veículos sem veículos mostra empty state', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/relationships')) return { relationships: FUNNEL };
      if (p === '/api/vehicles') return { vehicles: [] };
      if (p === '/api/routes') return { routes: [] };
      return {};
    });
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Veículos' }));
    expect(await screen.findByText('Nenhum veículo')).toBeInTheDocument();
  });

  it('otimiza com veículo/preço e paradas ignoradas; navega e salvar falha', async () => {
    window.open = vi.fn();
    m.post.mockReset();
    m.post.mockResolvedValueOnce({ ...RESULT, skipped: [20] });
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    await userEvent.selectOptions(screen.getByDisplayValue('Sem veículo (só distância)'), '5');
    await userEvent.type(screen.getByPlaceholderText('ex.: 6,19'), '6,20');
    await userEvent.click(screen.getByText('Alfa'));
    await userEvent.click(screen.getByRole('button', { name: 'Otimizar rota' }));
    await screen.findByText('Sequência de visitas');
    expect(screen.getByText(/ignorada/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Usar rota/ }));
    await userEvent.click(screen.getByTitle('Navegar até esta parada'));
    await userEvent.click(screen.getByRole('button', { name: /Navegar até aqui/ }));
    expect(window.open).toHaveBeenCalled();

    m.post.mockRejectedValueOnce(new Error('boom'));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar rota' }));
    screen.getByLabelText('Nome da rota');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  });

  it('abre uma rota salva no mapa', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/relationships')) return { relationships: FUNNEL };
      if (p === '/api/vehicles') return { vehicles: VEHICLES };
      if (p === '/api/routes') return { routes: [{ id: 9, nome: 'Rota X', vehicle_id: null, veiculo: null, dist_km: '10', dur_min: '20', litros: null, custo_total: null, template: false, created_at: '', paradas: '1' }] };
      if (p === '/api/routes/9') return {
        route: { origem_lat: '-23', origem_lon: '-46', dist_km: '10', dur_min: '20', preco_litro: null, litros: null, custo_total: null, geometry: { coordinates: [] } },
        stops: [{ company_id: 10, seq: 0, razao_social: 'Alfa', nome_fantasia: 'Alfa', cidade: 'SP', uf: 'SP', lat: '-23', lon: '-46', leg_dist_km: '5', leg_dur_min: '10' }],
      };
      return {};
    });
    render(<RoutePlanner />);
    await screen.findByText('Rota X');
    await userEvent.click(screen.getByTitle('Abrir no mapa'));
    expect(await screen.findByText('Sequência de visitas')).toBeInTheDocument();
  });

  it('partida definida pode voltar para a conta', async () => {
    vi.mocked(loadPartida).mockReturnValueOnce({ lat: -23, lon: -46, label: 'Minha base' });
    render(<RoutePlanner />);
    await screen.findByText('Alfa');
    expect(screen.getByText('Minha base')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'usar conta' }));
    await waitFor(() => expect(screen.queryByText('Minha base')).not.toBeInTheDocument());
  });

  it('erros: abrir rota, salvar e remover veículo falham', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/relationships')) return { relationships: FUNNEL };
      if (p === '/api/vehicles') return { vehicles: VEHICLES };
      if (p === '/api/routes') return { routes: [{ id: 9, nome: 'Rota X', vehicle_id: null, veiculo: null, dist_km: '10', dur_min: '20', litros: null, custo_total: null, template: false, created_at: '', paradas: '1' }] };
      if (p === '/api/routes/9') throw new Error('fail open');
      return {};
    });
    render(<RoutePlanner />);
    await screen.findByText('Rota X');
    await userEvent.click(screen.getByTitle('Abrir no mapa'));
    expect(await screen.findByText(/Falha ao abrir a rota/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Veículos' }));
    await screen.findByText(/Fiorino/);
    await userEvent.type(screen.getByPlaceholderText('Fiat Strada 2022'), 'Gol');
    await userEvent.type(screen.getByPlaceholderText('12,5'), '10');
    m.post.mockReset();
    m.post.mockRejectedValueOnce(new Error('x'));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(/Falha ao salvar veículo/)).toBeInTheDocument();

    m.del.mockReset();
    m.del.mockRejectedValueOnce(new Error('x'));
    await userEvent.click(screen.getByLabelText('Excluir'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/vehicles/5'));
  });
});

// Fase 5: ações nas rotas salvas (reusar, criar compromissos, template).
const SAVED = [{
  id: 7, nome: 'Rota seg', vehicle_id: null, veiculo: null,
  dist_km: '24.6', dur_min: '41', litros: '2', custo_total: '13.4',
  template: false, recorrencia: null, created_at: '2026-06-01', paradas: '2',
}];

describe('RoutePlanner: rotas salvas (Fase 5)', () => {
  beforeEach(() => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/relationships')) return { relationships: FUNNEL };
      if (p === '/api/vehicles') return { vehicles: VEHICLES };
      if (p === '/api/routes') return { routes: SAVED };
      return {};
    });
    vi.mocked(m.patch).mockReset();
    vi.stubGlobal('alert', vi.fn());
  });

  it('reusar: pede nome em modal e chama /reuse', async () => {
    m.post.mockResolvedValueOnce({ skipped: [] });
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Reusar rota' }));
    const nomeInput = screen.getByLabelText('Nome da nova rota');
    await userEvent.clear(nomeInput);
    await userEvent.type(nomeInput, 'Rota nova');
    await userEvent.click(screen.getByRole('button', { name: 'Reusar' })); // submit do modal
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/routes/7/reuse', { nome: 'Rota nova' }));
  });

  it('criar compromissos: pede data em modal e chama /agenda', async () => {
    m.post.mockResolvedValueOnce({ created: 2 });
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Criar compromissos' }));
    // input de data do modal (type=date) — define via change
    fireEvent.change(screen.getByLabelText('Data da rota'), { target: { value: '2026-07-01' } });
    // segundo "Criar compromissos" = submit do modal
    await userEvent.click(screen.getAllByRole('button', { name: 'Criar compromissos' }).at(-1)!);
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/routes/7/agenda', { start_at: '2026-07-01T08:00:00' }));
  });

  it('marcar template: faz PATCH e atualiza o estado local (sem refetch da lista)', async () => {
    m.patch.mockResolvedValueOnce({ route: { template: true } });
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Marcar como template' }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/routes/7', { template: true }));
    // o badge "Template" aparece a partir do retorno do PATCH, sem refetch:
    // GET /api/routes só foi chamado no mount (1x), não após o toggle.
    expect(await screen.findByText('Template')).toBeInTheDocument();
    expect(m.get.mock.calls.filter((c: unknown[]) => c[0] === '/api/routes')).toHaveLength(1);
  });

  it('reusar cancelado (prompt vazio) não chama API', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Reusar rota' }));
    expect(m.post).not.toHaveBeenCalledWith(expect.stringContaining('/reuse'), expect.anything());
  });

  it('reusar com paradas ignoradas e depois com erro', async () => {
    m.post.mockReset();
    m.post.mockResolvedValueOnce({ skipped: [1, 2] });
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Reusar rota' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reusar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/routes/7/reuse', expect.anything()));

    m.post.mockRejectedValueOnce(new Error('x'));
    await userEvent.click(screen.getByRole('button', { name: 'Reusar rota' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reusar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  });

  it('criar compromissos com erro exibe toast', async () => {
    m.post.mockReset();
    m.post.mockRejectedValueOnce(new Error('x'));
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Criar compromissos' }));
    fireEvent.change(screen.getByLabelText('Data da rota'), { target: { value: '2026-07-01' } });
    await userEvent.click(screen.getAllByRole('button', { name: 'Criar compromissos' }).at(-1)!);
    await waitFor(() => expect(m.post).toHaveBeenCalled());
  });

  it('lançar despesa de viagem (sucesso e erro)', async () => {
    m.post.mockReset();
    m.post.mockResolvedValueOnce({});
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar despesa de viagem' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lançar no Financeiro' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/routes/7/expense', expect.anything()));

    m.post.mockRejectedValueOnce(new Error('x'));
    await userEvent.click(screen.getByRole('button', { name: 'Lançar despesa de viagem' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lançar no Financeiro' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  });

  it('excluir rota salva: falha exibe toast', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    m.del.mockReset();
    m.del.mockRejectedValueOnce(new Error('x'));
    render(<RoutePlanner />);
    await screen.findByText('Rota seg');
    await userEvent.click(screen.getByLabelText('Excluir'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/routes/7'));
  });
});
