import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Cliente, Order, OrgUser } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, PageHeader, Spinner, StatRow } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { toast } from '../lib/toast.tsx';
import { brl0, dec, maskCNPJ, maskSearchCNPJ } from '../lib/format.ts';
import { confirmDialog } from '../lib/confirm.ts';

// bigint do pg pode vir string — normaliza p/ comparar/agrupar por dono.
const oid = (v: number | null): number | null => (v == null ? null : Number(v));
const SEM_DONO = -1; // bucket sintético p/ clientes sem vendedor (owner null)
// Pedidos que contam como valor realizado na carteira do vendedor.
const REALIZADO_STATUS = new Set(['faturado', 'entregue']);

// Tela de Carteiras. Carteira = interseção (vendedor × seus clientes), modelada
// pelo owner_user_id do company_relationships — NÃO é tabela nova. Aqui o admin
// troca o vendedor de uma carteira (transfere tudo) e move clientes entre
// carteiras (reatribui o owner de cada cliente). Fonte única: o relacionamento.
export function Carteiras(): React.JSX.Element {
  const { can } = useAuth();
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selOwner, setSelOwner] = useState<number>(SEM_DONO);
  const [adding, setAdding] = useState(false);
  const [pickQ, setPickQ] = useState('');

  const load = async (): Promise<void> => {
    const [u, r, o] = await Promise.all([
      api.get<{ users: OrgUser[] }>('/api/users'),
      api.get<{ relationships: Cliente[] }>('/api/relationships?status=cliente&limit=200'),
      api.get<{ orders: Order[] }>('/api/orders'),
    ]);
    setUsers(u.users);
    setClientes(r.relationships.map((c) => ({ ...c, owner_user_id: oid(c.owner_user_id) })));
    setOrders(o.orders);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  // Valor realizado = soma dos pedidos faturados/entregues, creditado ao
  // vendedor do pedido (order.owner_user_id) — a venda fica na carteira de quem
  // a fez. Agrega por vendedor e por vendedor×empresa (linha do cliente).
  const realizado = useMemo(() => {
    const byOwner = new Map<number, number>();
    const byOwnerCompany = new Map<string, number>();
    for (const o of orders) {
      if (!REALIZADO_STATUS.has(o.status)) continue;
      const ow = o.owner_user_id == null ? SEM_DONO : Number(o.owner_user_id);
      const val = Number(o.total) || 0;
      byOwner.set(ow, (byOwner.get(ow) ?? 0) + val);
      const k = `${ow}:${Number(o.company_id)}`;
      byOwnerCompany.set(k, (byOwnerCompany.get(k) ?? 0) + val);
    }
    return { byOwner, byOwnerCompany };
  }, [orders]);
  const realizadoOwner = (ownerId: number): number => realizado.byOwner.get(ownerId) ?? 0;
  const realizadoCliente = (ownerId: number, companyId: number): number =>
    realizado.byOwnerCompany.get(`${ownerId}:${Number(companyId)}`) ?? 0;

  const nomeVendedor = (id: number | null): string => {
    if (id == null) return 'Sem vendedor';
    const u = users.find((x) => Number(x.id) === Number(id));
    return u ? (u.nome ?? u.email) : `#${id}`;
  };

  // Carteiras = clientes agrupados por owner. Inclui vendedores ativos sem
  // clientes (carteira vazia) e o bucket "sem vendedor" quando houver órfãos.
  const carteiras = useMemo(() => {
    const byOwner = new Map<number, Cliente[]>();
    for (const c of clientes) {
      const k = c.owner_user_id ?? SEM_DONO;
      const arr = byOwner.get(k) ?? [];
      arr.push(c); byOwner.set(k, arr);
    }
    const out = users
      .filter((u) => u.ativo || byOwner.has(Number(u.id)))
      .map((u) => ({ ownerId: Number(u.id), nome: u.nome ?? u.email, ativo: u.ativo, clientes: byOwner.get(Number(u.id)) ?? [] }));
    if (byOwner.has(SEM_DONO)) {
      out.unshift({ ownerId: SEM_DONO, nome: 'Sem vendedor', ativo: true, clientes: byOwner.get(SEM_DONO) ?? [] });
    }
    return out;
  }, [clientes, users]);

  const sel = carteiras.find((c) => c.ownerId === selOwner) ?? carteiras[0];
  // garante seleção válida quando os dados chegam
  useEffect(() => {
    if (carteiras.length && !carteiras.some((c) => c.ownerId === selOwner)) setSelOwner(carteiras[0].ownerId);
  }, [carteiras, selOwner]);

  const valorCarteira = (cs: Cliente[]): number => cs.reduce((s, c) => s + (dec(c.valor_estimado) || 0), 0);

  // Move um cliente para outra carteira (reatribui o owner). Admin only no backend.
  const moverCliente = async (c: Cliente, toOwner: number | null, confirmMove = false): Promise<void> => {
    if (confirmMove) {
      const confirmed = await confirmDialog(
        `Mover ${c.nome_fantasia || c.razao_social} para ${nomeVendedor(toOwner)}?`,
        { title: 'Trocar vendedor?', confirmText: 'Mover cliente' },
      );
      if (!confirmed) return;
    }
    const before = clientes;
    setClientes((xs) => xs.map((x) => (x.id === c.id ? { ...x, owner_user_id: toOwner } : x)));
    try {
      await api.patch(`/api/relationships/${c.id}`, { owner_user_id: toOwner });
      toast.success(`${c.nome_fantasia || c.razao_social} → ${nomeVendedor(toOwner)}.`);
    } catch (e) {
      setClientes(before);
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível mover o cliente.');
    }
  };

  // Troca o vendedor da carteira: transfere os clientes desta carteira para
  // outro vendedor. Escopado por ids (só clientes — prospects do funil ficam
  // com o dono atual). Endpoint de transferência, admin only.
  const trocarVendedor = async (toOwner: number): Promise<void> => {
    if (sel.ownerId === SEM_DONO) { toast.error('Selecione uma carteira de vendedor.'); return; }
    if (sel.clientes.length === 0) { toast.error('Carteira sem clientes para transferir.'); return; }
    const confirmed = await confirmDialog(
      `Transferir ${sel.clientes.length} cliente(s) de ${sel.nome} para ${nomeVendedor(toOwner)}?`,
      { title: 'Transferir carteira inteira?', confirmText: 'Transferir carteira' },
    );
    if (!confirmed) return;
    try {
      const r = await api.post<{ transferred: number }>('/api/relationships/transfer', {
        from_user_id: sel.ownerId, to_user_id: toOwner, ids: sel.clientes.map((c) => c.id),
      });
      toast.success(`${r.transferred} registro(s) transferido(s) para ${nomeVendedor(toOwner)}.`);
      await load();
      setSelOwner(toOwner);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível trocar o vendedor.');
    }
  };

  // Clientes que NÃO estão na carteira selecionada — candidatos a adicionar.
  const candidatos = useMemo(() => {
    if (!sel) return [];
    const t = pickQ.trim().toLowerCase();
    const dig = t.replace(/\D/g, '');
    return clientes.filter((c) => (c.owner_user_id ?? SEM_DONO) !== sel.ownerId)
      .filter((c) => !t
        || c.razao_social.toLowerCase().includes(t)
        || (c.nome_fantasia ?? '').toLowerCase().includes(t)
        || (dig.length > 0 && c.cnpj.includes(dig)));
  }, [clientes, sel, pickQ]);

  if (loading) return <Spinner />;
  if (!sel) return <EmptyState icon="users" title="Sem vendedores" hint="Cadastre vendedores em Equipe para montar carteiras." />;

  const ativos = users.filter((u) => u.ativo);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Carteiras" subtitle="A carteira de cada vendedor e seus clientes. Troque o vendedor ou mova clientes entre carteiras." />

      <StatRow items={[
        { label: 'Carteiras', value: carteiras.filter((c) => c.ownerId !== SEM_DONO).length, icon: 'users' },
        { label: 'Clientes alocados', value: clientes.filter((c) => c.owner_user_id != null).length, icon: 'building', tone: 'info' },
        { label: 'Faturado + entregue', value: brl0([...realizado.byOwner].reduce((s, [, v]) => s + v, 0)), sub: 'valor realizado nas carteiras', icon: 'wallet', tone: 'success' },
        { label: 'Sem vendedor', value: clientes.filter((c) => c.owner_user_id == null).length, icon: 'alertTriangle', tone: 'warn' },
      ]} />

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        {/* Lista de carteiras */}
        <Card className="h-max p-2">
          <div className="space-y-1">
            {carteiras.map((c) => (
              <button key={c.ownerId} onClick={() => setSelOwner(c.ownerId)}
                className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                  c.ownerId === sel.ownerId ? 'bg-brand-50 text-brand-800' : 'hover:bg-ink-50')}>
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                  c.ownerId === SEM_DONO ? 'bg-amber-50 text-amber-600' : 'bg-ink-100 text-ink-500')}>
                  <Icon name={c.ownerId === SEM_DONO ? 'alertTriangle' : 'users'} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{c.nome}{!c.ativo && c.ownerId !== SEM_DONO && ' (inativo)'}</p>
                  <p className="truncate text-[11px] text-ink-400">{c.clientes.length} cliente(s) · {brl0(realizadoOwner(c.ownerId))} faturado</p>
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* Carteira selecionada */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-ink-900">{sel.nome}</h3>
              <p className="text-xs text-ink-400">
                {sel.clientes.length} cliente(s) · <span className="font-semibold text-emerald-600">{brl0(realizadoOwner(sel.ownerId))}</span> faturado · {brl0(valorCarteira(sel.clientes))} estimado
              </p>
            </div>
            <div className="flex items-center gap-2">
              {sel.ownerId !== SEM_DONO && can('relationships.transfer') && (
                <label className="inline-flex items-center gap-2 text-xs text-ink-500">
                  Trocar vendedor:
                  <select value="" onChange={(e) => { if (e.target.value) void trocarVendedor(Number(e.target.value)); }}
                    className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs">
                    <option value="">escolha…</option>
                    {/* u.id vem string da API; sel.ownerId é Number() — coage p/ excluir o dono atual */}
                    {ativos.filter((u) => Number(u.id) !== sel.ownerId).map((u) => <option key={u.id} value={u.id}>{u.nome ?? u.email}</option>)}
                  </select>
                </label>
              )}
              {can('relationships.transfer') && (
                <Btn size="sm" icon="plus" variant="soft" onClick={() => { setAdding((v) => !v); setPickQ(''); }}>Adicionar clientes</Btn>
              )}
            </div>
          </div>

          {/* Picker para adicionar clientes de outras carteiras */}
          {adding && (
            <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
              <div className="relative mb-2">
                <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input value={pickQ} onChange={(e) => setPickQ(maskSearchCNPJ(e.target.value))} maxLength={120} placeholder="Buscar cliente por nome ou CNPJ…"
                  className="w-full rounded-xl border border-ink-200 bg-surface py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200" />
              </div>
              <div className="max-h-60 space-y-1 overflow-auto">
                {candidatos.length === 0 ? (
                  <p className="py-4 text-center text-xs text-ink-400">Nenhum cliente para adicionar.</p>
                ) : candidatos.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink-700">{c.nome_fantasia || c.razao_social}</p>
                      <p className="truncate text-[11px] text-ink-400">{maskCNPJ(c.cnpj)} · atual: {nomeVendedor(c.owner_user_id)}</p>
                    </div>
                    <Btn size="sm" variant="ghost" icon="arrowRight"
                      onClick={() => moverCliente(c, sel.ownerId === SEM_DONO ? null : sel.ownerId)}>Adicionar</Btn>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Clientes da carteira */}
          <div className="mt-3 space-y-2">
            {sel.clientes.length === 0 ? (
              <EmptyState icon="building" title="Carteira vazia" hint="Use “Adicionar clientes” para alocar clientes a este vendedor." />
            ) : sel.clientes.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-xl border border-hairline bg-surface p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="building" size={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-ink-800">{c.nome_fantasia || c.razao_social}</p>
                    <Badge tone="neutral">{maskCNPJ(c.cnpj)}</Badge>
                    {c.uf && <Badge tone="info">{c.uf}</Badge>}
                    {realizadoCliente(sel.ownerId, c.company_id) > 0 && (
                      <Badge tone="success">{brl0(realizadoCliente(sel.ownerId, c.company_id))} faturado</Badge>
                    )}
                    {dec(c.valor_estimado) > 0 && <Badge tone="brand">{brl0(dec(c.valor_estimado))} est.</Badge>}
                  </div>
                  {c.representada && <p className="mt-0.5 truncate text-xs text-ink-400">{c.representada}</p>}
                </div>
                <label className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400">
                  <Icon name="users" size={14} />
                  <select value={c.owner_user_id ?? ''} aria-label="Vendedor da carteira"
                    disabled={!can('relationships.transfer')}
                    onChange={(e) => void moverCliente(c, e.target.value === '' ? null : Number(e.target.value), true)}
                    className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-700">
                    <option value="">Sem vendedor</option>
                    {ativos.map((u) => <option key={u.id} value={u.id}>{u.nome ?? u.email}</option>)}
                  </select>
                </label>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
