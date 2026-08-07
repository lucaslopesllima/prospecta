import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, BUSCA_DEBOUNCE_MS } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { useSellers, SellerFilter } from '../lib/sellers.tsx';
import type { Order, OrderStatus, RepresentedCompany } from '../lib/types.ts';
import { Badge, Btn, Card, cn, Collapse, EmptyState, FilterPanel, inputCls, Modal, PageHeader, RowActions, SafeButton, Spinner, StatRow, useIsNarrow, type Tone } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { brl, csvNum, fmtDate, maskSearchCNPJ } from '../lib/format.ts';
import { downloadCsv } from '../lib/export.ts';
import { toast } from '../lib/toast.tsx';
import { OrderModal } from '../lib/orderModal.tsx';
import { confirmDialog } from '../lib/confirm.ts';


const STATUS_META: Record<OrderStatus, { label: string; tone: Tone }> = {
  cotacao: { label: 'Cotação', tone: 'info' },
  rascunho: { label: 'Rascunho', tone: 'neutral' },
  enviado: { label: 'Enviado', tone: 'warn' },
  faturado: { label: 'Faturado', tone: 'success' },
  entregue: { label: 'Entregue', tone: 'brand' },
  cancelado: { label: 'Cancelado', tone: 'danger' },
};

// Próximo passo do fluxo feliz por status (cancelar tratado à parte).
const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  cotacao: { to: 'rascunho', label: 'Converter em pedido' },
  rascunho: { to: 'enviado', label: 'Enviar' },
  enviado: { to: 'faturado', label: 'Faturar' },
  faturado: { to: 'entregue', label: 'Entregar' },
};

// Página de pedidos vinda do servidor (default do GET /api/orders).
const PAGE = 100;

// Estado de abertura dos painéis (persistido) — mesmo padrão da Prospecção:
// filtros começam fechados, indicadores abertos.
const FILTERS_OPEN_KEY = 'pedidos:filtersOpen';
const KPIS_OPEN_KEY = 'pedidos:kpisOpen';

