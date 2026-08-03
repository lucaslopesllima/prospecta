import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { useAuth } from './auth.tsx';
import type { Carrier, CatalogItem, CommissionEntry, Contact, KanbanCard, Order, PriceTable, RepresentedCompany, TaxDefaults } from './types.ts';
import { Btn, Card, cn } from './ui.tsx';
import { Icon } from './icons.tsx';
import { brl, dec, maskMoney, maskPct, numStr, todayStr } from './format.ts';
import { toast } from './toast.tsx';

// Modal de criação/edição de pedido. Reusável: a tela de Pedidos e o chat do
// WhatsApp ("criar pedido a partir da conversa") montam o mesmo componente.
// Auto-suficiente — carrega representadas/clientes/catálogo/transportadoras
// sozinho, então quem usa só passa order (edição) ou prefill (novo).

const inputCls = 'w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200';

type Opt = { id: number; label: string };

// Campos de imposto por item (mesma ordem da config e do back). Ocultos na
// grade por ora (uso futuro) — seguem no estado, no total e no submit (0 se vazio).
const TAX_FIELDS = [
  ['icms_pct', 'ICMS %'], ['ipi_pct', 'IPI %'], ['st_pct', 'ST %'],
  ['pis_pct', 'PIS %'], ['cofins_pct', 'COFINS %'], ['iss_pct', 'ISS %'],
] as const;
type TaxKey = (typeof TAX_FIELDS)[number][0];

interface ItemDraft {
  catalog_item_id: number | null; descricao: string; unidade_medida: string; qtd: string; preco_unit: string;
  desconto_pct: string; icms_pct: string; ipi_pct: string; st_pct: string;
  pis_pct: string; cofins_pct: string; iss_pct: string;
}
const EMPTY_ITEM: ItemDraft = {
  catalog_item_id: null, descricao: '', unidade_medida: '', qtd: '1', preco_unit: '', desconto_pct: '',
  icms_pct: '', ipi_pct: '', st_pct: '', pis_pct: '', cofins_pct: '', iss_pct: '',
};

// Alíquotas default da org como strings, p/ preencher item novo (vazio = '').
const taxDraft = (d: TaxDefaults | null): Record<TaxKey, string> =>
  Object.fromEntries(TAX_FIELDS.map(([k]) => [k, d && d[k] ? String(d[k]) : ''])) as Record<TaxKey, string>;

const itemTotal = (i: ItemDraft): number => {
  const q = dec(i.qtd) || 0;
  const p = dec(i.preco_unit) || 0;
  const d = dec(i.desconto_pct) || 0;
  const imp = TAX_FIELDS.reduce((s, [k]) => s + (dec(i[k]) || 0), 0);
  return q * p * (1 - d / 100) * (1 + imp / 100);
};

export interface OrderPrefill {
  company_id: number;
  represented_id: number | null;
  relationship_id: number | null;
  // rótulo da empresa vinculada (chat do WhatsApp) — injeta a opção no select
  // quando a empresa não está no funil e por isso não vem na lista de clientes.
  company_label?: string;
}

