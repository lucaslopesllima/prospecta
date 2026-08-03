import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { CatalogItem, RepresentedCompany } from '../lib/types.ts';
import { Badge, Btn, Card, EmptyState, PageHeader, SafeButton, Segmented, Spinner, cn } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { brl, dec, maskMoney, numStr } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { PriceTables } from './PriceTables.tsx';
import { UNIDADES_MEDIDA_GRUPOS } from '../lib/units.ts';
import { confirmDialog } from '../lib/confirm.ts';

const inputCls = 'w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200';

// Alíquotas por produto. Campos ocultos na UI por ora (uso futuro) — o form
// preserva valores existentes e envia 0 quando vazio.
const TAX_FIELDS = [
  ['icms_pct', 'ICMS'], ['ipi_pct', 'IPI'], ['st_pct', 'ICMS-ST'],
  ['pis_pct', 'PIS'], ['cofins_pct', 'COFINS'], ['iss_pct', 'ISS'],
] as const;
type TaxKey = (typeof TAX_FIELDS)[number][0];

type Form = { nome: string; codigo: string; descricao: string; preco: string; unidade_medida: string; represented_id: string } & Record<TaxKey, string>;
const EMPTY: Form = {
  nome: '', codigo: '', descricao: '', preco: '', unidade_medida: '', represented_id: '',
  icms_pct: '', ipi_pct: '', st_pct: '', pis_pct: '', cofins_pct: '', iss_pct: '',
};
const toForm = (i: CatalogItem): Form => ({
  nome: i.nome, codigo: i.codigo ?? '', descricao: i.descricao ?? '',
  preco: numStr(i.preco), unidade_medida: i.unidade_medida ?? '',
  represented_id: i.represented_id != null ? String(i.represented_id) : '',
  ...Object.fromEntries(TAX_FIELDS.map(([k]) => [k, numStr(i[k])])) as Record<TaxKey, string>,
});
function toBody(f: Form): Record<string, unknown> {
  const t = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  const taxNum = (s: string): number => (s.trim() === '' ? 0 : dec(s));
  return {
    nome: f.nome.trim(), codigo: t(f.codigo), descricao: t(f.descricao),
    preco: f.preco.trim() === '' ? null : dec(f.preco),
    unidade_medida: t(f.unidade_medida),
    represented_id: f.represented_id === '' ? null : Number(f.represented_id),
    ...Object.fromEntries(TAX_FIELDS.map(([k]) => [k, taxNum(f[k])])),
  };
}