export function Orders(): React.JSX.Element {
  const { user, can, isOffice } = useAuth();
  // Coluna "Vendedor" só faz sentido com equipe: admin em conta escritório.
  const showOwner = user?.role === 'admin' && isOffice;
  const [params, setParams] = useSearchParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState<'todos' | OrderStatus>('todos');
  const [representedId, setRepresentedId] = useState<'todos' | number>('todos');
  const [ownerId, setOwnerId] = useState<'todos' | number>('todos');
  // Filtro de empresa (cliente) por nome ou CNPJ — vai debouncado ao servidor.
  const [companyQ, setCompanyQ] = useState('');
  const [companyTerm, setCompanyTerm] = useState('');
  const sellers = useSellers();
  // A tabela precisa de ~900px: no tablet com sidebar ainda não cabe.
  const mobile = useIsNarrow();
  const [editing, setEditing] = useState<Order | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [nfModal, setNfModal] = useState<Order | null>(null);
  // Painéis colapsáveis — mesmo padrão da Prospecção (toggle no header +
  // grid-rows, estado persistido). Filtros fechados / indicadores abertos.
  const [showFilters, setShowFilters] = useState(() => {
    try { return localStorage.getItem(FILTERS_OPEN_KEY) === '1'; } catch { return false; }
  });
  const [showKpis, setShowKpis] = useState(() => {
    try { return localStorage.getItem(KPIS_OPEN_KEY) !== '0'; } catch { return true; }
  });

  const [reps, setReps] = useState<RepresentedCompany[]>([]);

  // pré-preenchimento vindo do Kanban (?company_id=&represented_id=&relationship_id=)
  const prefill = useMemo(() => {
    const cid = params.get('company_id');
    if (!cid) return null;
    return {
      company_id: Number(cid),
      represented_id: params.get('represented_id') ? Number(params.get('represented_id')) : null,
      relationship_id: params.get('relationship_id') ? Number(params.get('relationship_id')) : null,
    };
  }, [params]);

  // Filtros de status/representada/vendedor vão para o servidor (paginado);
  // o vendedor (owner_user_id) só tem efeito para admin — para o rep o escopo
  // do token vence o querystring (scopeOwner).
  const buildQs = (offset: number): string => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (status !== 'todos') qs.set('status', status);
    if (representedId !== 'todos') qs.set('represented_id', String(representedId));
    if (ownerId !== 'todos') qs.set('owner_user_id', String(ownerId));
    if (companyTerm) qs.set('q', companyTerm);
    return qs.toString();
  };

  const load = async (): Promise<void> => {
    const r = await api.get<{ orders: Order[] }>(`/api/orders?${buildQs(0)}`);
    setOrders(r.orders);
    setHasMore(r.orders.length === PAGE);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [status, representedId, ownerId, companyTerm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce do campo de busca de empresa (300ms). <2 chars não filtra.
  useEffect(() => {
    const t = setTimeout(() => setCompanyTerm(companyQ.trim().length >= 2 ? companyQ.trim() : ''), BUSCA_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [companyQ]);

  useEffect(() => {
    try { localStorage.setItem(FILTERS_OPEN_KEY, showFilters ? '1' : '0'); } catch { /* storage indisponível */ }
  }, [showFilters]);
  useEffect(() => {
    try { localStorage.setItem(KPIS_OPEN_KEY, showKpis ? '1' : '0'); } catch { /* storage indisponível */ }
  }, [showKpis]);

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    try {
      const r = await api.get<{ orders: Order[] }>(`/api/orders?${buildQs(orders.length)}`);
      setOrders((xs) => [...xs, ...r.orders]);
      setHasMore(r.orders.length === PAGE);
    } finally { setLoadingMore(false); }
  };
  useEffect(() => {
    void api.get<{ empresas: RepresentedCompany[] }>('/api/represented')
      .then((r) => setReps(r.empresas.filter((e) => e.ativo))).catch(() => undefined);
  }, []);
  useEffect(() => { if (prefill) setAdding(true); }, [prefill]);

  // O servidor já filtra; o refino local só esconde linhas que deixaram de
  // casar após uma mutação otimista (ex.: transição de status).
  // Os ids do pedido vêm como STRING (bigint do pg em SELECT direto), enquanto os
  // filtros guardam NUMBER (Number(e.target.value) do <select>). Sem coagir,
  // `"7" === 7` é falso e escolher qualquer representada/vendedor esvazia a lista.
  const filtered = useMemo(() => orders.filter((o) =>
    (status === 'todos' || o.status === status)
    && (representedId === 'todos' || Number(o.represented_id) === representedId)
    && (ownerId === 'todos' || Number(o.owner_user_id) === ownerId)
  ), [orders, status, representedId, ownerId]);

  const kpis = useMemo(() => {
    let aberto = 0, faturado = 0;
    for (const o of filtered) {
      const v = Number(o.total);
      if (o.status === 'faturado' || o.status === 'entregue') faturado += v;
      else if (o.status !== 'cancelado') aberto += v;
    }
    return { aberto, faturado };
  }, [filtered]);

  const filtroAtivo = status !== 'todos' || representedId !== 'todos' || ownerId !== 'todos' || companyTerm !== '';

  const transition = async (o: Order, to: OrderStatus, nf?: string | null): Promise<void> => {
    // faturar pede o nº da NF — abre modal em vez de prompt nativo
    if (to === 'faturado' && nf === undefined) { setNfModal(o); return; }
    try {
      const r = await api.post<{ order: Order }>(`/api/orders/${o.id}/transition`, { status: to, nf_numero: nf ?? undefined });
      setOrders((xs) => xs.map((x) => (x.id === o.id ? r.order : x)));
      toast.success(to === 'cancelado' ? `Pedido #${o.numero} cancelado.` : `Pedido #${o.numero}: ${STATUS_META[to].label}.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível atualizar o pedido.'); }
  };

  const remove = async (o: Order): Promise<void> => {
    if (!(await confirmDialog(`Excluir o pedido #${o.numero}?`))) return;
    const before = orders;
    setOrders((xs) => xs.filter((x) => x.id !== o.id));
    try { await api.del(`/api/orders/${o.id}`); toast.success(`Pedido #${o.numero} excluído.`); }
    catch { setOrders(before); toast.error('Não foi possível excluir o pedido.'); }
  };

  const exportar = (): void => downloadCsv('pedidos',
    ['Número', 'Cliente', 'Representada', 'Vendedor', 'Status', 'NF', 'Total', 'Criado em'],
    filtered.map((o) => [o.numero, o.company_nome, o.represented_nome, o.owner_nome ?? o.owner_email ?? '',
      STATUS_META[o.status].label, o.nf_numero ?? '', csvNum(o.total), fmtDate(o.created_at)]));

  const openEdit = async (o: Order): Promise<void> => {
    const r = await api.get<{ order: Order }>(`/api/orders/${o.id}`);
    setEditing(r.order);
  };

  // Imprime o HTML do pedido/cotação (→ PDF). O HTML vem do servidor (papel
  // timbrado da org). Renderiza num iframe sandbox SEM allow-scripts: qualquer
  // <script> que escape do escape do servidor não executa (defesa em profundidade
  // contra XSS) — antes o document.write numa janela herdava a origem do app e
  // teria acesso ao token. allow-same-origin só p/ o parent disparar o print.
  const printOrder = async (o: Order): Promise<void> => {
    try {
      const { html } = await api.get<{ html: string }>(`/api/orders/${o.id}/print`);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      iframe.srcdoc = html;
      iframe.onload = (): void => {
        try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); }
        finally { setTimeout(() => iframe.remove(), 60_000); }
      };
      document.body.appendChild(iframe);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível gerar a impressão.'); }
  };

  const closeModal = (): void => {
    setAdding(false); setEditing(null);
    if (prefill) setParams({}, { replace: true });
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <PageHeader title="Pedidos" subtitle="Cotações e pedidos de venda por representada"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant={filtroAtivo ? 'primary' : 'soft'} icon="search"
              aria-expanded={showFilters} title={showFilters ? 'Recolher filtros' : 'Expandir filtros'}
              onClick={() => setShowFilters((v) => !v)}>
              Filtros
              <Icon name="chevronRight" size={15}
                className={cn('transition-transform duration-300 ease-out', showFilters ? 'rotate-90' : 'rotate-0')} />
            </Btn>
            <Btn variant="soft" icon="trendingUp"
              aria-expanded={showKpis} title={showKpis ? 'Recolher indicadores' : 'Expandir indicadores'}
              onClick={() => setShowKpis((v) => !v)}>
              Indicadores
              <Icon name="chevronRight" size={15}
                className={cn('transition-transform duration-300 ease-out', showKpis ? 'rotate-90' : 'rotate-0')} />
            </Btn>
            {can('orders.print') && (
              <Btn variant="ghost" icon="download" onClick={exportar} disabled={filtered.length === 0}>Exportar</Btn>
            )}
            {can('orders.import') && (
              <Btn variant="ghost" icon="arrowDown" onClick={() => setImporting(true)}>Importar NF</Btn>
            )}
            {can('orders.create') && (
              <Btn icon="plus" onClick={() => setAdding(true)}>Novo pedido</Btn>
            )}
          </div>
        } />

      {/* Desktop: acordeão inline. Celular: folha pelo rodapé — cobre a lista
          em vez de empurrá-la para fora da tela. */}
      <FilterPanel open={showFilters} onClose={() => setShowFilters(false)}
        titulo="Filtros dos pedidos"
        acao={{ label: `Ver ${filtered.length} pedido(s)`, onClick: () => setShowFilters(false) }}>
        <Card className="flex flex-wrap items-center gap-3 p-3 max-sm:flex-col max-sm:items-stretch max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none">
          <div className="relative min-w-[220px] flex-1">
            <Icon name="search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input value={companyQ} onChange={(e) => setCompanyQ(maskSearchCNPJ(e.target.value))}
              onKeyDown={(e) => { if (e.key === 'Enter') { const t = companyQ.trim(); setCompanyTerm(t.length >= 2 ? t : ''); } }}
              aria-label="Filtrar por empresa (nome ou CNPJ)" placeholder="Empresa: nome ou CNPJ"
              className="w-full rounded-lg border border-ink-200 bg-surface py-1.5 pl-8 pr-2.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400" />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filtrar por status"
            className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
            <option value="todos">Todos os status</option>
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={representedId} onChange={(e) => setRepresentedId(e.target.value === 'todos' ? 'todos' : Number(e.target.value))}
            aria-label="Filtrar por representada"
            className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-brand-400">
            <option value="todos">Todas as representadas</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
          </select>
          <SellerFilter value={ownerId} onChange={setOwnerId} sellers={sellers} />
        </Card>
      </FilterPanel>

      <Collapse open={showKpis} duration={200}>
        <StatRow cols={3} items={[
          { label: 'Em aberto', value: brl(kpis.aberto), icon: 'trendingUp', tone: 'info' },
          { label: 'Total faturado', value: brl(kpis.faturado), icon: 'check', tone: 'success' },
          { label: 'Pedidos', value: String(filtered.length), icon: 'list', tone: 'brand' },
        ]} />
      </Collapse>

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState icon="list" title="Nenhum pedido" hint="Crie uma cotação ou pedido para começar." />
      ) : (
        // A tabela tem 6 colunas e a célula de ações sozinha ocupa 240px fixos:
        // em 360px isso virava rolagem nos DOIS eixos, e o usuário arrastava de
        // lado perdendo de vista a linha que estava lendo. No celular cada
        // pedido vira um cartão; a tabela volta a partir de `md`.
        mobile ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-auto">
            {filtered.map((o) => (
              <OrderCard key={o.id} o={o} showOwner={showOwner} onEdit={() => openEdit(o)} onRemove={() => remove(o)}
                onTransition={(to) => transition(o, to)} onPrint={() => printOrder(o)} />
            ))}
          </div>
        ) : (
        <Card className="min-h-0 flex-1 overflow-auto p-0">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 text-left text-xs font-semibold uppercase tracking-wide text-ink-500 [&>tr>th]:border [&>tr>th]:border-ink-200 [&>tr>th]:bg-ink-100">
              <tr>
                <th className="w-14 px-3 py-2.5">#</th>
                <th className="w-full px-3 py-2.5">Cliente</th>
                {showOwner && <th className="w-px whitespace-nowrap px-3 py-2.5">Vendedor</th>}
                <th className="w-px whitespace-nowrap px-3 py-2.5">Status</th>
                <th className="w-px whitespace-nowrap px-3 py-2.5">Total</th>
                <th className="w-px whitespace-nowrap px-3 py-2.5">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <Row key={o.id} o={o} showOwner={showOwner} onEdit={() => openEdit(o)} onRemove={() => remove(o)}
                  onTransition={(to) => transition(o, to)} onPrint={() => printOrder(o)} />
              ))}
            </tbody>
          </table>
        </Card>
        )
      )}

      {!loading && hasMore && (
        <div className="flex justify-center">
          <Btn variant="soft" onClick={() => loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Carregando…' : 'Carregar mais'}
          </Btn>
        </div>
      )}

      {(adding || editing) && (
        <OrderModal order={editing} prefill={editing ? null : prefill}
          onClose={closeModal} onSaved={() => { closeModal(); void load(); }} />
      )}
      {importing && (
        <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); void load(); }} />
      )}
      {nfModal && (
        <NfModal order={nfModal} onClose={() => setNfModal(null)}
          onConfirm={(nf) => { const o = nfModal; setNfModal(null); void transition(o, 'faturado', nf); }} />
      )}
    </div>
  );
}

