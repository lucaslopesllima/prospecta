import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { useSellers, SellerFilter, sellerLabel } from '../lib/sellers.tsx';
import { Alert, Badge, Btn, Card, EmptyState, ErrorState, PageHeader, Spinner, StatCard, cn } from '../lib/ui.tsx';
import { brl, brl0, todayStr } from '../lib/format.ts';

interface FunilStage { id: number; nome: string; ordem: number; qtd: number; valor: string }
interface Agenda { id: number; tipo: string; titulo: string; start_at: string; company_id: number | null; razao_social: string | null }
interface SemContato { id: number; company_id: number; razao_social: string; nome_fantasia: string | null; ultimo_contato: string; dias: number }
interface Parado { id: number; company_id: number; razao_social: string; nome_fantasia: string | null; stage: string | null; desde: string; dias: number }
interface RankRow { user_id: number; nome: string | null; email: string; total: string; qtd: number }
interface DashboardData {
  competencia: string;
  inatividade_dias: number;
  funil: FunilStage[];
  vendas: { total: number; qtd: number; meta: number };
  comissoes: { previsto: number; recebido: number; divergentes: number };
  agenda: Agenda[];
  alertas: { sem_contato: SemContato[]; parados: Parado[] };
  ranking: RankRow[];
}

const hora = (iso: string): string => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function KpiAction({ allowed, to, children }: { allowed: boolean; to: string; children: ReactNode }): React.JSX.Element {
  const cls = 'block rounded-2xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300';
  if (!allowed) return <div aria-disabled="true" className={cls}>{children}</div>;
  return <Link to={to} className={`${cls} hover:shadow-pop`}>{children}</Link>;
}