export function Catalog(): React.JSX.Element {
  const { can } = useAuth();
  const [list, setList] = useState<CatalogItem[]>([]);
  const [reps, setReps] = useState<RepresentedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [tab, setTab] = useState<'itens' | 'tabelas'>('itens');
  const [addingTable, setAddingTable] = useState(false);
  const [q, setQ] = useState('');

  const load = async (): Promise<void> => {
    const [c, r] = await Promise.all([
      api.get<{ items: CatalogItem[] }>('/api/catalog'),
      api.get<{ empresas: RepresentedCompany[] }>('/api/represented'),
    ]);
    setList(c.items);
    setReps(r.empresas);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const repName = (id: number | null): string | null => reps.find((r) => r.id === id)?.nome ?? null;

  const create = async (f: Form): Promise<void> => {
    try {
      const r = await api.post<{ item: CatalogItem }>('/api/catalog', toBody(f));
      setList((xs) => [...xs, r.item]);
      setEditing(null);
      toast.success('Item criado.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar o item.'); }
  };
  const update = async (id: number, f: Form): Promise<void> => {
    try {
      const r = await api.patch<{ item: CatalogItem }>(`/api/catalog/${id}`, toBody(f));
      setList((xs) => xs.map((x) => (x.id === id ? r.item : x)));
      setEditing(null);
      toast.success('Item salvo.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar o item.'); }
  };
  // Otimista com rollback: PATCH/DELETE recusado devolve o estado anterior.
  const toggleAtivo = async (i: CatalogItem): Promise<void> => {
    const before = list;
    setList((xs) => xs.map((x) => (x.id === i.id ? { ...x, ativo: !x.ativo } : x)));
    try { await api.patch(`/api/catalog/${i.id}`, { ativo: !i.ativo }); }
    catch { setList(before); toast.error('Não foi possível atualizar o item.'); }
  };
  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir este item do mostruário?'))) return;
    const before = list;
    setList((xs) => xs.filter((x) => x.id !== id));
    try { await api.del(`/api/catalog/${id}`); toast.success('Item excluído.'); }
    catch { setList(before); toast.error('Não foi possível excluir o item.'); }
  };

  // filtro client-side por nome/código/descrição — catálogo grande vira scroll sem isso
  const termo = q.trim().toLowerCase();
  const filtered = termo
    ? list.filter((i) => `${i.nome} ${i.codigo ?? ''} ${i.descricao ?? ''}`.toLowerCase().includes(termo))
    : list;
  // o item em edição não pode sumir da lista porque o termo de busca mudou
  const display = typeof editing === 'number' && !filtered.some((i) => i.id === editing)
    ? [...filtered, list.find((i) => i.id === editing)].filter((i): i is CatalogItem => !!i)
    : filtered;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Mostruário" subtitle="Produtos e serviços que você oferece. Vincule na prospecção."
        actions={tab === 'itens'
          ? (editing !== 'new' && can('catalog.create') && <Btn icon="plus" onClick={() => setEditing('new')}>Novo item</Btn>)
          : (!addingTable && can('price_tables.create') && <Btn icon="plus" onClick={() => setAddingTable(true)}>Nova tabela</Btn>)} />

      <Segmented value={tab} onChange={setTab} options={[
        { value: 'itens', label: 'Itens', icon: 'box' },
        { value: 'tabelas', label: 'Tabelas de preço', icon: 'layers' },
      ]} />

      {tab === 'tabelas' ? (
        <Card className="p-4">
          <PriceTables reps={reps} catalog={list} adding={addingTable} onCloseAdd={() => setAddingTable(false)} />
        </Card>
      ) : loading ? <Spinner /> : (
        <Card className="p-4">
          {editing === 'new' && (
            <div className="mb-4"><ItemForm reps={reps} initial={EMPTY} onSave={create} onCancel={() => setEditing(null)} /></div>
          )}

          {list.length > 0 && (
            <div className="relative mb-3">
              <Icon name="search" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={120} placeholder="Buscar por nome, código ou descrição…" className={cn(inputCls, 'pl-9')} />
            </div>
          )}

          <div className="space-y-2">
            {list.length === 0 && editing !== 'new' && (
              <EmptyState icon="box" title="Mostruário vazio" hint="Cadastre os produtos/serviços que você representa." />
            )}
            {list.length > 0 && display.length === 0 && (
              <p className="py-6 text-center text-sm text-ink-400">Nenhum item para “{q.trim()}”.</p>
            )}
            {display.map((i) => editing === i.id ? (
              <Card key={i.id} className="border-brand-200 bg-brand-50/40 p-3">
                <ItemForm reps={reps} initial={toForm(i)} onSave={(f) => update(i.id, f)} onCancel={() => setEditing(null)} />
              </Card>
            ) : (
              <div key={i.id} className={cn('flex items-start gap-3 rounded-xl border border-ink-200/70 bg-surface p-3', !i.ativo && 'opacity-60')}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-500"><Icon name="box" size={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-ink-800">{i.nome}</p>
                    {i.codigo && <Badge tone="neutral">{i.codigo}</Badge>}
                    {repName(i.represented_id) && <Badge tone="brand">{repName(i.represented_id)}</Badge>}
                    {!i.ativo && <Badge tone="neutral">inativo</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-400">
                    {[i.preco != null ? brl(Number(i.preco)) + (i.unidade_medida ? ` / ${i.unidade_medida}` : '') : i.unidade_medida, i.descricao].filter(Boolean).join(' · ') || 'sem detalhes'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {can('catalog.update') && (
                    <SafeButton onClick={() => toggleAtivo(i)} title={i.ativo ? 'Desativar' : 'Ativar'}
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"><Icon name={i.ativo ? 'check' : 'x'} size={16} /></SafeButton>
                  )}
                  {can('catalog.update') && (
                    <button onClick={() => setEditing(i.id)} aria-label="Editar"
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"><Icon name="pencil" size={16} /></button>
                  )}
                  {can('catalog.delete') && (
                    <SafeButton onClick={() => remove(i.id)} aria-label="Excluir"
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500"><Icon name="trash" size={16} /></SafeButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function ItemForm({ reps, initial, onSave, onCancel }: {
  reps: RepresentedCompany[]; initial: Form; onSave: (f: Form) => void | Promise<void>; onCancel: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!f.nome.trim()) return;
    setBusy(true);
    try { await onSave(f); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <input autoFocus value={f.nome} onChange={set('nome')} maxLength={120} placeholder="Nome do produto / serviço *" className={inputCls} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <input value={f.codigo} onChange={set('codigo')} maxLength={120} placeholder="Código / SKU" className={inputCls} />
        <input type="text" inputMode="decimal" value={f.preco}
          onChange={(e) => setF((p) => ({ ...p, preco: maskMoney(e.target.value) }))} placeholder="Preço (R$)" className={inputCls} />
        <select value={f.unidade_medida} onChange={set('unidade_medida')} className={inputCls}>
          <option value="">Unidade de medida (opcional)</option>
          {UNIDADES_MEDIDA_GRUPOS.map((g) => (
            <optgroup key={g.grupo} label={g.grupo}>
              {g.itens.map((u) => <option key={u.value} value={u.value}>{u.label} ({u.value})</option>)}
            </optgroup>
          ))}
        </select>
        <select value={f.represented_id} onChange={set('represented_id')} className={inputCls}>
          <option value="">Representada (opcional)</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
        </select>
      </div>
      <textarea value={f.descricao} onChange={set('descricao')} maxLength={2000} placeholder="Descrição" rows={2} className={cn(inputCls, 'resize-y')} />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
        <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
      </div>
    </form>
  );
}
