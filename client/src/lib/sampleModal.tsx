import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Badge, Btn, cn, inputCls, Modal, SafeButton, Spinner, type Tone } from './ui.tsx';
import { Icon } from './icons.tsx';
import { toast } from './toast.tsx';
import { dec, maskPhone } from './format.ts';
import type { CatalogItem, Contact, SampleRequest, SampleStatus } from './types.ts';
import { confirmDialog } from './confirm.ts';

// Modais de amostra do funil: criar/editar uma solicitação e listar as da
// prospecção. Amostra escolhe um produto do catálogo, opcionalmente um contato
// (criado na hora) e um follow-up na agenda.
const txt = (s: string): string | null => (s.trim() === '' ? null : s.trim());

const STATUS: SampleStatus[] = ['solicitada', 'enviada', 'recebida', 'cancelada'];
const STATUS_LABEL: Record<SampleStatus, string> = {
  solicitada: 'Solicitada', enviada: 'Enviada', recebida: 'Recebida', cancelada: 'Cancelada',
};
const STATUS_TONE: Record<SampleStatus, Tone> = {
  solicitada: 'info', enviada: 'brand', recebida: 'success', cancelada: 'neutral',
};

// Amanhã às 09:00 — preset do follow-up da amostra.
function amanhaAs9(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SampleRequestModal({ card, catalog, sample, onClose, onSaved }: {
  card: { id: number; company_id: number; label: string };
  catalog: CatalogItem[];
  sample?: SampleRequest;            // presente → modo edição (PATCH)
  onClose: () => void;
  onSaved: (s: SampleRequest) => void;
}): React.JSX.Element {
  const editando = !!sample;
  const [catalogId, setCatalogId] = useState<number | null>(sample?.catalog_item_id ?? null);
  const [status, setStatus] = useState<SampleStatus>(sample?.status ?? 'solicitada');
  const [quantidade, setQuantidade] = useState(sample?.quantidade != null ? String(Number(sample.quantidade)) : '');
  const [dataPrevista, setDataPrevista] = useState(sample?.data_prevista ?? '');
  const [notas, setNotas] = useState(sample?.notas ?? '');

  // Contatos da empresa do card; modo seleção ou criação inline.
  const [contatos, setContatos] = useState<Contact[]>([]);
  const [contatoId, setContatoId] = useState<number | null>(sample?.contact_id ?? null);
  const [novoContato, setNovoContato] = useState(false);
  const [cNome, setCNome] = useState('');
  const [cTelefone, setCTelefone] = useState('');

  // Follow-up opcional na agenda (só na criação — a edição não recria atividade).
  const [agendar, setAgendar] = useState(false);
  const [agStart, setAgStart] = useState(amanhaAs9());
  const [agTitulo, setAgTitulo] = useState('');

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ contacts: Contact[] }>(`/api/contacts?company_id=${card.company_id}`)
      .then((r) => setContatos(r.contacts)).catch(() => undefined);
  }, [card.company_id]);

  const produtos = catalog.filter((c) => c.ativo);
  // c.id é STRING (/api/catalog); catalogId vem Number() do <select>.
  const produto = produtos.find((c) => Number(c.id) === Number(catalogId)) ?? null;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editando && catalogId == null) { toast.error('Escolha o produto da amostra.'); return; }
    if (!editando && agendar && (!agTitulo.trim() || !agStart)) { toast.error('Informe título e data do compromisso.'); return; }
    if (novoContato && !cNome.trim()) { toast.error('Informe o nome do novo contato.'); return; }
    setBusy(true);
    try {
      // Cria o contato antes (se inline) para vincular o id na amostra.
      let cid = contatoId;
      if (novoContato && cNome.trim()) {
        const r = await api.post<{ contact: Contact }>('/api/contacts', {
          nome: cNome.trim(), telefone: txt(cTelefone), company_id: card.company_id,
        });
        cid = r.contact.id;
      }
      const qtd = quantidade.trim() === '' ? null : dec(quantidade);
      const prev = dataPrevista === '' ? null : dataPrevista;
      if (editando) {
        const r = await api.patch<{ sample: SampleRequest }>(`/api/sample-requests/${sample!.id}`, {
          status, contact_id: cid, quantidade: qtd, data_prevista: prev, notas: txt(notas),
        });
        toast.success('Amostra atualizada.');
        onSaved(r.sample);
      } else {
        const body: Record<string, unknown> = {
          relationship_id: card.id, catalog_item_id: catalogId,
          contact_id: cid, quantidade: qtd, data_prevista: prev, notas: txt(notas),
        };
        if (agendar) body.agenda = { titulo: agTitulo.trim(), start_at: new Date(agStart).toISOString(), tipo: 'tarefa' };
        const r = await api.post<{ sample: SampleRequest }>('/api/sample-requests', body);
        toast.success('Amostra solicitada.');
        onSaved(r.sample);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar a amostra.');
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} width="lg" level={2}
      title={editando ? 'Editar amostra' : 'Solicitar amostra'} subtitle={card.label}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 py-1">
            {editando ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink-500">Produto</span>
                  <p className="rounded-xl bg-ink-50 px-3 py-2.5 text-sm font-medium text-ink-700">
                    {sample!.produto_snapshot}{sample!.produto_codigo ? ` · ${sample!.produto_codigo}` : ''}
                  </p>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-500">Status</span>
                  <select value={status} onChange={(e) => setStatus(e.target.value as SampleStatus)} className={inputCls}>
                    {STATUS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-500">Produto do mostruário *</span>
                <select value={catalogId ?? ''} onChange={(e) => setCatalogId(e.target.value === '' ? null : Number(e.target.value))}
                  className={inputCls} disabled={produtos.length === 0}>
                  <option value="">{produtos.length === 0 ? 'Nenhum produto no mostruário' : 'Selecione…'}</option>
                  {produtos.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.codigo ? ` (${c.codigo})` : ''}</option>)}
                </select>
              </label>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-500">Quantidade</span>
                <input type="number" min={0} max={1e6} step="0.001" value={quantidade} onChange={(e) => setQuantidade(e.target.value)}
                  placeholder="ex.: 1" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-500">Previsão de envio</span>
                <input type="date" value={dataPrevista} onChange={(e) => setDataPrevista(e.target.value)} className={inputCls} />
              </label>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-500">Contato (quem recebe)</span>
                <button type="button" onClick={() => { setNovoContato((v) => !v); setContatoId(null); }}
                  className="text-xs font-semibold text-brand-600 hover:text-brand-700">
                  {novoContato ? 'Escolher existente' : '+ Novo contato'}
                </button>
              </div>
              {novoContato ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input autoFocus value={cNome} maxLength={120} onChange={(e) => setCNome(e.target.value)} placeholder="Nome *" className={inputCls} />
                  <input value={cTelefone} onChange={(e) => setCTelefone(maskPhone(e.target.value))} placeholder="Telefone" inputMode="tel" className={inputCls} />
                </div>
              ) : (
                <select value={contatoId ?? ''} onChange={(e) => setContatoId(e.target.value === '' ? null : Number(e.target.value))}
                  className={inputCls}>
                  <option value="">{contatos.length === 0 ? 'Sem contatos — crie um' : 'Sem vínculo'}</option>
                  {contatos.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.cargo ? ` (${c.cargo})` : ''}</option>)}
                </select>
              )}
            </div>

            {editando ? (
              sample!.atividade_titulo && (
                <p className="inline-flex items-center gap-1.5 rounded-xl bg-ink-50 px-3 py-2 text-xs text-ink-500">
                  <Icon name="calendar" size={14} /> Follow-up: {sample!.atividade_titulo}
                  {sample!.atividade_start ? ` · ${new Date(sample!.atividade_start).toLocaleString('pt-BR')}` : ''}
                </p>
              )
            ) : (
              <div className="rounded-xl border border-ink-200 p-3">
                <label className="flex items-center gap-2 text-sm font-medium text-ink-700">
                  <input type="checkbox" checked={agendar}
                    onChange={(e) => { setAgendar(e.target.checked); if (e.target.checked && !agTitulo) setAgTitulo(produto ? `Amostra: ${produto.nome}` : 'Follow-up de amostra'); }}
                    className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-200" />
                  <Icon name="calendar" size={15} /> Agendar follow-up
                </label>
                {agendar && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <input value={agTitulo} maxLength={120} onChange={(e) => setAgTitulo(e.target.value)} placeholder="Título do compromisso" className={cn(inputCls, 'sm:col-span-2')} />
                    <input type="datetime-local" value={agStart} onChange={(e) => setAgStart(e.target.value)} className={cn(inputCls, 'sm:col-span-2')} />
                  </div>
                )}
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-500">Notas</span>
              <textarea value={notas} maxLength={2000} onChange={(e) => setNotas(e.target.value)} rows={2}
                placeholder="Observações livres" className={cn(inputCls, 'resize-y')} />
            </label>
          </div>
          <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-hairline bg-glass px-4 py-3 backdrop-blur-xl">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
            <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : (editando ? 'Salvar' : 'Solicitar')}</Btn>
          </div>
        </form>
    </Modal>
  );
}