export function Dashboard(): React.JSX.Element {
  const { user, isOffice, can } = useAuth();
  const sellers = useSellers();
  const [competencia, setCompetencia] = useState(todayStr().slice(0, 7));
  const [ownerId, setOwnerId] = useState<'todos' | number>('todos');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    setRefreshing(true);
    const qs = new URLSearchParams({ competencia });
    if (ownerId !== 'todos') qs.set('user_id', String(ownerId));
    void api.get<DashboardData>(`/api/dashboard?${qs.toString()}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Falha ao carregar dashboard.'); })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, [competencia, ownerId, retryKey]);

  const funilTotal = data ? data.funil.reduce((s, f) => s + f.qtd, 0) : 0;
  const funilValor = data ? data.funil.reduce((s, f) => s + Number(f.valor), 0) : 0;
  const metaPct = data && data.vendas.meta > 0 ? Math.round((data.vendas.total / data.vendas.meta) * 100) : null;
  const context = new URLSearchParams({ competencia });
  if (ownerId !== 'todos') context.set('owner_user_id', String(ownerId));
  const ordersHref = `/pedidos?${context.toString()}`;
  const funnelHref = `/funil?${context.toString()}`;
  const commissionsHref = `/comissoes?${context.toString()}`;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Dashboard" subtitle="Visão geral da operação no mês."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {refreshing && data && <span role="status" aria-live="polite" className="text-xs font-medium text-ink-400">Atualizando…</span>}
            <SellerFilter value={ownerId} onChange={setOwnerId} sellers={sellers} />
            <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} aria-label="Competência"
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400" />
          </div>
        } />

      {loadError && !data ? <ErrorState hint={loadError} onRetry={() => setRetryKey((v) => v + 1)} /> : !data ? <Spinner /> : (
        <div aria-busy={refreshing} className={cn('space-y-5 transition-opacity', refreshing && 'opacity-60')}>
          {loadError && (
            <Alert tone="warn" className="items-center px-4 py-3">
              <span className="flex-1">Dados anteriores mantidos. Atualização falhou: {loadError}</span>
              <Btn size="sm" variant="ghost" onClick={() => setRetryKey((v) => v + 1)}>Tentar novamente</Btn>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {/* KPI → ação: cada card leva à tela onde o usuário age sobre o número */}
            {/* VGV (Valor Geral de Vendas): soma faturada/entregue da competência, mesmos filtros (mês + vendedor). */}
            <KpiAction allowed={can('orders.list')} to={ordersHref}>
              <StatCard label="Ticket médio" value={brl0(data.vendas.qtd > 0 ? data.vendas.total / data.vendas.qtd : 0)} icon="wallet" tone="brand"
                sub={`${data.vendas.qtd} venda(s) no mês`} />
            </KpiAction>
            <KpiAction allowed={can('orders.list')} to={ordersHref}>
              <StatCard label="Vendas do mês" value={brl0(data.vendas.total)} icon="trendingUp" tone="success"
                sub={metaPct != null ? `${metaPct}% da meta (${brl0(data.vendas.meta)})` : `${data.vendas.qtd} pedido(s)`} />
            </KpiAction>
            <KpiAction allowed={can('commissions.list')} to={commissionsHref}>
              <StatCard label="Comissões previstas" value={brl0(data.comissoes.previsto)} icon="percent" tone="info"
                sub={`Recebido ${brl0(data.comissoes.recebido)}`} />
            </KpiAction>
            <KpiAction allowed={can('relationships.list')} to={funnelHref}>
              <StatCard label="Negócios no funil" value={String(funilTotal)} icon="columns" tone="brand"
                sub={brl0(funilValor)} />
            </KpiAction>
            <KpiAction allowed={can('commissions.list')} to={`${commissionsHref}&status=divergente`}>
              <StatCard label="Divergências" value={String(data.comissoes.divergentes)} icon="alertTriangle"
                tone={data.comissoes.divergentes > 0 ? 'danger' : 'neutral'}
                sub={data.comissoes.divergentes > 0 ? 'tocar para conferir →' : 'tudo certo'} />
            </KpiAction>
          </div>

          {metaPct != null && (
            <Card className="p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-ink-700">Meta do mês</span>
                <span className="tabnums text-ink-500">{brl(data.vendas.total)} / {brl(data.vendas.meta)}</span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-ink-100">
                <div className={cn('h-full rounded-full', metaPct >= 100 ? 'bg-emerald-500' : metaPct >= 60 ? 'bg-amber-500' : 'bg-brand-500')}
                  style={{ width: `${Math.min(100, metaPct)}%` }} />
              </div>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Funil por stage */}
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-ink-900">Funil por etapa</h3>
              {funilTotal === 0 ? (
                <EmptyState icon="columns" title="Funil vazio" hint="Adicione empresas pela Prospecção."
                  action={<Link to="/prospeccao" className="text-sm font-semibold text-brand-700 hover:underline">Prospectar empresas</Link>} />
              ) : (
                <div className="space-y-2">
                  {data.funil.map((f) => {
                    const pct = funilTotal > 0 ? (f.qtd / funilTotal) * 100 : 0;
                    return (
                      <div key={f.id}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-ink-700">{f.nome}</span>
                          <span className="tabnums text-ink-400">{f.qtd} · {brl0(Number(f.valor))}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                          <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Agenda de hoje */}
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink-900">Agenda de hoje</h3>
                <Link to="/agenda" className="text-xs font-semibold text-brand-600 hover:underline">Ver agenda</Link>
              </div>
              {data.agenda.length === 0 ? (
                <EmptyState icon="calendar" title="Nada para hoje" hint="Sem compromissos pendentes." />
              ) : (
                <ul className="space-y-2">
                  {data.agenda.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 text-sm">
                      <span className="tabnums shrink-0 rounded-lg bg-ink-100 px-2 py-1 text-xs font-bold text-ink-600">{hora(a.start_at)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="truncate font-medium text-ink-800">{a.titulo}</span>
                        {a.razao_social && <span className="ml-1 truncate text-xs text-ink-400">· {a.razao_social}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Alertas */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h3 className="mb-1 text-sm font-semibold text-ink-900">Clientes sem contato</h3>
              <p className="mb-3 text-xs text-ink-400">Prospects sem contato há mais de {data.inatividade_dias} dias.</p>
              {data.alertas.sem_contato.length === 0 ? (
                <p className="text-sm text-ink-400">Tudo em dia.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.alertas.sem_contato.map((x) => (
                    <li key={x.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link to={`/funil?relationship_id=${x.id}`} className="truncate text-ink-700 hover:text-brand-600">{x.nome_fantasia || x.razao_social}</Link>
                      <Badge tone="warn">{x.dias} dias</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              <h3 className="mb-1 text-sm font-semibold text-ink-900">Negócios parados</h3>
              <p className="mb-3 text-xs text-ink-400">No mesmo estágio há 30+ dias.</p>
              {data.alertas.parados.length === 0 ? (
                <p className="text-sm text-ink-400">Nenhum negócio estagnado.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.alertas.parados.map((x) => (
                    <li key={x.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link to={`/funil?relationship_id=${x.id}`} className="min-w-0 truncate text-ink-700 hover:text-brand-600">
                        {x.nome_fantasia || x.razao_social}
                        {x.stage && <span className="ml-1 text-xs text-ink-400">· {x.stage}</span>}
                      </Link>
                      <Badge tone="danger">{x.dias} dias</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Ranking (admin consolidado) — só em conta escritório com equipe. */}
          {isOffice && data.ranking.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-ink-900">Ranking de vendas do mês</h3>
              <div className="space-y-2">
                {data.ranking.map((r, i) => {
                  const top = data.ranking[0] ? Number(data.ranking[0].total) : 0;
                  const pct = top > 0 ? (Number(r.total) / top) * 100 : 0;
                  return (
                    <div key={r.user_id} className="flex items-center gap-3">
                      <span className="tabnums w-5 shrink-0 text-xs font-bold text-ink-400">{i + 1}º</span>
                      <span className="w-32 shrink-0 truncate text-sm text-ink-700">{r.nome ?? r.email}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                        <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="tabnums w-28 shrink-0 text-right text-sm font-semibold text-ink-800">{brl0(Number(r.total))}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {isOffice && (
            <p className="text-center text-xs text-ink-300">
              {user?.role === 'admin' && ownerId === 'todos' ? 'Visão consolidada da organização' : `Vendedor: ${ownerId === 'todos' ? (user?.nome ?? user?.email) : sellerLabel(sellers.find((s) => Number(s.id) === ownerId) ?? { id: 0, nome: null, email: String(ownerId), role: 'rep', ativo: true })}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
