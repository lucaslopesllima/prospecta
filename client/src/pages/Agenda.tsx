import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { Activity, KanbanCard, OptimizeResult } from '../lib/types.ts';
import { Btn, Card, cn, EmptyState, ErrorState, Modal, PageHeader, SafeButton, Segmented, Spinner, useIsMobile } from '../lib/ui.tsx';
import { Icon, type IconName } from '../lib/icons.tsx';
import { ActivityCreateModal, VisitModal, type RepresentedOption } from '../lib/activityModal.tsx';
import { toast } from '../lib/toast.tsx';
import { useAuth } from '../lib/auth.tsx';

// "Adicionar" sem dia escolhido abre num horário comercial futuro: antes das 9h
// usa hoje 09:00; durante o expediente, a próxima hora cheia (nunca no passado).
const proximoHorarioComercial = (): Date => {
  const d = new Date();
  if (d.getHours() < 9) d.setHours(9, 0, 0, 0);
  else d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
};

/* ── tipo metadata (color + icon per activity kind) ─────── */
const TIPO: Record<string, { label: string; icon: IconName; dot: string; chip: string }> = {
  tarefa:  { label: 'Tarefa',   icon: 'check',  dot: '#3e66ea', chip: 'bg-brand-50 text-brand-700' },
  ligacao: { label: 'Ligação',  icon: 'phone',  dot: '#0284c7', chip: 'bg-sky-50 text-sky-700' },
  visita:  { label: 'Visita',   icon: 'mapPin', dot: '#d97706', chip: 'bg-amber-50 text-amber-700' },
  reuniao: { label: 'Reunião',  icon: 'users',  dot: '#7c3aed', chip: 'bg-violet-50 text-violet-700' },
  whatsapp: { label: 'WhatsApp', icon: 'whatsapp', dot: '#25D366', chip: 'bg-emerald-50 text-emerald-700' },
  email:   { label: 'E-mail',   icon: 'mail',   dot: '#e11d48', chip: 'bg-rose-50 text-rose-700' },
};
const TIPOS = Object.keys(TIPO);
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/* ── date helpers ───────────────────────────────────────── */
const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(d.getDate() + n); return x; };
const startOfWeek = (d: Date): Date => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay());
const WEEK_START_HOUR = 6;
const WEEK_END_HOUR = 22;
const HOUR_PX = 48;
const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const sameDay = (a: Date, b: Date): boolean => dayKey(a) === dayKey(b);
const fmtTime = (iso: string): string => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDayLong = (d: Date): string => d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

/* empresa no funil → opção do dropdown de vínculo */
type FunnelCompany = { company_id: number; label: string };

