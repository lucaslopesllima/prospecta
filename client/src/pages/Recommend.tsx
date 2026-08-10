import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
// CSS do Leaflet viaja junto com o chunk lazy da página (fora do bundle inicial).
import 'leaflet/dist/leaflet.css';
import { MapContainer, CircleMarker, Popup, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import { api, ApiError, BUSCA_DEBOUNCE_MS } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Recommendation, GeocodeResult, CompanyDetail, Municipio } from '../lib/types.ts';
import { Alert, Badge, Btn, Card, cn, Collapse, EmptyState, FilterPanel, PageHeader, Popover, SafeButton, ScoreBar, Segmented, Spinner, StatRow, useCollapseOnOutside, usePanels, type Tone } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { CompanyFilterBar, useCompanyFilter, faixasParams, faixasInvalidas } from '../lib/companyFilter.tsx';
import { CompanyModal } from '../lib/companyModal.tsx';
import { NewContactModal, EMPTY_CONTACT, type ContactForm } from '../lib/contactForm.tsx';
import { Cnae } from '../lib/cnae.tsx';
import { maskPhone } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { ThemedTileLayer } from '../lib/mapTiles.tsx';

const MATCH_COLOR: Record<string, string> = {
  classe: '#039855', divisao: '#0284c7', secao: '#12b76a', nenhum: '#94a3b8',
};
const MATCH_LABEL: Record<string, string> = {
  classe: 'CNAE exato', divisao: 'Mesma divisão', secao: 'Mesma seção', nenhum: 'Sem match',
};
const MATCH_TONE: Record<string, Tone> = {
  classe: 'success', divisao: 'info', secao: 'brand', nenhum: 'neutral',
};
function FitBounds({ pts, focus }: { pts: [number, number][]; focus: MapFocus | null }): null {
  const map = useMap();
  useEffect(() => {
    if (focus) return;  // com foco ativo, quem manda é o FlyTo
    if (pts.length > 0) map.fitBounds(pts as LatLngBoundsExpression, { padding: [40, 40], maxZoom: 13 });
  }, [pts, map, focus]);
  return null;
}

type MapFocus = { id: string; lat: number; lon: number };
type RouteInfo = { destId: string; origem: [number, number]; coords: [number, number][]; distKm: number; durMin: number };
type DistanceOrigin = { lat: number; lon: number; source: 'partida' | 'conta' | 'territorio' };

// Centraliza/zoom na empresa focada (botão "Ver no mapa").
function FlyTo({ focus }: { focus: MapFocus | null }): null {
  const map = useMap();
  useEffect(() => {
    if (focus) map.setView([focus.lat, focus.lon], 15, { animate: true });
  }, [focus, map]);
  return null;
}

// Enquadra a rota traçada (origem + destino).
function FitRoute({ coords }: { coords: [number, number][] }): null {
  const map = useMap();
  useEffect(() => {
    if (coords.length > 0) map.fitBounds(coords as LatLngBoundsExpression, { padding: [50, 50] });
  }, [coords, map]);
  return null;
}

type Ponto = { r: Recommendation; lat: number; lon: number; exato?: boolean };
type Cluster = { key: string; n: number; lat: number; lon: number };

// Acima deste nº de pontos, agrupa por célula de grade (~1/4 de tile no zoom
// atual) — centenas de CircleMarkers individuais pesam no DOM. Clique no
// cluster aproxima; ao dar zoom a grade refina e os grupos se abrem.
const CLUSTER_THRESHOLD = 150;

