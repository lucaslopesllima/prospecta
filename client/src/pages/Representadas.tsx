import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { Brand, CompanyHit, RepresentedCompany } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, PageHeader, RowActions, SafeButton, Spinner } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { useAuth } from '../lib/auth.tsx';
import { CompanySearch } from '../lib/companySearch.tsx';
import { toast } from '../lib/toast.tsx';
import { invalidCNPJ, maskCNPJ } from '../lib/format.ts';
import { confirmDialog } from '../lib/confirm.ts';


/* ── Empresas representadas (marcas/fornecedores do rep) ──── */
type EmpForm = { nome: string; cnpj: string; segmento: string; site: string; contato: string; notas: string };
const EMPTY: EmpForm = { nome: '', cnpj: '', segmento: '', site: '', contato: '', notas: '' };
const toForm = (e: RepresentedCompany): EmpForm => ({
  nome: e.nome, cnpj: e.cnpj ?? '', segmento: e.segmento ?? '', site: e.site ?? '', contato: e.contato ?? '', notas: e.notas ?? '',
});

export function Representadas(): React.JSX.Element {
  const { can } = useAuth();
  const [list, setList] = useState<RepresentedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ empresas: RepresentedCompany[] }>('/api/represented');
    setList(r.empresas);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const create = async (f: EmpForm): Promise<void> => {
    try {
      const r = await api.post<{ empresa: RepresentedCompany }>('/api/represented', normalize(f));
      setList((xs) => [...xs, r.empresa]);
      setEditing(null);
      toast.success('Representada criada.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar.'); }
  };
  const update = async (id: number, f: EmpForm): Promise<void> => {
    try {
      const r = await api.patch<{ empresa: RepresentedCompany }>(`/api/represented/${id}`, normalize(f));
      setList((xs) => xs.map((x) => (x.id === id ? r.empresa : x)));
      setEditing(null);
      toast.success('Representada salva.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };
  const toggleAtivo = async (e: RepresentedCompany): Promise<void> => {
    setList((xs) => xs.map((x) => (x.id === e.id ? { ...x, ativo: !x.ativo } : x)));
    try { await api.patch(`/api/represented/${e.id}`, { ativo: !e.ativo }); }
    catch { setList((xs) => xs.map((x) => (x.id === e.id ? { ...x, ativo: e.ativo } : x))); toast.error('Não foi possível atualizar.'); }
  };
  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir esta empresa representada?'))) return;
    const before = list;
    setList((xs) => xs.filter((x) => x.id !== id));
    try { await api.del(`/api/represented/${id}`); toast.success('Representada excluída.'); }
    catch { setList(before); toast.error('Não foi possível excluir.'); }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Representadas" subtitle="Marcas/fornecedores que você representa. Pode cadastrar várias."
        actions={can('represented.create') && editing !== 'new' ? <Btn size="sm" icon="plus" onClick={() => setEditing('new')}>Nova</Btn> : undefined} />

      {loading ? <Spinner /> : (
        <Card className="p-4">
          {editing === 'new' && (
            <EmpresaForm inputCls={inputCls} initial={EMPTY} onSave={create} onCancel={() => setEditing(null)} />
          )}

          <div className={editing === 'new' ? 'mt-4 space-y-2' : 'space-y-2'}>
            {list.length === 0 && editing !== 'new' && (
              <EmptyState icon="building" title="Nenhuma empresa cadastrada" hint="Adicione as marcas/fornecedores que você representa." />
            )}
            {list.map((e) => editing === e.id ? (
              <Card key={e.id} className="border-brand-200 bg-brand-50/40 p-3">
                <EmpresaForm inputCls={inputCls} initial={toForm(e)} onSave={(f) => update(e.id, f)} onCancel={() => setEditing(null)} />
                <div className="mt-3 border-t border-brand-200/60 pt-3">
                  <BrandsEditor representedId={e.id} inputCls={inputCls} />
                </div>
              </Card>
            ) : (
              <div key={e.id} className={cn('flex items-start gap-3 rounded-xl border border-hairline bg-surface p-3', !e.ativo && 'opacity-60')}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-500"><Icon name="building" size={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-ink-800">{e.nome}</p>
                    {e.ativo ? <Badge tone="success">ativa</Badge> : <Badge tone="neutral">inativa</Badge>}
                    {e.segmento && <Badge tone="brand">{e.segmento}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-400">
                    {[e.cnpj, e.contato, e.site].filter(Boolean).join(' · ') || 'sem detalhes'}
                  </p>
                  {e.notas && <p className="mt-1 line-clamp-2 text-xs text-ink-500">{e.notas}</p>}
                </div>
                <RowActions
                  primary={{ icon: 'pencil', label: 'Editar', onClick: () => setEditing(e.id), hidden: !can('represented.update') }}
                  actions={[
                    { icon: e.ativo ? 'x' : 'check', label: e.ativo ? 'Desativar' : 'Ativar', onClick: () => toggleAtivo(e), hidden: !can('represented.update') },
                    { icon: 'trash', label: 'Excluir', onClick: () => remove(e.id), tone: 'danger', hidden: !can('represented.delete') },
                  ]} />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function normalize(f: EmpForm): Record<string, string | null> {
  const t = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return { nome: f.nome.trim(), cnpj: t(f.cnpj), segmento: t(f.segmento), site: t(f.site), contato: t(f.contato), notas: t(f.notas) };
}

function EmpresaForm({ inputCls, initial, onSave, onCancel }: {
  inputCls: string; initial: EmpForm; onSave: (f: EmpForm) => void | Promise<void>; onCancel: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<EmpForm>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof EmpForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!f.nome.trim()) return;
    if (invalidCNPJ(f.cnpj)) { toast.error('CNPJ inválido.'); return; }
    setBusy(true);
    try { await onSave(f); } finally { setBusy(false); }
  };

  // Autopreenche a partir da base de empresas (RFB).
  const fillFrom = (c: CompanyHit): void => setF((p) => ({
    ...p,
    nome: c.nome_fantasia || c.razao_social,
    cnpj: c.cnpj ?? p.cnpj,
    contato: p.contato || c.telefone1 || c.email || '',
  }));

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <CompanySearch onPick={fillFrom} placeholder="Buscar na base de empresas (CNPJ ou nome)…" />
      <input autoFocus value={f.nome} onChange={set('nome')} maxLength={200} placeholder="Nome da empresa / marca *" className={inputCls} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <input value={f.segmento} onChange={set('segmento')} maxLength={120} placeholder="Segmento (ex.: Calçados)" className={inputCls} />
        <input value={f.cnpj} autoCapitalize="characters" onChange={(e) => setF((p) => ({ ...p, cnpj: maskCNPJ(e.target.value) }))} placeholder="CNPJ" className={inputCls} />
        <input type="text" value={f.contato} onChange={set('contato')} maxLength={120} placeholder="Contato (telefone/e-mail)" className={inputCls} />
        <input value={f.site} inputMode="url" autoCapitalize="off" onChange={set('site')} maxLength={200} placeholder="Site" className={inputCls} />
      </div>
      <textarea value={f.notas} onChange={set('notas')} maxLength={2000} placeholder="Notas (linha de produtos, comissão, etc.)" rows={2} className={cn(inputCls, 'resize-y')} />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
        <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
      </div>
    </form>
  );
}

/* ── Marcas de uma empresa representada ────────────────────── */
function BrandsEditor({ representedId, inputCls }: { representedId: number; inputCls: string }): React.JSX.Element {
  const { can } = useAuth();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [novo, setNovo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ brands: Brand[] }>(`/api/brands?represented_id=${representedId}`)
      .then((r) => setBrands(r.brands)).catch(() => undefined);
  }, [representedId]);

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nome = novo.trim();
    if (!nome) return;
    setBusy(true);
    try {
      const r = await api.post<{ brand: Brand }>('/api/brands', { represented_id: representedId, nome });
      setBrands((xs) => [...xs, r.brand]);
      setNovo('');
    } finally { setBusy(false); }
  };
  const remove = async (id: number): Promise<void> => {
    setBrands((xs) => xs.filter((x) => x.id !== id));
    await api.del(`/api/brands/${id}`);
  };

  return (
    <div>
      <p className="text-xs font-semibold text-ink-600">Marcas que esta empresa trabalha</p>
      <p className="mt-0.5 text-xs text-ink-400">Aparecem no dropdown "Marca" da prospecção.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {brands.map((b) => (
          <span key={b.id} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-ink-700 shadow-card">
            {b.nome}
            {can('brands.delete') && (
              <SafeButton type="button" onClick={() => remove(b.id)} className="text-ink-300 hover:text-rose-500" aria-label="Remover">
                <Icon name="x" size={13} />
              </SafeButton>
            )}
          </span>
        ))}
        {brands.length === 0 && <span className="text-xs text-ink-300">Nenhuma marca ainda.</span>}
      </div>
      {can('brands.create') && (
        <form onSubmit={add} className="mt-2 flex gap-2">
          <input value={novo} onChange={(e) => setNovo(e.target.value)} maxLength={200} placeholder="Nova marca" className={cn(inputCls, 'flex-1')} />
          <Btn size="sm" icon="plus" type="submit" disabled={busy}>Add</Btn>
        </form>
      )}
    </div>
  );
}
