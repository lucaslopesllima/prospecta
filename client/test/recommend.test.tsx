// Prospecção (lista): tela vazia sem território, busca por território com debounce,
// paginação, adicionar ao funil, erro genérico. Leaflet mockado (jsdom não renderiza mapa).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Recommend } from '../src/pages/Recommend.tsx';
import { api, ApiError } from '../src/lib/api.ts';
import { useAuth, type User } from '../src/lib/auth.tsx';
import { toast } from '../src/lib/toast.tsx';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  CircleMarker: ({ children, ref, eventHandlers }: { children?: React.ReactNode; ref?: (m: { openPopup: () => void } | null) => void; eventHandlers?: { click?: () => void } }) => {
    if (typeof ref === 'function') ref({ openPopup: () => {} });
    return <div data-testid="cm" onClick={eventHandlers?.click}>{children}</div>;
  },
  Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Polyline: () => null, Tooltip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn(), getZoom: () => 11 }),
  useMapEvents: (h: { zoomend?: () => void }) => { if (h?.zoomend) setTimeout(h.zoomend, 0); return null; },
}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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

const rec = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: '1', cnpj: '11222333000144', razao_social: 'Alvo Comercio LTDA', nome_fantasia: 'Loja Alvo',
  cnae_principal: 4781400, municipio_id: 100, uf: 'SP', porte: 'pequeno', capital_social: '100000',
  lat: -23.5, lon: -46.6, score: 0.82,
  reason: {
    cnae_match: 'classe', cnae_principal: 4781400, distancia_km: 4.2, porte: 'pequeno',
    capital_social: '100000', idade_anos: 12.4,
    componentes: { cnae: 0.5, proximidade: 0.22, porte: 0.1, capital: 0.08, idade: 0.06 },
  }, ...over,
});

// A busca só dispara com território definido (município selecionado).
const comTerritorio = (): void =>
  localStorage.setItem('companyFilter:reco', JSON.stringify({
    munis: [{ id: 100, nome: 'São Paulo', uf: 'SP', regiao: 'Sudeste' }],
    raio: '', pesos: { cnae: 0.5, proximidade: 0.3, porte: 0.2 },
  }));

const mount = (): ReturnType<typeof render> =>
  render(<MemoryRouter><Recommend /></MemoryRouter>);

const clickCardAction = async (name: string | RegExp, trigger?: HTMLElement): Promise<void> => {
  await userEvent.click(trigger ?? screen.getAllByRole('button', { name: 'Mais ações' })[0]!);
  await userEvent.click(await screen.findByRole('menuitem', { name }));
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(m.get).mockReset();
  vi.mocked(m.post).mockReset();
  useAuthMock.mockReturnValue({
    user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can: () => true,
  });
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  m.get.mockImplementation(async (p: string) => {
    if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
    if (p === '/api/municipios/ufs') return { ufs: [] };
    if (p.includes('/geocode')) return { geocode: { lat: -23.55, lon: -46.63, precisao: 'rua' } };
    if (/\/api\/companies\/\d+$/.test(p)) return { company: { id: 1, cnpj: '11222333000144', razao_social: 'Alvo', nome_fantasia: null, cnae_principal: 4781400, cnae_secundarios: [], cnae_descricao: null, uf: 'SP', municipio_id: 100, cidade: 'SP', regiao: 'Sudeste', porte: 'micro', capital_social: '1', situacao_cadastral: 'Ativa', source: 'RFB', logradouro: null, numero: null, complemento: null, bairro: null, cep: null, telefone1: null, telefone2: null, email: null, fax: null, data_inicio_atividade: null, matriz_filial: 1, natureza_juridica: null, natureza_descricao: null, qualificacao_responsavel: null, qualificacao_descricao: null, ente_federativo: null, motivo_situacao: null, motivo_descricao: null, data_situacao_cadastral: null, situacao_especial: null, data_situacao_especial: null, nome_cidade_exterior: null, pais: null, pais_nome: null, opcao_simples: null, data_opcao_simples: null, data_exclusao_simples: null, opcao_mei: null, data_opcao_mei: null, data_exclusao_mei: null, lat: -23.5, lon: -46.6, raw_data: null, geo_lat: -23.5, geo_lon: -46.6, geo_precisao: 'rua' }, socios: [] };
    return {};
  });
});