function RecMarkers({ pontos, focus, renderMarker }: {
  pontos: Ponto[]; focus: MapFocus | null; renderMarker: (p: Ponto) => React.JSX.Element;
}): React.JSX.Element {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });

  const { singles, clusters } = useMemo(() => {
    if (pontos.length <= CLUSTER_THRESHOLD) return { singles: pontos, clusters: [] as Cluster[] };
    const cell = 360 / Math.pow(2, zoom + 2);
    const buckets = new Map<string, Ponto[]>();
    const singles: Ponto[] = [];
    for (const p of pontos) {
      if (focus?.id === p.r.id) { singles.push(p); continue; } // foco nunca clusteriza
      const k = `${Math.floor(p.lat / cell)}:${Math.floor(p.lon / cell)}`;
      const b = buckets.get(k);
      if (b) b.push(p); else buckets.set(k, [p]);
    }
    const clusters: Cluster[] = [];
    for (const [key, b] of buckets) {
      if (b.length === 1) { singles.push(b[0]!); continue; }
      clusters.push({
        key, n: b.length,
        lat: b.reduce((s, p) => s + p.lat, 0) / b.length,
        lon: b.reduce((s, p) => s + p.lon, 0) / b.length,
      });
    }
    return { singles, clusters };
  }, [pontos, zoom, focus]);

  return (
    <>
      {singles.map(renderMarker)}
      {clusters.map((c) => (
        <CircleMarker key={`cluster:${c.key}`} center={[c.lat, c.lon]}
          radius={Math.min(20, 11 + Math.log2(c.n) * 1.5)}
          pathOptions={{ color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 0.8, weight: 2 }}
          eventHandlers={{ click: () => map.setView([c.lat, c.lon], Math.min(zoom + 2, 16)) }}>
          <Tooltip permanent direction="center"
            className="!rounded-full !border-0 !bg-transparent !p-0 !shadow-none text-xs font-bold !text-white">
            {c.n}
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

export function Recommend(): React.JSX.Element {
  const { can } = useAuth();
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [offset, setOffset] = useState(0);
  // total de empresas do perfil (capado no servidor — ver total_capped)
  const [total, setTotal] = useState<{ n: number; capped: boolean } | null>(null);
  const [done, setDone] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'lista' | 'mapa'>('lista');
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = useCompanyFilter('prospeccao');
  const panels = usePanels('prospeccao', filter.territorio.length === 0 ? 'filtros' : 'kpis');
  const filtersOpen = panels.aberto === 'filtros';
  const kpisOpen = panels.aberto === 'kpis';
  const setFiltersOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    const open = typeof next === 'function' ? next(filtersOpen) : next;
    if (open) panels.abrir('filtros'); else if (filtersOpen) panels.fechar();
  };
  const setKpisOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    const open = typeof next === 'function' ? next(kpisOpen) : next;
    if (open) panels.abrir('kpis'); else if (kpisOpen) panels.fechar();
  };
  const [viewing, setViewing] = useState<number | null>(null);
  const [addingContact, setAddingContact] = useState<ContactForm | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [distanceOrigin, setDistanceOrigin] = useState<DistanceOrigin | null>(null);
  const [routingId, setRoutingId] = useState<string | null>(null);
  const [geoCache, setGeoCache] = useState<Record<string, { lat: number; lon: number; precisao: string }>>({});
  const LIMIT = 20;

  // URL compartilhável: hidrata filtros uma vez e depois espelha mudanças sem
  // criar entradas extras no histórico. Município usa endpoint de labels para
  // recuperar nome/UF a partir dos ids do link.
  const [urlReady, setUrlReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const hydrate = async (): Promise<void> => {
      const q = searchParams.get('q');
      const cnae = searchParams.get('cnae');
      const porte = searchParams.get('porte');
      if (q !== null) filter.setFq(q);
      if (cnae !== null) filter.setFCnae(cnae);
      if (porte !== null) filter.setFPorte(porte);
      const faixa = { ...filter.faixas };
      if (searchParams.has('cap_min')) faixa.capMin = searchParams.get('cap_min') ?? '';
      if (searchParams.has('cap_max')) faixa.capMax = searchParams.get('cap_max') ?? '';
      if (searchParams.has('idade_min')) faixa.idadeMin = searchParams.get('idade_min') ?? '';
      if (searchParams.has('idade_max')) faixa.idadeMax = searchParams.get('idade_max') ?? '';
      filter.setFaixas(faixa);
      const peso = { ...filter.pesos };
      for (const k of ['cnae', 'proximidade', 'porte', 'capital', 'idade'] as const) {
        const raw = searchParams.get(`w_${k}`);
        if (raw !== null && Number.isFinite(Number(raw))) peso[k] = Math.max(0, Math.min(1, Number(raw)));
      }
      filter.setPesos(peso);
      const lat = Number(searchParams.get('partida_lat'));
      const lon = Number(searchParams.get('partida_lon'));
      const label = searchParams.get('partida');
      if (label && Number.isFinite(lat) && Number.isFinite(lon)) filter.setPartida({ label, lat, lon });
      if (searchParams.get('view') === 'mapa') setView('mapa');
      const ids = (searchParams.get('munis') ?? '').split(',').map(Number).filter(Number.isFinite);
      if (ids.length > 0) {
        const r = await api.get<{ municipios: Municipio[] }>(`/api/municipios/labels?ids=${ids.join(',')}`).catch(() => null);
        if (!cancelled && r?.municipios) filter.setTerritorio(r.municipios);
      }
      if (!cancelled) setUrlReady(true);
    };
    void hydrate();
    return () => { cancelled = true; };
    // Estado inicial da URL é intencionalmente lido uma vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const next = new URLSearchParams();
    if (filter.fq.trim()) next.set('q', filter.fq.trim());
    if (filter.fCnae.trim()) next.set('cnae', filter.fCnae.trim());
    if (filter.fPorte) next.set('porte', filter.fPorte);
    if (filter.territorio.length > 0) next.set('munis', filter.territorio.map((m) => m.id).join(','));
    for (const [k, v] of Object.entries(faixasParams(filter.faixas))) next.set(k, v);
    for (const k of ['cnae', 'proximidade', 'porte', 'capital', 'idade'] as const) next.set(`w_${k}`, String(filter.pesos[k]));
    if (filter.partida) {
      next.set('partida', filter.partida.label);
      next.set('partida_lat', String(filter.partida.lat));
      next.set('partida_lon', String(filter.partida.lon));
    }
    if (view === 'mapa') next.set('view', 'mapa');
    setSearchParams(next, { replace: true });
  }, [filter.fq, filter.fCnae, filter.fPorte, filter.territorio, filter.faixas,
    filter.pesos, filter.partida, view, setSearchParams, urlReady]);

  // Primeira visita: usa cidade cadastrada na conta como território inicial.
  // Executa uma vez; se não houver endereço, CTA do estado vazio assume.
  const suggestedTerritory = useRef(false);
  useEffect(() => {
    if (suggestedTerritory.current || filter.territorio.length > 0 || searchParams.has('munis')) return;
    suggestedTerritory.current = true;
    void api.get<{ org?: { cidade?: string | null; uf?: string | null } }>('/api/account')
      .then(async (account) => {
        const city = account.org?.cidade?.trim();
        if (!city) return;
        const result = await api.get<{ municipios: Municipio[] }>(`/api/municipios/search?q=${encodeURIComponent(city)}`);
        const exact = result.municipios.find((m) => m.nome.localeCompare(city, 'pt-BR', { sensitivity: 'base' }) === 0
          && (!account.org?.uf || m.uf === account.org.uf));
        if (exact) filter.setTerritorio([exact]);
      })
      .catch(() => undefined);
  }, [filter.territorio.length, searchParams]);

  // Clicar na lista/mapa (ou em qualquer lugar fora do painel) recolhe os filtros.
  const filtrosRef = useRef<HTMLDivElement>(null);
  useCollapseOnOutside(filtersOpen, () => setFiltersOpen(false), filtrosRef, '[data-filtros-toggle]');

  // Geocode sob demanda do endereço (lat/lon exato), cacheado no banco e em memória.
  // Fallback: a própria coord da recomendação (centroide do município).
  const geocodeRec = async (rec: Recommendation): Promise<{ lat: number; lon: number; precisao: string }> => {
    if (geoCache[rec.id]) return geoCache[rec.id]!;
    try {
      const r = await api.get<{ geocode: GeocodeResult }>(`/api/companies/${rec.id}/geocode`);
      const g = { lat: r.geocode.lat, lon: r.geocode.lon, precisao: r.geocode.precisao };
      setGeoCache((s) => ({ ...s, [rec.id]: g }));
      return g;
    } catch {
      return { lat: rec.lat, lon: rec.lon, precisao: 'municipio' };
    }
  };

  // Rota (OSRM público) da localização atual do rep até a empresa escolhida.
  const traceRoute = async (rec: Recommendation): Promise<void> => {
    if (rec.lat == null || rec.lon == null) { toast.error('Empresa sem localização geográfica.'); return; }
    setRoutingId(rec.id);
    try {
      // Origem devolvida pela busca = mesmo ponto usado na distância em linha
      // reta. Fallback abaixo mantém compatibilidade com respostas antigas.
      let o: { lat: number; lon: number } | null =
        distanceOrigin ?? (filter.partida ? { lat: filter.partida.lat, lon: filter.partida.lon } : null);
      if (!o) {
        try {
          const r = await api.get<{ origem: { lat: number; lon: number } | null }>('/api/account/origem');
          if (r.origem) o = { lat: r.origem.lat, lon: r.origem.lon };
        } catch { /* ignora, tenta fallback */ }
      }
      if (!o) {
        if (!navigator.geolocation) { toast.error('Cadastre seu endereço em Configurações (conta) para traçar rotas.'); return; }
        const pos = await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 }));
        o = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      }
      const d = await geocodeRec(rec); // destino exato (geocode do endereço)
      const url = `https://router.project-osrm.org/route/v1/driving/${o.lon},${o.lat};${d.lon},${d.lat}?overview=full&geometries=geojson`;
      const resp = await fetch(url);
      const j = await resp.json() as { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] };
      if (j.code !== 'Ok' || !j.routes?.length) { toast.error('Não foi possível traçar a rota.'); return; }
      const rt = j.routes[0]!;
      setRoute({
        destId: rec.id,
        origem: [o.lat, o.lon],
        coords: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
        distKm: rt.distance / 1000,
        durMin: rt.duration / 60,
      });
      setView('mapa');
      setFocus(null);
    } catch (e) {
      toast.error(e instanceof GeolocationPositionError ? 'Permissão de localização negada.' : 'Falha ao traçar rota.');
    } finally { setRoutingId(null); }
  };

  // O território é o critério obrigatório: ele delimita a varredura da base.
  // Sem município definido, a tela fica vazia e pede a configuração.
  const territorioIds = filter.territorio.map((m) => m.id);
  const semTerritorio = territorioIds.length === 0;
  // faixa mín > máx: a busca fica parada até o usuário ajustar (ver load()).
  const faixaRuim = faixasInvalidas(filter.faixas);
  // total de empresas que batem com o perfil. O servidor para de contar no teto
  // (10.000), então acima disso o número vira "10.000+" em vez de um valor exato.
  const totalLabel = total === null
    ? `${recs.length} empresa(s)`
    : `${total.n.toLocaleString('pt-BR')}${total.capped ? '+' : ''} empresa(s)`;

  // Aborta a busca anterior antes de disparar a próxima — sem isso uma resposta
  // lenta de filtro antigo pode sobrescrever a da busca atual (race).
  const loadCtl = useRef<AbortController | null>(null);
  const load = async (off: number): Promise<void> => {
    loadCtl.current?.abort();
    const ac = new AbortController();
    loadCtl.current = ac;
    setLoading(true);
    setErr('');
    try {
      const qs = new URLSearchParams({ limit: String(LIMIT), offset: String(off) });
      qs.set('munis', territorioIds.join(','));
      qs.set('w_cnae', String(filter.pesos.cnae));
      qs.set('w_prox', String(filter.pesos.proximidade));
      qs.set('w_porte', String(filter.pesos.porte));
      qs.set('w_capital', String(filter.pesos.capital));
      qs.set('w_idade', String(filter.pesos.idade));
      // faixas (capital social / tempo de vida): filtro duro no servidor
      for (const [k, v] of Object.entries(faixasParams(filter.faixas))) qs.set(k, v);
      if (filter.fq.trim()) qs.set('q', filter.fq.trim());
      if (filter.fCnae.trim()) qs.set('cnae', filter.fCnae.trim());
      if (filter.fPorte) qs.set('porte', filter.fPorte);
      if (filter.partida) { qs.set('partida_lat', String(filter.partida.lat)); qs.set('partida_lon', String(filter.partida.lon)); }
      const r = await api.get<{
        results: Recommendation[]; origin?: DistanceOrigin;
        page: { count: number; total: number; total_capped: boolean };
      }>(`/api/recommend?${qs.toString()}`, { signal: ac.signal });
      // total ausente (resposta antiga/parcial): cai no fallback do totalLabel.
      setTotal(typeof r.page?.total === 'number'
        ? { n: r.page.total, capped: !!r.page.total_capped } : null);
      setRecs((prev) => (off === 0 ? r.results : [...prev, ...r.results]));
      if (off === 0) setDistanceOrigin(r.origin ?? null);
      setDone(r.results.length < LIMIT);
      setOffset(off + r.results.length);
    } catch (e) {
      if (ac.signal.aborted) return; // busca substituída/página fechada — ignora
      setErr(e instanceof ApiError ? e.message : 'Erro ao buscar recomendações');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => () => loadCtl.current?.abort(), []);

  // recarrega do servidor (página 0) ao mudar qualquer filtro — busca na BASE TODA,
  // com debounce p/ não disparar a cada tecla. Roda também no mount.
  useEffect(() => {
    if (semTerritorio) {  // sem território -> tela vazia, sem consultar
      setRecs([]); setDone(true); setOffset(0); setErr(''); setTotal(null);
      setLoading(false); // sem isso o spinner inicial nunca dá lugar ao empty state
      return;
    }
    // faixa com mínimo > máximo: não consulta (o servidor devolveria lista vazia
    // e pareceria "nenhuma empresa" em vez de filtro mal preenchido). O aviso vai
    // no campo e na tarja acima da lista; aqui só segura a busca até o ajuste.
    if (faixaRuim) {
      loadCtl.current?.abort();
      setLoading(false);
      return;
    }
    const t = setTimeout(() => { void load(0); }, BUSCA_DEBOUNCE_MS);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [filter.fq, filter.fCnae, filter.fPorte, territorioIds.join(','),
    filter.pesos.cnae, filter.pesos.proximidade, filter.pesos.porte,
    filter.pesos.capital, filter.pesos.idade,
    filter.faixas.capMin, filter.faixas.capMax, filter.faixas.idadeMin, filter.faixas.idadeMax,
    filter.partida?.lat, filter.partida?.lon]);

  // Botão "Buscar" dispara a consulta na hora e devolve espaço aos resultados.
  // Sem território (ou com faixa invertida) não há o que buscar.
  const buscar = (): void => {
    if (semTerritorio || faixaRuim) return;
    setFiltersOpen(false);
    void load(0);
  };

  const copiarBusca = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link da busca copiado.');
    } catch {
      toast.error('Não foi possível copiar o link da busca.');
    }
  };

  // No mapa, plota só o que já está carregado na lista — sem auto-paginar.

  // Monta o contato-base da empresa (nome + telefone do cadastro). O telefone não
  // vem na recomendação — busca no detalhe (RFB); sem detalhe, fica só o nome.
  const companyContactForm = async (rec: Recommendation): Promise<ContactForm> => {
    const nome = rec.nome_fantasia || rec.razao_social;
    const base: ContactForm = { ...EMPTY_CONTACT, nome, company_id: Number(rec.id), company_name: nome };
    try {
      const r = await api.get<{ company: CompanyDetail }>(`/api/companies/${rec.id}`);
      const tel = r.company.telefone1 || r.company.telefone2;
      return tel ? { ...base, telefone: maskPhone(tel) } : base;
    } catch {
      return base;
    }
  };

  const addToFunnel = async (rec: Recommendation): Promise<void> => {
    try {
      await api.post('/api/relationships', { company_id: Number(rec.id) });
      setAdded((s) => new Set(s).add(rec.id));
      toast.success(`${rec.nome_fantasia || rec.razao_social} adicionada ao funil.`);
    } catch (e) {
      toast.error((e as Error).message || 'Não foi possível adicionar ao funil.');
    }
  };

  // Abre o cadastro de contato padrão pré-preenchido com os dados da empresa.
  const addToContacts = async (rec: Recommendation): Promise<void> => {
    setAddingContact(await companyContactForm(rec));
  };

  const verNoMapa = async (rec: Recommendation): Promise<void> => {
    if (rec.lat == null || rec.lon == null) { toast.error('Empresa sem localização geográfica.'); return; }
    setView('mapa');
    const g = await geocodeRec(rec); // pino exato (geocode do endereço)
    setFocus({ id: rec.id, lat: g.lat, lon: g.lon });
  };

  // server já filtrou — nada de filtro client-side aqui.
  const visibleRecs = recs;

  const center = useMemo<[number, number]>(() => {
    const first = visibleRecs.find((r) => r.lat && r.lon);
    return first ? [first.lat, first.lon] : [-15.78, -47.93];
  }, [visibleRecs]);

  // Empresas da mesma cidade compartilham o centroide do município (sem geocode de
  // rua), então empilham num ponto só. Espalha em espiral quem divide coordenada,
  // pra TODOS os pontos ficarem visíveis e clicáveis.
  const pontos = useMemo(() => {
    const out: { r: Recommendation; lat: number; lon: number; exato?: boolean }[] = [];
    const grupos = new Map<string, Recommendation[]>();
    for (const r of visibleRecs) {
      if (r.lat == null || r.lon == null) continue;
      const e = geoCache[r.id];
      if (e) { out.push({ r, lat: e.lat, lon: e.lon, exato: e.precisao !== 'municipio' }); continue; }
      const k = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
      const g = grupos.get(k);
      if (g) g.push(r); else grupos.set(k, [r]);
    }
    for (const g of grupos.values()) {
      if (g.length === 1) { out.push({ r: g[0], lat: g[0].lat, lon: g[0].lon }); continue; }
      g.forEach((r, i) => {
        const ang = i * 2.3999632;             // ângulo áureo (rad)
        const rad = 0.0012 * Math.sqrt(i);     // cresce p/ fora (~centenas de metros)
        out.push({ r, lat: r.lat + rad * Math.cos(ang), lon: r.lon + rad * Math.sin(ang) });
      });
    }
    return out;
  }, [visibleRecs, geoCache]);
  const bounds = useMemo(() => pontos.map((p) => [p.lat, p.lon] as [number, number]), [pontos]);

  // analytics KPIs derived from the visible (filtered) recommendations
  const kpi = useMemo(() => {
    const n = visibleRecs.length;
    const avg = n ? visibleRecs.reduce((s, r) => s + r.score, 0) / n : 0;
    const exact = visibleRecs.filter((r) => r.reason.cnae_match === 'classe').length;
    const dists = visibleRecs.filter((r) => r.reason.distancia_km != null).map((r) => r.reason.distancia_km);
    const near = dists.length ? Math.min(...dists) : 0;
    return { n, avg, exact, near };
  }, [visibleRecs]);

  if (err && recs.length === 0) {
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="warn" className="p-4">
          <p className="font-semibold">{err}</p>
          <button onClick={() => setFiltersOpen(true)}
            className="mt-2 inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300">
            Ajustar filtros da busca <Icon name="chevronRight" size={15} />
          </button>
        </Alert>
      </div>
    );
  }

  // Filtro e indicadores rolam JUNTO com a lista (ficam dentro do mesmo scroller,
  // logo abaixo do header) — antes viviam num bloco fixo acima e, abertos,
  // comiam a altura útil da lista de forma permanente. Só o header fica fixo.
  const painelLista = (
    <div className="space-y-4">
      {faixaRuim && (
        <Alert tone="warn" className="flex-wrap items-center py-2">
          <span>Busca pausada: o valor inicial de uma faixa está maior que o limite.</span>
          {!filtersOpen && (
            <button onClick={() => setFiltersOpen(true)} className="font-semibold text-brand-700 hover:underline">
              Abrir filtros
            </button>
          )}
        </Alert>
      )}
      {/* Desktop: acordeão inline. Celular: folha pelo rodapé — o painel cobre a
          lista em vez de empurrá-la, e o rodapé conta os resultados ao vivo. */}
      <FilterPanel open={filtersOpen} onClose={() => setFiltersOpen(false)} onLimpar={filter.limpar}
        titulo="Filtros da busca"
        acao={{ label: `Ver ${recs.length} empresa(s)`, onClick: buscar, disabled: semTerritorio || faixaRuim }}>
        <div ref={filtrosRef}>
          <CompanyFilterBar f={filter} recommend buscando={loading} onBuscar={buscar} />
        </div>
      </FilterPanel>

      <Collapse open={kpisOpen} duration={200}>
        {/* `sub` diz "nos N carregados" porque o kpi deriva de visibleRecs — a
            página já buscada, não o total da busca. Sem isso o score médio muda
            a cada "Carregar mais" e parece estatística do resultado inteiro. */}
        <StatRow items={[
          { label: filter.filtroAtivo ? 'Resultados (filtrados)' : 'Recomendações', value: kpi.n, icon: 'building', tone: 'brand' },
          { label: 'Score médio', value: (kpi.avg * 100).toFixed(0), sub: `de 100 · nos ${kpi.n} carregados`, icon: 'trendingUp', tone: 'success' },
          { label: 'CNAE exato', value: kpi.exact, sub: 'match de classe', icon: 'target', tone: 'info' },
          { label: 'Mais próxima', value: `${kpi.near.toFixed(0)} km`, sub: 'em linha reta', icon: 'mapPin', tone: 'warn' },
        ]} />
      </Collapse>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="p-4 pb-0 sm:p-6 sm:pb-0">
        <PageHeader
          title="Empresas recomendadas"
          subtitle={semTerritorio
            ? 'Defina o território nos filtros para buscar empresas'
            : `${recs.length} de ${totalLabel} · ranqueados por fit`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {view === 'lista' && (
                <Btn variant={filter.filtroAtivo ? 'primary' : 'soft'} icon="search"
                  data-filtros-toggle
                  aria-expanded={filtersOpen} title={filtersOpen ? 'Recolher filtros' : 'Expandir filtros'}
                  onClick={() => setFiltersOpen((v) => !v)}>
                  Filtros
                  <Icon name="chevronRight" size={15}
                    className={cn('transition-transform duration-300 ease-out', filtersOpen ? 'rotate-90' : 'rotate-0')} />
                </Btn>
              )}
              {view === 'lista' && (
                <Btn variant="soft" icon="trendingUp"
                  aria-expanded={kpisOpen} title={kpisOpen ? 'Recolher indicadores' : 'Expandir indicadores'}
                  onClick={() => setKpisOpen((v) => !v)}>
                  Indicadores
                  <Icon name="chevronRight" size={15}
                    className={cn('transition-transform duration-300 ease-out', kpisOpen ? 'rotate-90' : 'rotate-0')} />
                </Btn>
              )}
              <Btn variant="ghost" icon="link" title="Copiar link desta busca" onClick={copiarBusca}>
                Compartilhar
              </Btn>
              <Segmented value={view} onChange={(v) => { setFocus(null); setView(v); }} options={[
                { value: 'lista', label: 'Lista', icon: 'list' },
                { value: 'mapa', label: 'Mapa', icon: 'map' },
              ]} />
            </div>
          }
        />

      </div>

      {view === 'mapa' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 pt-4 sm:px-6 sm:pb-6">
          {!done && !semTerritorio && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-800">
              <Icon name="info" size={15} className="shrink-0" />
              <span className="flex-1">
                Mapa exibindo {recs.length} de {totalLabel}. Carregue mais para ampliar a cobertura.
              </span>
              <Btn size="sm" variant="soft" disabled={loading} onClick={() => load(offset)}>
                {loading ? 'Carregando…' : 'Carregar mais pontos'}
              </Btn>
            </div>
          )}
          {route && (
            <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
              <Icon name="map" size={16} className="text-blue-600" />
              <span className="font-semibold text-blue-900">{route.distKm.toFixed(1)} km de carro</span>
              <span className="text-blue-700">· ~{Math.round(route.durMin)} min</span>
              <button onClick={() => setRoute(null)} className="ml-auto text-xs font-semibold text-blue-700 underline">Limpar rota</button>
            </div>
          )}
          <Card className="min-h-0 flex-1 overflow-hidden p-0">
            <MapContainer center={center} zoom={11} className="h-full w-full" scrollWheelZoom>
              <ThemedTileLayer />
              <FitBounds pts={bounds} focus={focus} />
              <FlyTo focus={focus} />
              <RecMarkers pontos={pontos} focus={focus} renderMarker={({ r, lat, lon }) => {
                const isFocus = focus?.id === r.id;
                return (
                <CircleMarker key={r.id} center={[lat, lon]} radius={isFocus ? 11 : 7}
                  ref={isFocus ? (m) => { m?.openPopup(); } : undefined}
                  pathOptions={{ color: isFocus ? '#dc2626' : MATCH_COLOR[r.reason.cnae_match],
                    weight: isFocus ? 3 : 1, fillOpacity: isFocus ? 0.9 : 0.7 }}>
                  <Popup minWidth={220} maxWidth={260}>
                    {/* Sem flex-nowrap: são até 4 ações e em uma linha só elas
                        estouravam a largura do balão do Leaflet. Cada ação
                        continua sem quebrar no meio (whitespace-nowrap). */}
                    <div className="max-w-full space-y-1">
                      <p className="break-words font-semibold">{r.razao_social}</p>
                      <p className="text-xs">Score {(r.score * 100).toFixed(0)} · {r.reason.distancia_km} km em linha reta</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                        <button onClick={() => setViewing(Number(r.id))} className="whitespace-nowrap text-xs font-semibold text-brand-700 underline dark:text-brand-300">Ver dados da empresa</button>
                        {added.has(r.id)
                          ? <span className="whitespace-nowrap text-xs text-emerald-600 dark:text-emerald-300">✓ no funil</span>
                          : can('relationships.create') && <SafeButton onClick={() => addToFunnel(r)} className="whitespace-nowrap text-xs font-semibold text-brand-700 underline dark:text-brand-300">+ Adicionar ao funil</SafeButton>}
                        {can('contacts.create') && <SafeButton onClick={() => addToContacts(r)} className="whitespace-nowrap text-xs font-semibold text-brand-700 underline dark:text-brand-300">+ Adicionar aos contatos</SafeButton>}
                        <SafeButton onClick={() => traceRoute(r)} disabled={routingId === r.id}
                          className="whitespace-nowrap text-xs font-semibold text-blue-700 underline disabled:opacity-50 dark:text-blue-300">
                          {routingId === r.id ? 'Traçando…' : 'Traçar rota'}
                        </SafeButton>
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
                );
              }} />
              {route && (
                <>
                  <Polyline positions={route.coords} pathOptions={{ color: '#2563eb', weight: 5, opacity: 0.8 }} />
                  <CircleMarker center={route.origem} radius={7} pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 1 }}>
                    <Popup>Origem da rota</Popup>
                  </CircleMarker>
                  <FitRoute coords={route.coords} />
                </>
              )}
            </MapContainer>
          </Card>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-4 pt-4 sm:px-6 sm:pb-6">
          {painelLista}
          {visibleRecs.map((r) => (
            <RecCard key={r.id} rec={r} added={added.has(r.id)} onAdd={() => addToFunnel(r)}
              onAddContact={() => addToContacts(r)}
              onView={() => setViewing(Number(r.id))} onViewMap={() => verNoMapa(r)}
              onRoute={() => traceRoute(r)} routing={routingId === r.id} />
          ))}
          {/* visibleRecs é alias de recs — condição sempre falsa (sem filtro client-side). Inalcançável. */}
          {/* v8 ignore next 3 */}
          {!loading && recs.length > 0 && visibleRecs.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-400">Nenhuma recomendação bate com os filtros.</p>
          )}
          {loading && <Spinner />}
          {!loading && !done && !semTerritorio && (
            <Btn variant="ghost" onClick={() => load(offset)}
              className="w-full border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50">
              Carregar mais
            </Btn>
          )}
          {recs.length === 0 && !loading && (semTerritorio
            ? <EmptyState icon="mapPin" title="Defina o território"
                hint="Selecione municípios ou um estado inteiro para buscar empresas."
                action={<Btn icon="mapPin" onClick={() => setFiltersOpen(true)}>Definir território</Btn>} />
            : <EmptyState icon="building" title="Nenhuma empresa encontrada"
                hint="Nenhuma empresa bate com os filtros aplicados. Ajuste os critérios." />)}
        </div>
      )}

      {viewing !== null && <CompanyModal companyId={viewing} onClose={() => setViewing(null)} />}
      {addingContact && <NewContactModal initial={addingContact} onClose={() => setAddingContact(null)} />}
    </div>
  );
}