// Captura o nº da NF ao faturar — substitui o prompt() nativo. NF é opcional.
function NfModal({ order, onClose, onConfirm }: { order: Order; onClose: () => void; onConfirm: (nf: string | null) => void }): React.JSX.Element {
  const [nf, setNf] = useState('');
  const submit = (e: React.FormEvent): void => { e.preventDefault(); onConfirm(nf.trim() || null); };
  return (
    <Modal onClose={onClose} width="sm">
      <h3 className="mb-1 text-sm font-bold text-ink-900">Faturar pedido #{order.numero}</h3>
      <p className="mb-3 text-xs text-ink-400">Informe o número da nota fiscal (opcional).</p>
      <form onSubmit={submit} className="space-y-3">
        <input value={nf} onChange={(e) => setNf(e.target.value)} autoFocus inputMode="numeric"
          maxLength={20} placeholder="Número da NF" className={inputCls} />
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit">Faturar</Btn>
        </div>
      </form>
    </Modal>
  );
}

// Versão mobile da linha: mesmos dados e as mesmas ações, empilhados. A ação de
// avanço (o `next` do status) fica exposta porque é o que se faz num pedido;
// imprimir/cancelar/excluir vão para o `⋯` do RowActions.
function OrderCard({ o, showOwner, onEdit, onRemove, onTransition, onPrint }: {
  o: Order; showOwner: boolean; onEdit: () => Promise<void>; onRemove: () => Promise<void>;
  onTransition: (to: OrderStatus) => Promise<void>; onPrint: () => Promise<void>;
}): React.JSX.Element {
  const { can } = useAuth();
  const meta = STATUS_META[o.status];
  const next = NEXT[o.status];
  const editable = o.status === 'cotacao' || o.status === 'rascunho';
  const cancellable = o.status !== 'cancelado' && o.status !== 'entregue';
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <SafeButton onClick={onEdit} className="min-w-0 flex-1 text-left" title={editable ? 'Editar pedido' : 'Ver pedido'}>
          <span className="block truncate font-semibold text-ink-800">{o.company_nome}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-400">
            #{o.numero} · {o.represented_nome}
            {o.nf_numero ? ` · NF ${o.nf_numero}` : ''}
            {showOwner && o.owner_nome ? ` · ${o.owner_nome}` : ''}
          </span>
        </SafeButton>
        <RowActions
          actions={[
            { icon: 'download', label: 'Imprimir / PDF', onClick: onPrint, hidden: !can('orders.print') },
            { icon: 'x', label: 'Cancelar pedido', onClick: () => onTransition('cancelado'), tone: 'danger', hidden: !(cancellable && can('orders.delete')) },
            { icon: 'trash', label: 'Excluir pedido', onClick: onRemove, tone: 'danger', hidden: !(editable && can('orders.delete')) },
          ]} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span className="tabnums text-sm font-bold text-ink-800">{brl(Number(o.total))}</span>
        </div>
        {next && can('orders.transition') && (
          <Btn size="sm" variant="soft" onClick={() => onTransition(next.to)}>{next.label}</Btn>
        )}
      </div>
    </Card>
  );
}

