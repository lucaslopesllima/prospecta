import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Activity, FinanceCategory, FinanceEntry, KanbanCard, RepresentedCompany } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, Modal, PageHeader, SafeButton, Segmented, Spinner, StatCard, type Tone } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { brl, fmtDate, numStr, todayStr, maskMoney, clampNum } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';


const mesLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][(m ?? 1) - 1]}/${y}`;
};

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  pendente: { label: 'Pendente', tone: 'warn' },
  liquidado: { label: 'Liquidado', tone: 'success' },
  cancelado: { label: 'Cancelado', tone: 'neutral' },
};

/* opções de vínculo (empresa prospect / representada / compromisso) */
type Opt = { id: number; label: string };

// Totais globais (org + carteira) somados no servidor — os KPIs não podem
// depender só das linhas paginadas.
interface Totais { receber_aberto: number; pagar_aberto: number; recebido: number; pago: number }

// Página de lançamentos vinda do servidor (default do GET /api/finance).
const PAGE = 200;

export function Finance(): React.JSX.Element {
  const { can } = useAuth();
  const [view, setView] = useState<'lancamentos' | 'fluxo' | 'dre'>('lancamentos');
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [totais, setTotais] = useState<Totais | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kind, setKind] = useState<'todos' | 'receber' | 'pagar'>('todos');
  const [status, setStatus] = useState<'todos' | 'pendente' | 'liquidado' | 'cancelado'>('todos');
  const [periodo, setPeriodo] = useState<'mes' | 'todos'>('mes');
  const [mesRef, setMesRef] = useState<string>(todayStr().slice(0, 7));
  const [editing, setEditing] = useState<FinanceEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [managingCats, setManagingCats] = useState(false);

  // dropdown sources
  const [companies, setCompanies] = useState<Opt[]>([]);
  const [represented, setRepresented] = useState<Opt[]>([]);
  const [activities, setActivities] = useState<Opt[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);

  const loadCategories = (): void => {
    void api.get<{ categories: FinanceCategory[] }>('/api/finance/categories')
      .then((r) => setCategories(r.categories)).catch(() => undefined);
  };
  useEffect(() => { loadCategories(); }, []);

  // Tipo/status vão para o servidor (paginado); o recorte por mês continua
  // local sobre as linhas carregadas (a regra "vencido pendente sempre
  // aparece" não é expressável com from/to simples).
  const buildQs = (offset: number): string => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (kind !== 'todos') qs.set('kind', kind);
    if (status !== 'todos') qs.set('status', status);
    return qs.toString();
  };

  const load = async (): Promise<void> => {
    const r = await api.get<{ entries: FinanceEntry[]; totais?: Totais }>(`/api/finance?${buildQs(0)}&totais=true`);
    setEntries(r.entries);
    setTotais(r.totais ?? null);
    setHasMore(r.entries.length === PAGE);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [kind, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    try {
      const r = await api.get<{ entries: FinanceEntry[] }>(`/api/finance?${buildQs(entries.length)}`);
      setEntries((xs) => [...xs, ...r.entries]);
      setHasMore(r.entries.length === PAGE);
    } finally { setLoadingMore(false); }
  };

  useEffect(() => {
    void api.get<{ cards: KanbanCard[] }>('/api/kanban').then((r) => {
      const seen = new Set<number>();
      const opts: Opt[] = [];
      for (const c of r.cards) {
        if (seen.has(c.company_id)) continue;
        seen.add(c.company_id);
        opts.push({ id: c.company_id, label: c.nome_fantasia || c.razao_social });
      }
      opts.sort((a, b) => a.label.localeCompare(b.label));
      setCompanies(opts);
    }).catch(() => undefined);
    void api.get<{ empresas: RepresentedCompany[] }>('/api/represented').then((r) => {
      setRepresented(r.empresas.map((e) => ({ id: e.id, label: e.nome })));
    }).catch(() => undefined);
    void api.get<{ activities: Activity[] }>('/api/activities').then((r) => {
      setActivities(r.activities.map((a) => ({ id: a.id, label: a.titulo })));
    }).catch(() => undefined);
  }, []);

  const filtered = useMemo(() => {
    const today = todayStr();
    return entries.filter((e) => {
      if (kind !== 'todos' && e.kind !== kind) return false;
      if (status !== 'todos' && e.status !== status) return false;
      // no recorte por mês, vencidos pendentes nunca somem (urgência não pode esconder)
      if (periodo === 'mes') {
        const vencidoPendente = e.status === 'pendente' && e.vencimento < today;
        if (!e.vencimento.startsWith(mesRef) && !vencidoPendente) return false;
      }
      return true;
    }).sort((a, b) => {
      // vencidos pendentes primeiro, depois por data de vencimento
      const av = a.status === 'pendente' && a.vencimento < today ? 0 : 1;
      const bv = b.status === 'pendente' && b.vencimento < today ? 0 : 1;
      return av - bv || a.vencimento.localeCompare(b.vencimento);
    });
  }, [entries, kind, status, periodo, mesRef]);

  // KPIs (somente lançamentos não cancelados): preferem o agregado do servidor
  // (?totais=1, global); o cálculo local sobre as linhas carregadas é só fallback.
  const kpis = useMemo(() => {
    if (totais) {
      return {
        receberAberto: totais.receber_aberto, pagarAberto: totais.pagar_aberto,
        recebido: totais.recebido, pago: totais.pago,
        saldo: totais.receber_aberto - totais.pagar_aberto,
      };
    }
    let receberAberto = 0, pagarAberto = 0, recebido = 0, pago = 0;
    for (const e of entries) {
      const v = Number(e.valor);
      if (e.status === 'cancelado') continue;
      if (e.kind === 'receber') { e.status === 'liquidado' ? (recebido += v) : (receberAberto += v); }
      else { e.status === 'liquidado' ? (pago += v) : (pagarAberto += v); }
    }
    return { receberAberto, pagarAberto, recebido, pago, saldo: receberAberto - pagarAberto };
  }, [entries, totais]);

  // Mutações otimistas com rollback: se o servidor recusar, o estado volta —
  // a UI nunca fica mentindo sobre o que está salvo.
  const remove = async (e: FinanceEntry): Promise<void> => {
    const before = entries;
    setEntries((xs) => xs.filter((x) => x.id !== e.id));
    try { await api.del(`/api/finance/${e.id}`); toast.success('Lançamento excluído.'); }
    catch { setEntries(before); toast.error('Não foi possível excluir o lançamento.'); }
  };
  const liquidar = async (e: FinanceEntry): Promise<void> => {
    const next = e.status === 'liquidado' ? 'pendente' : 'liquidado';
    const before = entries;
    setEntries((xs) => xs.map((x) => (x.id === e.id ? { ...x, status: next } : x)));
    try {
      await api.patch(`/api/finance/${e.id}`, {
        status: next, liquidacao_data: next === 'liquidado' ? todayStr() : null,
      });
      void load();
      toast.success(next === 'liquidado' ? 'Lançamento liquidado.' : 'Lançamento reaberto.');
    } catch { setEntries(before); toast.error('Não foi possível atualizar o lançamento.'); }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <PageHeader title="Financeiro" subtitle="Contas a pagar e a receber"
        actions={
          <div className="flex gap-2">
            {(can('finance_categories.create') || can('finance_categories.delete')) && (
              <Btn variant="ghost" icon="layers" onClick={() => setManagingCats(true)}>Categorias</Btn>
            )}
            {can('finance.create') && (
              <Btn icon="plus" onClick={() => setAdding(true)}>Lançamento</Btn>
            )}
          </div>
        } />

      <Segmented value={view} onChange={setView} options={[
        { value: 'lancamentos', label: 'Lançamentos', icon: 'list' },
        { value: 'fluxo', label: 'Fluxo de caixa', icon: 'trendingUp' },
        { value: 'dre', label: 'DRE', icon: 'barChart' },
      ]} />

      {view === 'fluxo' ? <CashflowView /> : view === 'dre' ? <DreView /> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="A receber (aberto)" value={brl(kpis.receberAberto)} icon="arrowDown" tone="success" />
        <StatCard label="A pagar (aberto)" value={brl(kpis.pagarAberto)} icon="arrowUp" tone="danger" />
        <StatCard label="Saldo previsto" value={brl(kpis.saldo)} icon="wallet" tone={kpis.saldo >= 0 ? 'brand' : 'danger'} />
        <StatCard label="Realizado" value={brl(kpis.recebido - kpis.pago)} sub={`+${brl(kpis.recebido)} · −${brl(kpis.pago)}`} icon="trendingUp" tone="info" />
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
        <Segmented value={kind} onChange={setKind} options={[
          { value: 'todos', label: 'Todos', icon: 'list' },
          { value: 'receber', label: 'A receber', icon: 'arrowDown' },
          { value: 'pagar', label: 'A pagar', icon: 'arrowUp' },
        ]} />
        <div className="flex flex-wrap items-center gap-2">
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filtrar por status"
            className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
            <option value="todos">Todos os status</option>
            <option value="pendente">Pendentes</option>
            <option value="liquidado">Liquidados</option>
            <option value="cancelado">Cancelados</option>
          </select>
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value as typeof periodo)} aria-label="Período"
            className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
            <option value="mes">Por mês</option>
            <option value="todos">Todo período</option>
          </select>
          {periodo === 'mes' && (
            <input type="month" value={mesRef} onChange={(e) => setMesRef(e.target.value)} aria-label="Mês de referência"
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400" />
          )}
        </div>
      </Card>

      {periodo === 'mes' && !loading && filtered.length > 0 && (
        <p className="-mt-1 px-1 text-xs text-ink-400">Exibindo {mesLabel(mesRef)} · vencidos pendentes sempre incluídos.</p>
      )}

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState icon="wallet" title="Nenhum lançamento" hint="Adicione uma conta a pagar ou a receber." />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto">
          {filtered.map((e) => (
            <Row key={e.id} e={e} onEdit={() => setEditing(e)} onRemove={() => remove(e)} onLiquidar={() => liquidar(e)} />
          ))}
          {hasMore && (
            <div className="flex justify-center pt-1">
              <Btn variant="soft" onClick={() => loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Carregando…' : 'Carregar mais'}
              </Btn>
            </div>
          )}
        </div>
      )}
      </>}

      {(adding || editing) && (
        <FinanceModal entry={editing} companies={companies} represented={represented} activities={activities}
          categories={categories}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); void load(); }} />
      )}
      {managingCats && (
        <CategoriesModal categories={categories} onClose={() => setManagingCats(false)} onChanged={loadCategories} />
      )}
    </div>
  );
}

function Row({ e, onEdit, onRemove, onLiquidar }: {
  e: FinanceEntry; onEdit: () => void; onRemove: () => void; onLiquidar: () => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const canUpdate = can('finance.update');
  const receber = e.kind === 'receber';
  const vencido = e.status === 'pendente' && e.vencimento < todayStr();
  const links = [e.company_nome, e.represented_nome, e.activity_titulo, e.route_nome].filter(Boolean) as string[];
  const recorrente = e.recorrencia === 'mensal' || e.recorrencia_origem_id != null;
  const categoria = e.categoria_nome ?? e.categoria;
  return (
    <Card className={cn('flex items-center gap-3 p-3', vencido && 'border-l-4 border-l-rose-500')}>
      <SafeButton onClick={onLiquidar} disabled={!canUpdate} title={e.status === 'liquidado' ? 'Reabrir' : 'Marcar liquidado'}
        className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl transition disabled:cursor-default',
          e.status === 'liquidado' ? 'bg-emerald-500 text-white'
            : receber ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
              : 'bg-rose-50 text-rose-600 hover:bg-rose-100')}>
        <Icon name={e.status === 'liquidado' ? 'check' : receber ? 'arrowDown' : 'arrowUp'} size={17} />
      </SafeButton>

      <button onClick={onEdit} disabled={!canUpdate} className="flex min-w-0 flex-1 items-center gap-3 text-left" title={canUpdate ? 'Editar' : undefined}>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-semibold', e.status === 'cancelado' ? 'text-ink-400 line-through' : 'text-ink-800')}>
            {e.descricao}
          </p>
          <p className="truncate text-xs text-ink-400">
            Venc. {fmtDate(e.vencimento)}
            {recorrente ? ' · ↻ mensal' : ''}
            {categoria ? ` · ${categoria}` : ''}
            {links.length ? ` · ${links.join(' · ')}` : ''}
          </p>
        </div>
      </button>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={cn('tabnums text-sm font-bold', receber ? 'text-emerald-600' : 'text-rose-600')}>
          {receber ? '+' : '−'} {brl(Number(e.valor))}
        </span>
        <Badge tone={vencido ? 'danger' : STATUS_META[e.status]!.tone}>
          {vencido && <Icon name="alertTriangle" size={11} />}
          {vencido ? 'Vencido' : STATUS_META[e.status]!.label}
        </Badge>
      </div>

      {can('finance.delete') && (
        <SafeButton onClick={onRemove} aria-label="Excluir"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500">
          <Icon name="x" size={16} />
        </SafeButton>
      )}
    </Card>
  );
}

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

interface CashflowWeek { semana: string; receber: number; pagar: number; comissao_prevista: number; saldo: number }

// Fluxo de caixa projetado (Fase 6.1): vencimentos pendentes + comissões
// previstas, por semana. Barra horizontal = saldo relativo ao maior |saldo|.
function CashflowView(): React.JSX.Element {
  const [months, setMonths] = useState(3);
  const [semanas, setSemanas] = useState<CashflowWeek[] | null>(null);
  useEffect(() => {
    setSemanas(null);
    const ctrl = new AbortController();
    void api.get<{ semanas: CashflowWeek[] }>(`/api/finance/cashflow?months=${months}`, { signal: ctrl.signal })
      .then((r) => setSemanas(r.semanas)).catch(() => undefined);
    return () => ctrl.abort();
  }, [months]);

  if (semanas === null) return <Spinner />;
  const totals = semanas.reduce((t, w) => ({
    receber: t.receber + w.receber, pagar: t.pagar + w.pagar,
    comissao: t.comissao + w.comissao_prevista, saldo: t.saldo + w.saldo,
  }), { receber: 0, pagar: 0, comissao: 0, saldo: 0 });
  const maxAbs = Math.max(1, ...semanas.map((w) => Math.abs(w.saldo)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-700">Projeção: próximos meses</p>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
          className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
          {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m} {m === 1 ? 'mês' : 'meses'}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="A receber" value={brl(totals.receber)} icon="arrowDown" tone="success" />
        <StatCard label="Comissões previstas" value={brl(totals.comissao)} icon="percent" tone="info" />
        <StatCard label="A pagar" value={brl(totals.pagar)} icon="arrowUp" tone="danger" />
        <StatCard label="Saldo projetado" value={brl(totals.saldo)} icon="wallet" tone={totals.saldo >= 0 ? 'brand' : 'danger'} />
      </div>
      {semanas.length === 0 ? (
        <EmptyState icon="trendingUp" title="Sem projeção" hint="Não há vencimentos pendentes nem comissões previstas no período." />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto">
          {semanas.map((w) => (
            <Card key={w.semana} className="p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-ink-700">Semana de {fmtDate(w.semana)}</span>
                <span className={cn('tabnums text-sm font-bold', w.saldo >= 0 ? 'text-emerald-600' : 'text-rose-600')}>{brl(w.saldo)}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100">
                <div className={cn('h-full rounded-full', w.saldo >= 0 ? 'bg-emerald-400' : 'bg-rose-400')}
                  style={{ width: `${Math.max(4, Math.abs(w.saldo) / maxAbs * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-[11px] text-ink-400">
                +{brl(w.receber)} a receber · +{brl(w.comissao_prevista)} comissão · −{brl(w.pagar)} a pagar
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

interface DreMonth { mes: number; receita: number; despesa: number; resultado: number; despesas_por_categoria: Record<string, number> }

// DRE simplificado (Fase 6.1): receita (comissões recebidas) − despesas por
// categoria, mês a mês. Linhas com movimento apenas.
function DreView(): React.JSX.Element {
  const [ano, setAno] = useState(new Date().getFullYear());
  const [meses, setMeses] = useState<DreMonth[] | null>(null);
  useEffect(() => {
    setMeses(null);
    const ctrl = new AbortController();
    void api.get<{ meses: DreMonth[] }>(`/api/finance/dre?ano=${ano}`, { signal: ctrl.signal })
      .then((r) => setMeses(r.meses)).catch(() => undefined);
    return () => ctrl.abort();
  }, [ano]);

  if (meses === null) return <Spinner />;
  const comMov = meses.filter((m) => m.receita !== 0 || m.despesa !== 0);
  const tot = meses.reduce((t, m) => ({ receita: t.receita + m.receita, despesa: t.despesa + m.despesa, resultado: t.resultado + m.resultado }), { receita: 0, despesa: 0, resultado: 0 });
  const anoAtual = new Date().getFullYear();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-700">Resultado por mês</p>
        <select value={ano} onChange={(e) => setAno(Number(e.target.value))}
          className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
          {[anoAtual, anoAtual - 1, anoAtual - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Receita (ano)" value={brl(tot.receita)} icon="arrowDown" tone="success" />
        <StatCard label="Despesa (ano)" value={brl(tot.despesa)} icon="arrowUp" tone="danger" />
        <StatCard label="Resultado" value={brl(tot.resultado)} icon="trendingUp" tone={tot.resultado >= 0 ? 'brand' : 'danger'} />
      </div>
      {comMov.length === 0 ? (
        <EmptyState icon="barChart" title="Sem movimento" hint={`Nenhuma comissão recebida ou despesa liquidada em ${ano}.`} />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto">
          {comMov.map((m) => (
            <Card key={m.mes} className="p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-ink-700">{MESES[m.mes - 1]}/{ano}</span>
                <span className={cn('tabnums text-sm font-bold', m.resultado >= 0 ? 'text-emerald-600' : 'text-rose-600')}>{brl(m.resultado)}</span>
              </div>
              <p className="mt-1 text-[11px] text-ink-400">
                Receita {brl(m.receita)} · Despesa {brl(m.despesa)}
              </p>
              {Object.keys(m.despesas_por_categoria).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {Object.entries(m.despesas_por_categoria).map(([cat, v]) => (
                    <span key={cat} className="rounded-md bg-rose-50 px-2 py-0.5 text-[11px] text-rose-600">{cat}: {brl(v)}</span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// Gestão de categorias (cadastro leve + grupo de DRE). Fase 6.1.
function CategoriesModal({ categories, onClose, onChanged }: {
  categories: FinanceCategory[]; onClose: () => void; onChanged: () => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const [nome, setNome] = useState('');
  const [grupo, setGrupo] = useState('');
  const [kind, setKind] = useState<'' | 'pagar' | 'receber'>('');
  const [busy, setBusy] = useState(false);

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!nome.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/finance/categories', { nome: nome.trim(), grupo_dre: grupo.trim() || null, kind: kind || null });
      setNome(''); setGrupo(''); setKind('');
      onChanged();
      toast.success('Categoria criada.');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível criar a categoria.'); }
    finally { setBusy(false); }
  };
  const remove = async (c: FinanceCategory): Promise<void> => {
    if (!(await confirmDialog(`Excluir a categoria "${c.nome}"? Os lançamentos ficam sem categoria.`))) return;
    await api.del(`/api/finance/categories/${c.id}`).catch(() => undefined);
    onChanged();
  };

  return (
    <Modal onClose={onClose} width="md">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">Categorias financeiras</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100">
          <Icon name="x" size={17} />
        </button>
      </div>
      {can('finance_categories.create') && (
        <form onSubmit={add} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome *" maxLength={120} className={inputCls} />
          <input value={grupo} onChange={(e) => setGrupo(e.target.value)} placeholder="Grupo DRE (ex.: Operacional)" maxLength={120} className={inputCls} />
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={inputCls}>
            <option value="">Pagar e receber</option>
            <option value="pagar">Só a pagar</option>
            <option value="receber">Só a receber</option>
          </select>
          <Btn icon="plus" type="submit" disabled={busy}>{busy ? '…' : 'Adicionar'}</Btn>
        </form>
      )}
      <div className="max-h-[55vh] space-y-1.5 overflow-auto">
        {categories.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">Nenhuma categoria cadastrada.</p>
        ) : categories.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-lg border border-ink-100 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-800">{c.nome}</p>
              <p className="truncate text-[11px] text-ink-400">
                {c.grupo_dre}{c.kind ? ` · só ${c.kind}` : ''}
              </p>
            </div>
            {can('finance_categories.delete') && (
            <SafeButton onClick={() => remove(c)} aria-label={`Excluir ${c.nome}`}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500">
              <Icon name="trash" size={16} />
            </SafeButton>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function FinanceModal({ entry, companies, represented, activities, categories, onClose, onSaved }: {
  entry: FinanceEntry | null; companies: Opt[]; represented: Opt[]; activities: Opt[];
  categories: FinanceCategory[];
  onClose: () => void; onSaved: () => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<'receber' | 'pagar'>(entry?.kind ?? 'receber');
  const [descricao, setDescricao] = useState(entry?.descricao ?? '');
  const [valor, setValor] = useState(entry ? numStr(entry.valor) : '');
  const [vencimento, setVencimento] = useState(entry?.vencimento ?? todayStr());
  const [categoria, setCategoria] = useState(entry?.categoria ?? '');
  const [categoriaId, setCategoriaId] = useState<number | null>(entry?.categoria_id ?? null);
  const [notas, setNotas] = useState(entry?.notas ?? '');
  const [companyId, setCompanyId] = useState<number | null>(entry?.company_id ?? null);
  const [representedId, setRepresentedId] = useState<number | null>(entry?.represented_id ?? null);
  const [activityId, setActivityId] = useState<number | null>(entry?.activity_id ?? null);
  const [recorrencia, setRecorrencia] = useState<'nenhuma' | 'mensal'>(entry?.recorrencia === 'mensal' ? 'mensal' : 'nenhuma');
  const [recorrenciaFim, setRecorrenciaFim] = useState(entry?.recorrencia_fim ?? '');
  const [busy, setBusy] = useState(false);
  // lançamento gerado por recorrência (filho) não reabre a config de recorrência.
  const showRecorrencia = !entry?.recorrencia_origem_id;

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    const v = clampNum(valor, 0, 1e9);
    if (!descricao.trim()) { toast.error('Informe a descrição.'); return; }
    if (!vencimento) { toast.error('Informe o vencimento.'); return; }
    if (!Number.isFinite(v) || v <= 0) { toast.error('Informe um valor maior que zero.'); return; }
    setBusy(true);
    try {
      const body = {
        kind, descricao, valor: v, vencimento,
        categoria: categoriaId == null ? (categoria || null) : null,
        categoria_id: categoriaId,
        notas: notas || null,
        company_id: companyId, represented_id: representedId, activity_id: activityId,
        ...(showRecorrencia ? {
          recorrencia: recorrencia === 'mensal' ? 'mensal' : null,
          recorrencia_fim: recorrencia === 'mensal' && recorrenciaFim ? recorrenciaFim : null,
        } : {}),
      };
      if (entry) await api.patch(`/api/finance/${entry.id}`, body);
      else await api.post('/api/finance', body);
      toast.success(entry ? 'Lançamento salvo.' : 'Lançamento criado.');
      onSaved();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível salvar o lançamento.'); }
    finally { setBusy(false); }
  };

  const sel = (val: number | null, set: (n: number | null) => void, opts: Opt[], placeholder: string): React.JSX.Element => (
    <select value={val ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
      <option value="">{placeholder}</option>
      {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );

  return (
    <Modal onClose={onClose} width="md">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">{entry ? 'Editar lançamento' : 'Novo lançamento'}</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100">
          <Icon name="x" size={17} />
        </button>
      </div>
      <form onSubmit={submit} className="max-h-[70vh] space-y-3 overflow-auto pr-1">
        <div className="grid grid-cols-2 gap-1.5">
          {(['receber', 'pagar'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={cn('flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-semibold transition',
                kind === k
                  ? (k === 'receber' ? 'border-transparent bg-emerald-50 text-emerald-700' : 'border-transparent bg-rose-50 text-rose-600')
                  : 'border-ink-200 text-ink-500 hover:bg-ink-50')}>
              <Icon name={k === 'receber' ? 'arrowDown' : 'arrowUp'} size={15} />
              {k === 'receber' ? 'A receber' : 'A pagar'}
            </button>
          ))}
        </div>
        <input autoFocus value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Descrição" maxLength={120} className={inputCls} />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Valor (R$)</span>
            <input inputMode="decimal" value={valor} onChange={(e) => setValor(maskMoney(e.target.value))} placeholder="0,00" className={cn(inputCls, 'mt-1')} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Vencimento</span>
            <input type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} className={cn(inputCls, 'mt-1')} />
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Categoria</span>
          <select value={categoriaId ?? ''} onChange={(e) => setCategoriaId(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
            <option value="">Sem categoria / livre</option>
            {categories.filter((c) => c.ativo && (c.kind == null || c.kind === kind)).map((c) => (
              <option key={c.id} value={c.id}>{c.nome} · {c.grupo_dre}</option>
            ))}
            {/* categoria desativada já vinculada ao lançamento — mantém a opção */}
            {entry?.categoria_id != null && !categories.some((c) => c.id === entry.categoria_id) && (
              <option value={entry.categoria_id}>{entry.categoria_nome ?? `#${entry.categoria_id}`}</option>
            )}
          </select>
        </label>
        {categoriaId == null && (
          <input value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder="Categoria livre (opcional)" maxLength={120} className={inputCls} />
        )}
        {showRecorrencia && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Recorrência</span>
              <select value={recorrencia} onChange={(e) => setRecorrencia(e.target.value as typeof recorrencia)} className={cn(inputCls, 'mt-1')}>
                <option value="nenhuma">Sem recorrência</option>
                <option value="mensal">Mensal</option>
              </select>
            </label>
            {recorrencia === 'mensal' && (
              <label className="block">
                <span className="text-xs font-semibold text-ink-600">Repetir até (opcional)</span>
                <input type="date" value={recorrenciaFim} onChange={(e) => setRecorrenciaFim(e.target.value)} className={cn(inputCls, 'mt-1')} />
              </label>
            )}
          </div>
        )}
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Empresa prospect</span>
          {sel(companyId, setCompanyId, companies, 'Sem vínculo')}
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Empresa representada</span>
          {sel(representedId, setRepresentedId, represented, 'Sem vínculo')}
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Compromisso</span>
          {sel(activityId, setActivityId, activities, 'Sem vínculo')}
        </label>
        <textarea value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Notas (opcional)" rows={2} maxLength={2000} className={inputCls} />
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
        </div>
      </form>
    </Modal>
  );
}