function RecCard({ rec, added, onAdd, onAddContact, onView, onViewMap, onRoute, routing }: { rec: Recommendation; added: boolean; onAdd: () => void; onAddContact: () => void; onView: () => void; onViewMap: () => void; onRoute: () => void; routing: boolean }): React.JSX.Element {
  const { can } = useAuth();
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const c = rec.reason.componentes;
  const score = rec.score * 100;
  const hasLocation = rec.lat != null && rec.lon != null;
  const hasSecondary = can('contacts.create') || hasLocation;
  return (
    <Card className="p-4 transition-shadow hover:shadow-pop">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-500">
            <Icon name="building" size={20} />
          </span>
          <div className="min-w-0">
            <button type="button" onClick={onView} title="Ver dados da empresa" aria-label="Ver dados da empresa"
              className="block max-w-full truncate text-left font-semibold text-ink-900 transition-colors hover:text-brand-600 hover:underline">
              {rec.nome_fantasia || rec.razao_social}
            </button>
            <p className="truncate text-xs text-ink-400">{rec.razao_social} · {rec.uf}</p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('tabnums text-xl font-bold', score >= 70 ? 'text-emerald-600' : score >= 40 ? 'text-brand-600' : 'text-ink-500')}>
            {score.toFixed(0)}
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">score</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone={MATCH_TONE[rec.reason.cnae_match]}>{MATCH_LABEL[rec.reason.cnae_match]}</Badge>
        <Badge tone="neutral"><Cnae code={rec.cnae_principal} /></Badge>
        <Badge tone="neutral"><Icon name="mapPin" size={12} />{rec.reason.distancia_km} km em linha reta</Badge>
        <Badge tone="neutral">porte {rec.reason.porte}</Badge>
        {rec.reason.idade_anos != null && (
          <Badge tone="neutral">{Math.floor(rec.reason.idade_anos)} anos</Badge>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <ScoreBar label="CNAE" value={c.cnae} />
        <ScoreBar label="Prox." value={c.proximidade} />
        <ScoreBar label="Porte" value={c.porte} />
        <ScoreBar label="Capital" value={c.capital} />
        <ScoreBar label="Idade" value={c.idade} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {added
          ? <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600"><Icon name="check" size={16} /> Adicionado ao funil</span>
          : can('relationships.create') && <Btn size="sm" icon="plus" onClick={onAdd}>Adicionar ao funil</Btn>}
        {hasSecondary && (
          <>
            <button ref={actionsRef} type="button" onClick={() => setActionsOpen((v) => !v)}
              aria-label="Mais ações" aria-haspopup="menu" aria-expanded={actionsOpen}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-ink-600 transition hover:bg-ink-100 sm:min-h-8">
              <Icon name="moreHorizontal" size={17} /> Mais ações
            </button>
            <Popover open={actionsOpen} anchorRef={actionsRef} onClose={() => setActionsOpen(false)} width={220} align="left">
              {can('contacts.create') && (
                <SafeButton onClick={() => { setActionsOpen(false); return onAddContact(); }} role="menuitem"
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-ink-700 hover:bg-ink-50">
                  <Icon name="users" size={16} /> Adicionar aos contatos
                </SafeButton>
              )}
              {hasLocation && (
                <SafeButton onClick={() => { setActionsOpen(false); return onViewMap(); }} role="menuitem"
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-ink-700 hover:bg-ink-50">
                  <Icon name="map" size={16} /> Ver no mapa
                </SafeButton>
              )}
              {hasLocation && (
                <SafeButton onClick={() => { setActionsOpen(false); return onRoute(); }} role="menuitem" disabled={routing}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-50">
                  <Icon name="route" size={16} /> {routing ? 'Traçando…' : 'Rota'}
                </SafeButton>
              )}
            </Popover>
          </>
        )}
      </div>
    </Card>
  );
}