export function OrderModal({ order = null, prefill = null, onClose, onSaved }: {
  order?: Order | null;
  prefill?: OrderPrefill | null;
  onClose: () => void; onSaved: () => void;
}): React.JSX.Element {
  const { user } = useAuth();
  const readOnly = order != null && order.status !== 'cotacao' && order.status !== 'rascunho';

  const [reps, setReps] = useState<RepresentedCompany[]>([]);
  const [companies, setCompanies] = useState<(Opt & { relationship_id: number })[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);

  const [companyId, setCompanyId] = useState<number | null>(order?.company_id ?? prefill?.company_id ?? null);
  const [representedId, setRepresentedId] = useState<number | null>(order?.represented_id ?? prefill?.represented_id ?? null);
  const [cotacao, setCotacao] = useState(order ? order.status === 'cotacao' : false);
  const [validade, setValidade] = useState(order?.validade?.slice(0, 10) ?? '');
  const [condicao, setCondicao] = useState(order?.condicao_pagamento ?? '');
  const [carrierId, setCarrierId] = useState<number | null>(order?.carrier_id ?? null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState<number | null>(order?.contact_id ?? null);
  const [contactBusy, setContactBusy] = useState(false);
  const [frete, setFrete] = useState(order ? numStr(order.frete) : '');
  const [observacoes, setObservacoes] = useState(order?.observacoes ?? '');
  const [items, setItems] = useState<ItemDraft[]>(
    (order?.items ?? []).map((i) => ({
      catalog_item_id: i.catalog_item_id, descricao: i.descricao_snapshot,
      unidade_medida: i.unidade_medida_snapshot ?? '', qtd: numStr(i.qtd),
      preco_unit: numStr(i.preco_unit), desconto_pct: String(Number(i.desconto_pct) || ''),
      icms_pct: String(Number(i.icms_pct) || ''), ipi_pct: String(Number(i.ipi_pct) || ''),
      st_pct: String(Number(i.st_pct) || ''), pis_pct: String(Number(i.pis_pct) || ''),
      cofins_pct: String(Number(i.cofins_pct) || ''), iss_pct: String(Number(i.iss_pct) || ''),
    })),
  );
  const [table, setTable] = useState<PriceTable | null>(null);
  const [taxDef, setTaxDef] = useState<TaxDefaults | null>(null);
  const [comissao, setComissao] = useState<CommissionEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false); // mostra erros inline só após tentar salvar

  // Dependências do formulário (carregadas pelo próprio modal).
  useEffect(() => {
    void api.get<{ empresas: RepresentedCompany[] }>('/api/represented')
      .then((r) => setReps(r.empresas.filter((e) => e.ativo))).catch(() => undefined);
    void api.get<{ cards: KanbanCard[] }>('/api/kanban').then((r) => {
      setCompanies(r.cards.map((c) => ({
        id: c.company_id, relationship_id: c.id, label: c.nome_fantasia || c.razao_social,
      })).sort((a, b) => a.label.localeCompare(b.label)));
    }).catch(() => undefined);
    void api.get<{ items: CatalogItem[] }>('/api/catalog')
      .then((r) => setCatalog(r.items.filter((i) => i.ativo))).catch(() => undefined);
    void api.get<{ carriers: Carrier[] }>('/api/carriers')
      .then((r) => setCarriers(r.carriers.filter((c) => c.ativo))).catch(() => undefined);
  }, []);

  // Contatos da empresa cliente — populam o select "Contato" do pedido.
  useEffect(() => {
    if (companyId == null) { setContacts([]); return; }
    // `?? []`: resposta sem a chave derrubava o modal inteiro no render do
    // <select> de contato (contacts.map em cima de undefined).
    void api.get<{ contacts: Contact[] }>(`/api/contacts?company_id=${companyId}`)
      .then((r) => setContacts(r.contacts ?? [])).catch(() => undefined);
  }, [companyId]);

  // Troca o contato do pedido. Em pedido já salvo grava na hora (endpoint próprio,
  // liberado em qualquer status); em pedido novo só guarda p/ enviar no submit.
  const changeContact = (id: number | null): void => {
    setContactId(id);
    if (order == null) return;
    setContactBusy(true);
    void api.patch<{ order: Order }>(`/api/orders/${order.id}/contact`, { contact_id: id })
      .then(() => toast.success('Contato do pedido atualizado.'))
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao atualizar contato.'))
      .finally(() => setContactBusy(false));
  };

  // validação por item, reusada pra destacar campo e bloquear submit
  const itemErr = (i: ItemDraft): { desc: boolean; qtd: boolean; preco: boolean } => ({
    desc: !i.descricao.trim(),
    qtd: !(dec(i.qtd) > 0),
    preco: i.preco_unit.trim() === '' || !(dec(i.preco_unit) >= 0),
  });

  // pedido faturado/entregue tem comissão gerada — exibe a previsão
  // (admin vê o total; vendedor vê a própria parte).
  useEffect(() => {
    if (order == null || (order.status !== 'faturado' && order.status !== 'entregue')) return;
    void api.get<{ entries: CommissionEntry[] }>(`/api/commissions?order_id=${order.id}`)
      .then((r) => setComissao(r.entries[0] ?? null)).catch(() => undefined);
  }, [order]);

  // alíquotas default da org → preenchem impostos de itens novos.
  useEffect(() => {
    void api.get<{ tax: TaxDefaults }>('/api/tax-defaults')
      .then((r) => setTaxDef(r.tax)).catch(() => undefined);
  }, []);

  // representada escolhida -> carrega a tabela de preço vigente
  useEffect(() => {
    setTable(null);
    if (representedId == null) return;
    void api.get<{ table: PriceTable | null }>(`/api/price-tables/active?represented_id=${representedId}`)
      .then((r) => setTable(r.table)).catch(() => undefined);
  }, [representedId]);

  // ids vêm como string do back (bigint sem parser no pg) — coage os dois lados
  // pra casar com o id numérico do <select> (Number(value)).
  const tablePrice = (catalogItemId: number): string | null => {
    const it = table?.items?.find((x) => Number(x.catalog_item_id) === Number(catalogItemId));
    return it != null ? numStr(it.preco) : null;
  };

  // imposto do item novo: se o produto define ALGUM imposto, usa o do produto
  // (campo nulo = 0); senão cai inteiro no default da org.
  const itemTax = (cat?: CatalogItem): Record<TaxKey, string> => {
    const has = cat != null && TAX_FIELDS.some(([k]) => cat[k] != null);
    return has
      ? Object.fromEntries(TAX_FIELDS.map(([k]) => [k, numStr(cat[k])])) as Record<TaxKey, string>
      : taxDraft(taxDef);
  };

  const addCatalogItem = (id: number): void => {
    const cat = catalog.find((c) => Number(c.id) === Number(id));
    setItems((xs) => [...xs, {
      ...EMPTY_ITEM,
      ...itemTax(cat),
      catalog_item_id: id,
      descricao: cat?.nome ?? '',
      unidade_medida: cat?.unidade_medida ?? '',
      preco_unit: tablePrice(id) ?? numStr(cat?.preco),
    }]);
  };
  const setItem = (idx: number, patch: Partial<ItemDraft>): void =>
    setItems((xs) => xs.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  const total = items.reduce((s, i) => s + itemTotal(i), 0) + (dec(frete) || 0);

  // empresa vinculada que não está no funil não aparece na lista — injeta a opção.
  const companyMissing = companyId != null && !companies.some((c) => Number(c.id) === Number(companyId));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (readOnly) return;
    setTried(true);
    if (companyId == null || representedId == null) { toast.error('Escolha o cliente e a representada.'); return; }
    if (items.length === 0) { toast.error('Adicione pelo menos um item.'); return; }
    // aponta o primeiro item incompleto pelo número, em vez de mensagem genérica
    const badIdx = items.findIndex((i) => { const er = itemErr(i); return er.desc || er.qtd || er.preco; });
    if (badIdx >= 0) { toast.error(`Item ${badIdx + 1}: preencha descrição, quantidade e preço.`); return; }
    setBusy(true);
    const num = (s: string): number | undefined => (s.trim() === '' ? undefined : dec(s));
    const body: Record<string, unknown> = {
      company_id: companyId,
      represented_id: representedId,
      // funil primeiro: se o cliente foi trocado, pega o relationship do card
      // escolhido; senão cai no do próprio pedido/prefill (cliente fora do funil).
      relationship_id: companies.find((c) => Number(c.id) === Number(companyId))?.relationship_id
        ?? order?.relationship_id
        ?? prefill?.relationship_id
        ?? null,
      price_table_id: table != null ? table.id : null,
      validade: cotacao && validade ? validade : null,
      condicao_pagamento: condicao || null,
      carrier_id: carrierId,
      contact_id: contactId,
      frete: dec(frete) || 0,
      observacoes: observacoes || null,
      items: items.map((i) => ({
        catalog_item_id: i.catalog_item_id,
        descricao: i.descricao.trim(),
        unidade_medida: i.unidade_medida.trim() || null,
        qtd: dec(i.qtd),
        preco_unit: dec(i.preco_unit),
        desconto_pct: num(i.desconto_pct) ?? 0,
        icms_pct: num(i.icms_pct) ?? 0,
        ipi_pct: num(i.ipi_pct) ?? 0,
        st_pct: num(i.st_pct) ?? 0,
        pis_pct: num(i.pis_pct) ?? 0,
        cofins_pct: num(i.cofins_pct) ?? 0,
        iss_pct: num(i.iss_pct) ?? 0,
      })),
    };
    try {
      if (order) await api.patch(`/api/orders/${order.id}`, body);
      else await api.post('/api/orders', { ...body, status: cotacao ? 'cotacao' : 'rascunho' });
      toast.success(order ? `Pedido #${order.numero} salvo.` : 'Pedido criado.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar o pedido.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[2000] grid place-items-center bg-black/45 p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl p-4 shadow-pop">
        <div onClick={(e) => e.stopPropagation()}>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-ink-900">
              {order ? `Pedido #${order.numero}` : 'Novo pedido'}
              {readOnly && <span className="ml-2 text-xs font-medium text-ink-400">(somente leitura)</span>}
            </h3>
            <button onClick={onClose} aria-label="Fechar" className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100">
              <Icon name="x" size={17} />
            </button>
          </div>
          <form onSubmit={submit} className="max-h-[75vh] space-y-3 overflow-auto pr-1">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold text-ink-600">Cliente (funil) *</span>
                <select value={companyId ?? ''} disabled={readOnly}
                  onChange={(e) => setCompanyId(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
                  <option value="">Escolha o cliente</option>
                  {companyMissing && <option value={companyId!}>{prefill?.company_label ?? order?.company_nome ?? 'Empresa vinculada'}</option>}
                  {companies.map((c) => <option key={c.relationship_id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-ink-600">Representada *</span>
                <select value={representedId ?? ''} disabled={readOnly}
                  onChange={(e) => setRepresentedId(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
                  <option value="">Escolha a representada</option>
                  {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                </select>
              </label>
            </div>
            {representedId != null && (
              <p className="text-xs text-ink-400">
                {table ? <>Tabela de preço vigente: <span className="font-semibold text-ink-600">{table.nome}</span></> : 'Sem tabela de preço vigente — preços do mostruário.'}
              </p>
            )}

            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-ink-600">Itens *</span>
              {items.map((i, idx) => {
                const err = tried ? itemErr(i) : { desc: false, qtd: false, preco: false };
                const fieldCls = (bad: boolean): string => cn('rounded-lg border bg-surface px-2 py-1.5 text-sm',
                  bad ? 'border-rose-400 ring-1 ring-rose-200' : 'border-ink-200');
                return (
                <div key={idx} className="space-y-1.5 rounded-xl border border-ink-200/70 bg-ink-50/50 p-2">
                  <div className="flex items-center gap-2">
                    <input value={i.descricao} disabled={readOnly} maxLength={120} aria-label={`Descrição item ${idx + 1}`} aria-invalid={err.desc}
                      onChange={(e) => setItem(idx, { descricao: e.target.value })} placeholder="Descrição *"
                      className={cn('min-w-0 flex-1', fieldCls(err.desc))} />
                    {!readOnly && (
                      <button type="button" aria-label={`Remover item ${idx + 1}`} onClick={() => setItems((xs) => xs.filter((_, j) => j !== idx))}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500"><Icon name="x" size={15} /></button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    {([['qtd', 'Qtd *'], ['preco_unit', 'Preço *'], ['desconto_pct', 'Desc %']] as const).map(([k, ph]) => {
                      const bad = (k === 'qtd' && err.qtd) || (k === 'preco_unit' && err.preco);
                      // qtd herda a unidade do produto (snapshot) — rótulo "Qtd (KG)".
                      const lbl = k === 'qtd' && i.unidade_medida ? `Qtd * (${i.unidade_medida})` : ph;
                      return (
                      <label key={k} className="block">
                        <span className="mb-0.5 block truncate text-[10px] font-semibold text-ink-500">{lbl}</span>
                        <input type="text" inputMode="decimal" value={i[k]} disabled={readOnly} aria-label={`${ph} item ${idx + 1}`} aria-invalid={bad}
                          onChange={(e) => setItem(idx, { [k]: k.endsWith('_pct') ? maskPct(e.target.value) : k === 'qtd' ? maskMoney(e.target.value, 6) : maskMoney(e.target.value) })} placeholder={ph}
                          className={cn(fieldCls(bad), 'w-full')} />
                      </label>
                      );
                    })}
                    <div className="col-span-3 sm:col-span-1">
                      <span className="mb-0.5 block text-[10px] font-semibold text-ink-500">Total</span>
                      <span className="tabnums grid h-[34px] place-items-center text-xs font-bold text-ink-700">{brl(itemTotal(i))}</span>
                    </div>
                  </div>
                </div>
                );
              })}
              {!readOnly && (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <select value="" aria-label="Adicionar item do mostruário"
                    onChange={(e) => { if (e.target.value !== '') addCatalogItem(Number(e.target.value)); }} className={inputCls}>
                    <option value="">+ Item do mostruário…</option>
                    {catalog.map((c) => {
                      const p = tablePrice(c.id) ?? (c.preco || null);
                      return <option key={c.id} value={c.id}>{c.nome}{p != null ? ` (${brl(Number(p))})` : ' — sem preço'}</option>;
                    })}
                  </select>
                  <Btn variant="ghost" type="button" icon="plus" onClick={() => setItems((xs) => [...xs, { ...EMPTY_ITEM, ...taxDraft(taxDef) }])}>
                    Item livre
                  </Btn>
                </div>
              )}
            </div>

            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Contato do pedido</span>
              <select value={contactId ?? ''} disabled={readOnly || contactBusy}
                onChange={(e) => changeContact(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
                <option value="">Sem contato</option>
                {/* pedido pode apontar p/ contato fora da lista atual da empresa — mantém a opção */}
                {order?.contact_id != null && !contacts.some((c) => Number(c.id) === Number(order.contact_id)) && (
                  <option value={order.contact_id}>{order.contact_nome ?? `#${order.contact_id}`}</option>
                )}
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.cargo ? ` · ${c.cargo}` : ''}</option>)}
              </select>
              {companyId == null && <span className="mt-1 block text-[11px] text-ink-400">Escolha o cliente para listar contatos.</span>}
            </label>

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block">
                <span className="text-xs font-semibold text-ink-600">Frete (R$)</span>
                <input type="text" inputMode="decimal" value={frete} disabled={readOnly}
                  onChange={(e) => setFrete(maskMoney(e.target.value))} className={cn(inputCls, 'mt-1')} />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-ink-600">Cond. pagamento</span>
                <input value={condicao} disabled={readOnly} maxLength={120} onChange={(e) => setCondicao(e.target.value)}
                  placeholder="ex.: 28/56 dias" className={cn(inputCls, 'mt-1')} />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-ink-600">Transportadora</span>
                <select value={carrierId ?? ''} disabled={readOnly}
                  onChange={(e) => setCarrierId(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
                  <option value="">Sem transportadora</option>
                  {/* pedido antigo pode apontar para transportadora desativada — mantém a opção */}
                  {order?.carrier_id != null && !carriers.some((c) => c.id === order.carrier_id) && (
                    <option value={order.carrier_id}>{order.carrier_nome ?? `#${order.carrier_id}`}</option>
                  )}
                  {carriers.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>
              </label>
            </div>

            <div className="grid items-end gap-2 sm:grid-cols-3">
              <label className="flex h-[42px] items-center gap-2 text-sm font-medium text-ink-700">
                <input type="checkbox" checked={cotacao} disabled={readOnly || order != null}
                  onChange={(e) => { setCotacao(e.target.checked); if (e.target.checked && !validade) setValidade(todayStr()); }}
                  className="h-4 w-4 rounded border-ink-300 accent-brand-600" />
                É cotação
              </label>
              {cotacao && (
                <label className="block">
                  <span className="text-xs font-semibold text-ink-600">Válida até</span>
                  <input type="date" value={validade} disabled={readOnly} onChange={(e) => setValidade(e.target.value)} className={cn(inputCls, 'mt-1')} />
                </label>
              )}
            </div>

            <textarea value={observacoes} disabled={readOnly} maxLength={2000} onChange={(e) => setObservacoes(e.target.value)}
              placeholder="Observações" rows={2} className={inputCls} />

            {comissao && comissao.status !== 'cancelada' && (
              <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {user?.role === 'admin'
                  ? <>Comissão prevista: <span className="tabnums font-bold">{brl(Number(comissao.valor_previsto))}</span> ({Number(comissao.percent_aplicado)}%) · vendedor {brl(Number(comissao.valor_vendedor))}</>
                  : <>Sua comissão prevista: <span className="tabnums font-bold">{brl(Number(comissao.valor_vendedor))}</span></>}
                {comissao.status === 'recebida' ? ' · recebida' : comissao.status === 'divergente' ? ' · divergente' : ''}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="tabnums text-sm font-bold text-ink-900">Total: {brl(total)}</span>
              <div className="flex gap-2">
                <Btn variant="ghost" type="button" onClick={onClose}>{readOnly ? 'Fechar' : 'Cancelar'}</Btn>
                {!readOnly && <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar pedido'}</Btn>}
              </div>
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
}