describe('Recommend', () => {
  it('sem território: tela vazia, sem consultar a base', async () => {
    mount();
    expect(await screen.findByText('Defina o território')).toBeInTheDocument();
    expect(m.get.mock.calls.some((c) => String(c[0]).startsWith('/api/recommend'))).toBe(false);
  });

  it('com território dispara a busca (debounce) e lista resultados com score', async () => {
    comTerritorio();
    mount();
    expect(await screen.findByText('Loja Alvo', undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getAllByText('82').length).toBeGreaterThan(0); // score no card e no KPI
    const url = m.get.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/recommend'))!;
    expect(url).toContain('munis=100');
  });

  it('faixa de capital com mínimo > máximo não consulta a base e avisa', async () => {
    comTerritorio();
    // filtro persistido da tela com a faixa invertida (min 1.000.000 > max 500.000)
    localStorage.setItem('companyFilter:prospeccao', JSON.stringify({
      fq: '', fCnae: '', fPorte: '',
      faixas: { capMin: '1.000.000', capMax: '500.000', idadeMin: '', idadeMax: '' },
    }));
    mount();
    expect(await screen.findByText(/Busca pausada/)).toBeInTheDocument();
    expect(m.get.mock.calls.some((c) => String(c[0]).startsWith('/api/recommend'))).toBe(false);

    // corrigir o máximo destrava a busca
    await userEvent.click(screen.getByRole('button', { name: 'Abrir filtros' }));
    const capMax = await screen.findByLabelText('Capital social máximo');
    await userEvent.clear(capMax);
    await userEvent.type(capMax, '2000000');
    expect(await screen.findByText('Loja Alvo', undefined, { timeout: 2000 })).toBeInTheDocument();
    const url = m.get.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/recommend'))!;
    expect(url).toContain('cap_min=1000000');
    expect(url).toContain('cap_max=2000000');
  });

  it('adicionar ao funil marca o card sem criar contato implicitamente', async () => {
    comTerritorio();
    m.post.mockResolvedValue({ relationship: { id: 1 } });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: /Adicionar ao funil/ }));
    expect(m.post).toHaveBeenCalledWith('/api/relationships', { company_id: 1 });
    expect(await screen.findByText('Adicionado ao funil')).toBeInTheDocument();
    expect(m.post).not.toHaveBeenCalledWith('/api/contacts', expect.anything());
  });

  it('erro ao adicionar ao funil mantém card disponível e avisa', async () => {
    comTerritorio();
    m.post.mockRejectedValueOnce(new Error('funil falhou'));
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: /Adicionar ao funil/ }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('funil falhou'));
    expect(screen.getByRole('button', { name: /Adicionar ao funil/ })).toBeInTheDocument();
  });

  it('erro da busca (400) mostra card com ação de ajustar filtros', async () => {
    comTerritorio();
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) throw new ApiError(400, 'parâmetros inválidos');
      if (p === '/api/municipios/ufs') return { ufs: [] };
      return {};
    });
    mount();
    expect(await screen.findByText('parâmetros inválidos', undefined, { timeout: 2000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ajustar filtros/ }));
  });

  it('"Carregar mais" pagina com offset', async () => {
    comTerritorio();
    // primeira página cheia (20) habilita o botão; cada página traz ids distintos
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) {
        const off = Number(new URLSearchParams(p.split('?')[1]).get('offset') ?? '0');
        return { results: Array.from({ length: 20 }, (_, i) => { const n = off + i + 1; return rec({ id: String(n), razao_social: `Empresa ${n}`, nome_fantasia: `Empresa ${n}` }); }), page: { count: 20 } };
      }
      if (p === '/api/municipios/ufs') return { ufs: [] };
      return {};
    });
    mount();
    await screen.findByText('Empresa 1', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => {
      const urls = m.get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/recommend'));
      expect(urls.some((u) => u.includes('offset=20'))).toBe(true);
    });
  });
});

// GeolocationPositionError pode não existir no jsdom; garante o global p/ o instanceof.
if (!('GeolocationPositionError' in globalThis)) {
  (globalThis as unknown as { GeolocationPositionError: unknown }).GeolocationPositionError = class GeolocationPositionError extends Error {};
}
const GPE = (globalThis as unknown as { GeolocationPositionError: new () => Error }).GeolocationPositionError;

const comTerritorioPartida = (): void => localStorage.setItem('companyFilter:reco', JSON.stringify({
  munis: [{ id: 100, nome: 'São Paulo', uf: 'SP', regiao: 'Sudeste' }],
  pesos: { cnae: 0.5, proximidade: 0.3, porte: 0.2 },
  partida: { label: 'Partida X', lat: -23.4, lon: -46.5 },
}));

