import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { GoalProgress, OrgUser, PermissionGroup, RepresentedCompany } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, Modal, PageHeader, SafeButton, Segmented, Spinner } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { brl, dec, isEmail, maskMoney, todayStr } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { confirmDialog } from '../lib/confirm.ts';


function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>
      {children}
    </label>
  );
}

export function Team(): React.JSX.Element {
  const [tab, setTab] = useState<'usuarios' | 'metas'>('usuarios');
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Vendedores"
        subtitle="Vendedores, administradores e metas da sua organização."
        actions={
          <Segmented value={tab} onChange={setTab} options={[
            { value: 'usuarios', label: 'Usuários', icon: 'users' },
            { value: 'metas', label: 'Metas', icon: 'target' },
          ]} />
        }
      />
      {tab === 'usuarios' ? <Usuarios /> : <Metas />}
    </div>
  );
}

function Usuarios(): React.JSX.Element {
  const { user: me, can } = useAuth();
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [role, setRole] = useState<'rep' | 'admin'>('rep');
  const [groupId, setGroupId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<OrgUser | null>(null);
  const [resetting, setResetting] = useState<OrgUser | null>(null);

  const load = async (): Promise<void> => {
    try {
      const r = await api.get<{ users: OrgUser[] }>('/api/users');
      setUsers(r.users);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Erro ao carregar equipe');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  // Grupos para o seletor. Pode 403 se quem gerencia equipe não tem groups.list —
  // nesse caso o seletor some e os usuários ficam sem grupo atribuído por aqui.
  useEffect(() => {
    void api.get<{ groups: PermissionGroup[] }>('/api/groups').then((r) => setGroups(r.groups)).catch(() => undefined);
  }, []);

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!isEmail(email)) { toast.error('E-mail inválido.'); return; }
    setBusy(true); setErr('');
    try {
      await api.post('/api/users', {
        nome: nome.trim(), email: email.trim(), senha, role,
        group_id: groupId === '' ? null : groupId,
      });
      setNome(''); setEmail(''); setSenha(''); setRole('rep'); setGroupId(''); setShowForm(false);
      await load();
      toast.success('Usuário criado.');
    } catch (e2) {
      const msg = e2 instanceof ApiError ? e2.message : 'Erro ao criar usuário';
      setErr(msg); toast.error(msg);
    } finally { setBusy(false); }
  };

  const patch = async (id: number, body: Partial<Pick<OrgUser, 'role' | 'ativo' | 'nome' | 'group_id'>>): Promise<void> => {
    setErr('');
    try {
      await api.patch(`/api/users/${id}`, body);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Erro ao atualizar usuário');
    }
  };

  const resetPwd = async (u: OrgUser, senha2: string): Promise<void> => {
    setErr('');
    try {
      await api.post(`/api/users/${u.id}/password`, { senha: senha2 });
      await load();
      setResetting(null);
      toast.success(`Senha provisória definida para ${u.nome ?? u.email}.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Erro ao redefinir senha');
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        {can('users.create') && <Btn icon="plus" onClick={() => setShowForm((v) => !v)}>Novo usuário</Btn>}
      </div>

      {err && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}

      {showForm && (
        <Card className="max-w-2xl p-4">
          <h3 className="text-sm font-semibold text-ink-900">Novo usuário</h3>
          <p className="mt-0.5 text-xs text-ink-400">
            Informe uma senha provisória — o usuário será obrigado a trocá-la no primeiro acesso.
          </p>
          <form onSubmit={create} className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Nome"><input value={nome} onChange={(e) => setNome(e.target.value)} required maxLength={120} className={inputCls} /></Field>
            <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={160} className={inputCls} /></Field>
            <Field label="Senha provisória">
              <input type="text" value={senha} onChange={(e) => setSenha(e.target.value)} required minLength={6} maxLength={200} className={inputCls} />
              <span className={cn('mt-1 block text-[11px]', senha.length === 0 ? 'text-ink-400' : senha.length >= 6 ? 'text-emerald-600' : 'text-amber-600')}>
                Mínimo 6 caracteres{senha.length > 0 && senha.length < 6 ? ` (faltam ${6 - senha.length})` : ''}
              </span>
            </Field>
            <Field label="Papel">
              <select value={role} onChange={(e) => setRole(e.target.value as 'rep' | 'admin')} className={inputCls}>
                <option value="rep">Vendedor</option>
                <option value="admin">Administrador</option>
              </select>
            </Field>
            {groups.length > 0 && (
              <Field label="Grupo de permissões">
                <select value={groupId} onChange={(e) => setGroupId(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
                  <option value="">Sem grupo</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
                </select>
              </Field>
            )}
            <div className="flex gap-2 sm:col-span-2">
              <Btn type="submit" disabled={busy}>{busy ? '…' : 'Criar usuário'}</Btn>
              <Btn type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancelar</Btn>
            </div>
          </form>
        </Card>
      )}

      <Card className="overflow-x-auto">
        {users.length === 0 ? (
          <EmptyState icon="users" title="Nenhum usuário" hint="Crie o primeiro vendedor da sua equipe." />
        ) : (
          // min-w: sem ele a tabela obedece ao container estreito e espreme as
          // colunas até quebrar letra a letra — o overflow-x do Card nunca rola.
          <table className="w-full min-w-[720px] text-sm">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-ink-100 text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">E-mail</th>
                <th className="px-4 py-3">Papel</th>
                {groups.length > 0 && <th className="px-4 py-3">Grupo</th>}
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = Number(u.id) === Number(me?.id);
                return (
                  <tr key={u.id} className={cn('border-b border-ink-50 last:border-0', !u.ativo && 'opacity-60')}>
                    <td className="px-4 py-3 font-medium text-ink-900">
                      <NameCell u={u} self={self} onSave={(nome) => patch(u.id, { nome })} />
                    </td>
                    <td className="px-4 py-3 text-ink-600">{u.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        disabled={self || !can('users.update')}
                        onChange={(e) => void patch(u.id, { role: e.target.value as 'admin' | 'rep' })}
                        className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-xs disabled:cursor-not-allowed disabled:bg-ink-50"
                      >
                        <option value="rep">Vendedor</option>
                        <option value="admin">Administrador</option>
                      </select>
                    </td>
                    {groups.length > 0 && (
                      <td className="px-4 py-3">
                        <select
                          value={u.group_id ?? ''}
                          disabled={!can('users.update')}
                          onChange={(e) => void patch(u.id, { group_id: e.target.value === '' ? null : Number(e.target.value) })}
                          className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-xs disabled:cursor-not-allowed disabled:bg-ink-50"
                        >
                          <option value="">Sem grupo</option>
                          {groups.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
                        </select>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <Badge tone={u.ativo ? 'success' : 'neutral'}>{u.ativo ? 'Ativo' : 'Desativado'}</Badge>
                        {u.must_change_password && <Badge tone="warn">Senha provisória</Badge>}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex gap-1.5">
                        {!self && can('relationships.transfer') && (
                          <Btn size="sm" variant="ghost" onClick={() => setTransfer(u)}>Transferir carteira</Btn>
                        )}
                        {!self && can('users.reset_password') && (
                          <Btn size="sm" variant="ghost" onClick={() => setResetting(u)}>Redefinir senha</Btn>
                        )}
                        {!self && can('users.update') && (
                          <Btn size="sm" variant={u.ativo ? 'danger' : 'soft'}
                            onClick={() => patch(u.id, { ativo: !u.ativo })}>
                            {u.ativo ? 'Desativar' : 'Reativar'}
                          </Btn>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {transfer && (
        <TransferModal from={transfer} users={users.filter((u) => u.id !== transfer.id)}
          onClose={() => setTransfer(null)} onDone={() => { setTransfer(null); }} />
      )}
      {resetting && (
        <ResetPwdModal user={resetting} onClose={() => setResetting(null)}
          onConfirm={(senha2) => resetPwd(resetting, senha2)} />
      )}
    </div>
  );
}

// Redefinir senha provisória — substitui o window.prompt nativo por modal com
// regra visível e validação antes de enviar.
function ResetPwdModal({ user, onClose, onConfirm }: { user: OrgUser; onClose: () => void; onConfirm: (senha: string) => void | Promise<void> }): React.JSX.Element {
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = senha.length >= 6;
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try { await onConfirm(senha); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} width="sm">
      <h3 className="mb-1 text-sm font-bold text-ink-900">Redefinir senha</h3>
      <p className="mb-3 text-xs text-ink-400">Nova senha provisória para {user.nome ?? user.email}. O usuário troca no próximo acesso.</p>
      <form onSubmit={submit} className="space-y-3">
        <input type="text" value={senha} onChange={(e) => setSenha(e.target.value)} autoFocus minLength={6} maxLength={200}
          placeholder="Nova senha provisória" className={inputCls} />
        <span className={cn('block text-[11px]', senha.length === 0 ? 'text-ink-400' : ok ? 'text-emerald-600' : 'text-amber-600')}>
          Mínimo 6 caracteres{senha.length > 0 && !ok ? ` (faltam ${6 - senha.length})` : ''}
        </span>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit" disabled={!ok || busy}>Redefinir</Btn>
        </div>
      </form>
    </Modal>
  );
}

// Nome do usuário editável direto na tabela: clica → input → Enter/blur salva,
// Esc cancela. Só dispara o PATCH se o nome mudou.
function NameCell({ u, self, onSave }: { u: OrgUser; self: boolean; onSave: (nome: string) => Promise<void> }): React.JSX.Element {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(u.nome ?? '');
  useEffect(() => { setVal(u.nome ?? ''); }, [u.nome]);

  const commit = async (): Promise<void> => {
    setEditing(false);
    const t = val.trim();
    if (t && t !== (u.nome ?? '')) await onSave(t);
    else setVal(u.nome ?? '');
  };

  if (editing) {
    return (
      <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} maxLength={120} onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') { setVal(u.nome ?? ''); setEditing(false); }
        }}
        aria-label={`Editar nome de ${u.email}`}
        className="w-40 rounded-lg border border-brand-300 bg-surface px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-brand-200" />
    );
  }
  if (!can('users.update')) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {u.nome ?? '—'}
        {self && <span className="text-xs font-normal text-ink-400">(você)</span>}
      </span>
    );
  }
  return (
    <button onClick={() => setEditing(true)} title="Editar nome"
      className="group inline-flex items-center gap-1.5 text-left hover:text-brand-600">
      {u.nome ?? '—'}
      {self && <span className="text-xs font-normal text-ink-400">(você)</span>}
      <Icon name="pencil" size={13} className="text-ink-300 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// Transferência total da carteira de um vendedor para outro (desligamento ou
// realocação). A API move todos os relationships do vendedor de origem.
function TransferModal({ from, users, onClose, onDone }: {
  from: OrgUser; users: OrgUser[]; onClose: () => void; onDone: () => void;
}): React.JSX.Element {
  const [toId, setToId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<number | null>(null);

  const submit = async (): Promise<void> => {
    if (toId === '') return;
    setBusy(true); setErr('');
    try {
      const r = await api.post<{ transferred: number }>('/api/relationships/transfer', {
        from_user_id: from.id, to_user_id: toId,
      });
      setResult(r.transferred);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Não foi possível transferir.');
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} width="md">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">Transferir carteira</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100">
          <Icon name="x" size={17} />
        </button>
      </div>
      {result !== null ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">{result} registro(s) transferido(s) de {from.nome ?? from.email}.</p>
          <div className="flex justify-end"><Btn onClick={onDone}>Concluir</Btn></div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-400">
            Move toda a carteira (funil) de <strong>{from.nome ?? from.email}</strong> para outro vendedor.
          </p>
          <Field label="Transferir para">
            <select value={toId} onChange={(e) => setToId(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
              <option value="">Escolha o vendedor…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.nome ?? u.email}</option>)}
            </select>
          </Field>
          {err && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
            <Btn icon="check" disabled={busy || toId === ''} onClick={() => submit()}>{busy ? '…' : 'Transferir'}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Metas(): React.JSX.Element {
  const { can } = useAuth();
  const [competencia, setCompetencia] = useState(todayStr().slice(0, 7));
  const [progress, setProgress] = useState<GoalProgress[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [reps, setReps] = useState<RepresentedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // form nova meta
  const [userId, setUserId] = useState<number | ''>('');
  const [representedId, setRepresentedId] = useState<number | ''>('');
  const [valor, setValor] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true); setErr('');
    try {
      const r = await api.get<{ progress: GoalProgress[] }>(`/api/goals/progress?competencia=${competencia}`);
      setProgress(r.progress);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Erro ao carregar metas');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [competencia]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void api.get<{ users: OrgUser[] }>('/api/users').then((r) => setUsers(r.users.filter((u) => u.ativo))).catch(() => undefined);
    void api.get<{ empresas: RepresentedCompany[] }>('/api/represented').then((r) => setReps(r.empresas.filter((e) => e.ativo))).catch(() => undefined);
  }, []);

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (userId === '' || valor.trim() === '') return;
    setBusy(true); setErr('');
    try {
      await api.post('/api/goals', {
        user_id: userId,
        represented_id: representedId === '' ? null : representedId,
        competencia,
        valor_meta: dec(valor),
      });
      setUserId(''); setRepresentedId(''); setValor('');
      await load();
      toast.success('Meta definida.');
    } catch (e2) {
      const msg = e2 instanceof ApiError ? e2.message : 'Erro ao criar meta';
      setErr(msg); toast.error(msg);
    } finally { setBusy(false); }
  };

  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir esta meta?'))) return;
    try { await api.del(`/api/goals/${id}`); await load(); toast.success('Meta excluída.'); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'Erro ao excluir meta'); }
  };

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Competência">
          <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} className={cn(inputCls, 'w-44')} />
        </Field>
        {can('goals.create') && (
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field label="Vendedor">
              <select value={userId} onChange={(e) => setUserId(e.target.value === '' ? '' : Number(e.target.value))} required className={cn(inputCls, 'w-48')}>
                <option value="">Escolha…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.nome ?? u.email}</option>)}
              </select>
            </Field>
            <Field label="Representada (opcional)">
              <select value={representedId} onChange={(e) => setRepresentedId(e.target.value === '' ? '' : Number(e.target.value))} className={cn(inputCls, 'w-48')}>
                <option value="">Todas (meta global)</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
              </select>
            </Field>
            <Field label="Meta (R$)">
              <input type="text" inputMode="decimal" value={valor} onChange={(e) => setValor(maskMoney(e.target.value))} required className={cn(inputCls, 'w-36')} />
            </Field>
            <Btn icon="plus" type="submit" disabled={busy}>{busy ? '…' : 'Definir meta'}</Btn>
          </form>
        )}
      </Card>

      {err && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}

      {loading ? (
        <Spinner />
      ) : progress.length === 0 ? (
        <EmptyState icon="target" title="Sem metas no mês" hint="Defina a meta de um vendedor para o mês selecionado." />
      ) : (
        <div className="space-y-2">
          {progress.map((g) => {
            const pct = g.pct ?? 0;
            const tone = pct >= 100 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-brand-500';
            return (
              <Card key={g.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">{g.vendedor_nome ?? g.vendedor_email}</p>
                    <p className="truncate text-xs text-ink-400">{g.represented_nome ?? 'Meta global'}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="tabnums text-sm font-bold text-ink-900">{brl(g.realizado)} <span className="font-normal text-ink-400">/ {brl(Number(g.valor_meta))}</span></p>
                      <p className="tabnums text-xs font-semibold text-ink-500">{g.pct ?? 0}%</p>
                    </div>
                    {can('goals.delete') && (
                      <SafeButton onClick={() => remove(g.id)} aria-label="Excluir meta"
                        className="grid h-8 w-8 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500"><Icon name="trash" size={16} /></SafeButton>
                    )}
                  </div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
