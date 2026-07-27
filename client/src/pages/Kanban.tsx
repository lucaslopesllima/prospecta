import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Brand, CatalogItem, Contact, KanbanCard, NamedItem, PrivateLabel, RepresentedCompany, Stage } from '../lib/types.ts';
import { Badge, Btn, Collapse, PageHeader, Popover, SafeButton, Spinner, StatCard, cn, type Tone } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { CompanyFilterBar, useCompanyFilter } from '../lib/companyFilter.tsx';
import { useSellers, SellerFilter } from '../lib/sellers.tsx';
import { CompanyModal } from '../lib/companyModal.tsx';
import { ActivityCreateModal } from '../lib/activityModal.tsx';
import { SampleRequestModal, SampleListModal } from '../lib/sampleModal.tsx';
import { brl0 as brl, clampNum, isEmail, maskMoney, maskPhone, numStr } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';

const STATUS_TONE: Record<string, Tone> = {
  prospect: 'info', cliente: 'success', descartado: 'neutral',
};
const STATUS_LABEL: Record<string, string> = {
  prospect: 'Prospect', cliente: 'Cliente', descartado: 'Descartado',
};
const STATUS_OPTS = ['prospect', 'cliente', 'descartado'] as const;
const inputCls = 'w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200';
const FILTERS_OPEN_KEY = 'funil:filtersOpen';
const KPIS_OPEN_KEY = 'funil:kpisOpen';

// Card do board: /api/kanban devolve a contagem de amostras (amostras_count)
// em vez do array completo — a lista é carregada sob demanda no modal de amostras.
type BoardCard = KanbanCard & { amostras_count?: number };

