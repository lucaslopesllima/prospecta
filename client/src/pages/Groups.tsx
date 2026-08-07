import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { PermissionGroup, PermissionCatalogItem } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, Modal, PageHeader, Spinner } from '../lib/ui.tsx';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';


export function Groups(): React.JSX.Element {
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<PermissionGroup | 'new' | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [g, c] = await Promise.all([
        api.get<{ groups: PermissionGroup[] }>('/api/groups'),
        api.get<{ permissions: PermissionCatalogItem[] }>('/api/permissions/catalog'),
      ]);
      setGroups(g.groups);
      setCatalog(c.permissions);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Erro ao carregar grupos');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  if (loading) return <div className="p-6"><Spinner /></div>;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Grupos de permissão"
        subtitle="Cada usuário pertence a um grupo; o grupo define as ações permitidas."
        actions={<Btn icon="plus" onClick={() => setEditing('new')}>Novo grupo</Btn>}
      />

      {err && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}

      {groups.length === 0 ? (
        <EmptyState icon="layers" title="Nenhum grupo" hint="Crie o primeiro grupo de permissões." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card key={g.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900">{g.nome}</p>
                  <p className="text-xs text-ink-400">{g.user_count ?? 0} usuário(s)</p>
                </div>
                {g.is_admin
                  ? <Badge tone="success">Acesso total</Badge>
                  : <Badge tone="neutral">{g.permissions.length} permissões</Badge>}
              </div>
              <div className="mt-auto flex justify-end">
                <Btn size="sm" variant="ghost" icon={g.is_admin ? 'eye' : 'pencil'}
                  onClick={() => setEditing(g)}>{g.is_admin ? 'Ver' : 'Editar'}</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <GroupEditor
          group={editing === 'new' ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function GroupEditor({ group, catalog, onClose, onSaved }: {
  group: PermissionGroup | null;
  catalog: PermissionCatalogItem[];
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const readOnly = group?.is_admin === true;
  const [nome, setNome] = useState(group?.nome ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(group?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Catálogo agrupado por módulo, preservando a ordem de inserção.
  const modules = useMemo(() => {
    const m = new Map<string, PermissionCatalogItem[]>();
    for (const item of catalog) {
      const arr = m.get(item.module) ?? [];
      arr.push(item);
      m.set(item.module, arr);
    }
    return [...m.entries()];
  }, [catalog]);

  const toggle = (code: string): void => {
    if (readOnly) return;
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const toggleModule = (items: PermissionCatalogItem[], on: boolean): void => {
    if (readOnly) return;
    setPerms((prev) => {
      const next = new Set(prev);
      for (const it of items) { if (on) next.add(it.code); else next.delete(it.code); }
      return next;
    });
  };

  const save = async (): Promise<void> => {
    if (nome.trim() === '') { setErr('Informe o nome do grupo.'); return; }
    setBusy(true); setErr('');
    const body = { nome: nome.trim(), permissions: [...perms] };
    try {
      if (group) await api.patch(`/api/groups/${group.id}`, body);
      else await api.post('/api/groups', body);
      toast.success(group ? 'Grupo atualizado.' : 'Grupo criado.');
      onSaved();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Erro ao salvar grupo';
      setErr(msg); toast.error(msg);
    } finally { setBusy(false); }
  };

  const remove = async (): Promise<void> => {
    if (!group || !(await confirmDialog(`Excluir o grupo "${group.nome}"?`))) return;
    try {
      await api.del(`/api/groups/${group.id}`);
      toast.success('Grupo excluído.');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Erro ao excluir grupo');
    }
  };

  return (
    <Modal onClose={onClose} width="4xl"
      title={readOnly ? 'Grupo Administrador' : group ? 'Editar grupo' : 'Novo grupo'}
      footer={<>
        {group && !readOnly && (
          <Btn variant="danger" size="sm" icon="trash" className="mr-auto" onClick={() => remove()}>Excluir grupo</Btn>
        )}
        {err && <span className="text-xs text-rose-600">{err}</span>}
        <Btn variant="ghost" onClick={onClose}>Fechar</Btn>
        {!readOnly && <Btn icon="check" disabled={busy} onClick={() => save()}>{busy ? '…' : 'Salvar'}</Btn>}
      </>}>
          <div className="space-y-4 py-1">
            {readOnly && (
              <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                O grupo Administrador tem acesso total e não é editável.
              </p>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-500">Nome do grupo</span>
              <input value={nome} disabled={readOnly} maxLength={120} onChange={(e) => setNome(e.target.value)} className={inputCls} />
            </label>

            {!readOnly && modules.map(([mod, items]) => {
              const allOn = items.every((it) => perms.has(it.code));
              return (
                <div key={mod}>
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-400">{mod}</h4>
                    <button onClick={() => toggleModule(items, !allOn)}
                      className="text-xs font-medium text-brand-600 hover:underline">
                      {allOn ? 'Desmarcar tudo' : 'Marcar tudo'}
                    </button>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {items.map((it) => (
                      <label key={it.code} className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition',
                        perms.has(it.code) ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600 hover:bg-ink-50',
                      )}>
                        <input type="checkbox" checked={perms.has(it.code)} onChange={() => toggle(it.code)}
                          className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-200" />
                        <span>{it.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}

            {readOnly && (
              <p className="text-sm text-ink-500">Todas as permissões do sistema estão concedidas.</p>
            )}
          </div>

    </Modal>
  );
}