function Row({ o, showOwner, onEdit, onRemove, onTransition, onPrint }: {
  o: Order; showOwner: boolean; onEdit: () => Promise<void>; onRemove: () => Promise<void>;
  onTransition: (to: OrderStatus) => Promise<void>; onPrint: () => Promise<void>;
}): React.JSX.Element {
  const { can } = useAuth();
  const meta = STATUS_META[o.status];
  const next = NEXT[o.status];
  const editable = o.status === 'cotacao' || o.status === 'rascunho';
  const owner = o.owner_nome ?? o.owner_email ?? '—';
  const cancellable = o.status !== 'cancelado' && o.status !== 'entregue';
  return (
    <tr className="transition-colors hover:bg-ink-50 [&>td]:border [&>td]:border-ink-200">
      <td className="px-3 py-2.5 align-middle">
        <span className="tabnums text-xs font-bold text-ink-500">#{o.numero}</span>
      </td>
      <td className="px-3 py-2.5 align-middle">
        <SafeButton onClick={onEdit} className="block max-w-[460px] text-left" title={editable ? 'Editar pedido' : 'Ver pedido'}>
          <span className="block truncate font-semibold text-ink-800">{o.company_nome}</span>
          <span className="block truncate text-xs text-ink-400">
            {o.represented_nome}
            {o.carrier_nome ?? o.transportadora ? ` · ${o.carrier_nome ?? o.transportadora}` : ''}
            {o.nf_numero ? ` · NF ${o.nf_numero}` : ''}
            {o.status === 'cotacao' && o.validade ? ` · válida até ${fmtDate(o.validade)}` : ''}
            {` · ${fmtDate(o.created_at)}`}
          </span>
        </SafeButton>
      </td>
      {showOwner && (
        <td className="max-w-[160px] truncate px-3 py-2.5 align-middle text-xs text-ink-500">{owner}</td>
      )}
      <td className="px-3 py-2.5 align-middle"><Badge tone={meta.tone}>{meta.label}</Badge></td>
      <td className="tabnums whitespace-nowrap px-3 py-2.5 align-middle text-sm font-bold text-ink-800">{brl(Number(o.total))}</td>
      <td className="px-3 py-2 align-middle">
        {/* slots de largura fixa → ícones alinham em coluna entre as linhas */}
        <div className="grid w-max grid-cols-[2rem_9rem_2rem_2rem] items-center justify-items-center gap-1">
          {can('orders.print') ? (
            <SafeButton onClick={onPrint} title="Imprimir / PDF"
              className="grid h-8 w-8 place-items-center rounded-lg text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-500/15"><Icon name="download" size={16} /></SafeButton>
          ) : <span />}
          {next && can('orders.transition') ? (
            <Btn variant="soft" title={next.label} className="w-full justify-center truncate px-2 text-xs" onClick={() => onTransition(next.to)}>{next.label}</Btn>
          ) : <span />}
          {cancellable && can('orders.delete') ? (
            <SafeButton onClick={() => onTransition('cancelado')} title="Cancelar pedido"
              className="grid h-8 w-8 place-items-center rounded-lg text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/15"><Icon name="x" size={16} /></SafeButton>
          ) : <span />}
          {editable && can('orders.delete') ? (
            <SafeButton onClick={onRemove} aria-label={`Excluir pedido ${o.numero}`} title="Excluir pedido"
              className="grid h-8 w-8 place-items-center rounded-lg text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/15"><Icon name="trash" size={16} /></SafeButton>
          ) : <span />}
        </div>
      </td>
    </tr>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ processadas: number; faturadas: number } | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ processadas: number; faturadas: number }>('/api/orders/import', { csv });
      setResult(r);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível importar.');
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} width="lg">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">Importar faturamento (CSV)</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-ink-100 hover:text-ink-800 sm:h-8 sm:w-8 sm:rounded-lg">
          <Icon name="x" size={17} />
        </button>
      </div>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            {result.faturadas} de {result.processadas} linha(s) faturada(s).
          </p>
          <div className="flex justify-end"><Btn onClick={onDone}>Concluir</Btn></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-ink-400">
            Cabeçalho com colunas <code>nf, data, cnpj, valor</code> (separador vírgula ou ponto-e-vírgula).
            Pedidos <strong>enviados</strong> com mesmo CNPJ e valor são marcados como faturados.
          </p>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} maxLength={1000000}
            placeholder={'nf;data;cnpj;valor\n123;01/06/2026;00.000.000/0000-00;1.234,56'}
            className={cn(inputCls, 'font-mono text-xs')} />
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
            <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Importar'}</Btn>
          </div>
        </form>
      )}
    </Modal>
  );
}