export function Kanban(): React.JSX.Element {
  const [stages, setStages] = useState<Stage[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<number | 'none' | null>(null);
  const [editing, setEditing] = useState<BoardCard | null>(null);
  const [moveFor, setMoveFor] = useState<number | null>(null); // card com menu "mover" aberto
  const [viewing, setViewing] = useState<number | null>(null); // company_id em visualização
  const [sampleFor, setSampleFor] = useState<BoardCard | null>(null); // card criando amostra
  const [samplesView, setSamplesView] = useState<BoardCard | null>(null); // card vendo/editando amostras
  const [reps, setReps] = useState<RepresentedCompany[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [scenarios, setScenarios] = useState<NamedItem[]>([]);
  const [actions, setActions] = useState<NamedItem[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);

  const [filtersOpen, setFiltersOpen] = useState(() => {
    try { return localStorage.getItem(FILTERS_OPEN_KEY) === '1'; } catch { return false; }
  });
  const [kpisOpen, setKpisOpen] = useState(() => {
    try { return localStorage.getItem(KPIS_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const [ownerId, setOwnerId] = useState<'todos' | number>('todos');
  const sellers = useSellers();
  const filter = useCompanyFilter('funil');

  const load = useCallback(async (): Promise<void> => {
    const r = await api.get<{ stages: Stage[]; cards: BoardCard[] }>('/api/kanban');
    setStages(r.stages);
    setCards(r.cards);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void Promise.all([
      api.get<{ empresas: RepresentedCompany[] }>('/api/represented').then((r) => setReps(r.empresas)),
      api.get<{ brands: Brand[] }>('/api/brands').then((r) => setBrands(r.brands)),
      api.get<{ items: NamedItem[] }>('/api/scenarios').then((r) => setScenarios(r.items)),
      api.get<{ items: NamedItem[] }>('/api/actions').then((r) => setActions(r.items)),
      api.get<{ items: CatalogItem[] }>('/api/catalog').then((r) => setCatalog(r.items)),
    ]).catch(() => undefined);
  }, []);

  // Persiste se a barra de filtros está aberta.
  useEffect(() => {
    try { localStorage.setItem(FILTERS_OPEN_KEY, filtersOpen ? '1' : '0'); } catch { /* storage indisponível */ }
  }, [filtersOpen]);

  // Persiste se os indicadores (KPIs) estão expandidos.
  useEffect(() => {
    try { localStorage.setItem(KPIS_OPEN_KEY, kpisOpen ? '1' : '0'); } catch { /* storage indisponível */ }
  }, [kpisOpen]);

  // Espelho dos cards em ref: `move` fica estável (useCallback sem depender de
  // `cards`) e os handlers do CardItem (React.memo) não recriam a cada render.
  const cardsRef = useRef<BoardCard[]>([]);
  cardsRef.current = cards;

  const move = useCallback(async (cardId: number, stageId: number | null): Promise<void> => {
    const card = cardsRef.current.find((c) => c.id === cardId);
    if (!card || card.stage_id === stageId) return;
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, stage_id: stageId } : c))); // optimistic
    try {
      // Server pode virar status='cliente' ao chegar na última coluna -> reflete na hora.
      const r = await api.patch<{ relationship: KanbanCard }>(`/api/relationships/${cardId}`, { stage_id: stageId });
      setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, status: r.relationship.status } : c)));
    } catch {
      void load(); // revert from server on failure
      toast.error('Não foi possível mover o card.');
    }
  }, [load]);

  // Handlers estáveis passados ao CardItem (React.memo).
  const onDragStartCard = useCallback((id: number) => setDragId(id), []);
  const onDragEndCard = useCallback(() => { setDragId(null); setOver(null); }, []);
  const onMoveCard = useCallback((id: number, stageId: number | null) => { const p = move(id, stageId); setMoveFor(null); return p; }, [move]);
  const onEditCard = useCallback((c: BoardCard) => setEditing(c), []);
  const onToggleMenu = useCallback((id: number) => setMoveFor((m) => (m === id ? null : id)), []);
  const onCloseMenu = useCallback(() => setMoveFor(null), []);
  const onViewCompany = useCallback((companyId: number) => setViewing(companyId), []);
  const onSampleCard = useCallback((c: BoardCard) => setSampleFor(c), []);
  const onSamplesCard = useCallback((c: BoardCard) => setSamplesView(c), []);

  const saveEdit = async (id: number, patch: EditPatch): Promise<void> => {
    try {
      await api.patch(`/api/relationships/${id}`, patch);
      await load(); // refetch so the joined dropdown labels (marca, contato, etc.) come back fresh
      setEditing(null);
      toast.success('Prospecção atualizada.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };

  const removeFromFunnel = async (id: number): Promise<void> => {
    setCards((cs) => cs.filter((c) => c.id !== id)); // optimista
    setEditing(null);
    try { await api.del(`/api/relationships/${id}`); toast.success('Empresa removida do funil.'); }
    catch { void load(); toast.error('Não foi possível remover do funil.'); }
  };

  const visibleCards = useMemo(
    () => filter.apply(cards).filter((c) => ownerId === 'todos' || c.owner_user_id === ownerId),
    [filter.apply, cards, ownerId],
  );

  // Agrupa os cards por etapa uma única vez (em vez de um .filter por coluna).
  const cardsByColumn = useMemo(() => {
    const m = new Map<number | 'none', BoardCard[]>();
    for (const c of visibleCards) {
      const key = c.stage_id ?? 'none';
      const list = m.get(key);
      if (list) list.push(c); else m.set(key, [c]);
    }
    return m;
  }, [visibleCards]);

  if (loading) return <div className="p-6"><Spinner /></div>;

  const columns: { key: number | 'none'; nome: string }[] = [
    ...stages.map((s) => ({ key: s.id as number | 'none', nome: s.nome })),
  ];
  const hasOrphans = (cardsByColumn.get('none')?.length ?? 0) > 0;
  if (hasOrphans) columns.unshift({ key: 'none', nome: 'Sem etapa' });

  const totalValor = visibleCards.reduce((s, c) => s + Number(c.valor_estimado ?? 0), 0);
  const clientes = visibleCards.filter((c) => c.status === 'cliente').length;
  const oculto = cards.length - visibleCards.length;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-4 p-4 sm:p-6">
        <PageHeader title="Funil de vendas" subtitle="Arraste os cards ou use o botão → para mover entre etapas."
          actions={
            <div className="flex items-center gap-2">
              <Btn variant={filter.filtroAtivo ? 'primary' : 'soft'} icon="search"
                aria-expanded={filtersOpen} title={filtersOpen ? 'Recolher filtros' : 'Expandir filtros'}
                onClick={() => setFiltersOpen((v) => !v)}>
                Filtros{oculto > 0 ? ` · ${oculto} ocultos` : ''}
                <Icon name="chevronRight" size={15}
                  className={cn('transition-transform duration-300 ease-out', filtersOpen ? 'rotate-90' : 'rotate-0')} />
              </Btn>
              <Btn variant="soft" icon="trendingUp"
                aria-expanded={kpisOpen} title={kpisOpen ? 'Recolher indicadores' : 'Expandir indicadores'}
                onClick={() => setKpisOpen((v) => !v)}>
                Indicadores
                <Icon name="chevronRight" size={15}
                  className={cn('transition-transform duration-300 ease-out', kpisOpen ? 'rotate-90' : 'rotate-0')} />
              </Btn>
              <SellerFilter value={ownerId} onChange={setOwnerId} sellers={sellers} />
            </div>
          } />

        <Collapse open={filtersOpen} duration={1500}>
          <CompanyFilterBar f={filter} />
        </Collapse>

        <Collapse open={kpisOpen} duration={1000}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={oculto > 0 ? 'Negócios (filtrados)' : 'Negócios'} value={visibleCards.length} icon="layers" tone="brand" />
            <StatCard label="Valor em funil" value={brl(totalValor)} icon="trendingUp" tone="success" />
            <StatCard label="Clientes" value={clientes} icon="users" tone="info" />
            <StatCard label="Etapas" value={stages.length} icon="columns" tone="neutral" />
          </div>
        </Collapse>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 sm:px-6 sm:pb-6">
        {columns.map((col) => {
          const colCards = cardsByColumn.get(col.key) ?? [];
          const valor = colCards.reduce((s, c) => s + Number(c.valor_estimado ?? 0), 0);
          const target = col.key === 'none' ? null : (col.key as number);
          const active = over === col.key;
          return (
            <div key={String(col.key)}
              // só troca o estado quando a coluna sob o drag muda — dragover
              // dispara continuamente e re-renderizava o board inteiro.
              onDragOver={(e) => { e.preventDefault(); setOver((p) => (p === col.key ? p : col.key)); }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={() => { if (dragId !== null) void move(dragId, target); setDragId(null); setOver(null); }}
              className={cn('flex w-72 shrink-0 flex-col rounded-2xl border p-2 transition-colors',
                active ? 'border-brand-300 bg-brand-50/60' : 'border-ink-200/70 bg-ink-100/50')}>
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-sm font-semibold text-ink-700">{col.nome}</span>
                <span className="tabnums rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-ink-500 shadow-card">{colCards.length}</span>
              </div>
              {valor > 0 && (
                <p className="tabnums px-2 pb-1.5 text-xs font-medium text-ink-400">{brl(valor)}</p>
              )}
              <div className="flex-1 space-y-2 overflow-auto px-0.5 pb-1">
                {colCards.map((c) => (
                  <CardItem key={c.id} c={c} stages={stages}
                    dragging={dragId === c.id} menuOpen={moveFor === c.id}
                    onDragStartCard={onDragStartCard} onDragEndCard={onDragEndCard}
                    onMove={onMoveCard} onEdit={onEditCard}
                    onToggleMenu={onToggleMenu} onCloseMenu={onCloseMenu}
                    onView={onViewCompany} onSample={onSampleCard} onSamples={onSamplesCard} />
                ))}
                {colCards.length === 0 && (
                  <p className="rounded-xl border border-dashed border-ink-200 px-2 py-6 text-center text-xs text-ink-300">
                    Solte cards aqui
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <EditModal card={editing} stages={stages} reps={reps} brands={brands}
          scenarios={scenarios} actions={actions} catalog={catalog}
          onCatalogCreated={(it) => setCatalog((xs) => [...xs, it])}
          onRemove={removeFromFunnel}
          onSave={saveEdit} onClose={() => setEditing(null)} />
      )}
      {viewing !== null && (
        <CompanyModal companyId={viewing} onClose={() => setViewing(null)} />
      )}
      {sampleFor && (
        <SampleRequestModal
          card={{ id: sampleFor.id, company_id: sampleFor.company_id, label: sampleFor.nome_fantasia || sampleFor.razao_social }}
          catalog={catalog}
          onClose={() => setSampleFor(null)}
          onSaved={() => { setSampleFor(null); void load(); }}
        />
      )}
      {samplesView && (
        <SampleListModal
          card={{ id: samplesView.id, company_id: samplesView.company_id, label: samplesView.nome_fantasia || samplesView.razao_social }}
          catalog={catalog}
          onClose={() => setSamplesView(null)}
          onChanged={() => { void load(); }}
        />
      )}
    </div>
  );
}

// Card do board extraído em React.memo com props/handlers estáveis: arrastar
// sobre uma coluna (over) ou abrir o menu de um card não re-renderiza os demais.
const CardItem = memo(function CardItem({ c, stages, dragging, menuOpen, onDragStartCard, onDragEndCard, onMove, onEdit, onToggleMenu, onCloseMenu, onView, onSample, onSamples }: {
  c: BoardCard; stages: Stage[]; dragging: boolean; menuOpen: boolean;
  onDragStartCard: (id: number) => void; onDragEndCard: () => void;
  onMove: (id: number, stageId: number | null) => void;
  onEdit: (c: BoardCard) => void;
  onToggleMenu: (id: number) => void; onCloseMenu: () => void;
  onView: (companyId: number) => void;
  onSample: (c: BoardCard) => void; onSamples: (c: BoardCard) => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // /api/kanban manda só a contagem; o array completo é fallback (compat).
  const nAmostras = c.amostras_count ?? c.amostras?.length ?? 0;
  return (
    <div draggable={can('relationships.update')}
      onDragStart={() => onDragStartCard(c.id)}
      onDragEnd={onDragEndCard}
      className={cn('group relative cursor-grab rounded-xl border border-ink-200/70 bg-surface p-3 shadow-card transition active:cursor-grabbing',
        dragging && 'opacity-50')}>
      <div className="absolute right-2 top-2 flex items-center gap-0.5">
        {can('relationships.update') && (
          <button type="button"
            onClick={() => onEdit(c)}
            title="Editar prospecção"
            className="rounded-lg p-1 text-ink-300 transition hover:bg-ink-100 hover:text-ink-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
            <Icon name="pencil" size={14} />
          </button>
        )}
        {can('relationships.update') && (
          <button type="button" ref={menuBtnRef}
            onClick={() => onToggleMenu(c.id)}
            aria-label="Mover para outra etapa" aria-haspopup="menu" aria-expanded={menuOpen}
            title="Mover para…"
            className="rounded-lg p-1 text-ink-300 transition hover:bg-ink-100 hover:text-ink-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
            <Icon name="arrowRight" size={14} />
          </button>
        )}
      </div>
      {/* Menu em portal: a coluna do funil rola (overflow-auto) e cortava o
          menu dos cards do fim da lista. */}
      <Popover open={menuOpen} anchorRef={menuBtnRef} onClose={onCloseMenu} width={176}>
        <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">Mover para</p>
        {stages.map((s) => (
          <SafeButton key={s.id} type="button" role="menuitem" disabled={c.stage_id === s.id}
            onClick={() => onMove(c.id, s.id)}
            className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
              c.stage_id === s.id ? 'font-semibold text-brand-600' : 'text-ink-700 hover:bg-ink-50')}>
            {c.stage_id === s.id && <Icon name="check" size={13} />}{s.nome}
          </SafeButton>
        ))}
      </Popover>
      <div className="pr-12">
        <button type="button" onClick={() => onView(c.company_id)}
          title="Ver dados da empresa"
          className="block max-w-full truncate text-left text-sm font-semibold text-ink-800 transition-colors hover:text-brand-600 hover:underline">
          {c.nome_fantasia || c.razao_social}
        </button>
      </div>
      <p className="truncate text-xs text-ink-400">{c.razao_social}</p>
      {(c.marca || (c.contatos?.length ?? 0) > 0) && (
        <p className="mt-1 truncate text-xs text-ink-500">
          {[c.marca, (c.contatos ?? []).map((x) => x.nome).join(', ')].filter(Boolean).join(' · ')}
        </p>
      )}
      {(c.catalogo?.length ?? 0) > 0 && (
        <p className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-ink-400">
          <Icon name="box" size={12} className="shrink-0" />
          <span className="truncate">{c.catalogo.map((x) => x.nome).join(', ')}</span>
        </p>
      )}
      {nAmostras > 0 && (
        <button type="button" onClick={() => onSamples(c)}
          title="Ver/editar amostras solicitadas"
          className="mt-1 inline-flex max-w-full items-center gap-1 truncate rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100">
          <Icon name="flask" size={12} className="shrink-0" />
          <span className="truncate">{nAmostras} amostra{nAmostras > 1 ? 's' : ''}</span>
        </button>
      )}
      {c.valor_estimado && Number(c.valor_estimado) > 0 && (
        <p className="tabnums mt-1 text-xs font-semibold text-emerald-600">{brl(Number(c.valor_estimado))}</p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-ink-400">
          <Icon name="mapPin" size={12} className="shrink-0" />
          <span className="truncate">{[c.cidade, c.uf].filter(Boolean).join(' · ')}</span>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* âncora simples (não NavLink): o Kanban também renderiza fora de Router nos testes */}
        {can('orders.create') && (
          <a href={`/pedidos?company_id=${c.company_id}&relationship_id=${c.id}${c.represented_id != null ? `&represented_id=${c.represented_id}` : ''}`}
            title="Novo pedido"
            className="inline-flex items-center gap-1 rounded-lg bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-600 transition hover:bg-brand-50 hover:text-brand-700">
            <Icon name="plus" size={13} /> Pedido
          </a>
        )}
        {can('sample_requests.create') && (
          <button type="button" onClick={() => onSample(c)} title="Solicitar amostra"
            className="inline-flex items-center gap-1 rounded-lg bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-600 transition hover:bg-brand-50 hover:text-brand-700">
            <Icon name="flask" size={13} /> +Amostra
          </button>
        )}
        {c.telefone1 && (
          <SafeButton type="button" title="Abrir conversa no WhatsApp"
            onClick={() => api.post<{ chat: { id: number } }>('/api/whatsapp/chats/from-company', { company_id: c.company_id, numero: c.telefone1 })
              .then((r) => { window.location.href = `/whatsapp?chat=${r.chat.id}`; })
              .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Falha ao abrir WhatsApp'))}
            className="inline-flex items-center gap-1 rounded-lg bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-600 transition hover:bg-emerald-50 hover:text-emerald-700">
            <Icon name="phone" size={13} /> WhatsApp
          </SafeButton>
        )}
      </div>
    </div>
  );
});

interface EditPatch {
  stage_id: number | null; status: string; valor_estimado: number | null; notas: string | null;
  represented_id: number | null; marca_id: number | null; contato_ids: number[]; catalogo_ids: number[];
  cenario_id: number | null; acao_id: number | null;
  data_contato: string | null; previsao_data: string | null; motivo_descarte: string | null;
}

const txt = (s: string): string | null => (s.trim() === '' ? null : s.trim());
const numOrNull = (s: string): number | null => (s === '' ? null : Number(s));
// Id vindo da API pode ser number (json_agg) ou string (bigint em SELECT direto).
// Normaliza para number antes de qualquer comparação/inclusão.
const nid = (v: number | string): number => Number(v);
const Field = ({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>
    {children}
  </label>
);

function EditModal({ card, stages, reps, brands, scenarios, actions, catalog, onCatalogCreated, onRemove, onSave, onClose }: {
  card: KanbanCard; stages: Stage[]; reps: RepresentedCompany[]; brands: Brand[];
  scenarios: NamedItem[]; actions: NamedItem[]; catalog: CatalogItem[];
  onCatalogCreated: (item: CatalogItem) => void;
  onRemove: (id: number) => void | Promise<void>;
  onSave: (id: number, patch: EditPatch) => Promise<void>; onClose: () => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const [stageId, setStageId] = useState<number | null>(card.stage_id);
  const [status, setStatus] = useState<string>(card.status);
  const [valor, setValor] = useState<string>(numStr(card.valor_estimado));
  const [representadaId, setRepresentadaId] = useState<number | null>(card.represented_id);
  const [marcaId, setMarcaId] = useState<number | null>(card.marca_id);
  const [contatoIds, setContatoIds] = useState<number[]>(card.contatos.map((c) => nid(c.id)));
  const [catalogoIds, setCatalogoIds] = useState<number[]>(card.catalogo.map((c) => nid(c.id)));
  const [cenarioId, setCenarioId] = useState<number | null>(card.cenario_id);
  const [acaoId, setAcaoId] = useState<number | null>(card.acao_id);
  const [dataContato, setDataContato] = useState<string>(card.data_contato ?? '');
  const [previsaoData, setPrevisaoData] = useState<string>(card.previsao_data ?? '');
  const [motivoDescarte, setMotivoDescarte] = useState<string>(card.motivo_descarte ?? '');
  const [notas, setNotas] = useState<string>(card.notas ?? '');
  const [busy, setBusy] = useState(false);

  // Contatos da empresa-cliente deste card (carregados sob demanda) + criação via modal.
  const [contatos, setContatos] = useState<Contact[]>([]);
  const [creating, setCreating] = useState(false);
  const [creatingProd, setCreatingProd] = useState(false);
  const [creatingActivity, setCreatingActivity] = useState(false);

  // Private labels da EMPRESA (não do card): o vínculo vive em
  // private_label_companies, então salvar faz PUT em /api/companies/:id/private-labels
  // — separado do PATCH do relationship. `labelIni` detecta se houve mudança.
  const verLabels = can('private_labels.list');
  const editLabels = can('private_labels.update');
  const [labels, setLabels] = useState<PrivateLabel[]>([]);
  const [labelIds, setLabelIds] = useState<number[]>([]);
  const [labelIni, setLabelIni] = useState<number[]>([]);
  const [creatingLabel, setCreatingLabel] = useState(false);

  useEffect(() => {
    void api.get<{ contacts: Contact[] }>(`/api/contacts?company_id=${card.company_id}`)
      .then((r) => setContatos(r.contacts)).catch(() => undefined);
  }, [card.company_id]);

  useEffect(() => {
    if (!verLabels) return;
    void api.get<{ labels: PrivateLabel[] }>('/api/private-labels')
      .then((r) => setLabels(r.labels ?? [])).catch(() => undefined);
    void api.get<{ labels: PrivateLabel[] }>(`/api/companies/${card.company_id}/private-labels`)
      .then((r) => { const ids = (r.labels ?? []).map((l) => nid(l.id)); setLabelIds(ids); setLabelIni(ids); })
      .catch(() => undefined);
  }, [card.company_id, verLabels]);

  // Marca filtrada pela representada selecionada.
  const marcasFiltradas = brands.filter((b) => representadaId == null || b.represented_id === representadaId);
  // Os ids das listas de apoio (/api/contacts, /api/catalog, /api/private-labels)
  // chegam como STRING — bigint do pg sai como texto no SELECT direto. Já os ids
  // dentro do card vêm de json_agg, onde bigint vira NUMBER. Comparar sem coagir
  // (`"7" === 7`) faz o item nunca ser encontrado: o selecionado não vira pill e
  // continua listado como disponível. Por isso `nid` nos dois lados.
  const selecionados = contatoIds
    .map((id) => contatos.find((c) => nid(c.id) === id))
    .filter((c): c is Contact => !!c);
  const disponiveis = contatos.filter((c) => !contatoIds.includes(nid(c.id)));
  const catSel = catalogoIds.map((id) => catalog.find((c) => nid(c.id) === id)).filter((c): c is CatalogItem => !!c);
  const catDisp = catalog.filter((c) => c.ativo && !catalogoIds.includes(nid(c.id)));
  const labelSel = labelIds.map((id) => labels.find((l) => nid(l.id) === id)).filter((l): l is PrivateLabel => !!l);
  const labelDisp = labels.filter((l) => !labelIds.includes(nid(l.id)));

  const onCreatedContato = (c: Contact): void => {
    setContatos((xs) => [...xs, c]);
    setContatoIds((ids) => [...ids, nid(c.id)]);
    setCreating(false);
  };

  const onCreatedLabel = (l: PrivateLabel): void => {
    setLabels((xs) => [...xs, l].sort((a, b) => a.nome.localeCompare(b.nome)));
    setLabelIds((ids) => [...ids, nid(l.id)]);
    setCreatingLabel(false);
  };

  const onCreatedProduto = (it: CatalogItem): void => {
    onCatalogCreated(it);
    setCatalogoIds((ids) => [...ids, nid(it.id)]);
    setCreatingProd(false);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      // Vínculo de private label é da empresa, em rota própria — vai antes do
      // PATCH porque onSave fecha o modal em caso de sucesso.
      const mudou = labelIds.length !== labelIni.length || labelIds.some((id) => !labelIni.includes(id));
      if (editLabels && mudou) {
        try {
          await api.put(`/api/companies/${card.company_id}/private-labels`, { label_ids: labelIds });
          api.invalidate('/api/private-labels'); // contagens do catálogo
          setLabelIni(labelIds);
        } catch (e2) {
          toast.error(e2 instanceof Error ? e2.message : 'Não foi possível salvar as private labels.');
          return;
        }
      }
      await onSave(card.id, {
        stage_id: stageId,
        status,
        valor_estimado: valor.trim() === '' ? null : clampNum(valor, 0, 1e9),
        represented_id: representadaId,
        marca_id: marcaId,
        contato_ids: contatoIds,
        catalogo_ids: catalogoIds,
        cenario_id: cenarioId,
        acao_id: acaoId,
        data_contato: dataContato === '' ? null : dataContato,
        previsao_data: previsaoData === '' ? null : previsaoData,
        // motivo só faz sentido em descartado; nos demais status limpa o campo.
        motivo_descarte: status === 'descartado' ? txt(motivoDescarte) : null,
        notas: txt(notas),
      });
    } finally { setBusy(false); }
  };

  return (
   <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-ink-200 bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink-800">{card.nome_fantasia || card.razao_social}</h2>
            <p className="truncate text-xs text-ink-400">{card.razao_social}</p>
            {(card.cidade || card.uf) && (
              <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-400">
                <Icon name="mapPin" size={12} />{[card.cidade, card.uf].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose}
            className="rounded-lg p-1 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700">
            <Icon name="x" size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 overflow-y-auto p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Etapa do funil">
                <select value={stageId ?? ''} onChange={(e) => setStageId(numOrNull(e.target.value))} className={inputCls}>
                  <option value="">Sem etapa</option>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                  {STATUS_OPTS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </Field>
              {status === 'descartado' && (
                <Field label="Motivo do descarte">
                  <input value={motivoDescarte} onChange={(e) => setMotivoDescarte(e.target.value)}
                    maxLength={2000} placeholder="ex.: Preço alto, sem fit, concorrente" className={inputCls} />
                </Field>
              )}
              <Field label="Representada">
                <select value={representadaId ?? ''}
                  onChange={(e) => { setRepresentadaId(numOrNull(e.target.value)); setMarcaId(null); }}
                  className={inputCls}>
                  <option value="">—</option>
                  {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                </select>
              </Field>
              <Field label="Marca">
                <select value={marcaId ?? ''} onChange={(e) => setMarcaId(numOrNull(e.target.value))}
                  disabled={representadaId == null} className={cn(inputCls, representadaId == null && 'opacity-50')}>
                  <option value="">{representadaId == null ? 'Escolha a representada' : '—'}</option>
                  {marcasFiltradas.map((b) => <option key={b.id} value={b.id}>{b.nome}</option>)}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-ink-500">Contatos</span>
                {selecionados.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {selecionados.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-700">
                        {c.nome}{c.cargo ? ` · ${c.cargo}` : ''}
                        {c.telefone && (
                          <SafeButton type="button" title="Iniciar conversa no WhatsApp" aria-label="Iniciar conversa"
                            onClick={() => api.post<{ chat: { id: number } }>('/api/whatsapp/chats/from-company', { company_id: card.company_id, numero: c.telefone, nome: c.nome })
                              .then((r) => { window.location.href = `/whatsapp?chat=${r.chat.id}`; })
                              .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Falha ao abrir WhatsApp'))}
                            className="text-emerald-600 hover:text-emerald-700">
                            <Icon name="whatsapp" size={13} />
                          </SafeButton>
                        )}
                        <button type="button" onClick={() => setContatoIds((ids) => ids.filter((x) => x !== c.id))}
                          className="text-ink-400 hover:text-rose-500" aria-label="Remover">
                          <Icon name="x" size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <select value="" onChange={(e) => { const id = numOrNull(e.target.value); if (id != null) setContatoIds((ids) => [...ids, id]); }}
                    className={cn(inputCls, 'flex-1')} disabled={disponiveis.length === 0}>
                    <option value="">{disponiveis.length === 0 ? 'Nenhum contato disponível' : 'Adicionar contato…'}</option>
                    {disponiveis.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.cargo ? ` (${c.cargo})` : ''}</option>)}
                  </select>
                  <Btn size="sm" variant="soft" type="button" icon="plus" onClick={() => setCreating(true)} title="Criar novo contato" />
                </div>
              </div>
              {verLabels && (
                <div className="sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-ink-500">Private labels</span>
                  {labelSel.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {labelSel.map((l) => (
                        <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-700">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: l.cor || '#94a3b8' }} />
                          {l.nome}
                          {editLabels && (
                            <button type="button" onClick={() => setLabelIds((ids) => ids.filter((x) => x !== l.id))}
                              className="text-ink-400 hover:text-rose-500" aria-label="Remover">
                              <Icon name="x" size={13} />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {editLabels && (
                    <div className="flex gap-2">
                      <select value="" onChange={(e) => { const id = numOrNull(e.target.value); if (id != null) setLabelIds((ids) => [...ids, id]); }}
                        className={cn(inputCls, 'flex-1')} disabled={labelDisp.length === 0}>
                        <option value="">{labels.length === 0 ? 'Nenhuma private label cadastrada' : labelDisp.length === 0 ? 'Todas adicionadas' : 'Adicionar private label…'}</option>
                        {labelDisp.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                      </select>
                      {can('private_labels.create') && (
                        <Btn size="sm" variant="soft" type="button" icon="plus" onClick={() => setCreatingLabel(true)} title="Criar nova private label" />
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-ink-500">Catálogo</span>
                {catSel.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {catSel.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-700">
                        {c.nome}{c.codigo ? ` · ${c.codigo}` : ''}
                        <button type="button" onClick={() => setCatalogoIds((ids) => ids.filter((x) => x !== c.id))}
                          className="text-ink-400 hover:text-rose-500" aria-label="Remover">
                          <Icon name="x" size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <select value="" onChange={(e) => { const id = numOrNull(e.target.value); if (id != null) setCatalogoIds((ids) => [...ids, id]); }}
                    className={cn(inputCls, 'flex-1')} disabled={catDisp.length === 0}>
                    <option value="">{catalog.length === 0 ? 'Nenhum item no catálogo' : catDisp.length === 0 ? 'Todos adicionados' : 'Adicionar item do catálogo…'}</option>
                    {catDisp.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.codigo ? ` (${c.codigo})` : ''}</option>)}
                  </select>
                  <Btn size="sm" variant="soft" type="button" icon="plus" onClick={() => setCreatingProd(true)} title="Criar novo produto" />
                </div>
              </div>
              <Field label="Cenário atual">
                <select value={cenarioId ?? ''} onChange={(e) => setCenarioId(numOrNull(e.target.value))} className={inputCls}>
                  <option value="">—</option>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                </select>
              </Field>
              <Field label="Ação para próximo nível">
                <select value={acaoId ?? ''} onChange={(e) => setAcaoId(numOrNull(e.target.value))} className={inputCls}>
                  <option value="">—</option>
                  {actions.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
                </select>
              </Field>
              <Field label="Data do contato">
                <input type="date" value={dataContato} onChange={(e) => setDataContato(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Valor estimado (R$)">
                <input inputMode="decimal" value={valor} onChange={(e) => setValor(maskMoney(e.target.value))} placeholder="0,00" className={inputCls} />
              </Field>
              <Field label="Previsão de faturamento (data)">
                <input type="date" value={previsaoData} onChange={(e) => setPrevisaoData(e.target.value)} className={inputCls} />
              </Field>
            </div>

            <Field label="Notas">
              <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} maxLength={2000}
                placeholder="Observações livres" className={cn(inputCls, 'resize-y')} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 p-4">
            {can('relationships.delete') && (
              <Btn variant="danger" type="button" icon="x"
                onClick={() => confirmDialog('Remover esta empresa do funil?').then((ok) => { if (ok) return onRemove(card.id); })}>
                Remover do funil
              </Btn>
            )}
            {can('activities.create') && (
              <Btn variant="soft" type="button" icon="calendar" onClick={() => setCreatingActivity(true)}>
                Criar compromisso
              </Btn>
            )}
            <div className="ml-auto flex gap-2">
              <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
              <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
            </div>
          </div>
        </form>
      </div>
    </div>
    {creating && (
      <NovoContato companyId={card.company_id} onCreated={onCreatedContato} onCancel={() => setCreating(false)} />
    )}
    {creatingLabel && (
      <NovaPrivateLabel onCreated={onCreatedLabel} onCancel={() => setCreatingLabel(false)} />
    )}
    {creatingProd && (
      <NovoProduto reps={reps} onCreated={onCreatedProduto} onCancel={() => setCreatingProd(false)} />
    )}
    {creatingActivity && (
      <ActivityCreateModal
        preset={hojeAs9()}
        funnel={[{ company_id: card.company_id, label: card.nome_fantasia || card.razao_social }]}
        represented={reps}
        presetCompanyId={card.company_id}
        onClose={() => setCreatingActivity(false)}
        onSaved={() => setCreatingActivity(false)}
      />
    )}
   </>
  );
}

// Hoje às 09:00 — preset do compromisso criado a partir do funil.
function hojeAs9(): Date {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d;
}

// Modal "Criar nova private label" — cria no catálogo da org; quem vincula à
// empresa é o EditModal, no submit (PUT /api/companies/:id/private-labels).
const LABEL_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

function NovaPrivateLabel({ onCreated, onCancel }: {
  onCreated: (l: PrivateLabel) => void; onCancel: () => void;
}): React.JSX.Element {
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [cor, setCor] = useState<string>(LABEL_PALETTE[0]);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!nome.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ label: PrivateLabel }>('/api/private-labels', {
        nome: nome.trim(), descricao: txt(descricao), cor,
      });
      api.invalidate('/api/private-labels');
      toast.success('Private label criada.');
      onCreated(r.label);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar a private label.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-ink-200 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 p-5">
          <h2 className="text-base font-semibold text-ink-800">Criar nova private label</h2>
          <button type="button" onClick={onCancel}
            className="rounded-lg p-1 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="space-y-2.5 p-5">
          <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} maxLength={120}
            placeholder="Nome *" className={inputCls} />
          <input value={descricao} onChange={(e) => setDescricao(e.target.value)} maxLength={500}
            placeholder="Descrição (opcional)" className={inputCls} />
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-500">Cor</span>
            {LABEL_PALETTE.map((c) => (
              <button key={c} type="button" onClick={() => setCor(c)} aria-label={`Cor ${c}`}
                className={cn('h-6 w-6 rounded-full ring-offset-2 transition', cor === c && 'ring-2 ring-ink-400')}
                style={{ backgroundColor: c }} />
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-100 p-4">
          <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
          <Btn icon="check" type="button" onClick={() => void save()} disabled={busy || !nome.trim()}>
            {busy ? '…' : 'Criar'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// Modal "Criar novo contato" — vincula o contato à empresa-cliente do card.
function NovoContato({ companyId, onCreated, onCancel }: {
  companyId: number; onCreated: (c: Contact) => void; onCancel: () => void;
}): React.JSX.Element {
  const [nome, setNome] = useState('');
  const [cargo, setCargo] = useState('');
  const [telefone, setTelefone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!nome.trim()) return;
    if (email.trim() && !isEmail(email)) { toast.error('E-mail inválido.'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ contact: Contact }>('/api/contacts', {
        nome: nome.trim(), cargo: txt(cargo), telefone: txt(telefone), email: txt(email), company_id: companyId,
      });
      toast.success('Contato criado.');
      onCreated(r.contact);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar o contato.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-ink-200 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 p-5">
          <h2 className="text-base font-semibold text-ink-800">Criar novo contato</h2>
          <button type="button" onClick={onCancel}
            className="rounded-lg p-1 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="space-y-2.5 p-5">
          <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} maxLength={120} placeholder="Nome *" className={inputCls} />
          <div className="grid gap-2.5 sm:grid-cols-2">
            <input value={cargo} onChange={(e) => setCargo(e.target.value)} maxLength={120} placeholder="Cargo" className={inputCls} />
            <input value={telefone} onChange={(e) => setTelefone(maskPhone(e.target.value))} placeholder="Telefone" inputMode="tel" className={inputCls} />
          </div>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} placeholder="E-mail" className={inputCls} />
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-100 p-4">
          <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
          <Btn icon="check" type="button" onClick={() => save()} disabled={busy || !nome.trim()}>{busy ? '…' : 'Criar'}</Btn>
        </div>
      </div>
    </div>
  );
}

// Modal "Criar novo produto" no catálogo (org-wide).
function NovoProduto({ reps, onCreated, onCancel }: {
  reps: RepresentedCompany[]; onCreated: (i: CatalogItem) => void; onCancel: () => void;
}): React.JSX.Element {
  const [nome, setNome] = useState('');
  const [codigo, setCodigo] = useState('');
  const [preco, setPreco] = useState('');
  const [repId, setRepId] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!nome.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ item: CatalogItem }>('/api/catalog', {
        nome: nome.trim(), codigo: txt(codigo),
        preco: preco.trim() === '' ? null : clampNum(preco, 0, 1e9),
        represented_id: repId === '' ? null : Number(repId),
      });
      toast.success('Produto criado.');
      onCreated(r.item);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar o produto.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-ink-200 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 p-5">
          <h2 className="text-base font-semibold text-ink-800">Criar novo produto</h2>
          <button type="button" onClick={onCancel}
            className="rounded-lg p-1 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="space-y-2.5 p-5">
          <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} maxLength={120} placeholder="Nome *" className={inputCls} />
          <div className="grid gap-2.5 sm:grid-cols-2">
            <input value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={120} placeholder="Código / SKU" className={inputCls} />
            <input inputMode="decimal" value={preco} onChange={(e) => setPreco(maskMoney(e.target.value))} placeholder="Preço (R$)" className={inputCls} />
          </div>
          <select value={repId} onChange={(e) => setRepId(e.target.value)} className={inputCls}>
            <option value="">Representada (opcional)</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-100 p-4">
          <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
          <Btn icon="check" type="button" onClick={() => save()} disabled={busy || !nome.trim()}>{busy ? '…' : 'Criar'}</Btn>
        </div>
      </div>
    </div>
  );
}

