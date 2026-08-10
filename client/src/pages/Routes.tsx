import { useEffect, useMemo, useState } from 'react';
// CSS do Leaflet viaja junto com o chunk lazy da página (fora do bundle inicial).
import 'leaflet/dist/leaflet.css';
import { MapContainer, CircleMarker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import { api, ApiError } from '../lib/api.ts';
import type { FunnelCompany, Vehicle, OptimizeResult, RouteStop, SavedRoute } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, Modal, PageHeader, SafeButton, Segmented, Spinner, StatRow } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { brl, maskPlaca, maskMoney, clampNum } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { loadPartida, type Partida } from '../lib/companyFilter.tsx';
import { useAuth } from '../lib/auth.tsx';
import { confirmDialog } from '../lib/confirm.ts';
import { ThemedTileLayer } from '../lib/mapTiles.tsx';

// Navega até um ponto único. Origem omitida de propósito → no celular o Maps usa
// o GPS atual como ponto de partida; no desktop abre a aba com o destino.
const navTo = (lat: number, lon: number): void => {
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`, '_blank', 'noopener');
};

// Modal genérico de entrada — substitui window.prompt nativo nas rotas (nome,
// data, valor de despesa). Prefill visível, validação e visual da app.
type PromptKind = 'text' | 'date' | 'decimal';
interface PromptState { title: string; label: string; kind: PromptKind; initial: string; confirmLabel: string; placeholder?: string; onConfirm: (v: string) => void }

function PromptModal({ state, onClose }: { state: PromptState; onClose: () => void }): React.JSX.Element {
  const [val, setVal] = useState(state.initial);
  const submit = (e: React.FormEvent): void => { e.preventDefault(); onClose(); state.onConfirm(val); };
  return (
    <Modal onClose={onClose} width="sm">
      <h3 className="mb-3 text-sm font-bold text-ink-900">{state.title}</h3>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-600">{state.label}</span>
          <input autoFocus value={val} onChange={(e) => setVal(state.kind === 'decimal' ? maskMoney(e.target.value) : e.target.value)}
            type={state.kind === 'date' ? 'date' : 'text'}
            inputMode={state.kind === 'decimal' ? 'decimal' : undefined}
            maxLength={state.kind === 'decimal' ? undefined : 120}
            placeholder={state.placeholder}
            className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200" />
        </label>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit">{state.confirmLabel}</Btn>
        </div>
      </form>
    </Modal>
  );
}

const km = (n: number | null): string => (n == null ? '—' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`);
const dur = (min: number | null): string => {
  if (min == null) return '—';
  const h = Math.floor(min / 60); const m = Math.round(min % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
};
const FUEL_LABEL: Record<Vehicle['combustivel'], string> = {
  gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel', flex: 'Flex',
};

function FitAll({ pts }: { pts: [number, number][] }): null {
  const map = useMap();
  useEffect(() => {
    if (pts.length > 0) map.fitBounds(pts as LatLngBoundsExpression, { padding: [40, 40], maxZoom: 14 });
  }, [pts, map]);
  return null;
}

/* ───────────────────────── Planejar ───────────────────────── */
function Planner({ vehicles }: { vehicles: Vehicle[] }): React.JSX.Element {
  const { can } = useAuth();
  const [funnel, setFunnel] = useState<FunnelCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [vehicleId, setVehicleId] = useState<number | ''>('');
  const [preco, setPreco] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [saved, setSaved] = useState<SavedRoute[]>([]);
  const [partida, setPartida] = useState<Partida | null>(loadPartida());
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const nomePadraoData = (): string => new Date().toLocaleDateString('pt-BR');
  const hojeIso = (): string => new Date().toISOString().slice(0, 10);

  const reloadSaved = (): void => {
    void api.get<{ routes: SavedRoute[] }>('/api/routes').then((r) => setSaved(r.routes)).catch(() => undefined);
  };

  useEffect(() => {
    void api.get<{ relationships: FunnelCompany[] }>('/api/relationships?limit=200')
      .then((r) => setFunnel(r.relationships))
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Erro ao carregar funil'))
      .finally(() => setLoading(false));
    reloadSaved();
  }, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return funnel;
    return funnel.filter((c) => `${c.razao_social} ${c.nome_fantasia ?? ''}`.toLowerCase().includes(t));
  }, [funnel, q]);

  const toggle = (companyId: number): void => {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(companyId)) n.delete(companyId); else n.add(companyId);
      return n;
    });
  };

  const optimize = async (): Promise<void> => {
    if (sel.size < 1) return;
    setBusy(true); setErr(''); setResult(null); setOpenedId(null);
    try {
      const body = {
        company_ids: [...sel],
        vehicle_id: vehicleId === '' ? null : vehicleId,
        preco_litro: preco.trim() ? Number(preco.replace(',', '.')) : null,
        origem_lat: partida?.lat ?? null,
        origem_lon: partida?.lon ?? null,
      };
      const r = await api.post<OptimizeResult>('/api/routes/optimize', body);
      setResult(r);
      if (r.skipped.length > 0) {
        const nomes = r.skipped
          // skipped vem do body coagido pelo schema Fastify (number); funnel traz
          // company_id string (bigint) — sem coagir, nenhum nome é resolvido.
          .map((id) => { const c = funnel.find((x) => Number(x.company_id) === Number(id)); return c ? (c.nome_fantasia || c.razao_social) : null; })
          .filter(Boolean);
        setErr(`Sem localização, ignorada(s): ${nomes.length ? nomes.join(', ') : `${r.skipped.length} empresa(s)`}.`);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Falha ao calcular a rota.');
    } finally { setBusy(false); }
  };

  const save = (): void => {
    if (!result) return;
    setPrompt({
      title: 'Salvar rota', label: 'Nome da rota', kind: 'text', confirmLabel: 'Salvar',
      initial: `Rota ${nomePadraoData()}`,
      onConfirm: (nome) => { if (nome.trim()) void doSave(nome.trim()); },
    });
  };
  const doSave = async (nome: string): Promise<void> => {
    if (!result) return;
    setBusy(true); setErr('');
    try {
      await api.post('/api/routes', {
        nome,
        vehicle_id: vehicleId === '' ? null : vehicleId,
        origem_lat: result.origem.lat, origem_lon: result.origem.lon,
        dist_km: result.dist_km, dur_min: result.dur_min,
        preco_litro: result.preco_litro, litros: result.litros, custo_total: result.custo_total,
        geometry: result.geometry,
        stops: result.stops.map((s) => ({
          company_id: s.company_id, seq: s.seq, lat: s.lat, lon: s.lon,
          leg_dist_km: s.leg_dist_km, leg_dur_min: s.leg_dur_min,
        })),
      });
      reloadSaved();
      toast.success('Rota salva.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao salvar a rota.');
    } finally { setBusy(false); }
  };

  const delSaved = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir esta rota?'))) return;
    try { await api.del(`/api/routes/${id}`); toast.success('Rota excluída.'); }
    catch { toast.error('Não foi possível excluir a rota.'); }
    reloadSaved();
  };

  // Fase 5.3 — reusar: re-otimiza as paradas (empresas podem ter mudado) e
  // salva uma rota nova.
  const reuse = (r: SavedRoute): void => {
    setPrompt({
      title: 'Reusar rota', label: 'Nome da nova rota', kind: 'text', confirmLabel: 'Reusar',
      initial: `${r.nome} (${nomePadraoData()})`,
      onConfirm: (nome) => { if (nome.trim()) void doReuse(r, nome.trim()); },
    });
  };
  const doReuse = async (r: SavedRoute, nome: string): Promise<void> => {
    try {
      const out = await api.post<{ skipped: number[] }>(`/api/routes/${r.id}/reuse`, { nome });
      reloadSaved();
      toast.success(out.skipped.length
        ? `Rota criada — ${out.skipped.length} empresa(s) sem localização ignorada(s).`
        : 'Rota criada.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao reusar a rota.');
    }
  };

  // Abre uma rota salva no mapa (igual ao Otimizar): busca o detalhe (origem +
  // geometria + paradas) e popula `result`. Valores numéricos vêm string do pg.
  const openSaved = async (r: SavedRoute): Promise<void> => {
    setBusy(true); setErr(''); setOpenedId(r.id);
    const num = (v: unknown): number => Number(v ?? 0);
    const numN = (v: unknown): number | null => (v == null ? null : Number(v));
    try {
      const { route, stops } = await api.get<{ route: Record<string, unknown>; stops: RouteStop[] }>(`/api/routes/${r.id}`);
      setResult({
        origem: { lat: num(route.origem_lat), lon: num(route.origem_lon) },
        stops: stops.map((s) => ({
          ...s, lat: num(s.lat), lon: num(s.lon),
          leg_dist_km: numN(s.leg_dist_km), leg_dur_min: numN(s.leg_dur_min),
        })),
        dist_km: num(route.dist_km), dur_min: num(route.dur_min),
        preco_litro: numN(route.preco_litro), litros: numN(route.litros), custo_total: numN(route.custo_total),
        geometry: (route.geometry as OptimizeResult['geometry']) ?? { coordinates: [] },
        skipped: [],
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Falha ao abrir a rota.');
    } finally { setBusy(false); }
  };

  // Marca/desmarca como template (rota recorrente reutilizável). O PATCH já
  // devolve a rota atualizada — aplica no estado local em vez de refazer o GET
  // da lista inteira.
  const toggleTemplate = async (r: SavedRoute): Promise<void> => {
    try {
      const out = await api.patch<{ route?: Pick<SavedRoute, 'template'> }>(
        `/api/routes/${r.id}`, { template: !r.template });
      const next = out.route?.template ?? !r.template;
      setSaved((list) => list.map((x) => (x.id === r.id ? { ...x, template: next } : x)));
    } catch { /* falha: mantém o estado atual */ }
  };

  // Fase 5.2 inverso — cria um compromisso de visita por parada.
  const agendar = (r: SavedRoute): void => {
    setPrompt({
      title: 'Agendar visitas', label: 'Data da rota', kind: 'date', confirmLabel: 'Criar compromissos',
      initial: hojeIso(),
      onConfirm: (d) => { if (d) void doAgendar(r, d); },
    });
  };
  const doAgendar = async (r: SavedRoute, d: string): Promise<void> => {
    try {
      const out = await api.post<{ created: number }>(`/api/routes/${r.id}/agenda`, { start_at: `${d}T08:00:00` });
      toast.success(`${out.created} compromisso(s) criado(s) na Agenda.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao criar compromissos.');
    }
  };

  // Fase 6.1 — lança a despesa de viagem (combustível) da rota no financeiro.
  const lancarCusto = (r: SavedRoute): void => {
    setPrompt({
      title: 'Lançar despesa de viagem', label: 'Valor (R$)', kind: 'decimal', confirmLabel: 'Lançar no Financeiro',
      initial: r.custo_total != null ? String(Number(r.custo_total)) : '', placeholder: 'ex.: 120,00',
      onConfirm: (raw) => void doLancarCusto(r, raw),
    });
  };
  const doLancarCusto = async (r: SavedRoute, raw: string): Promise<void> => {
    const valor = raw.trim() === '' ? undefined : clampNum(raw, 0, 1e9);
    try {
      await api.post(`/api/routes/${r.id}/expense`, valor != null ? { valor } : {});
      toast.success('Despesa de viagem lançada no Financeiro.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao lançar a despesa.');
    }
  };

  const mapPts: [number, number][] = result
    ? [[result.origem.lat, result.origem.lon], ...result.stops.map((s) => [s.lat, s.lon] as [number, number])]
    : [];

  if (loading) return <Spinner label="Carregando funil…" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      {/* coluna esquerda: seleção */}
      <div className="flex flex-col gap-3">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-ink-700">Empresas do funil</p>
            <Badge tone={sel.size ? 'brand' : 'neutral'}>{sel.size} selecionada(s)</Badge>
          </div>
          <div className="relative mb-2">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"><Icon name="search" size={15} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar empresa…" maxLength={120}
              className="w-full rounded-xl border border-ink-200 bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-400" />
          </div>
          <div className="max-h-[42vh] space-y-1 overflow-auto pr-1">
            {filtered.length === 0 && <p className="px-1 py-4 text-center text-xs text-ink-400">Nenhuma empresa no funil.</p>}
            {filtered.map((c) => {
              const checked = sel.has(c.company_id);
              const semGeo = c.lat == null && c.lon == null;
              return (
                <button key={c.id} onClick={() => toggle(c.company_id)}
                  className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors',
                    checked ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-ink-50')}>
                  <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border',
                    checked ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300')}>
                    {checked && <Icon name="check" size={11} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-800">{c.nome_fantasia || c.razao_social}</span>
                    <span className="block truncate text-[11px] text-ink-400">{c.uf}{semGeo && ' · sem localização'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="space-y-3 p-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Veículo</label>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm outline-none focus:border-brand-400">
              <option value="">Sem veículo (só distância)</option>
              {vehicles.filter((v) => v.ativo).map((v) => (
                <option key={v.id} value={v.id}>{v.nome} · {Number(v.consumo_kml)} km/l</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Preço do litro (R$) — opcional</label>
            <input value={preco} onChange={(e) => setPreco(maskMoney(e.target.value))} inputMode="decimal" placeholder="ex.: 6,19"
              className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm outline-none focus:border-brand-400" />
            <p className="mt-1 text-[11px] text-ink-400">Vazio usa o preço cadastrado no veículo.</p>
          </div>
          <div className="rounded-xl bg-ink-50 px-3 py-2 text-[11px] text-ink-500 dark:bg-ink-800/40">
            <span className="font-semibold text-ink-600">Partida: </span>
            {partida ? (
              <>
                <span className="text-ink-700">{partida.label}</span>
                <button onClick={() => setPartida(null)} className="ml-1.5 font-semibold text-brand-600 hover:underline">usar conta</button>
              </>
            ) : (
              <span>endereço da conta · defina um endereço de partida nos filtros da Prospecção</span>
            )}
          </div>
          {can('routes.optimize') && (
            <Btn icon="route" onClick={() => optimize()} disabled={busy || sel.size < 1} className="w-full">
              {busy ? 'Calculando…' : 'Otimizar rota'}
            </Btn>
          )}
          {err && <p className="text-xs text-amber-600">{err}</p>}
        </Card>
      </div>

      {/* coluna direita: resultado */}
      <div className="flex flex-col gap-4">
        {!result ? (
          <Card className="grid min-h-[300px] place-items-center p-6">
            <EmptyState icon="route" title="Monte uma rota"
              hint="Selecione empresas do funil e clique em Otimizar para ver a melhor sequência de visitas." />
          </Card>
        ) : (
          <>
            <StatRow items={[
              { icon: 'route', label: 'Distância', value: km(result.dist_km), sub: 'ida e volta' },
              { icon: 'calendar', label: 'Duração', value: dur(result.dur_min), tone: 'info' },
              { icon: 'fuel', label: 'Combustível', value: result.litros != null ? `${result.litros.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} L` : '—', tone: 'warn' },
              { icon: 'wallet', label: 'Custo estimado', value: result.custo_total != null ? brl(result.custo_total) : '—', tone: 'success' },
            ]} />

            <Card className="overflow-hidden p-0">
              <div className="h-[320px] w-full">
                <MapContainer center={[result.origem.lat, result.origem.lon]} zoom={11} className="h-full w-full" scrollWheelZoom>
                  <ThemedTileLayer />
                  <FitAll pts={mapPts} />
                  {/* traçado em Signal Orange (acento da marca) p/ separar do
                      azul dos marcadores numerados. */}
                  <Polyline positions={result.geometry.coordinates} pathOptions={{ color: '#ff6a2b', weight: 4, opacity: 0.85 }} />
                  <CircleMarker center={[result.origem.lat, result.origem.lon]} radius={9} pathOptions={{ color: '#fff', weight: 2, fillColor: '#111827', fillOpacity: 1 }}>
                    <Tooltip permanent direction="center" className="!bg-transparent !border-0 !shadow-none !p-0 !text-[10px] !font-bold !text-white">●</Tooltip>
                  </CircleMarker>
                  {result.stops.map((s) => (
                    <CircleMarker key={s.company_id} center={[s.lat, s.lon]} radius={11}
                      pathOptions={{ color: '#fff', weight: 2, fillColor: '#2448bc', fillOpacity: 1 }}>
                      <Tooltip permanent direction="center" className="!bg-transparent !border-0 !shadow-none !p-0 !text-[11px] !font-bold !text-white">{s.seq + 1}</Tooltip>
                      <Popup>
                        <span className="block text-sm font-semibold text-ink-800">{s.seq + 1}. {s.nome_fantasia || s.razao_social}</span>
                        <span className="mb-1.5 block text-xs text-ink-500">{[s.cidade, s.uf].filter(Boolean).join(' · ')}</span>
                        <button onClick={() => navTo(s.lat, s.lon)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline">
                          <Icon name="mapPin" size={13} /> Navegar até aqui
                        </button>
                      </Popup>
                    </CircleMarker>
                  ))}
                </MapContainer>
              </div>
              <div className="flex items-center gap-4 border-t border-ink-100 px-4 py-2 text-[11px] text-ink-500">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-ink-900" /> Origem</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-600" /> Paradas (na ordem 1, 2, 3…)</span>
              </div>
            </Card>

            <Card className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
                <p className="text-sm font-semibold text-ink-700">Sequência de visitas</p>
                <div className="flex items-center gap-2">
                  {/* URL universal do Google Maps: no celular abre o app; no desktop, nova aba.
                      Round trip — volta à origem (ida e volta). */}
                  <Btn size="sm" variant="soft" icon="mapPin" onClick={() => {
                    const o = `${result.origem.lat},${result.origem.lon}`;
                    const wp = result.stops.map((s) => `${s.lat},${s.lon}`).join('|');
                    window.open(`https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${o}&waypoints=${encodeURIComponent(wp)}&travelmode=driving`, '_blank', 'noopener');
                  }}>Usar rota</Btn>
                  {can('routes.create') && (
                    <Btn size="sm" icon="check" onClick={() => void save()} disabled={busy}>Salvar rota</Btn>
                  )}
                </div>
              </div>
              <ol className="divide-y divide-ink-100">
                {result.stops.map((s) => (
                  <li key={s.company_id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">{s.seq + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-800">{s.nome_fantasia || s.razao_social}</span>
                      <span className="block truncate text-[11px] text-ink-400">{[s.cidade, s.uf].filter(Boolean).join(' · ')}</span>
                    </span>
                    {s.leg_dist_km != null && <span className="shrink-0 text-[11px] tabular-nums text-ink-400">+{km(s.leg_dist_km)}</span>}
                    <button onClick={() => navTo(s.lat, s.lon)} title="Navegar até esta parada"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-500/15">
                      <Icon name="mapPin" size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            </Card>
          </>
        )}

        {saved.length > 0 && (
          <Card className="p-0">
            <p className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-700">Rotas salvas</p>
            <ul className="divide-y divide-ink-100">
              {saved.map((r) => (
                <li key={r.id} className={cn('flex items-center gap-2 px-4 py-2.5', openedId === r.id && 'bg-brand-50 dark:bg-brand-500/15')}>
                  <SafeButton onClick={() => openSaved(r)} title="Abrir no mapa" className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"><Icon name="route" size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink-800">{r.nome}</span>
                        {r.template && <Badge tone="brand">Template</Badge>}
                      </span>
                      <span className="block truncate text-[11px] text-ink-400">
                        {r.paradas} parada(s) · {km(r.dist_km != null ? Number(r.dist_km) : null)}
                        {r.custo_total != null && ` · ${brl(Number(r.custo_total))}`}
                        {r.veiculo && ` · ${r.veiculo}`}
                      </span>
                    </span>
                  </SafeButton>
                  {can('routes.agenda') && (
                    <button onClick={() => void agendar(r)} aria-label="Criar compromissos" title="Criar compromissos na Agenda"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600">
                      <Icon name="calendar" size={15} />
                    </button>
                  )}
                  {can('routes.reuse') && (
                    <button onClick={() => void reuse(r)} aria-label="Reusar rota" title="Reusar (re-otimizar)"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600">
                      <Icon name="compass" size={15} />
                    </button>
                  )}
                  {can('routes.expense') && (
                    <button onClick={() => void lancarCusto(r)} aria-label="Lançar despesa de viagem" title="Lançar custo no Financeiro"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600">
                      <Icon name="wallet" size={15} />
                    </button>
                  )}
                  {can('routes.update') && (
                    <SafeButton onClick={() => toggleTemplate(r)} aria-label="Marcar como template" title={r.template ? 'Desmarcar template' : 'Marcar como template'}
                      className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-ink-100',
                        r.template ? 'text-brand-600' : 'text-ink-400 hover:text-brand-600')}>
                      <Icon name="layers" size={15} />
                    </SafeButton>
                  )}
                  {can('routes.delete') && (
                    <SafeButton onClick={() => delSaved(r.id)} aria-label="Excluir"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-rose-50 hover:text-rose-600">
                      <Icon name="trash" size={16} />
                    </SafeButton>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {prompt && <PromptModal state={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}

/* ───────────────────────── Veículos ───────────────────────── */
const EMPTY_FORM = { nome: '', placa: '', combustivel: 'gasolina', consumo_kml: '', tanque_litros: '', preco_litro: '' };
type VForm = typeof EMPTY_FORM;

function Vehicles({ vehicles, reload }: { vehicles: Vehicle[]; reload: () => void }): React.JSX.Element {
  const { can } = useAuth();
  const [form, setForm] = useState<VForm>(EMPTY_FORM);
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k: keyof VForm, v: string): void => setForm((f) => ({ ...f, [k]: v }));

  const startEdit = (v: Vehicle): void => {
    setEditId(v.id);
    setForm({
      nome: v.nome, placa: v.placa ?? '', combustivel: v.combustivel,
      consumo_kml: String(v.consumo_kml), tanque_litros: v.tanque_litros ?? '', preco_litro: v.preco_litro ?? '',
    });
  };
  const cancel = (): void => { setEditId(null); setForm(EMPTY_FORM); setErr(''); };

  const num = (s: string): number | null => (s.trim() ? clampNum(s, 0, 1e6) : null);

  const submit = async (): Promise<void> => {
    if (!form.nome.trim() || !form.consumo_kml.trim()) { setErr('Nome e consumo são obrigatórios.'); return; }
    setBusy(true); setErr('');
    const body = {
      nome: form.nome.trim(), placa: form.placa.trim() || null, combustivel: form.combustivel,
      consumo_kml: num(form.consumo_kml), tanque_litros: num(form.tanque_litros), preco_litro: num(form.preco_litro),
    };
    try {
      if (editId != null) await api.patch(`/api/vehicles/${editId}`, body);
      else await api.post('/api/vehicles', body);
      cancel(); reload();
      toast.success(editId != null ? 'Veículo salvo.' : 'Veículo criado.');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Falha ao salvar veículo.');
    } finally { setBusy(false); }
  };

  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Remover este veículo?'))) return;
    try { await api.del(`/api/vehicles/${id}`); toast.success('Veículo removido.'); }
    catch { toast.error('Não foi possível remover o veículo.'); }
    if (editId === id) cancel();
    reload();
  };

  const ativos = vehicles.filter((v) => v.ativo);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card className="p-0">
        <p className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-700">Meus veículos</p>
        {ativos.length === 0 ? (
          <div className="p-6"><EmptyState icon="car" title="Nenhum veículo" hint="Cadastre um veículo para estimar o custo de combustível das rotas." /></div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {ativos.map((v) => (
              <li key={v.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-600"><Icon name="car" size={18} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-800">{v.nome}</span>
                  <span className="block truncate text-[11px] text-ink-400">
                    {FUEL_LABEL[v.combustivel]} · {Number(v.consumo_kml)} km/l
                    {v.preco_litro != null && ` · ${brl(Number(v.preco_litro))}/L`}
                    {v.placa && ` · ${v.placa}`}
                  </span>
                </span>
                {can('vehicles.update') && (
                  <button onClick={() => startEdit(v)} aria-label="Editar"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"><Icon name="pencil" size={16} /></button>
                )}
                {can('vehicles.delete') && (
                  <SafeButton onClick={() => remove(v.id)} aria-label="Excluir"
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-500 hover:bg-rose-50 hover:text-rose-500 sm:h-8 sm:w-8 sm:rounded-lg"><Icon name="trash" size={16} /></SafeButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="h-fit space-y-3 p-4">
        <p className="text-sm font-semibold text-ink-700">{editId != null ? 'Editar veículo' : 'Novo veículo'}</p>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">Nome *</label>
          <input value={form.nome} onChange={(e) => set('nome', e.target.value)} placeholder="Fiat Strada 2022" maxLength={120}
            className="w-full rounded-xl border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Combustível</label>
            <select value={form.combustivel} onChange={(e) => set('combustivel', e.target.value)}
              className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm outline-none focus:border-brand-400">
              {(['gasolina', 'etanol', 'diesel', 'flex'] as const).map((f) => <option key={f} value={f}>{FUEL_LABEL[f]}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Placa</label>
            <input value={form.placa} onChange={(e) => set('placa', maskPlaca(e.target.value))} placeholder="ABC1D23"
              className="w-full rounded-xl border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">km/litro *</label>
            <input value={form.consumo_kml} onChange={(e) => set('consumo_kml', maskMoney(e.target.value))} inputMode="decimal" placeholder="12,5"
              className="w-full rounded-xl border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Tanque (L)</label>
            <input value={form.tanque_litros} onChange={(e) => set('tanque_litros', maskMoney(e.target.value))} inputMode="decimal" placeholder="55"
              className="w-full rounded-xl border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">R$/litro</label>
            <input value={form.preco_litro} onChange={(e) => set('preco_litro', maskMoney(e.target.value))} inputMode="decimal" placeholder="6,19"
              className="w-full rounded-xl border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400" />
          </div>
        </div>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        <div className="flex gap-2">
          {can(editId != null ? 'vehicles.update' : 'vehicles.create') && (
            <Btn icon="check" onClick={() => submit()} disabled={busy} className="flex-1">{busy ? '…' : 'Salvar'}</Btn>
          )}
          {editId != null && <Btn variant="ghost" onClick={cancel}>Cancelar</Btn>}
        </div>
      </Card>
    </div>
  );
}

/* ───────────────────────── Página ───────────────────────── */
export function RoutePlanner(): React.JSX.Element {
  const [tab, setTab] = useState<'planejar' | 'veiculos'>('planejar');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);

  const reloadVehicles = (): void => {
    void api.get<{ vehicles: Vehicle[] }>('/api/vehicles').then((r) => setVehicles(r.vehicles)).catch(() => undefined);
  };
  useEffect(() => { reloadVehicles(); }, []);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Planejador de rota" subtitle="Selecione empresas do funil e gere a melhor sequência de visitas."
        actions={<Segmented value={tab} onChange={setTab} options={[
          { value: 'planejar', label: 'Planejar', icon: 'route' },
          { value: 'veiculos', label: 'Veículos', icon: 'car' },
        ]} />} />
      <div className="mt-4">
        {tab === 'planejar' ? <Planner vehicles={vehicles} /> : <Vehicles vehicles={vehicles} reload={reloadVehicles} />}
      </div>
    </div>
  );
}
