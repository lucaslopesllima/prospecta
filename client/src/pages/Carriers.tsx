import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Carrier, CompanyHit } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, PageHeader, SafeButton, Spinner } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { CompanySearch } from '../lib/companySearch.tsx';
import { toast } from '../lib/toast.tsx';
import { invalidCNPJ, isEmail, maskCNPJ, maskPhone } from '../lib/format.ts';
import { confirmDialog } from '../lib/confirm.ts';


type Form = { nome: string; cnpj: string; telefone: string; email: string; contato: string; observacoes: string };
const EMPTY: Form = { nome: '', cnpj: '', telefone: '', email: '', contato: '', observacoes: '' };
const toForm = (c: Carrier): Form => ({
  nome: c.nome, cnpj: c.cnpj ?? '', telefone: c.telefone ?? '', email: c.email ?? '',
  contato: c.contato ?? '', observacoes: c.observacoes ?? '',
});
function toBody(f: Form): Record<string, unknown> {
  const t = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    nome: f.nome.trim(), cnpj: t(f.cnpj), telefone: t(f.telefone),
    email: t(f.email), contato: t(f.contato), observacoes: t(f.observacoes),
  };
}

// Cadastro de transportadoras: vinculáveis ao pedido (carrier_id). Exclusão é
// soft no servidor (ativo=false) — pedido emitido mantém o rótulo.
export function Carriers(): React.JSX.Element {
  const { can } = useAuth();
  const [list, setList] = useState<Carrier[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ carriers: Carrier[] }>('/api/carriers');
    setList(r.carriers);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const create = async (f: Form): Promise<void> => {
    try {
      const r = await api.post<{ carrier: Carrier }>('/api/carriers', toBody(f));
      setList((xs) => [...xs, r.carrier]);
      setEditing(null);
      toast.success('Transportadora criada.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar.'); }
  };
  const update = async (id: number, f: Form): Promise<void> => {
    try {
      const r = await api.patch<{ carrier: Carrier }>(`/api/carriers/${id}`, toBody(f));
      setList((xs) => xs.map((x) => (x.id === id ? r.carrier : x)));
      setEditing(null);
      toast.success('Transportadora salva.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };
  // Otimista com rollback, mesmo padrão do Catálogo.
  const toggleAtivo = async (c: Carrier): Promise<void> => {
    const before = list;
    setList((xs) => xs.map((x) => (x.id === c.id ? { ...x, ativo: !x.ativo } : x)));
    try { await api.patch(`/api/carriers/${c.id}`, { ativo: !c.ativo }); }
    catch { setList(before); toast.error('Não foi possível atualizar a transportadora.'); }
  };
  const remove = async (c: Carrier): Promise<void> => {
    if (!(await confirmDialog('Desativar esta transportadora? Pedidos já emitidos mantêm o vínculo.'))) return;
    const before = list;
    setList((xs) => xs.map((x) => (x.id === c.id ? { ...x, ativo: false } : x)));
    try { await api.del(`/api/carriers/${c.id}`); toast.success('Transportadora desativada.'); }
    catch { setList(before); toast.error('Não foi possível desativar a transportadora.'); }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Transportadoras" subtitle="Cadastro para vincular nos pedidos de venda."
        actions={editing !== 'new' && can('carriers.create') && <Btn icon="plus" onClick={() => setEditing('new')}>Nova transportadora</Btn>} />

      {loading ? <Spinner /> : (
        <Card className="p-4">
          {editing === 'new' && (
            <div className="mb-4"><CarrierForm initial={EMPTY} onSave={create} onCancel={() => setEditing(null)} /></div>
          )}

          <div className="space-y-2">
            {list.length === 0 && editing !== 'new' && (
              <EmptyState icon="car" title="Nenhuma transportadora" hint="Cadastre as transportadoras que entregam seus pedidos." />
            )}
            {list.map((c) => editing === c.id ? (
              <Card key={c.id} className="border-brand-200 bg-brand-50/40 p-3">
                <CarrierForm initial={toForm(c)} onSave={(f) => update(c.id, f)} onCancel={() => setEditing(null)} />
              </Card>
            ) : (
              <div key={c.id} className={cn('flex items-start gap-3 rounded-xl border border-ink-200/70 bg-surface p-3', !c.ativo && 'opacity-60')}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-500"><Icon name="car" size={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-ink-800">{c.nome}</p>
                    {c.cnpj && <Badge tone="neutral">{c.cnpj}</Badge>}
                    {!c.ativo && <Badge tone="neutral">inativa</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-400">
                    {[c.contato, c.telefone, c.email].filter(Boolean).join(' · ') || 'sem contato'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {can('carriers.update') && (
                    <SafeButton onClick={() => toggleAtivo(c)} title={c.ativo ? 'Desativar' : 'Ativar'}
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"><Icon name={c.ativo ? 'check' : 'x'} size={16} /></SafeButton>
                  )}
                  {can('carriers.update') && (
                    <button onClick={() => setEditing(c.id)} aria-label="Editar transportadora"
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"><Icon name="pencil" size={16} /></button>
                  )}
                  {can('carriers.delete') && (
                    <SafeButton onClick={() => remove(c)} aria-label="Excluir transportadora"
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

function CarrierForm({ initial, onSave, onCancel }: {
  initial: Form; onSave: (f: Form) => void | Promise<void>; onCancel: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!f.nome.trim()) return;
    if (f.email.trim() && !isEmail(f.email)) {
      toast.error('E-mail inválido.');
      return;
    }
    if (invalidCNPJ(f.cnpj)) { toast.error('CNPJ inválido.'); return; }
    setBusy(true);
    try { await onSave(f); } finally { setBusy(false); }
  };

  // Autopreenche o formulário a partir de uma empresa da base RFB. Mantém os
  // campos já digitados que a empresa não fornece.
  const fillFrom = (c: CompanyHit): void => setF((p) => ({
    ...p,
    nome: c.nome_fantasia || c.razao_social,
    cnpj: c.cnpj ?? p.cnpj,
    telefone: c.telefone1 ?? c.telefone2 ?? p.telefone,
    email: c.email ?? p.email,
  }));

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <CompanySearch onPick={fillFrom} placeholder="Buscar na base de empresas (CNPJ ou nome)…" />
      <input autoFocus value={f.nome} onChange={set('nome')} maxLength={120} placeholder="Nome da transportadora *" className={inputCls} />
      <div className="grid gap-2.5 sm:grid-cols-3">
        <input value={f.cnpj} autoCapitalize="characters" onChange={(e) => setF((p) => ({ ...p, cnpj: maskCNPJ(e.target.value) }))} placeholder="CNPJ" className={inputCls} />
        <input value={f.telefone} inputMode="tel" onChange={(e) => setF((p) => ({ ...p, telefone: maskPhone(e.target.value) }))} placeholder="Telefone" className={inputCls} />
        <input type="email" value={f.email} onChange={set('email')} maxLength={160} placeholder="E-mail" className={inputCls} />
      </div>
      <input value={f.contato} onChange={set('contato')} maxLength={120} placeholder="Pessoa de contato" className={inputCls} />
      <textarea value={f.observacoes} onChange={set('observacoes')} maxLength={2000} placeholder="Observações" rows={2} className={cn(inputCls, 'resize-y')} />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
        <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
      </div>
    </form>
  );
}
