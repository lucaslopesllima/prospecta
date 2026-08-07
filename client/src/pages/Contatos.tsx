import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { Contact, RepresentedCompany } from '../lib/types.ts';
import { Badge, Btn, Card, EmptyState, PageHeader, RowActions, Spinner } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { useAuth } from '../lib/auth.tsx';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';
import { ContatoForm, EMPTY_CONTACT, contactBody, contactInputCls as inputCls, toContactForm, type ContactForm } from '../lib/contactForm.tsx';
import { EntityLabels } from '../lib/privateLabelPicker.tsx';

export function Contatos(): React.JSX.Element {
  const { can } = useAuth();
  const [list, setList] = useState<Contact[]>([]);
  const [reps, setReps] = useState<RepresentedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  const load = async (): Promise<void> => {
    const [c, r] = await Promise.all([
      api.get<{ contacts: Contact[] }>('/api/contacts'),
      api.get<{ empresas: RepresentedCompany[] }>('/api/represented'),
    ]);
    setList(c.contacts);
    setReps(r.empresas);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const repName = (id: number | null): string | null => reps.find((r) => r.id === id)?.nome ?? null;

  const create = async (f: ContactForm): Promise<void> => {
    try {
      const r = await api.post<{ contact: Contact }>('/api/contacts', contactBody(f));
      setList((xs) => [...xs, r.contact]);
      setEditing(null);
      toast.success('Contato criado.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar o contato.'); }
  };
  const update = async (id: number, f: ContactForm): Promise<void> => {
    try {
      const r = await api.patch<{ contact: Contact }>(`/api/contacts/${id}`, contactBody(f));
      setList((xs) => xs.map((x) => (x.id === id ? r.contact : x)));
      setEditing(null);
      toast.success('Contato salvo.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar o contato.'); }
  };
  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir este contato?'))) return;
    const before = list;
    setList((xs) => xs.filter((x) => x.id !== id));
    try { await api.del(`/api/contacts/${id}`); toast.success('Contato excluído.'); }
    catch { setList(before); toast.error('Não foi possível excluir o contato.'); }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Contatos" subtitle="Pessoas que você pode vincular na prospecção. Contatos de uma empresa-cliente também podem ser criados direto no funil."
        actions={can('contacts.create') && editing !== 'new' ? <Btn size="sm" icon="plus" onClick={() => setEditing('new')}>Novo</Btn> : undefined} />

      {loading ? <Spinner /> : (
        <Card className="p-4">
          {editing === 'new' && (
            <ContatoForm inputCls={inputCls} reps={reps} initial={EMPTY_CONTACT} onSave={create} onCancel={() => setEditing(null)} />
          )}

          <div className={editing === 'new' ? 'mt-4 space-y-2' : 'space-y-2'}>
            {list.length === 0 && editing !== 'new' && (
              <EmptyState icon="users" title="Nenhum contato" hint="Cadastre pessoas para selecionar na prospecção." />
            )}
            {list.map((c) => editing === c.id ? (
              <Card key={c.id} className="border-brand-200 bg-brand-50/40 p-3">
                <ContatoForm inputCls={inputCls} reps={reps} initial={toContactForm(c)} onSave={(f) => update(c.id, f)} onCancel={() => setEditing(null)} />
                {can('private_labels.list') && (
                  <div className="mt-3 border-t border-ink-100 pt-3">
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Private labels</p>
                    <EntityLabels kind="contact" id={c.id} canEdit={can('private_labels.update')} />
                  </div>
                )}
              </Card>
            ) : (
              <div key={c.id} className="flex items-start gap-3 rounded-xl border border-hairline bg-surface p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-500"><Icon name="users" size={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-ink-800">{c.nome}</p>
                    {c.cargo && <Badge tone="neutral">{c.cargo}</Badge>}
                    {c.company_name && <Badge tone="neutral"><Icon name="building" size={12} />{c.company_name}</Badge>}
                    {repName(c.represented_id) && <Badge tone="brand">{repName(c.represented_id)}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-400">{[c.email, c.telefone].filter(Boolean).join(' · ') || 'sem contato'}</p>
                </div>
                <RowActions
                  primary={{ icon: 'pencil', label: 'Editar', onClick: () => setEditing(c.id), hidden: !can('contacts.update') }}
                  actions={[
                    { icon: 'trash', label: 'Excluir', onClick: () => remove(c.id), tone: 'danger', hidden: !can('contacts.delete') },
                  ]} />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