const okRoute = { code: 'Ok', routes: [{ distance: 2000, duration: 180, geometry: { coordinates: [[-46.5, -23.4], [-46.6, -23.5]] as [number, number][] } }] };
const mockFetch = (val: unknown): void => { global.fetch = vi.fn().mockResolvedValue({ json: async () => val }) as unknown as typeof fetch; };

describe('Recommend — mapa, rota e interações', () => {
  it('alterna para o mapa, mostra marcadores e abre o modal pelo popup', async () => {
    comTerritorio();
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    expect(await screen.findByTestId('map')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ver dados da empresa' }));
    expect(await screen.findByText('Dados da empresa')).toBeInTheDocument();
  });

  it('"Ver no mapa" foca o pino e geocodifica', async () => {
    comTerritorio();
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Ver no mapa');
    expect(await screen.findByTestId('map')).toBeInTheDocument();
    await waitFor(() => expect(m.get.mock.calls.some((c) => String(c[0]).includes('/geocode'))).toBe(true));
  });

  it('traça rota usando o endereço de partida e limpa a rota', async () => {
    comTerritorioPartida();
    mockFetch(okRoute);
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    expect(await screen.findByText(/2\.0 km/, undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/~3 min/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Limpar rota' }));
    await waitFor(() => expect(screen.queryByText(/2\.0 km/)).not.toBeInTheDocument());
  });

  it('traça rota via origem da conta quando não há partida', async () => {
    comTerritorio();
    mockFetch(okRoute);
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p === '/api/account/origem') return { origem: { lat: -23.3, lon: -46.4 } };
      if (p.includes('/geocode')) return { geocode: { lat: -23.55, lon: -46.63, precisao: 'rua' } };
      return {};
    });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    expect(await screen.findByText(/2\.0 km/, undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('traça rota via geolocalização quando a origem da conta falha', async () => {
    comTerritorio();
    mockFetch(okRoute);
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: -23.2, longitude: -46.3 } } as GeolocationPosition) } });
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p === '/api/account/origem') throw new Error('sem origem');
      if (p.includes('/geocode')) return { geocode: { lat: -23.55, lon: -46.63, precisao: 'rua' } };
      return {};
    });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    expect(await screen.findByText(/2\.0 km/, undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('sem partida, sem origem e sem geolocalização avisa para cadastrar endereço', async () => {
    comTerritorio();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p === '/api/account/origem') return { origem: null };
      return {};
    });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Cadastre seu endereço')));
  });

  it('rota sem resultado do OSRM avisa', async () => {
    comTerritorioPartida();
    mockFetch({ code: 'NoRoute', routes: [] });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível traçar a rota.'));
  });

  it('falha genérica ao traçar rota', async () => {
    comTerritorioPartida();
    global.fetch = vi.fn().mockRejectedValue(new Error('net')) as unknown as typeof fetch;
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Falha ao traçar rota.'));
  });

  it('permissão de localização negada', async () => {
    comTerritorio();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_ok: PositionCallback, rej: PositionErrorCallback) => rej(new GPE() as unknown as GeolocationPositionError) } });
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p === '/api/account/origem') return { origem: null };
      return {};
    });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Rota');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Permissão de localização negada.'));
  });

  it('erro ao adicionar ao funil dispara toast', async () => {
    comTerritorio();
    m.post.mockRejectedValueOnce(new Error('duplicado'));
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: /Adicionar ao funil/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('duplicado'));
  });

  it('abre/fecha filtros e indicadores, persistindo no localStorage', async () => {
    localStorage.setItem('prospeccao:panel', 'filtros');
    comTerritorio();
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getAllByRole('button', { name: /Filtros/ })[0]);
    await userEvent.click(screen.getByRole('button', { name: /Indicadores/ }));
    await waitFor(() => expect(localStorage.getItem('prospeccao:panel')).toBe('kpis'));
  });

  it('botão Buscar consulta a base na hora e fecha os filtros', async () => {
    localStorage.setItem('prospeccao:panel', 'filtros');
    comTerritorio();
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    const buscas = (): number => m.get.mock.calls.filter((c) => String(c[0]).startsWith('/api/recommend')).length;
    const antes = buscas();
    await userEvent.click(screen.getByRole('button', { name: /Buscar/ }));
    await waitFor(() => expect(buscas()).toBe(antes + 1));
    expect(localStorage.getItem('prospeccao:panel')).toBe('none');
  });

  it('sem território o botão Buscar não consulta nem fecha os filtros', async () => {
    localStorage.setItem('prospeccao:panel', 'filtros');
    mount();
    await screen.findByText('Defina o território');
    await userEvent.click(screen.getByRole('button', { name: /Buscar/ }));
    expect(m.get.mock.calls.some((c) => String(c[0]).startsWith('/api/recommend'))).toBe(false);
    expect(localStorage.getItem('prospeccao:panel')).toBe('filtros');
  });

  it('clicar na lista recolhe os filtros abertos', async () => {
    localStorage.setItem('prospeccao:panel', 'filtros');
    comTerritorio();
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByText('Loja Alvo')); // fora do painel de filtros
    await waitFor(() => expect(localStorage.getItem('prospeccao:panel')).toBe('none'));
  });

  it('cards mostram faixas de score, fallback de nome e escondem mapa sem coordenada', async () => {
    comTerritorio();
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [
        rec({ id: '1', razao_social: 'Alta', nome_fantasia: 'Alta Ltda', score: 0.85 }),
        rec({ id: '2', razao_social: 'Media', nome_fantasia: null, score: 0.5 }),
        rec({ id: '3', razao_social: 'Baixa', nome_fantasia: 'Baixa Ltda', score: 0.2, lat: null as unknown as number, lon: null as unknown as number }),
      ], page: { count: 3 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      return {};
    });
    mount();
    expect(await screen.findByText('Alta Ltda', undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('Media')).toBeInTheDocument(); // nome_fantasia null → razao_social
    const baixa = screen.getByText('Baixa Ltda').closest('.p-4')!;
    await userEvent.click(within(baixa as HTMLElement).getByRole('button', { name: 'Mais ações' }));
    expect(screen.queryByRole('menuitem', { name: 'Ver no mapa' })).not.toBeInTheDocument();
  });

  it('sem permissão esconde o botão de adicionar ao funil', async () => {
    comTerritorio();
    useAuthMock.mockReturnValue({ user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(), can: () => false });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    expect(screen.queryByRole('button', { name: /Adicionar ao funil/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Adicionar aos contatos/ })).not.toBeInTheDocument();
  });

  it('território definido mas sem resultados mostra vazio', async () => {
    comTerritorio();
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [], page: { count: 0 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      return {};
    });
    mount();
    expect(await screen.findByText('Nenhuma empresa encontrada', undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('empresas na mesma coordenada são espalhadas (espiral) no mapa', async () => {
    comTerritorio();
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [
        rec({ id: '1', razao_social: 'Um', nome_fantasia: 'Um' }),
        rec({ id: '2', razao_social: 'Dois', nome_fantasia: 'Dois' }),
      ], page: { count: 2 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      return {};
    });
    mount();
    await screen.findByText('Um', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    expect(await screen.findByTestId('map')).toBeInTheDocument();
  });

  it('acima do limite agrupa em clusters (com foco e ponto isolado)', async () => {
    comTerritorio();
    const many = Array.from({ length: 154 }, (_, i) => rec({ id: String(i + 1), razao_social: `E${i + 1}`, nome_fantasia: `E${i + 1}` }));
    many.push(rec({ id: '155', razao_social: 'Longe', nome_fantasia: 'Longe', lat: -3, lon: -60 }));
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: many, page: { count: many.length } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p.includes('/geocode')) return { geocode: { lat: -23.5, lon: -46.6, precisao: 'rua' } };
      return {};
    });
    mount();
    await screen.findByText('E1', undefined, { timeout: 2000 });
    // foca o primeiro (vai pro mapa com focus) → exercita o caminho de foco no cluster
    await clickCardAction('Ver no mapa');
    await screen.findByTestId('map');
    // clica todos os marcadores; só o cluster tem handler (aproxima o mapa)
    for (const cm of screen.getAllByTestId('cm')) fireEvent.click(cm);
  }, 20000);
});