// Lista as amostras da prospecção; clicar numa abre o editor (modal preenchido).
export function SampleListModal({ card, catalog, onClose, onChanged }: {
  card: { id: number; company_id: number; label: string };
  catalog: CatalogItem[];
  onClose: () => void;
  onChanged: () => void;   // avisa o funil pra recarregar contagens/status
}): React.JSX.Element {
  const [samples, setSamples] = useState<SampleRequest[] | null>(null);
  const [editing, setEditing] = useState<SampleRequest | null>(null);

  const load = (): void => {
    void api.get<{ samples: SampleRequest[] }>(`/api/sample-requests?relationship_id=${card.id}`)
      .then((r) => setSamples(r.samples)).catch(() => setSamples([]));
  };
  useEffect(load, [card.id]);

  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir esta solicitação de amostra?'))) return;
    try {
      await api.del(`/api/sample-requests/${id}`);
      toast.success('Amostra excluída.');
      load();
      onChanged();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível excluir.'); }
  };

  return (
    <>
      <Modal onClose={onClose} width="lg" level={1} title="Amostras" subtitle={card.label}>
          <div className="space-y-2 py-1">
            {samples === null ? (
              <div className="grid place-items-center py-8"><Spinner /></div>
            ) : samples.length === 0 ? (
              <p className="px-2 py-8 text-center text-sm text-ink-400">Nenhuma amostra solicitada.</p>
            ) : samples.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-xl border border-ink-200 p-3">
                <button type="button" onClick={() => setEditing(s)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Icon name="flask" size={16} className="shrink-0 text-ink-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-800">{s.produto_snapshot}</p>
                    <p className="truncate text-xs text-ink-400">
                      {[s.quantidade != null ? `Qtd ${Number(s.quantidade)}` : null,
                        s.data_prevista ? `Prev. ${new Date(`${s.data_prevista}T00:00`).toLocaleDateString('pt-BR')}` : null,
                        s.contato].filter(Boolean).join(' · ') || 'Sem detalhes'}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                </button>
                <SafeButton type="button" onClick={() => remove(s.id)} title="Excluir"
                  className="shrink-0 rounded-lg p-1.5 text-ink-300 transition hover:bg-rose-50 hover:text-rose-500">
                  <Icon name="trash" size={15} />
                </SafeButton>
              </div>
            ))}
          </div>
      </Modal>
      {editing && (
        <SampleRequestModal card={card} catalog={catalog} sample={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onChanged(); }} />
      )}
    </>
  );
}
