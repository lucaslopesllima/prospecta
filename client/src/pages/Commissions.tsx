import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type {
  CatalogItem, CommissionEntry, CommissionRule, CommissionStatus,
  KanbanCard, OrgUser, RepresentedCompany,
} from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, Modal, PageHeader, SafeButton, Segmented, Spinner, StatRow, type Tone } from '../lib/ui.tsx';
import { useSellers, SellerFilter } from '../lib/sellers.tsx';
import { downloadCsv } from '../lib/export.ts';
import { Icon } from '../lib/icons.tsx';
import { brl, csvNum, dec, fmtDate, maskMoney, maskPct, numStr, todayStr } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';


const STATUS_META: Record<CommissionStatus, { label: string; tone: Tone }> = {
  prevista: { label: 'Prevista', tone: 'info' },
  recebida: { label: 'Recebida', tone: 'success' },
  divergente: { label: 'Divergente', tone: 'danger' },
  cancelada: { label: 'Cancelada', tone: 'neutral' },
};

export function Commissions(): React.JSX.Element {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [tab, setTab] = useState<'extrato' | 'regras'>('extrato');
  const [reps, setReps] = useState<RepresentedCompany[]>([]);

  useEffect(() => {
    void api.get<{ empresas: RepresentedCompany[] }>('/api/represented')
      .then((r) => setReps(r.empresas.filter((e) => e.ativo))).catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <PageHeader title="Comissões" subtitle="Previsto vs. recebido por representada"
        actions={
          <Segmented value={tab} onChange={setTab} options={[
            { value: 'extrato', label: 'Extrato', icon: 'wallet' },
            { value: 'regras', label: 'Regras', icon: 'percent' },
          ]} />
        } />
      {tab === 'extrato'
        ? <Extrato reps={reps} />
        : <Rules reps={reps} admin={admin} />}
    </div>
  );
}

/* ── Extrato mensal ─────────────────────────────────────── */

function Extrato({ reps }: { reps: RepresentedCompany[] }): React.JSX.Element {
  const { can } = useAuth();
  const [competencia, setCompetencia] = useState(todayStr().slice(0, 7));
  const [representedId, setRepresentedId] = useState<'todas' | number>('todas');
  const [status, setStatus] = useState<'todos' | CommissionStatus>('todos');
  const [ownerId, setOwnerId] = useState<'todos' | number>('todos');
  const sellers = useSellers();
  const [entries, setEntries] = useState<CommissionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState<CommissionEntry | null>(null);
  const [reconciling, setReconciling] = useState(false);

  const load = async (): Promise<void> => {
    // competencia é o que mantém o extrato limitado a um mês no servidor —
    // input type=month pode ser limpo pelo usuário; sem valor, não consulta.
    if (!competencia) return;
    setLoading(true);
    const qs = new URLSearchParams({ competencia });
    if (representedId !== 'todas') qs.set('represented_id', String(representedId));
    if (status !== 'todos') qs.set('status', status);
    if (ownerId !== 'todos') qs.set('user_id', String(ownerId));
    try {
      const r = await api.get<{ entries: CommissionEntry[] }>(`/api/commissions?${qs.toString()}`);
      setEntries(r.entries);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [competencia, representedId, status, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const kpis = useMemo(() => {
    let previsto = 0, recebido = 0, divergentes = 0;
    for (const e of entries) {
      if (e.status === 'cancelada') continue;
      previsto += Number(e.valor_previsto);
      if (e.valor_recebido != null) recebido += Number(e.valor_recebido);
      if (e.status === 'divergente') divergentes++;
    }
    return { previsto, recebido, divergentes };
  }, [entries]);

  // visão mensal por representada: subtotais previsto/recebido por grupo
  const grupos = useMemo(() => {
    const map = new Map<string, CommissionEntry[]>();
    for (const e of entries) {
      const xs = map.get(e.represented_nome) ?? [];
      xs.push(e);
      map.set(e.represented_nome, xs);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  return (
    <>
      <StatRow cols={3} items={[
        { label: 'Recebido no mês', value: brl(kpis.recebido), sub: `previsto ${brl(kpis.previsto)}`, icon: 'check', tone: 'success' },
        { label: 'A receber', value: brl(Math.max(0, kpis.previsto - kpis.recebido)), sub: 'previsto ainda não pago', icon: 'trendingUp', tone: 'info' },
        { label: 'Divergências', value: String(kpis.divergentes), sub: kpis.divergentes > 0 ? 'revisar baixas' : 'tudo certo', icon: 'alertTriangle', tone: kpis.divergentes > 0 ? 'danger' : 'neutral' },
      ]} />

      <Card className="flex flex-wrap items-center gap-3 p-3">
        <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} aria-label="Competência"
          className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400" />
        <select value={representedId} onChange={(e) => setRepresentedId(e.target.value === 'todas' ? 'todas' : Number(e.target.value))}
          aria-label="Filtrar por representada"
          className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
          <option value="todas">Todas as representadas</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filtrar por status"
          className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
          <option value="todos">Todos os status</option>
          {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <SellerFilter value={ownerId} onChange={setOwnerId} sellers={sellers} />
        <Btn variant="ghost" size="sm" icon="download" className="ml-auto" disabled={entries.length === 0}
          onClick={() => downloadCsv(`comissoes-${competencia}`,
            ['Pedido', 'NF', 'Cliente', 'Representada', 'Vendedor', 'Previsto', 'Recebido', 'Status'],
            entries.map((e) => [e.order_numero, e.nf_numero ?? '', e.company_nome, e.represented_nome,
              e.vendedor_nome ?? e.vendedor_email ?? '', csvNum(e.valor_previsto),
              e.valor_recebido == null ? '' : csvNum(e.valor_recebido), e.status]))}>
          Exportar
        </Btn>
        {can('commissions.reconcile') && (
          <Btn variant="ghost" size="sm" icon="arrowDown" onClick={() => setReconciling(true)}>
            Conciliar CSV
          </Btn>
        )}
      </Card>

      {loading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState icon="percent" title="Nenhuma comissão na competência"
          hint="Comissões são geradas automaticamente quando um pedido é faturado e existe regra vigente." />
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto">
          {grupos.map(([nome, xs]) => {
            const previsto = xs.reduce((s, e) => s + (e.status === 'cancelada' ? 0 : Number(e.valor_previsto)), 0);
            const recebido = xs.reduce((s, e) => s + (e.valor_recebido != null ? Number(e.valor_recebido) : 0), 0);
            return (
              <section key={nome}>
                <div className="mb-1.5 flex items-baseline justify-between px-1">
                  <h3 className="text-sm font-bold text-ink-800">{nome}</h3>
                  <p className="tabnums text-xs text-ink-500">
                    previsto <span className="font-bold text-ink-700">{brl(previsto)}</span>
                    {' · '}recebido <span className="font-bold text-emerald-700">{brl(recebido)}</span>
                  </p>
                </div>
                <div className="space-y-2">
                  {xs.map((e) => (
                    <EntryRow key={e.id} e={e} onSettle={() => setSettling(e)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {settling && (
        <SettleModal entry={settling} onClose={() => setSettling(null)}
          onSaved={() => { setSettling(null); void load(); }} />
      )}
      {reconciling && (
        <ReconcileModal onClose={() => setReconciling(false)}
          onDone={() => { setReconciling(false); void load(); }} />
      )}
    </>
  );
}

function EntryRow({ e, onSettle }: { e: CommissionEntry; onSettle: () => void }): React.JSX.Element {
  const { can } = useAuth();
  const meta = STATUS_META[e.status];
  return (
    <Card className={cn('flex items-center gap-3 p-3', e.status === 'cancelada' && 'opacity-60')}>
      <span className="tabnums grid h-9 w-12 shrink-0 place-items-center rounded-xl bg-ink-100 text-xs font-bold text-ink-600">
        #{e.order_numero}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-800">{e.company_nome}</p>
        <p className="truncate text-xs text-ink-400">
          {e.vendedor_nome ?? e.vendedor_email ?? 'sem vendedor'}
          {e.nf_numero ? ` · NF ${e.nf_numero}` : ''}
          {` · pedido ${brl(Number(e.order_total))} × ${Number(e.percent_aplicado)}%`}
          {` · vendedor ${brl(Number(e.valor_vendedor))} (${Number(e.vendedor_split_pct)}%)`}
          {e.recebida_em ? ` · baixa em ${fmtDate(e.recebida_em)}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="tabnums text-sm font-bold text-ink-800">
          {brl(Number(e.valor_previsto))}
          {e.valor_recebido != null && Number(e.valor_recebido) !== Number(e.valor_previsto) && (
            <span className={cn('ml-1', e.status === 'divergente' ? 'text-rose-600' : 'text-emerald-700')}>
              → {brl(Number(e.valor_recebido))}
            </span>
          )}
        </span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      {can('commissions.settle') && (e.status === 'prevista' || e.status === 'divergente') && (
        <Btn variant="ghost" size="sm" onClick={onSettle}>Dar baixa</Btn>
      )}
    </Card>
  );
}

function SettleModal({ entry, onClose, onSaved }: {
  entry: CommissionEntry; onClose: () => void; onSaved: () => void;
}): React.JSX.Element {
  const [valor, setValor] = useState(numStr(entry.valor_recebido ?? entry.valor_previsto));
  const [data, setData] = useState(todayStr());
  const [observacao, setObservacao] = useState(entry.observacao ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (valor.trim() === '' || !Number.isFinite(dec(valor)) || !data) return;
    setBusy(true);
    try {
      await api.patch(`/api/commissions/${entry.id}/settle`, {
        valor_recebido: dec(valor), recebida_em: data, observacao: observacao.trim() || null,
      });
      toast.success('Baixa registrada.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível dar baixa.');
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} width="md">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">Baixa da comissão · pedido #{entry.order_numero}</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-ink-100 hover:text-ink-800 sm:h-8 sm:w-8 sm:rounded-lg">
          <Icon name="x" size={17} />
        </button>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-ink-400">
          Previsto: <span className="font-semibold text-ink-600">{brl(Number(entry.valor_previsto))}</span>.
          Valor diferente do previsto marca a comissão como divergente.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Valor recebido *</span>
            <input type="text" inputMode="decimal" placeholder="0,00" value={valor} autoFocus
              onChange={(e) => setValor(maskMoney(e.target.value))} className={cn(inputCls, 'mt-1')} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Recebida em *</span>
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={cn(inputCls, 'mt-1')} />
          </label>
        </div>
        <textarea value={observacao} onChange={(e) => setObservacao(e.target.value)} maxLength={2000}
          placeholder="Observação" rows={2} className={inputCls} />
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Confirmar baixa'}</Btn>
        </div>
      </form>
    </Modal>
  );
}

function ReconcileModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ processadas: number; baixadas: number; divergentes: number } | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ processadas: number; baixadas: number; divergentes: number }>(
        '/api/commissions/reconcile', { csv },
      );
      setResult(r);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível conciliar.');
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} width="lg">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">Conciliar pagamentos (CSV)</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-ink-100 hover:text-ink-800 sm:h-8 sm:w-8 sm:rounded-lg">
          <Icon name="x" size={17} />
        </button>
      </div>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            {result.baixadas} de {result.processadas} linha(s) baixada(s)
            {result.divergentes > 0 ? `, ${result.divergentes} divergente(s).` : '.'}
          </p>
          <div className="flex justify-end"><Btn onClick={onDone}>Concluir</Btn></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-ink-400">
            Cabeçalho com colunas <code>pedido</code> (ou <code>nf</code>) e <code>valor</code>, mais
            <code> data</code> opcional. Cada linha dá baixa na comissão do pedido; valor fora da
            tolerância marca divergência.
          </p>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} maxLength={1000000}
            placeholder={'pedido;valor;data\n12;345,67;05/06/2026'}
            className={cn(inputCls, 'font-mono text-xs')} />
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
            <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Conciliar'}</Btn>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ── Regras (precedência: produto > cliente > vendedor > geral) ── */

const alvoRegra = (r: CommissionRule): { label: string; tone: Tone } =>
  r.catalog_item_id != null ? { label: `Produto · ${r.catalog_nome ?? `#${r.catalog_item_id}`}`, tone: 'brand' }
  : r.company_id != null ? { label: `Cliente · ${r.company_nome ?? `#${r.company_id}`}`, tone: 'info' }
  : r.user_id != null ? { label: `Vendedor · ${r.user_nome ?? r.user_email ?? `#${r.user_id}`}`, tone: 'warn' }
  : { label: 'Regra geral', tone: 'neutral' };

function Rules({ reps, admin }: { reps: RepresentedCompany[]; admin: boolean }): React.JSX.Element {
  const { can } = useAuth();
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CommissionRule | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [companies, setCompanies] = useState<{ id: number; label: string }[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);

  const load = async (): Promise<void> => {
    const r = await api.get<{ rules: CommissionRule[] }>('/api/commission-rules');
    setRules(r.rules);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!admin) return;
    void api.get<{ items: CatalogItem[] }>('/api/catalog')
      .then((r) => setCatalog(r.items.filter((i) => i.ativo))).catch(() => undefined);
    void api.get<{ cards: KanbanCard[] }>('/api/kanban').then((r) => {
      const seen = new Set<number>();
      setCompanies(r.cards.filter((c) => !seen.has(c.company_id) && seen.add(c.company_id) !== undefined)
        .map((c) => ({ id: c.company_id, label: c.nome_fantasia || c.razao_social }))
        .sort((a, b) => a.label.localeCompare(b.label)));
    }).catch(() => undefined);
    void api.get<{ users: OrgUser[] }>('/api/users')
      .then((r) => setUsers(r.users.filter((u) => u.ativo))).catch(() => undefined);
  }, [admin]);

  const remove = async (r: CommissionRule): Promise<void> => {
    if (!(await confirmDialog('Excluir esta regra de comissão?'))) return;
    const before = rules;
    setRules((xs) => xs.filter((x) => x.id !== r.id));
    try { await api.del(`/api/commission-rules/${r.id}`); toast.success('Regra excluída.'); }
    catch { setRules(before); toast.error('Não foi possível excluir a regra.'); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto">
      <p className="px-1 text-xs text-ink-400">
        Precedência na resolução: <strong>produto</strong> &gt; <strong>cliente</strong> &gt; <strong>vendedor</strong> &gt; regra geral da representada.
      </p>
      {can('commission_rules.create') && (
        <div className="flex justify-end">
          <Btn icon="plus" size="sm" onClick={() => setAdding(true)}>Nova regra</Btn>
        </div>
      )}
      {(adding || editing) && (
        <RuleForm reps={reps} catalog={catalog} companies={companies} users={users} rule={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); void load(); }} />
      )}
      {rules.length === 0 && !adding && (
        <EmptyState icon="percent" title="Nenhuma regra de comissão"
          hint="Crie ao menos a regra geral de cada representada para gerar comissões ao faturar." />
      )}
      {rules.map((r) => {
        const alvo = alvoRegra(r);
        return (
          <div key={r.id} className={cn('flex items-start gap-3 rounded-xl border border-hairline bg-surface p-3', !r.ativo && 'opacity-60')}>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-500"><Icon name="percent" size={18} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="truncate text-sm font-semibold text-ink-800">{r.represented_nome}</p>
                <Badge tone={alvo.tone}>{alvo.label}</Badge>
                {!r.ativo && <Badge tone="neutral">inativa</Badge>}
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-400">
                {Number(r.percent)}% · vendedor {Number(r.vendedor_split_pct)}% ·{' '}
                {fmtDate(r.vigencia_inicio)} → {r.vigencia_fim ? fmtDate(r.vigencia_fim) : 'sem fim'}
              </p>
            </div>
            {(can('commission_rules.update') || can('commission_rules.delete')) && (
              <div className="flex shrink-0 items-center gap-1">
                {can('commission_rules.update') && (
                  <button onClick={() => setEditing(r)} aria-label="Editar regra"
                    className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-ink-100 hover:text-ink-800 sm:h-8 sm:w-8 sm:rounded-lg"><Icon name="pencil" size={16} /></button>
                )}
                {can('commission_rules.delete') && (
                  <SafeButton onClick={() => remove(r)} aria-label="Excluir regra"
                    className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-rose-50 hover:text-rose-500 sm:h-8 sm:w-8 sm:rounded-lg"><Icon name="trash" size={16} /></SafeButton>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RuleForm({ reps, catalog, companies, users, rule, onClose, onSaved }: {
  reps: RepresentedCompany[]; catalog: CatalogItem[]; companies: { id: number; label: string }[];
  users: OrgUser[]; rule: CommissionRule | null;
  onClose: () => void; onSaved: () => void;
}): React.JSX.Element {
  const [representedId, setRepresentedId] = useState(rule ? String(rule.represented_id) : '');
  // alvo é exclusivo: produto OU cliente OU vendedor OU geral
  const [alvo, setAlvo] = useState<'geral' | 'produto' | 'cliente' | 'vendedor'>(
    rule?.catalog_item_id != null ? 'produto' : rule?.company_id != null ? 'cliente' : rule?.user_id != null ? 'vendedor' : 'geral',
  );
  const [alvoId, setAlvoId] = useState(String(rule?.catalog_item_id ?? rule?.company_id ?? rule?.user_id ?? ''));
  const [percent, setPercent] = useState(rule ? String(Number(rule.percent)) : '');
  const [split, setSplit] = useState(rule ? String(Number(rule.vendedor_split_pct)) : '100');
  const [inicio, setInicio] = useState(rule?.vigencia_inicio?.slice(0, 10) ?? todayStr());
  const [fim, setFim] = useState(rule?.vigencia_fim?.slice(0, 10) ?? '');
  const [ativo, setAtivo] = useState(rule?.ativo ?? true);
  const [busy, setBusy] = useState(false);

  const opcoesAlvo: { id: number; label: string }[] =
    alvo === 'produto' ? catalog.map((c) => ({ id: c.id, label: c.nome }))
    : alvo === 'cliente' ? companies
    : alvo === 'vendedor' ? users.map((u) => ({ id: u.id, label: u.nome ?? u.email }))
    : [];

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (representedId === '' || percent.trim() === '' || !inicio) { toast.error('Preencha representada, comissão % e início de vigência.'); return; }
    if (alvo !== 'geral' && alvoId === '') { toast.error('Escolha o alvo da regra.'); return; }
    setBusy(true);
    const body = {
      represented_id: Number(representedId),
      catalog_item_id: alvo === 'produto' ? Number(alvoId) : null,
      company_id: alvo === 'cliente' ? Number(alvoId) : null,
      user_id: alvo === 'vendedor' ? Number(alvoId) : null,
      percent: dec(percent),
      vendedor_split_pct: split.trim() === '' ? 100 : dec(split),
      vigencia_inicio: inicio, vigencia_fim: fim || null, ativo,
    };
    try {
      if (rule) await api.patch(`/api/commission-rules/${rule.id}`, body);
      else await api.post('/api/commission-rules', body);
      toast.success(rule ? 'Regra salva.' : 'Regra criada.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar a regra.');
    } finally { setBusy(false); }
  };

  return (
    <Card className="border-brand-200 bg-brand-50/40 p-3">
      <form onSubmit={submit} className="space-y-2.5">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Representada *</span>
            <select value={representedId} onChange={(e) => setRepresentedId(e.target.value)} className={cn(inputCls, 'mt-1')}>
              <option value="">Escolha a representada</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Tipo de regra</span>
            <select value={alvo} aria-label="Tipo de regra"
              onChange={(e) => { setAlvo(e.target.value as typeof alvo); setAlvoId(''); }} className={cn(inputCls, 'mt-1')}>
              <option value="geral">Geral da representada</option>
              <option value="produto">Por produto</option>
              <option value="cliente">Por cliente</option>
              <option value="vendedor">Por vendedor</option>
            </select>
          </label>
        </div>
        {alvo !== 'geral' && (
          <select value={alvoId} aria-label="Alvo da regra" onChange={(e) => setAlvoId(e.target.value)} className={inputCls}>
            <option value="">Escolha {alvo === 'produto' ? 'o produto' : alvo === 'cliente' ? 'o cliente' : 'o vendedor'} *</option>
            {opcoesAlvo.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Comissão % *</span>
            <input type="text" inputMode="decimal" value={percent}
              onChange={(e) => setPercent(maskPct(e.target.value))} className={cn(inputCls, 'mt-1')} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Split vendedor %</span>
            <input type="text" inputMode="decimal" value={split}
              onChange={(e) => setSplit(maskPct(e.target.value))} className={cn(inputCls, 'mt-1')} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Vigência início *</span>
            <input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} className={cn(inputCls, 'mt-1')} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Vigência fim</span>
            <input type="date" value={fim} onChange={(e) => setFim(e.target.value)} className={cn(inputCls, 'mt-1')} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> Ativa
        </label>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar regra'}</Btn>
        </div>
      </form>
    </Card>
  );
}