describe('Recommend — cobertura extra', () => {
  it('geocode sob demanda que falha usa a coordenada da recomendação', async () => {
    comTerritorio();
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p.includes('/geocode')) throw new Error('geo falhou');
      return {};
    });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction('Ver no mapa');
    expect(await screen.findByTestId('map')).toBeInTheDocument();
    await waitFor(() => expect(m.get.mock.calls.some((c) => String(c[0]).includes('/geocode'))).toBe(true));
  });

  it('popup do mapa: traça rota e adiciona ao funil (mostra ✓ no funil)', async () => {
    comTerritorioPartida();
    mockFetch(okRoute);
    m.post.mockResolvedValueOnce({});
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    await screen.findByTestId('map');
    await userEvent.click(screen.getByRole('button', { name: /Traçar rota/ }));
    expect(await screen.findByText(/2\.0 km/, undefined, { timeout: 2000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Adicionar ao funil/ }));
    expect(await screen.findByText(/no funil/, undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('abre e fecha o modal de dados pelo botão do card', async () => {
    comTerritorio();
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByTitle('Ver dados da empresa')); // botão de olho (onView)
    expect(await screen.findByText('Dados da empresa')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Dados da empresa').closest('.fixed')!); // backdrop → onClose
    await waitFor(() => expect(screen.queryByText('Dados da empresa')).not.toBeInTheDocument());
  });
});

describe('Recommend — adicionar aos contatos', () => {
  const rep = { id: 5, nome: 'ACME', cnpj: null, segmento: null, site: null, contato: null, notas: null, ativo: true };

  // Detalhe da empresa com telefone + representadas, para o modal pré-preenchido.
  const withDetail = (over: { telefone1?: string | null; telefone2?: string | null } = {}): void => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p === '/api/represented') return { empresas: [rep] };
      if (/\/api\/companies\/\d+$/.test(p)) return { company: { id: 1, razao_social: 'Alvo', nome_fantasia: 'Loja Alvo', telefone1: over.telefone1 ?? null, telefone2: over.telefone2 ?? null } };
      if (p.includes('/geocode')) return { geocode: { lat: -23.5, lon: -46.6, precisao: 'rua' } };
      return {};
    });
  };

  it('pré-preenche nome + telefone da empresa e cria o contato', async () => {
    comTerritorio();
    withDetail({ telefone1: '4830001111' });
    m.post.mockResolvedValueOnce({ contact: { id: 9, nome: 'Loja Alvo' } });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction(/Adicionar aos contatos/);

    expect(await screen.findByText('Novo contato')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nome *')).toHaveValue('Loja Alvo');
    expect(screen.getByPlaceholderText('Telefone')).toHaveValue('(48) 3000-1111');
    // empresa vem vinculada como chip (não abre o buscador)
    expect(screen.getAllByText('Loja Alvo').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/contacts',
      expect.objectContaining({ nome: 'Loja Alvo', telefone: '(48) 3000-1111', company_id: 1 })));
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Contato criado.');
    // modal fecha após criar
    await waitFor(() => expect(screen.queryByText('Novo contato')).not.toBeInTheDocument());
  });

  it('sem telefone no cadastro abre o modal só com o nome; erro ao criar avisa', async () => {
    comTerritorio();
    withDetail(); // telefone1/2 null → sem telefone
    m.post.mockRejectedValueOnce(new Error('cc-fail'));
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction(/Adicionar aos contatos/);
    await screen.findByText('Novo contato');
    expect(screen.getByPlaceholderText('Telefone')).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('cc-fail'));
  });

  it('falha ao buscar o detalhe ainda abre o modal com nome + empresa', async () => {
    comTerritorio();
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/recommend')) return { results: [rec({})], page: { count: 1 } };
      if (p === '/api/municipios/ufs') return { ufs: [] };
      if (p === '/api/represented') return { empresas: [rep] };
      if (/\/api\/companies\/\d+$/.test(p)) throw new Error('detalhe falhou');
      return {};
    });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await clickCardAction(/Adicionar aos contatos/);
    await screen.findByText('Novo contato');
    expect(screen.getByPlaceholderText('Nome *')).toHaveValue('Loja Alvo');

    // fecha pelo Cancelar (onClose)
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Novo contato')).not.toBeInTheDocument());
  });

  it('também disponível no popup do mapa', async () => {
    comTerritorio();
    withDetail({ telefone1: '4830001111' });
    mount();
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    await screen.findByTestId('map');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar aos contatos/ }));
    expect(await screen.findByText('Novo contato')).toBeInTheDocument();
    // fecha pelo backdrop (onClose)
    await userEvent.click(screen.getByText('Novo contato').closest('.fixed')!);
    await waitFor(() => expect(screen.queryByText('Novo contato')).not.toBeInTheDocument());
  });
});