export function Agenda(): React.JSX.Element {
  const { can } = useAuth();
  const mobile = useIsMobile();
  const [items, setItems] = useState<Activity[]>([]);
  const [funnel, setFunnel] = useState<FunnelCompany[]>([]);
  const [represented, setRepresented] = useState<RepresentedOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  // View persistida: sobrevive a reload (inclusive offline no PWA — o usuário que
  // escolheu "Lista" continua na lista ao reabrir sem rede).
  const [view, setView] = useState<'mes' | 'semana' | 'lista'>(() => {
    const saved = localStorage.getItem('rs_agenda_view');
    if (saved === 'mes' || saved === 'semana' || saved === 'lista') return saved;
    // Sem escolha salva: no celular a grade de 7 colunas fica ilegível (célula
    // ~51px) — abre direto na lista; desktop mantém o mês.
    return typeof matchMedia !== 'undefined' && matchMedia('(max-width: 640px)').matches ? 'lista' : 'mes';
  });
  const changeView = useCallback((v: 'mes' | 'semana' | 'lista'): void => {
    setView(v);
    try { localStorage.setItem('rs_agenda_view', v); } catch { /* quota/priv mode */ }
  }, []);
  const activeView = mobile ? 'lista' : view;
  const [tipoFilter, setTipoFilter] = useState<Set<string>>(new Set(TIPOS));
  const [status, setStatus] = useState<'todos' | 'pendente' | 'feito'>('todos');
  const [addAt, setAddAt] = useState<Date | null>(null);     // add-modal open + preset date
  const [dayOpen, setDayOpen] = useState<Date | null>(null); // day-detail modal
  const [editing, setEditing] = useState<Activity | null>(null); // edit-modal target
  const [visiting, setVisiting] = useState<Activity | null>(null); // visit (check-in/relatório) modal
  const [rotaBusy, setRotaBusy] = useState(false);

  const today = useMemo(() => new Date(), []);

  // Janela visível ± 1 período de buffer — evita carregar todo o histórico.
  // Mês (e lista) = mês do cursor ± 1 mês; semana = semana da âncora ± 1 semana.
  // Recarrega quando o usuário navega (cursor/âncora mudam).
  const range = useMemo(() => {
    if (activeView === 'semana') {
      const s = startOfWeek(weekAnchor);
      return { from: addDays(s, -7), to: addDays(s, 14) };
    }
    const first = startOfMonth(cursor);
    return { from: addMonths(first, -1), to: addMonths(first, 2) };
  }, [activeView, cursor, weekAnchor]);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    const qs = new URLSearchParams({
      from: range.from.toISOString(), to: range.to.toISOString(), limit: '500',
    });
    try {
      const r = await api.get<{ activities: Activity[] }>(`/api/activities?${qs.toString()}`);
      setItems(r.activities);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Falha ao carregar agenda.');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  // Empresas do funil para vincular numa atividade (uma opção por company_id).
  useEffect(() => {
    void api.get<{ cards: KanbanCard[] }>('/api/kanban').then((r) => {
      const seen = new Set<number>();
      const opts: FunnelCompany[] = [];
      for (const c of r.cards) {
        if (seen.has(c.company_id)) continue;
        seen.add(c.company_id);
        opts.push({ company_id: c.company_id, label: c.nome_fantasia || c.razao_social });
      }
      opts.sort((a, b) => a.label.localeCompare(b.label));
      setFunnel(opts);
    }).catch(() => undefined);
  }, []);

  // Representadas para vincular numa atividade (com seus contatos no modal).
  useEffect(() => {
    void api.get<{ empresas: RepresentedOption[] }>('/api/represented')
      .then((r) => setRepresented(r.empresas)).catch(() => undefined);
  }, []);

  const toggle = async (a: Activity): Promise<void> => {
    const next = a.status === 'feito' ? 'pendente' : 'feito';
    setItems((xs) => xs.map((x) => (x.id === a.id ? { ...x, status: next } : x)));
    try { await api.patch(`/api/activities/${a.id}`, { status: next }); }
    catch { setItems((xs) => xs.map((x) => (x.id === a.id ? { ...x, status: a.status } : x))); toast.error('Não foi possível atualizar.'); }
  };
  const remove = async (a: Activity): Promise<void> => {
    const before = items;
    setItems((xs) => xs.filter((x) => x.id !== a.id));
    try { await api.del(`/api/activities/${a.id}`); toast.success('Atividade excluída.'); }
    catch { setItems(before); toast.error('Não foi possível excluir.'); }
  };

  // filtered set used by every view
  const filtered = useMemo(() => {
    const monthStart = startOfMonth(cursor);
    const monthEnd = addMonths(monthStart, 1);
    return items.filter((a) => {
      const date = new Date(a.start_at);
      return tipoFilter.has(a.tipo)
        && (status === 'todos' || a.status === status)
        && (activeView !== 'lista' || (date >= monthStart && date < monthEnd));
    });
  }, [items, tipoFilter, status, activeView, cursor]);

  // events grouped by calendar day
  const byDay = useMemo(() => {
    const m: Record<string, Activity[]> = {};
    for (const a of filtered) (m[dayKey(new Date(a.start_at))] ??= []).push(a);
    for (const k in m) m[k]!.sort((x, y) => x.start_at.localeCompare(y.start_at));
    return m;
  }, [filtered]);

  // 6-week grid starting on the Sunday before the 1st
  const grid = useMemo(() => {
    const first = startOfMonth(cursor);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const weekDays = useMemo(() => {
    const s = startOfWeek(weekAnchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [weekAnchor]);

  const goPrev = (): void => activeView === 'semana' ? setWeekAnchor((d) => addDays(d, -7)) : setCursor((c) => addMonths(c, -1));
  const goNext = (): void => activeView === 'semana' ? setWeekAnchor((d) => addDays(d, 7)) : setCursor((c) => addMonths(c, 1));
  const goToday = (): void => { setCursor(startOfMonth(new Date())); setWeekAnchor(new Date()); };
  const navLabel = activeView === 'semana'
    ? `${weekDays[0]!.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} – ${weekDays[6]!.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`
    : cursor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  const toggleTipo = (t: string): void => setTipoFilter((s) => {
    const n = new Set(s);
    n.has(t) ? n.delete(t) : n.add(t);
    return n;
  });

  // Fase 5.2 — "Rota do dia": junta as empresas dos compromissos do dia,
  // otimiza pelo planejador existente e salva como "Rota DD/MM".
  const gerarRota = async (date: Date, events: Activity[]): Promise<void> => {
    const ids = [...new Set(events.map((e) => e.company_id).filter((x): x is number => x != null))];
    if (ids.length === 0) { toast.error('Nenhum compromisso com empresa vinculada neste dia.'); return; }
    setRotaBusy(true);
    try {
      const r = await api.post<OptimizeResult>('/api/routes/optimize', { company_ids: ids });
      await api.post('/api/routes', {
        nome: `Rota ${date.toLocaleDateString('pt-BR')}`,
        origem_lat: r.origem.lat, origem_lon: r.origem.lon,
        dist_km: r.dist_km, dur_min: r.dur_min,
        preco_litro: r.preco_litro, litros: r.litros, custo_total: r.custo_total,
        geometry: r.geometry,
        stops: r.stops.map((s) => ({
          company_id: s.company_id, seq: s.seq, lat: s.lat, lon: s.lon,
          leg_dist_km: s.leg_dist_km, leg_dur_min: s.leg_dur_min,
        })),
      });
      const aviso = r.skipped.length ? ` (${r.skipped.length} sem localização ignorada(s))` : '';
      toast.success(`Rota gerada e salva${aviso}. Veja em Rotas.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao gerar a rota do dia.');
    } finally { setRotaBusy(false); }
  };

  const pendentes = filtered.filter((a) => a.status !== 'feito').length;

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <PageHeader title="Agenda" subtitle={`${pendentes} atividade(s) pendente(s)`}
        actions={can('activities.create')
          ? <Btn icon="plus" onClick={() => setAddAt(proximoHorarioComercial())}>Adicionar</Btn>
          : undefined} />

      {/* ── control panel ─────────────────────────────── */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-1">
          <button onClick={goPrev} aria-label="Anterior"
            className="grid h-11 w-11 place-items-center rounded-lg text-ink-500 hover:bg-ink-100 lg:h-9 lg:w-9">
            <Icon name="chevronRight" size={18} className="rotate-180" />
          </button>
          <button onClick={goToday}
            className="min-h-11 rounded-lg px-3 py-1.5 text-sm font-semibold text-ink-600 hover:bg-ink-100 lg:min-h-0">Hoje</button>
          <button onClick={goNext} aria-label="Próximo"
            className="grid h-11 w-11 place-items-center rounded-lg text-ink-500 hover:bg-ink-100 lg:h-9 lg:w-9">
            <Icon name="chevronRight" size={18} />
          </button>
          <span className="ml-2 text-base font-bold capitalize tracking-tight text-ink-900">{navLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* tipo filters */}
          <div className="flex flex-wrap gap-1">
            {TIPOS.map((t) => {
              const on = tipoFilter.has(t);
              return (
                <button key={t} onClick={() => toggleTipo(t)}
                  className={cn('inline-flex min-h-11 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition lg:min-h-0',
                    on ? 'border-transparent ' + TIPO[t]!.chip : 'border-ink-200 text-ink-400 hover:bg-ink-50')}>
                  <span className="h-2 w-2 rounded-full" style={{ background: on ? TIPO[t]!.dot : '#cbd5e1' }} />
                  {TIPO[t]!.label}
                </button>
              );
            })}
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}
            aria-label="Filtrar atividades por status"
            className="min-h-11 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400 lg:min-h-0">
            <option value="todos">Todos</option>
            <option value="pendente">Pendentes</option>
            <option value="feito">Concluídos</option>
          </select>
          {!mobile && <Segmented value={view} onChange={changeView} options={[
            { value: 'mes', label: 'Mês', icon: 'calendar' },
            { value: 'semana', label: 'Semana', icon: 'columns' },
            { value: 'lista', label: 'Lista', icon: 'list' },
          ]} />}
        </div>
      </Card>

      {/* ── calendar / list ───────────────────────────── */}
      {loading ? (
        <Spinner />
      ) : loadError ? (
        <ErrorState hint={loadError} onRetry={() => load()} />
      ) : activeView === 'mes' ? (
        <MonthGrid grid={grid} cursor={cursor} today={today} byDay={byDay} onDay={setDayOpen} />
      ) : activeView === 'semana' ? (
        <WeekView days={weekDays} today={today} byDay={byDay}
          onDay={setDayOpen}
          onSlot={(d) => setAddAt(d)} />
      ) : (
        <ListView byDay={byDay} onToggle={toggle} onRemove={remove} onEdit={setEditing} onVisit={setVisiting} onAdd={() => setAddAt(proximoHorarioComercial())} />
      )}

      {addAt && (
        <ActivityCreateModal preset={addAt} funnel={funnel} represented={represented} onClose={() => setAddAt(null)}
          onSaved={() => { setAddAt(null); void load(); }} />
      )}
      {dayOpen && (
        <DayModal date={dayOpen} events={byDay[dayKey(dayOpen)] ?? []}
          onClose={() => setDayOpen(null)}
          onToggle={toggle} onRemove={remove}
          onEdit={(a) => { setDayOpen(null); setEditing(a); }}
          onVisit={(a) => { setDayOpen(null); setVisiting(a); }}
          rotaBusy={rotaBusy} onGerarRota={(d, evs) => gerarRota(d, evs)}
          onAdd={() => { const d = new Date(dayOpen); d.setHours(9, 0, 0, 0); setDayOpen(null); setAddAt(d); }} />
      )}
      {visiting && (
        <VisitModal activity={visiting} onClose={() => setVisiting(null)}
          onSaved={() => { setVisiting(null); void load(); }} />
      )}
      {editing && (
        <ActivityCreateModal preset={new Date(editing.start_at)} funnel={funnel} represented={represented}
          activity={{ id: editing.id, titulo: editing.titulo, tipo: editing.tipo, start_at: editing.start_at,
            company_id: editing.company_id, represented_id: editing.represented_id, contact_id: editing.contact_id }}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }} />
      )}
    </div>
  );
}

/* ── month grid (Google-Calendar style) ─────────────────── */
function MonthGrid({ grid, cursor, today, byDay, onDay }: {
  grid: Date[]; cursor: Date; today: Date; byDay: Record<string, Activity[]>; onDay: (d: Date) => void;
}): React.JSX.Element {
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
      <div className="grid grid-cols-7 border-b border-hairline">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-400">{w}</div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {grid.map((d, i) => {
          const out = d.getMonth() !== cursor.getMonth();
          const isToday = sameDay(d, today);
          const evs = byDay[dayKey(d)] ?? [];
          return (
            <button key={i} onClick={() => onDay(d)}
              className={cn('flex min-h-[88px] flex-col gap-1 border-b border-r border-ink-100 p-1.5 text-left transition-colors hover:bg-ink-50',
                i % 7 === 6 && 'border-r-0', out && 'bg-ink-50/40')}>
              <span className={cn('tabnums grid h-6 w-6 place-items-center rounded-full text-xs font-semibold',
                isToday ? 'bg-brand-600 text-white' : out ? 'text-ink-300' : 'text-ink-600')}>
                {d.getDate()}
              </span>
              <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                {evs.slice(0, 3).map((a) => (
                  <span key={a.id}
                    className={cn('flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] font-medium',
                      TIPO[a.tipo]?.chip ?? 'bg-ink-100 text-ink-600', a.status === 'feito' && 'line-through opacity-60')}>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TIPO[a.tipo]?.dot ?? '#94a3b8' }} />
                    <span className="tabnums shrink-0">{fmtTime(a.start_at)}</span>
                    <span className="truncate">{a.titulo}</span>
                  </span>
                ))}
                {evs.length > 3 && <span className="px-1 text-[10px] font-semibold text-ink-400">+{evs.length - 3} mais</span>}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/* ── week view (time-grid, Google-Calendar style) ───────── */
function WeekView({ days, today, byDay, onDay, onSlot }: {
  days: Date[]; today: Date; byDay: Record<string, Activity[]>;
  onDay: (d: Date) => void; onSlot: (d: Date) => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const hours = Array.from({ length: WEEK_END_HOUR - WEEK_START_HOUR }, (_, i) => WEEK_START_HOUR + i);
  const bodyH = hours.length * HOUR_PX;
  const cols = '56px repeat(7, minmax(0, 1fr))';

  const pos = (a: Activity): { top: number; height: number } => {
    const s = new Date(a.start_at);
    const startMin = s.getHours() * 60 + s.getMinutes() - WEEK_START_HOUR * 60;
    const end = a.end_at ? new Date(a.end_at) : null;
    const durMin = end ? Math.max((end.getTime() - s.getTime()) / 60000, 30) : 45;
    return {
      top: Math.max(0, Math.min((startMin / 60) * HOUR_PX, bodyH - 22)),
      height: Math.max((durMin / 60) * HOUR_PX, 26),
    };
  };

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
      {/* day headers */}
      <div className="grid border-b border-hairline" style={{ gridTemplateColumns: cols }}>
        <div />
        {days.map((d, i) => {
          const isToday = sameDay(d, today);
          return (
            <button key={i} onClick={() => onDay(d)} className="flex flex-col items-center gap-0.5 border-l border-ink-100 py-2 hover:bg-ink-50">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">{WEEKDAYS[d.getDay()]}</span>
              <span className={cn('tabnums grid h-7 w-7 place-items-center rounded-full text-sm font-bold', isToday ? 'bg-brand-600 text-white' : 'text-ink-700')}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      {/* scrollable time body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid" style={{ gridTemplateColumns: cols, height: bodyH }}>
          {/* time gutter */}
          <div className="relative">
            {hours.map((h) => (
              <div key={h} className="tabnums absolute right-1 -translate-y-1/2 text-[10px] font-medium text-ink-400" style={{ top: (h - WEEK_START_HOUR) * HOUR_PX }}>
                {String(h).padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {days.map((d, di) => {
            const evs = byDay[dayKey(d)] ?? [];
            return (
              <div key={di} className="relative border-l border-ink-100"
                onClick={(e) => {
                  if (!can('activities.create')) return;
                  const hour = Math.min(WEEK_END_HOUR - 1, WEEK_START_HOUR + Math.floor(e.nativeEvent.offsetY / HOUR_PX));
                  const dd = new Date(d); dd.setHours(hour, 0, 0, 0); onSlot(dd);
                }}>
                {hours.map((h) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-ink-100" style={{ top: (h - WEEK_START_HOUR) * HOUR_PX }} />
                ))}
                {evs.map((a) => {
                  const { top, height } = pos(a);
                  const done = a.status === 'feito';
                  return (
                    <button key={a.id} onClick={(e) => { e.stopPropagation(); onDay(d); }}
                      className={cn('absolute left-0.5 right-0.5 overflow-hidden rounded-md border-l-2 px-1.5 py-0.5 text-left text-[10px] shadow-card',
                        TIPO[a.tipo]?.chip ?? 'bg-ink-100 text-ink-600', done && 'line-through opacity-60')}
                      style={{ top, height, borderColor: TIPO[a.tipo]?.dot ?? '#94a3b8' }}>
                      <span className="block truncate font-semibold">{a.titulo}</span>
                      <span className="tabnums block truncate opacity-80">{fmtTime(a.start_at)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/* ── list view ──────────────────────────────────────────── */
function ListView({ byDay, onToggle, onRemove, onEdit, onVisit, onAdd }: {
  byDay: Record<string, Activity[]>; onToggle: (a: Activity) => void; onRemove: (a: Activity) => void;
  onEdit: (a: Activity) => void; onVisit: (a: Activity) => void; onAdd: () => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const days = Object.entries(byDay).sort((a, b) => (a[1][0]?.start_at ?? '').localeCompare(b[1][0]?.start_at ?? ''));
  if (days.length === 0) {
    return <EmptyState icon="calendar" title="Nenhuma atividade" hint="Ajuste os filtros ou adicione uma atividade." />;
  }
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto">
      {days.map(([k, list]) => (
        <div key={k}>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{fmtDayLong(new Date(list[0]!.start_at))}</p>
          <div className="space-y-2">
            {list.map((a) => <Row key={a.id} a={a} onToggle={onToggle} onRemove={onRemove} onEdit={onEdit} onVisit={onVisit} />)}
          </div>
        </div>
      ))}
      {can('activities.create') && <Btn variant="soft" icon="plus" onClick={onAdd}>Adicionar atividade</Btn>}
    </div>
  );
}

function Row({ a, onToggle, onRemove, onEdit, onVisit }: {
  a: Activity; onToggle: (a: Activity) => void; onRemove: (a: Activity) => void; onEdit: (a: Activity) => void; onVisit: (a: Activity) => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const done = a.status === 'feito';
  // Visita em campo: só faz sentido com empresa vinculada (check-in/relatório).
  const podeVisitar = a.company_id != null;
  const visitada = !!a.checkin_at || !!a.relatorio;
  return (
    <Card className="flex items-center gap-3 p-3">
      <SafeButton onClick={() => onToggle(a)} aria-label="Concluir" disabled={!can('activities.update')}
        className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-50',
          done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-ink-300 text-transparent hover:border-brand-400')}>
        <Icon name="check" size={14} />
      </SafeButton>
      <button onClick={() => onEdit(a)} className="flex min-w-0 flex-1 items-center gap-3 text-left" title="Editar">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', TIPO[a.tipo]?.chip ?? 'bg-ink-100 text-ink-500', done && 'opacity-50')}>
          <Icon name={TIPO[a.tipo]?.icon ?? 'check'} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-semibold', done ? 'text-ink-400 line-through' : 'text-ink-800')}>{a.titulo}</p>
          <p className="truncate text-xs text-ink-400">{fmtTime(a.start_at)} · {TIPO[a.tipo]?.label ?? a.tipo}{a.razao_social ? ` · ${a.razao_social}` : ''}{a.represented_nome ? ` · ${a.represented_nome}` : ''}{a.contact_nome ? ` · ${a.contact_nome}` : ''}</p>
        </div>
      </button>
      {podeVisitar && (can('activities.checkin') || can('activities.report')) && (
        <button onClick={() => onVisit(a)} aria-label="Registrar visita" title="Check-in / relatório"
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg transition',
            visitada ? 'text-emerald-600 hover:bg-emerald-50' : 'text-ink-300 hover:bg-brand-50 hover:text-brand-600')}>
          <Icon name="mapPin" size={16} />
        </button>
      )}
      {can('activities.update') && (
        <button onClick={() => onEdit(a)} aria-label="Editar"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100">
          <Icon name="pencil" size={16} />
        </button>
      )}
      {can('activities.delete') && (
        <SafeButton onClick={() => onRemove(a)} aria-label="Excluir"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-500 hover:bg-rose-50 hover:text-rose-500 sm:h-8 sm:w-8 sm:rounded-lg">
          <Icon name="trash" size={16} />
        </SafeButton>
      )}
    </Card>
  );
}

/* A casca de modal local virou o `Modal` de lib/ui.tsx — que traz Esc, trava do
   scroll de fundo, altura máxima com corpo rolável e folha pelo rodapé no
   celular. Só o `capitalize` do título (dia por extenso) segue aqui. */

/* ── day-detail modal ───────────────────────────────────── */
function DayModal({ date, events, onClose, onToggle, onRemove, onEdit, onVisit, onAdd, onGerarRota, rotaBusy }: {
  date: Date; events: Activity[]; onClose: () => void;
  onToggle: (a: Activity) => void; onRemove: (a: Activity) => void; onEdit: (a: Activity) => void;
  onVisit: (a: Activity) => void; onAdd: () => void;
  onGerarRota: (d: Date, evs: Activity[]) => void; rotaBusy: boolean;
}): React.JSX.Element {
  const { can } = useAuth();
  const comEmpresa = events.filter((e) => e.company_id != null).length;
  return (
    <Modal title={<span className="capitalize">{fmtDayLong(date)}</span>} onClose={onClose}>
      <div className="space-y-2">
        {events.length === 0
          ? <p className="py-6 text-center text-sm text-ink-400">Nenhuma atividade neste dia.</p>
          : events.map((a) => <Row key={a.id} a={a} onToggle={onToggle} onRemove={onRemove} onEdit={onEdit} onVisit={onVisit} />)}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {comEmpresa >= 2 && (
          <Btn variant="soft" icon="route" disabled={rotaBusy} onClick={() => onGerarRota(date, events)} className="w-full">
            {rotaBusy ? 'Gerando…' : `Gerar rota do dia (${comEmpresa} paradas)`}
          </Btn>
        )}
        {can('activities.create') && (
          <Btn variant="soft" icon="plus" onClick={onAdd} className="w-full">Adicionar neste dia</Btn>
        )}
      </div>
    </Modal>
  );
}
