import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { Cliente, CompanyHit } from '../lib/types.ts';
import { Badge, Btn, Card, cn, EmptyState, inputCls, PageHeader, RowActions, Spinner, StatRow } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { CompanySearch } from '../lib/companySearch.tsx';
import { CompanyModal } from '../lib/companyModal.tsx';
import { toast } from '../lib/toast.tsx';
import { brl0, dec, maskCNPJ, maskMoney, maskSearchCNPJ, numStr } from '../lib/format.ts';
import { confirmDialog } from '../lib/confirm.ts';


// Tela de Clientes. Um cliente é um company_relationships com status='cliente':
// NÃO copia dados da empresa, só referencia (company_id). Os campos da empresa
// são lidos via JOIN/CompanyModal a partir da base global — fonte única.
export function Clientes(): React.JSX.Element {
  const { can } = useAuth();
  const [list, setList] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [verEmpresa, setVerEmpresa] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ relationships: Cliente[] }>('/api/relationships?status=cliente&limit=200');
    setList(r.relationships);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  // Adiciona empresa da base global como cliente (cria a referência). Se já
  // existir vínculo (prospecto no funil), o backend devolve 409 — orienta o uso.
  const addCliente = async (c: CompanyHit): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ relationship: Cliente }>('/api/relationships', { company_id: c.id, status: 'cliente' });
      // POST devolve só as colunas do relationship; recarrega p/ trazer o JOIN da empresa.
      setList((xs) => [{ ...r.relationship, razao_social: c.razao_social, nome_fantasia: c.nome_fantasia,
        cnpj: c.cnpj, uf: c.uf, contatos: [] } as Cliente, ...xs]);
      setAdding(false);
      toast.success('Cliente adicionado.');
      void load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      toast.error(/funil|já/i.test(msg) ? 'Empresa já está no funil — converta para cliente no Funil.' : (msg || 'Não foi possível adicionar.'));
    } finally { setBusy(false); }
  };

  // Importa clientes a partir de um CSV só com CNPJs (com ou sem máscara). O
  // arquivo é lido no cliente; só os CNPJs vão ao backend, que resolve cada um
  // na base global e cria o vínculo como cliente. Devolve resumo p/ o toast.
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite reimportar o mesmo arquivo
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      // Quebra por linha/vírgula/;/tab; mantém só tokens com dígito (pula header/branco).
      const cnpjs = text.split(/[\r\n,;\t]+/).map((s) => s.trim()).filter((s) => /\d/.test(s));
      if (cnpjs.length === 0) { toast.error('Nenhum CNPJ encontrado no arquivo.'); return; }
      const r = await api.post<{ created: number; alreadyExists: string[]; notFound: string[]; invalid: string[] }>(
        '/api/relationships/import', { cnpjs },
      );
      const parts = [`${r.created} adicionado(s)`];
      if (r.alreadyExists.length) parts.push(`${r.alreadyExists.length} já era(m) cliente`);
      if (r.notFound.length) parts.push(`${r.notFound.length} fora da base`);
      if (r.invalid.length) parts.push(`${r.invalid.length} inválido(s)`);
      const msg = parts.join(' · ');
      if (r.created > 0) { toast.success(msg); void load(); } else toast.error(msg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao importar o CSV.');
    } finally { setImporting(false); }
  };

  const save = async (id: number, patch: { notas: string | null; valor_estimado: number | null }): Promise<void> => {
    try {
      const r = await api.patch<{ relationship: Cliente }>(`/api/relationships/${id}`, patch);
      setList((xs) => xs.map((x) => (x.id === id ? { ...x, notas: r.relationship.notas, valor_estimado: r.relationship.valor_estimado } : x)));
      setEditing(null);
      toast.success('Cliente salvo.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };

  // Ativa/inativa o cliente (soft). Otimista com rollback. Inativo segue na base,
  // só sai do uso corrente — diferente de remover (apaga o vínculo).
  const toggleAtivo = async (c: Cliente): Promise<void> => {
    const before = list;
    setList((xs) => xs.map((x) => (x.id === c.id ? { ...x, ativo: !x.ativo } : x)));
    try {
      await api.patch(`/api/relationships/${c.id}`, { ativo: !c.ativo });
      toast.success(c.ativo ? 'Cliente inativado.' : 'Cliente reativado.');
    } catch { setList(before); toast.error('Não foi possível atualizar.'); }
  };

  const remove = async (c: Cliente): Promise<void> => {
    if (!(await confirmDialog(`Remover ${c.nome_fantasia || c.razao_social} dos clientes? A empresa permanece na base; só o vínculo é removido.`))) return;
    const before = list;
    setList((xs) => xs.filter((x) => x.id !== c.id));
    try { await api.del(`/api/relationships/${c.id}`); toast.success('Vínculo removido.'); }
    catch { setList(before); toast.error('Não foi possível remover.'); }
  };

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return list;
    const dig = t.replace(/\D/g, '');
    return list.filter((c) =>
      c.razao_social.toLowerCase().includes(t)
      || (c.nome_fantasia ?? '').toLowerCase().includes(t)
      || (dig.length > 0 && c.cnpj.includes(dig)));
  }, [list, q]);

  const totalValor = useMemo(() => list.reduce((s, c) => s + (dec(c.valor_estimado) || 0), 0), [list]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Clientes" subtitle="Empresas convertidas em cliente. Os dados cadastrais vêm da base — aqui só o relacionamento."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => void onFile(e)} />
            {can('relationships.import') && (
              <Btn variant="soft" icon="download" disabled={importing} onClick={() => fileRef.current?.click()}>
                {importing ? 'Importando…' : 'Importar CSV'}
              </Btn>
            )}
            {can('relationships.create') && !adding && <Btn icon="plus" onClick={() => setAdding(true)}>Novo cliente</Btn>}
          </div>
        )} />

      {loading ? <Spinner /> : (
        <>
          <StatRow items={[
            { label: 'Clientes ativos', value: list.length, icon: 'users' },
            { label: 'Valor estimado total', value: brl0(totalValor), icon: 'wallet', tone: 'success' },
          ]} />

          <Card className="p-4">
            {adding && (
              <div className="mb-4 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
                <p className="mb-2 text-xs font-medium text-ink-500">Busque a empresa na base e selecione para vinculá-la como cliente.</p>
                <CompanySearch onPick={(c) => void addCliente(c)} placeholder="Buscar empresa por CNPJ ou nome…" disableInFunnel />
                <div className="mt-2 flex justify-end">
                  <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(false)}>Fechar</Btn>
                </div>
              </div>
            )}

            {list.length > 0 && (
              <div className="relative mb-3">
                <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input value={q} onChange={(e) => setQ(maskSearchCNPJ(e.target.value))} maxLength={120} placeholder="Filtrar por nome ou CNPJ…"
                  className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-3 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200" />
              </div>
            )}

            <div className="space-y-2">
              {list.length === 0 && !adding && (
                <EmptyState icon="users" title="Nenhum cliente ainda"
                  hint="Adicione uma empresa da base como cliente ou converta um prospecto no Funil." />
              )}
              {list.length > 0 && filtered.length === 0 && (
                <p className="py-8 text-center text-sm text-ink-400">Nenhum cliente corresponde ao filtro.</p>
              )}
              {filtered.map((c) => editing === c.id ? (
                <Card key={c.id} className="border-brand-200 bg-brand-50/40 p-3">
                  <ClienteForm cliente={c} onSave={(p) => save(c.id, p)} onCancel={() => setEditing(null)} />
                </Card>
              ) : (
                <div key={c.id} className={cn('flex items-start gap-3 rounded-xl border border-hairline bg-surface p-3', !c.ativo && 'opacity-60')}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="building" size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-ink-800">{c.nome_fantasia || c.razao_social}</p>
                      <Badge tone="neutral">{maskCNPJ(c.cnpj)}</Badge>
                      {c.uf && <Badge tone="info">{c.uf}</Badge>}
                      {c.representada && <Badge tone="brand">{c.representada}</Badge>}
                      {!c.ativo && <Badge tone="warn">inativo</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-400">
                      {[
                        dec(c.valor_estimado) ? brl0(dec(c.valor_estimado)) : null,
                        c.contatos.length ? `${c.contatos.length} contato(s)` : null,
                        c.notas,
                      ].filter(Boolean).join(' · ') || 'sem detalhes do relacionamento'}
                    </p>
                  </div>
                  {/* No celular fica só "ver empresa"; o resto entra no `⋯`.
                      Quatro ícones fixavam 140px da linha e o nome sumia. */}
                  <RowActions
                    primary={{ icon: 'eye', label: 'Ver dados da empresa', onClick: () => setVerEmpresa(c.company_id) }}
                    actions={[
                      { icon: 'pencil', label: 'Editar relacionamento', onClick: () => setEditing(c.id), hidden: !can('relationships.update') },
                      { icon: c.ativo ? 'x' : 'check', label: c.ativo ? 'Inativar cliente' : 'Reativar cliente', onClick: () => toggleAtivo(c), hidden: !can('relationships.delete') },
                      { icon: 'trash', label: 'Remover cliente', onClick: () => remove(c), tone: 'danger', hidden: !can('relationships.delete') },
                    ]} />
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {verEmpresa !== null && <CompanyModal companyId={verEmpresa} onClose={() => setVerEmpresa(null)} />}
    </div>
  );
}

// Edita só o estado do relacionamento (valor estimado + notas). Os dados da
// empresa não são editáveis aqui — pertencem à base global.
function ClienteForm({ cliente, onSave, onCancel }: {
  cliente: Cliente; onSave: (p: { notas: string | null; valor_estimado: number | null }) => void | Promise<void>; onCancel: () => void;
}): React.JSX.Element {
  const [valor, setValor] = useState(numStr(cliente.valor_estimado));
  const [notas, setNotas] = useState(cliente.notas ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    const v = dec(valor);
    try {
      await onSave({ notas: notas.trim() === '' ? null : notas.trim(), valor_estimado: Number.isFinite(v) ? v : null });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <p className="text-sm font-semibold text-ink-800">{cliente.nome_fantasia || cliente.razao_social}</p>
      <input value={valor} type="text" inputMode="decimal" onChange={(e) => setValor(maskMoney(e.target.value))} placeholder="Valor estimado (R$)" className={inputCls} />
      <textarea value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={2000} placeholder="Notas do relacionamento" rows={2} className={cn(inputCls, 'resize-y')} />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
        <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
      </div>
    </form>
  );
}
