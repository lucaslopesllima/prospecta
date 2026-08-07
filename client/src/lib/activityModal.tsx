import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { postField } from './offline.ts';
import { Btn, cn, inputCls, Modal } from './ui.tsx';
import { Icon, type IconName } from './icons.tsx';
import { toast } from './toast.tsx';
import { useAuth } from './auth.tsx';
import type { Activity } from './types.ts';
import { EMAIL_RE, maskPhone } from './format.ts';

// Modal de criação de atividade/compromisso. Reutilizado na Agenda e no Funil.

type TipoOpt = { v: string; label: string; icon: IconName; chip: string };
// Tipos base = compromissos simples (só título/quando). whatsapp e email são
// "tipos de agendamento": pedem os mesmos campos das telas originais (WhatsApp /
// Agendamento de e-mail) e disparam o envio de verdade pelos processadores.
const TIPOS_BASE: TipoOpt[] = [
  { v: 'tarefa', label: 'Tarefa', icon: 'check', chip: 'bg-brand-50 text-brand-700' },
  { v: 'ligacao', label: 'Ligação', icon: 'phone', chip: 'bg-sky-50 text-sky-700' },
  { v: 'visita', label: 'Visita', icon: 'mapPin', chip: 'bg-amber-50 text-amber-700' },
  { v: 'reuniao', label: 'Reunião', icon: 'users', chip: 'bg-violet-50 text-violet-700' },
];
const TIPO_WHATSAPP: TipoOpt = { v: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp', chip: 'bg-emerald-50 text-emerald-700' };
const TIPO_EMAIL: TipoOpt = { v: 'email', label: 'E-mail', icon: 'mail', chip: 'bg-rose-50 text-rose-700' };

export type FunnelCompany = { company_id: number; label: string };
export type RepresentedOption = { id: number; nome: string };
type ContactOption = { id: number; nome: string; telefone: string | null };

// Quebra uma string de e-mails (vírgula/;/espaço/linha) em tokens não vazios.
const splitEmails = (s: string): string[] => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

const toLocalInput = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export type EditableActivity = {
  id: number; titulo: string; tipo: string; start_at: string;
  company_id: number | null; represented_id: number | null; contact_id: number | null;
};

export function ActivityCreateModal({ preset, funnel, represented, presetCompanyId, activity, onClose, onSaved }: {
  preset: Date; funnel: FunnelCompany[]; represented: RepresentedOption[]; presetCompanyId?: number | null;
  activity?: EditableActivity;  // se presente → modo edição (PATCH)
  onClose: () => void; onSaved: () => void;
}): React.JSX.Element {
  const { can, user } = useAuth();
  const editando = !!activity;
  const [titulo, setTitulo] = useState(activity?.titulo ?? '');
  const [tipo, setTipo] = useState(activity?.tipo ?? 'tarefa');
  const [start, setStart] = useState(toLocalInput(activity ? new Date(activity.start_at) : preset));
  const [companyId, setCompanyId] = useState<number | null>(activity ? activity.company_id : (presetCompanyId ?? null));
  const [representedId, setRepresentedId] = useState<number | null>(activity?.represented_id ?? null);
  const [contactId, setContactId] = useState<number | null>(activity?.contact_id ?? null);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [busy, setBusy] = useState(false);
  // Campos do agendamento de WhatsApp.
  const [numero, setNumero] = useState('');
  const [mensagem, setMensagem] = useState('');
  // Campos do agendamento de e-mail (remetente sugere o e-mail do usuário logado).
  const [remetente, setRemetente] = useState(user?.email ?? '');
  const [destinatario, setDestinatario] = useState('');
  const [assunto, setAssunto] = useState('');
  const [corpo, setCorpo] = useState('');
  const [recorrencia, setRecorrencia] = useState('nenhuma');

  // Tipos de agendamento só aparecem ao criar (não se editam por aqui — vêm dos
  // fluxos de envio) e só com a permissão do respectivo módulo.
  const tipos: TipoOpt[] = [
    ...TIPOS_BASE,
    ...(!editando && can('whatsapp.schedule') ? [TIPO_WHATSAPP] : []),
    ...(!editando && can('email_schedules.create') ? [TIPO_EMAIL] : []),
  ];
  const isWhats = tipo === 'whatsapp';
  const isEmail = tipo === 'email';
  const isSchedule = isWhats || isEmail;

  // Contatos vêm da empresa do funil (prioridade) ou da representada escolhida.
  // Empresa filtra por company_id; senão cai na representada. Troca de qualquer
  // um zera o contato se ele não pertencer mais à lista.
  useEffect(() => {
    const param = companyId != null ? `company_id=${companyId}`
      : representedId != null ? `represented_id=${representedId}` : null;
    if (param == null) { setContacts([]); return; }
    let alive = true;
    void api.get<{ contacts: ContactOption[] }>(`/api/contacts?${param}`)
      .then((r) => { if (alive) setContacts(r.contacts); })
      .catch(() => { if (alive) setContacts([]); });
    return () => { alive = false; };
  }, [companyId, representedId]);

  // Num agendamento de WhatsApp, o contato escolhido puxa o telefone dele pro
  // número (só se ainda estiver vazio, pra não sobrescrever edição manual).
  // Reativo: cobre escolher o contato antes de trocar pro tipo WhatsApp e a
  // lista de contatos chegar depois da seleção.
  useEffect(() => {
    if (!isWhats || contactId == null || numero.trim()) return;
    // id de bigint vem string do pg — coage os dois lados antes de comparar.
    const c = contacts.find((x) => Number(x.id) === contactId);
    if (c?.telefone) setNumero(c.telefone);
  }, [isWhats, contactId, contacts]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickContact = (id: number | null): void => setContactId(id);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!start) { toast.error('Informe a data e hora.'); return; }
    if (isWhats) {
      if (!numero.trim()) { toast.error('Informe o número de WhatsApp.'); return; }
      if (!mensagem.trim()) { toast.error('Escreva a mensagem.'); return; }
    } else if (isEmail) {
      const dest = splitEmails(destinatario);
      if (!remetente.trim() || dest.length === 0 || !assunto.trim() || !corpo.trim()) {
        toast.error('Preencha remetente, destinatário, assunto e corpo.'); return;
      }
      if (!EMAIL_RE.test(remetente.trim())) { toast.error('E-mail do remetente inválido.'); return; }
      if (dest.some((d) => !EMAIL_RE.test(d))) { toast.error('Há e-mail de destinatário inválido.'); return; }
    } else if (!titulo.trim()) { toast.error('Informe o título da atividade.'); return; }

    const startIso = new Date(start).toISOString();
    setBusy(true);
    try {
      if (isWhats) {
        await api.post('/api/whatsapp/chats/schedule-direct', {
          numero: numero.trim(), text: mensagem.trim(), agendado_para: startIso,
          company_id: companyId, contact_id: contactId,
        });
        toast.success('WhatsApp agendado.');
      } else if (isEmail) {
        await api.post('/api/email-schedules', {
          remetente: remetente.trim(), destinatario: splitEmails(destinatario).join(', '),
          assunto, corpo, agendado_para: startIso, company_id: companyId, recorrencia,
        });
        toast.success('E-mail agendado.');
      } else {
        const body = {
          titulo: titulo.trim(), tipo, start_at: startIso,
          company_id: companyId, represented_id: representedId, contact_id: contactId,
        };
        if (editando) await api.patch(`/api/activities/${activity!.id}`, body);
        else await api.post('/api/activities', body);
        toast.success(editando ? 'Atividade salva.' : 'Atividade criada.');
      }
      onSaved();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  };

  const semVinculo = companyId == null && representedId == null;

  return (
    <Modal onClose={onClose} width="md">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink-900">{editando ? 'Editar atividade' : 'Nova atividade'}</h3>
        <button onClick={onClose} aria-label="Fechar" className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-ink-100 hover:text-ink-800 sm:h-8 sm:w-8 sm:rounded-lg">
          <Icon name="x" size={17} />
        </button>
      </div>
      <form onSubmit={submit} className="max-h-[75vh] space-y-3 overflow-auto">
        {!isSchedule && (
          <input autoFocus value={titulo} maxLength={120} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Ligar para cliente" className={inputCls} />
        )}
        <div className="grid grid-cols-3 gap-1.5">
          {tipos.map((t) => (
            <button key={t.v} type="button" onClick={() => setTipo(t.v)}
              className={cn('flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-[11px] font-semibold transition',
                tipo === t.v ? 'border-transparent ' + t.chip : 'border-ink-200 text-ink-500 hover:bg-ink-50')}>
              <Icon name={t.icon} size={16} />{t.label}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">{isSchedule ? 'Enviar em' : 'Quando'}</span>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={cn(inputCls, 'mt-1')} />
        </label>

        {/* vínculos: empresa/representada/contato (contato do WhatsApp puxa o número) */}
        {!isEmail && (
          <>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Empresa do funil</span>
              <select value={companyId ?? ''} onChange={(e) => { setCompanyId(e.target.value === '' ? null : Number(e.target.value)); setContactId(null); }} className={cn(inputCls, 'mt-1')}>
                <option value="">Sem vínculo</option>
                {funnel.map((f) => <option key={f.company_id} value={f.company_id}>{f.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Representada</span>
              <select value={representedId ?? ''}
                onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); setRepresentedId(v); setContactId(null); }}
                className={cn(inputCls, 'mt-1')}>
                <option value="">Sem vínculo</option>
                {represented.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Contato</span>
              <select value={contactId ?? ''} disabled={semVinculo}
                onChange={(e) => pickContact(e.target.value === '' ? null : Number(e.target.value))}
                className={cn(inputCls, 'mt-1', semVinculo && 'opacity-50')}>
                <option value="">{semVinculo ? 'Escolha empresa ou representada' : contacts.length ? 'Sem vínculo' : 'Nenhum contato'}</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </label>
          </>
        )}

        {/* agendamento de WhatsApp: número livre + mensagem */}
        {isWhats && (
          <>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Número de WhatsApp</span>
              <input value={numero} onChange={(e) => setNumero(maskPhone(e.target.value))} maxLength={20} inputMode="tel"
                placeholder="Ex.: (11) 91234-5678" className={cn(inputCls, 'mt-1')} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Mensagem</span>
              <textarea value={mensagem} onChange={(e) => setMensagem(e.target.value)} rows={3} maxLength={4000}
                placeholder="Texto da mensagem…" className={cn(inputCls, 'mt-1 resize-none')} />
            </label>
          </>
        )}

        {/* agendamento de e-mail: mesmos campos da tela de Agendamento de e-mail */}
        {isEmail && (
          <>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Empresa do funil</span>
              <select value={companyId ?? ''} onChange={(e) => setCompanyId(e.target.value === '' ? null : Number(e.target.value))} className={cn(inputCls, 'mt-1')}>
                <option value="">Sem vínculo</option>
                {funnel.map((f) => <option key={f.company_id} value={f.company_id}>{f.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Remetente</span>
              <input type="email" value={remetente} onChange={(e) => setRemetente(e.target.value)} maxLength={160}
                placeholder="seu@email.com" className={cn(inputCls, 'mt-1')} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Destinatários</span>
              <input value={destinatario} onChange={(e) => setDestinatario(e.target.value)} maxLength={800}
                placeholder="contato@empresa.com, outro@empresa.com" className={cn(inputCls, 'mt-1')} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Assunto</span>
              <input value={assunto} onChange={(e) => setAssunto(e.target.value)} maxLength={200}
                placeholder="Assunto do e-mail" className={cn(inputCls, 'mt-1')} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Corpo</span>
              <textarea value={corpo} onChange={(e) => setCorpo(e.target.value)} rows={5} maxLength={20000}
                placeholder="Conteúdo do e-mail" className={cn(inputCls, 'mt-1 resize-y')} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-600">Repetição</span>
              <select value={recorrencia} onChange={(e) => setRecorrencia(e.target.value)} className={cn(inputCls, 'mt-1')}>
                <option value="nenhuma">Não repetir</option>
                <option value="diaria">Diária</option>
                <option value="semanal">Semanal</option>
                <option value="mensal">Mensal</option>
              </select>
            </label>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancelar</Btn>
          <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
        </div>
      </form>
    </Modal>
  );
}

/* ── Modal de visita em campo (Fase 5): check-in geo + relatório ─────────── */
const RESULTADOS = ['Pedido fechado', 'Em negociação', 'Retornar depois', 'Sem interesse'];

export function VisitModal({ activity, onClose, onSaved }: {
  activity: Activity; onClose: () => void; onSaved: () => void;
}): React.JSX.Element {
  const [checkedAt, setCheckedAt] = useState<string | null>(activity.checkin_at ?? null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [resultado, setResultado] = useState(activity.relatorio?.resultado ?? RESULTADOS[0]!);
  const [proximo, setProximo] = useState(activity.relatorio?.proximo_passo ?? '');
  const [texto, setTexto] = useState(activity.relatorio?.texto ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const doCheckin = (): void => {
    if (!navigator.geolocation) { setMsg('Geolocalização indisponível neste dispositivo.'); return; }
    setGeoBusy(true); setMsg('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void postField(`/api/activities/${activity.id}/checkin`,
          { lat: pos.coords.latitude, lon: pos.coords.longitude }, `Check-in: ${activity.titulo}`)
          .then((r) => { setCheckedAt(new Date().toISOString()); setMsg(r.queued ? 'Check-in salvo offline — sincroniza ao reconectar.' : ''); })
          .catch(() => setMsg('Falha ao registrar check-in.'))
          .finally(() => setGeoBusy(false));
      },
      () => { setMsg('Não foi possível obter a localização (permissão negada?).'); setGeoBusy(false); },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const r = await postField(`/api/activities/${activity.id}/report`,
        { resultado, proximo_passo: proximo.trim() || null, texto: texto.trim() || null },
        `Relatório: ${activity.titulo}`);
      if (r.queued) { setMsg('Relatório salvo offline — sincroniza ao reconectar.'); setBusy(false); return; }
      onSaved();
    } catch { setMsg('Falha ao salvar o relatório.'); setBusy(false); }
  };

  return (
    <Modal onClose={onClose} width="md">
      <div className="mb-3 flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-ink-900">Visita</h3>
          {activity.razao_social && <p className="truncate text-xs text-ink-400">{activity.razao_social}</p>}
        </div>
        <button onClick={onClose} aria-label="Fechar" className="grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-ink-100 hover:text-ink-800 sm:h-8 sm:w-8 sm:rounded-lg">
          <Icon name="x" size={17} />
        </button>
      </div>

      {/* check-in */}
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-ink-200 p-2.5">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg',
          checkedAt ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-100 text-ink-500')}>
          <Icon name="mapPin" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-800">Check-in</p>
          <p className="truncate text-[11px] text-ink-400">
            {checkedAt ? `Registrado ${new Date(checkedAt).toLocaleString('pt-BR')}` : 'Marque sua chegada no cliente.'}
          </p>
        </div>
        <Btn size="sm" variant={checkedAt ? 'soft' : 'primary'} icon="mapPin" disabled={geoBusy} onClick={doCheckin}>
          {geoBusy ? '…' : checkedAt ? 'Refazer' : 'Check-in'}
        </Btn>
      </div>

      {/* relatório */}
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Resultado</span>
          <select value={resultado} onChange={(e) => setResultado(e.target.value)} className={cn(inputCls, 'mt-1')}>
            {RESULTADOS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Próximo passo</span>
          <input value={proximo} maxLength={120} onChange={(e) => setProximo(e.target.value)} placeholder="Ex.: enviar proposta até sexta" className={cn(inputCls, 'mt-1')} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-ink-600">Observações</span>
          <textarea value={texto} maxLength={2000} onChange={(e) => setTexto(e.target.value)} rows={3} placeholder="Como foi a visita?" className={cn(inputCls, 'mt-1 resize-none')} />
        </label>
        {msg && <p className="text-xs text-amber-600">{msg}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>Fechar</Btn>
          <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar visita'}</Btn>
        </div>
      </form>
    </Modal>
  );
}
