import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { Contact, CompanyHit, PrivateLabel, PrivateLabelCompany } from '../lib/types.ts';
import { Badge, Btn, Card, EmptyState, inputCls, PageHeader, RowActions, SafeButton, Spinner } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { useAuth } from '../lib/auth.tsx';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';
import { CompanySearch } from '../lib/companySearch.tsx';

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

type LabelForm = { nome: string; descricao: string; cor: string | null };
const EMPTY: LabelForm = { nome: '', descricao: '', cor: PALETTE[0] };

function LabelFormFields({ initial, onSave, onCancel }: {
  initial: LabelForm; onSave: (f: LabelForm) => void | Promise<void>; onCancel: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<LabelForm>(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!f.nome.trim()) return;
    setBusy(true);
    try { await onSave(f); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-2.5">
      <input autoFocus value={f.nome} onChange={(e) => setF((p) => ({ ...p, nome: e.target.value }))}
        maxLength={120} placeholder="Nome da private label *" className={inputCls} />
      <input value={f.descricao} onChange={(e) => setF((p) => ({ ...p, descricao: e.target.value }))}
        maxLength={500} placeholder="Descrição (opcional)" className={inputCls} />
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-ink-400">Cor</span>
        {PALETTE.map((c) => (
          <button key={c} type="button" onClick={() => setF((p) => ({ ...p, cor: c }))}
            aria-label={`Cor ${c}`}
            className={`h-6 w-6 rounded-full ring-offset-2 transition ${f.cor === c ? 'ring-2 ring-ink-400' : ''}`}
            style={{ backgroundColor: c }} />
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
        <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
      </div>
    </form>
  );
}

// Gestão dos vínculos (empresas + contatos) de uma label. Persiste cada alteração
// na hora via PUT do conjunto completo.
function LabelLinks({ label }: { label: PrivateLabel }): React.JSX.Element {
  const [companies, setCompanies] = useState<PrivateLabelCompany[] | null>(null);
  const [contacts, setContacts] = useState<{ id: number; nome: string; cargo: string | null }[]>([]);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [pickContact, setPickContact] = useState(false);

  useEffect(() => {
    void api.get<{ companies: PrivateLabelCompany[]; contacts: { id: number; nome: string; cargo: string | null }[] }>(`/api/private-labels/${label.id}`)
      .then((r) => { setCompanies(r.companies ?? []); setContacts(r.contacts ?? []); }).catch(() => setCompanies([]));
    void api.get<{ contacts: Contact[] }>('/api/contacts').then((r) => setAllContacts(r.contacts ?? [])).catch(() => undefined);
  }, [label.id]);

  const saveCompanies = async (next: PrivateLabelCompany[]): Promise<void> => {
    const before = companies;
    setCompanies(next);
    try {
      await api.put(`/api/private-labels/${label.id}/companies`, { company_ids: next.map((c) => c.id) });
      api.invalidate('/api/private-labels');
    } catch (e) { setCompanies(before); toast.error(e instanceof Error ? e.message : 'Falha ao salvar empresas.'); }
  };
  const saveContacts = async (next: { id: number; nome: string; cargo: string | null }[]): Promise<void> => {
    const before = contacts;
    setContacts(next);
    try {
      await api.put(`/api/private-labels/${label.id}/contacts`, { contact_ids: next.map((c) => c.id) });
      api.invalidate('/api/private-labels');
    } catch (e) { setContacts(before); toast.error(e instanceof Error ? e.message : 'Falha ao salvar contatos.'); }
  };

  const addCompany = (c: CompanyHit): void => {
    if (companies?.some((x) => x.id === c.id)) return;
    void saveCompanies([...(companies ?? []), { id: c.id, cnpj: c.cnpj, razao_social: c.razao_social, nome_fantasia: c.nome_fantasia, uf: c.uf }]);
  };

  const availableContacts = allContacts.filter((c) => !contacts.some((x) => x.id === c.id));

  return (
    <div className="mt-3 grid gap-4 border-t border-ink-100 pt-3 sm:grid-cols-2">
      {/* Empresas */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Empresas ({companies?.length ?? 0})</p>
        <CompanySearch onPick={addCompany} placeholder="Vincular empresa por CNPJ ou nome…" />
        <div className="mt-2 space-y-1.5">
          {companies === null ? <Spinner /> : companies.length === 0 ? (
            <p className="text-xs text-ink-300">Nenhuma empresa vinculada.</p>
          ) : companies.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-1.5">
              <Icon name="building" size={14} className="shrink-0 text-ink-400" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-700">{c.nome_fantasia || c.razao_social}</span>
              <span className="shrink-0 text-[11px] text-ink-400">{c.uf}</span>
              <SafeButton onClick={() => saveCompanies((companies ?? []).filter((x) => x.id !== c.id))} aria-label="Remover empresa"
                className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-300 hover:bg-rose-50 hover:text-rose-500"><Icon name="x" size={14} /></SafeButton>
            </div>
          ))}
        </div>
      </div>

      {/* Contatos */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Contatos ({contacts.length})</p>
          <button type="button" onClick={() => setPickContact((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline">
            <Icon name="plus" size={11} /> Vincular
          </button>
        </div>
        {pickContact && (
          <div className="mb-2 max-h-40 overflow-y-auto rounded-xl border border-ink-200 bg-ink-50/40 p-1">
            {availableContacts.length === 0 ? (
              <p className="px-2 py-2 text-center text-xs text-ink-400">Nenhum contato disponível.</p>
            ) : availableContacts.map((c) => (
              <button key={c.id} type="button"
                onClick={() => { void saveContacts([...contacts, { id: c.id, nome: c.nome, cargo: c.cargo }]); }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface">
                <Icon name="users" size={14} className="shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate text-ink-700">{c.nome}</span>
                {c.cargo && <span className="shrink-0 text-[11px] text-ink-400">{c.cargo}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          {contacts.length === 0 ? (
            <p className="text-xs text-ink-300">Nenhum contato vinculado.</p>
          ) : contacts.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-1.5">
              <Icon name="users" size={14} className="shrink-0 text-ink-400" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-700">{c.nome}</span>
              {c.cargo && <span className="shrink-0 text-[11px] text-ink-400">{c.cargo}</span>}
              <SafeButton onClick={() => saveContacts(contacts.filter((x) => x.id !== c.id))} aria-label="Remover contato"
                className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-300 hover:bg-rose-50 hover:text-rose-500"><Icon name="x" size={14} /></SafeButton>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PrivateLabels(): React.JSX.Element {
  const { can } = useAuth();
  const [list, setList] = useState<PrivateLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ labels: PrivateLabel[] }>('/api/private-labels');
    setList(r.labels ?? []);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const create = async (f: LabelForm): Promise<void> => {
    try {
      const r = await api.post<{ label: PrivateLabel }>('/api/private-labels', { nome: f.nome.trim(), descricao: f.descricao.trim() || null, cor: f.cor });
      setList((xs) => [...xs, { ...r.label, companies_count: 0, contacts_count: 0 }].sort((a, b) => a.nome.localeCompare(b.nome)));
      setEditing(null);
      toast.success('Private label criada.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar.'); }
  };
  const update = async (id: number, f: LabelForm): Promise<void> => {
    try {
      const r = await api.patch<{ label: PrivateLabel }>(`/api/private-labels/${id}`, { nome: f.nome.trim(), descricao: f.descricao.trim() || null, cor: f.cor });
      setList((xs) => xs.map((x) => (x.id === id ? { ...x, ...r.label } : x)));
      setEditing(null);
      toast.success('Private label salva.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };
  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir esta private label? Os vínculos com empresas e contatos serão desfeitos.'))) return;
    const before = list;
    setList((xs) => xs.filter((x) => x.id !== id));
    try { await api.del(`/api/private-labels/${id}`); toast.success('Private label excluída.'); }
    catch { setList(before); toast.error('Não foi possível excluir.'); }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Private Labels"
        subtitle="Marcas próprias que você fornece para terceiros. Vincule empresas e contatos a cada label."
        actions={can('private_labels.create') && editing !== 'new' ? <Btn size="sm" icon="plus" onClick={() => setEditing('new')}>Nova</Btn> : undefined} />

      {loading ? <Spinner /> : (
        <Card className="p-4">
          {editing === 'new' && (
            <div className="mb-4"><LabelFormFields initial={EMPTY} onSave={create} onCancel={() => setEditing(null)} /></div>
          )}

          <div className="space-y-2">
            {list.length === 0 && editing !== 'new' && (
              <EmptyState icon="sparkles" title="Nenhuma private label" hint="Crie uma para vincular empresas e contatos." />
            )}
            {list.map((l) => editing === l.id ? (
              <Card key={l.id} className="border-brand-200 bg-brand-50/40 p-3">
                <LabelFormFields initial={{ nome: l.nome, descricao: l.descricao ?? '', cor: l.cor ?? PALETTE[0] }}
                  onSave={(f) => update(l.id, f)} onCancel={() => setEditing(null)} />
              </Card>
            ) : (
              <div key={l.id} className="rounded-xl border border-hairline bg-surface p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: l.cor || '#94a3b8' }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-ink-800">{l.nome}</p>
                      <Badge tone="neutral"><Icon name="building" size={12} />{l.companies_count ?? 0}</Badge>
                      <Badge tone="neutral"><Icon name="users" size={12} />{l.contacts_count ?? 0}</Badge>
                    </div>
                    {l.descricao && <p className="mt-0.5 truncate text-xs text-ink-400">{l.descricao}</p>}
                  </div>
                  <RowActions
                    primary={{ icon: expanded === l.id ? 'chevronLeft' : 'chevronRight', label: 'Vínculos', onClick: () => setExpanded((e) => (e === l.id ? null : l.id)) }}
                    actions={[
                      { icon: 'pencil', label: 'Editar', onClick: () => setEditing(l.id), hidden: !can('private_labels.update') },
                      { icon: 'trash', label: 'Excluir', onClick: () => remove(l.id), tone: 'danger', hidden: !can('private_labels.delete') },
                    ]} />
                </div>
                {expanded === l.id && can('private_labels.update') && <LabelLinks label={l} />}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
