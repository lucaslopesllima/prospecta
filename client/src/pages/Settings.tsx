import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { NamedItem, Stage, TaxDefaults } from '../lib/types.ts';
import { Btn, Card, cn, inputCls, PageHeader, SafeButton, Spinner } from '../lib/ui.tsx';
import { Icon, type IconName } from '../lib/icons.tsx';
import { useOptionalUser, useAuth } from '../lib/auth.tsx';
import { toast } from '../lib/toast.tsx';
import { clampNum, dec, isEmail, maskPct } from '../lib/format.ts';
import { confirmDialog } from '../lib/confirm.ts';

type Section = 'funil' | 'cenarios' | 'acoes' | 'aliquotas' | 'alertas' | 'smtp' | 'whatsapp';
const SECTIONS: { key: Section; label: string; icon: IconName; desc: string; admin?: boolean }[] = [
  { key: 'cenarios', label: 'Cenários', icon: 'list', desc: 'Opções de "cenário atual"' },
  { key: 'acoes', label: 'Ações próximo nível', icon: 'target', desc: 'Opções de ação para avançar' },
  { key: 'funil', label: 'Funil', icon: 'columns', desc: 'Fases do seu pipeline de vendas' },
  // Aba de alíquotas oculta por ora — impostos reservados para uso futuro (AliquotasEditor mantido).
  // { key: 'aliquotas', label: 'Alíquotas', icon: 'percent', desc: 'Impostos default dos pedidos', admin: true },
  { key: 'alertas', label: 'Alertas', icon: 'bell', desc: 'Inatividade no dashboard', admin: true },
  { key: 'smtp', label: 'E-mail (SMTP)', icon: 'mail', desc: 'Servidor de envio dos e-mails agendados', admin: true },
  { key: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp', desc: 'Preferências de envio das mensagens', admin: true },
];

export function Settings(): React.JSX.Element {
  const user = useOptionalUser();
  const sections = SECTIONS.filter((s) => !s.admin || user?.role === 'admin');
  const [section, setSection] = useState<Section>('cenarios');
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Configurações" subtitle="Ajuste como o Rovva funciona para a sua operação." />
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* sub-nav */}
        <nav className="flex gap-2 overflow-x-auto sm:w-56 sm:flex-col sm:gap-1 sm:overflow-x-visible">
          {sections.map((s) => {
            const on = section === s.key;
            return (
              <button key={s.key} onClick={() => setSection(s.key)}
                className={cn('flex items-center gap-3 whitespace-nowrap sm:whitespace-normal rounded-xl px-3 py-2.5 text-left transition-colors',
                  on ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/20' : 'bg-surface text-ink-600 shadow-card hover:bg-ink-50')}>
                <Icon name={s.icon} size={18} className={cn('shrink-0', on ? 'text-white' : 'text-ink-400')} />
                <span className="min-w-0 text-sm font-semibold">
                  {s.label}
                  <span className={cn('hidden text-xs font-normal sm:block', on ? 'text-brand-100' : 'text-ink-400')}>{s.desc}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1">
          {section === 'cenarios' && (
            <NamedListEditor inputCls={inputCls} path="scenarios" titulo="Cenários" icon="list"
              desc='Opções do dropdown "Cenário atual" na prospecção.' placeholder="Novo cenário (ex.: Já compra do concorrente)" />
          )}
          {section === 'acoes' && (
            <NamedListEditor inputCls={inputCls} path="actions" titulo="Ações para próximo nível" icon="target"
              desc='Opções do dropdown "Ação para próximo nível" na prospecção.' placeholder="Nova ação (ex.: Enviar proposta)" />
          )}
          {section === 'funil' && <FunilEditor inputCls={inputCls} />}
          {section === 'aliquotas' && <AliquotasEditor inputCls={inputCls} />}
          {section === 'alertas' && <AlertasEditor inputCls={inputCls} />}
          {section === 'smtp' && <SmtpEditor inputCls={inputCls} />}
          {section === 'whatsapp' && <WhatsAppEditor />}
        </div>
      </div>
    </div>
  );
}

// Config dos alertas de inatividade do dashboard (org-scoped, admin only no backend).
function AlertasEditor({ inputCls }: { inputCls: string }): React.JSX.Element {
  const [dias, setDias] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.get<{ org: { inatividade_dias: number } }>('/api/account')
      .then((r) => setDias(r.org.inatividade_dias))
      .finally(() => setLoading(false));
  }, []);

  const save = async (): Promise<void> => {
    if (dias === '' || dias < 1) { toast.error('Informe um número de dias válido.'); return; }
    try {
      await api.patch('/api/account', { inatividade_dias: clampNum(dias, 1, 365) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success('Alerta de inatividade salvo.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };

  if (loading) return <Spinner />;
  return (
    <Card className="max-w-lg p-4">
      <h3 className="text-sm font-semibold text-ink-900">Alertas de inatividade</h3>
      <p className="mt-0.5 text-xs text-ink-400">
        Prospects sem contato por mais que este número de dias aparecem como alerta no dashboard.
      </p>
      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium text-ink-500">Dias sem contato</span>
        <input type="number" min={1} max={365} value={dias}
          onChange={(e) => setDias(e.target.value === '' ? '' : Number(e.target.value))}
          className={cn(inputCls, 'w-32')} />
      </label>
      <div className="mt-4 flex items-center gap-3">
        <Btn icon="check" onClick={() => save()}>Salvar</Btn>
        {saved && <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600"><Icon name="check" size={16} /> Salvo</span>}
      </div>
    </Card>
  );
}

// Config SMTP da org (admin). É o servidor que dispara os e-mails agendados.
// A senha nunca volta do backend (só has_password); deixar o campo em branco
// mantém a senha atual ao salvar.
interface SmtpView {
  host: string; port: number; secure: boolean; username: string | null;
  from_email: string; from_name: string | null; enabled: boolean; has_password: boolean;
}
function SmtpEditor({ inputCls }: { inputCls: string }): React.JSX.Element {
  const { can } = useAuth();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void api.get<{ smtp: SmtpView | null }>('/api/settings/smtp')
      .then((r) => {
        const s = r.smtp;
        if (s) {
          setHost(s.host); setPort(s.port); setSecure(s.secure); setUsername(s.username ?? '');
          setFromEmail(s.from_email); setFromName(s.from_name ?? ''); setEnabled(s.enabled);
          setHasPassword(s.has_password);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const save = async (): Promise<void> => {
    if (!host.trim() || !fromEmail.trim()) { toast.error('Informe o host e o e-mail de origem.'); return; }
    if (!isEmail(fromEmail)) { toast.error('E-mail de origem inválido.'); return; }
    setBusy(true);
    try {
      await api.put('/api/settings/smtp', {
        host: host.trim(), port: clampNum(port, 1, 65535), secure,
        username: username.trim() || null,
        // só envia password quando preenchida — branco mantém a atual.
        password: password ? password : null,
        from_email: fromEmail.trim(), from_name: fromName.trim() || null, enabled,
      });
      if (password) setHasPassword(true);
      setPassword('');
      toast.success('SMTP salvo.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  };

  const testar = async (): Promise<void> => {
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; to: string }>('/api/settings/smtp/test');
      toast.success(`E-mail de teste enviado para ${r.to}.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Falha no teste de envio.'); }
    finally { setTesting(false); }
  };

  if (loading) return <Spinner />;
  return (
    <Card className="max-w-lg p-4">
      <h3 className="text-sm font-semibold text-ink-900">Servidor de e-mail (SMTP)</h3>
      <p className="mt-0.5 text-xs text-ink-400">
        Os e-mails agendados são disparados por este servidor. A senha é guardada cifrada e não é exibida.
      </p>

      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-500">Host</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} maxLength={200} placeholder="smtp.seudominio.com" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">Porta</span>
            <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 587)} className={inputCls} />
          </label>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="h-4 w-4 rounded border-ink-300 text-brand-600" />
          <span className="text-sm text-ink-700">Conexão segura (SSL/TLS — porta 465). Desmarcado usa STARTTLS (587).</span>
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">Usuário</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={200} placeholder="login do SMTP" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">Senha {hasPassword && <span className="text-emerald-600">(definida)</span>}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200}
              placeholder={hasPassword ? '•••••• (manter atual)' : 'senha do SMTP'} className={inputCls} />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">E-mail de origem</span>
            <input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} maxLength={160} placeholder="naoresponda@seudominio.com" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">Nome de exibição</span>
            <input value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} placeholder="Sua Empresa" className={inputCls} />
          </label>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-ink-300 text-brand-600" />
          <span className="text-sm text-ink-700">Disparo ativo — sem isso os agendamentos ficam com erro "SMTP não configurado".</span>
        </label>
      </div>

      <div className="mt-4 flex items-center gap-2">
        {can('settings.smtp.update') && <Btn icon="check" onClick={() => save()} disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>}
        {can('settings.smtp.test') && <Btn variant="soft" icon="mail" onClick={() => testar()} disabled={testing}>{testing ? 'Enviando…' : 'Enviar teste'}</Btn>}
      </div>
    </Card>
  );
}

// Preferências de envio do WhatsApp da org (admin). Hoje só o toggle de incluir o
// nome de quem enviou no texto que chega ao contato. Sem isso o nome aparece só no
// balão dentro do app (rótulo verde) e o contato não vê quem da equipe falou.
function WhatsAppEditor(): React.JSX.Element {
  const { can } = useAuth();
  const [incluir, setIncluir] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ include_sender_name: boolean }>('/api/whatsapp/status')
      .then((r) => setIncluir(r.include_sender_name))
      .finally(() => setLoading(false));
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.patch('/api/whatsapp/settings', { include_sender_name: incluir });
      toast.success('Preferências do WhatsApp salvas.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner />;
  const editable = can('whatsapp.connect');
  return (
    <Card className="max-w-lg p-4">
      <h3 className="text-sm font-semibold text-ink-900">Envio de mensagens</h3>
      <p className="mt-0.5 text-xs text-ink-400">
        Como as mensagens saem para o contato. O nome sempre aparece no balão dentro do Rovva;
        aqui você decide se ele também vai no texto que o contato recebe no WhatsApp.
      </p>

      <label className="mt-4 flex items-start gap-2">
        <input type="checkbox" checked={incluir} disabled={!editable}
          onChange={(e) => setIncluir(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600" />
        <span className="text-sm text-ink-700">
          Incluir o nome de quem enviou no texto da mensagem.
          <span className="mt-0.5 block text-xs text-ink-400">
            Prefixa o envio com <span className="font-mono">*Nome*:</span> — vale para envios manuais e agendados.
          </span>
        </span>
      </label>

      {editable && (
        <div className="mt-4">
          <Btn icon="check" onClick={() => save()} disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
        </div>
      )}
    </Card>
  );
}

// Alíquotas default da org (org-scoped, admin only no backend). Usadas como base
// nos impostos de cada item ao criar pedido; cada pedido guarda a própria cópia.
const TAX_FIELDS: { key: keyof TaxDefaults; label: string }[] = [
  { key: 'icms_pct', label: 'ICMS' },
  { key: 'ipi_pct', label: 'IPI' },
  { key: 'st_pct', label: 'ICMS-ST' },
  { key: 'pis_pct', label: 'PIS' },
  { key: 'cofins_pct', label: 'COFINS' },
  { key: 'iss_pct', label: 'ISS' },
];

// Editor de alíquotas: feature desabilitada (entrada de nav comentada em SECTIONS,
// nunca renderizada). Preservado p/ reativação futura — fora da cobertura.
/* v8 ignore start */
function AliquotasEditor({ inputCls }: { inputCls: string }): React.JSX.Element {
  const { can } = useAuth();
  const [tax, setTax] = useState<Record<keyof TaxDefaults, string>>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.get<{ tax: TaxDefaults }>('/api/tax-defaults').then((r) => {
      setTax(Object.fromEntries(TAX_FIELDS.map(({ key }) => [key, r.tax[key] ? String(r.tax[key]) : ''])) as Record<keyof TaxDefaults, string>);
    });
  }, []);

  const set = (k: keyof TaxDefaults) => (e: React.ChangeEvent<HTMLInputElement>): void =>
    setTax((p) => ({ ...p!, [k]: maskPct(e.target.value) }));

  const save = async (): Promise<void> => {
    if (!tax) return;
    const body = Object.fromEntries(TAX_FIELDS.map(({ key }) => [key, dec(tax[key]) || 0]));
    try {
      const r = await api.patch<{ tax: TaxDefaults }>('/api/tax-defaults', body);
      setTax(Object.fromEntries(TAX_FIELDS.map(({ key }) => [key, r.tax[key] ? String(r.tax[key]) : ''])) as Record<keyof TaxDefaults, string>);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success('Alíquotas salvas.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  };

  if (!tax) return <Spinner />;
  return (
    <Card className="max-w-lg p-4">
      <h3 className="text-sm font-semibold text-ink-900">Alíquotas de impostos</h3>
      <p className="mt-0.5 text-xs text-ink-400">
        Percentuais default usados ao criar um pedido. Cada item do pedido recebe uma cópia editável —
        mudar aqui não altera pedidos já criados.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {TAX_FIELDS.map(({ key, label }) => (
          <label key={key} className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">{label} (%)</span>
            <input type="text" inputMode="decimal" value={tax[key]} onChange={set(key)}
              placeholder="0" className={inputCls} />
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        {can('tax_defaults.update') && <Btn icon="check" onClick={() => save()}>Salvar</Btn>}
        {saved && <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600"><Icon name="check" size={16} /> Salvo</span>}
      </div>
    </Card>
  );
}
/* v8 ignore stop */

function FunilEditor({ inputCls }: { inputCls: string }): React.JSX.Element {
  const { can } = useAuth();
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [novo, setNovo] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const flash = (): void => { setSaved(true); setTimeout(() => setSaved(false), 1500); };

  const load = async (): Promise<void> => {
    const r = await api.get<{ stages: Stage[] }>('/api/stages');
    setStages(r.stages);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nome = novo.trim();
    if (!nome) return;
    setBusy(true);
    try {
      const r = await api.post<{ stage: Stage }>('/api/stages', { nome });
      setStages((s) => [...s, r.stage]);
      setNovo('');
      flash(); toast.success(`Fase "${nome}" adicionada.`);
    } catch (e2) { toast.error(e2 instanceof Error ? e2.message : 'Não foi possível adicionar a fase.'); }
    finally { setBusy(false); }
  };

  const rename = async (id: number, nome: string): Promise<void> => {
    const trimmed = nome.trim();
    if (!trimmed) return;
    try { await api.patch(`/api/stages/${id}`, { nome: trimmed }); setStages((s) => s.map((x) => (x.id === id ? { ...x, nome: trimmed } : x))); flash(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível renomear.'); }
  };

  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir esta fase? Os cards nela ficam sem etapa.'))) return;
    try {
      await api.del(`/api/stages/${id}`);
      setStages((s) => s.filter((x) => x.id !== id));
      flash(); toast.success('Fase excluída.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível excluir a fase.'); }
  };

  // Reorder by swapping with neighbor, then persist new ordem for the affected stages.
  const move = async (idx: number, dir: -1 | 1): Promise<void> => {
    const j = idx + dir;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    const renumbered = next.map((st, i) => ({ ...st, ordem: i + 1 }));
    setStages(renumbered);
    await Promise.all(
      renumbered
        .filter((st, i) => stages[i]?.id !== st.id || stages[i]?.ordem !== st.ordem)
        .map((st) => api.patch(`/api/stages/${st.id}`, { ordem: st.ordem })),
    );
    flash();
  };

  if (loading) return <Spinner />;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900">Fases do funil</h3>
        {saved && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><Icon name="check" size={14} /> Salvo</span>}
      </div>
      <p className="mt-0.5 text-xs text-ink-400">Renomeie (Enter ou clique fora para salvar), reordene e exclua. Reflete direto na tela de Funil.</p>

      <ul className="mt-4 space-y-2">
        {stages.map((st, i) => (
          <li key={st.id} className="flex items-center gap-2 rounded-xl border border-hairline bg-ink-50 p-2">
            <span className="tabnums grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-xs font-bold text-ink-400 shadow-card">
              {i + 1}
            </span>
            <input defaultValue={st.nome} disabled={!can('stages.update')} maxLength={120}
              onBlur={(e) => { if (e.target.value.trim() !== st.nome) void rename(st.id, e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="min-w-0 flex-1 rounded-lg border border-transparent bg-surface px-2 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200" />
            <div className="flex shrink-0 items-center gap-1">
              <SafeButton onClick={() => move(i, -1)} disabled={i === 0 || !can('stages.update')}
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-500 hover:bg-surface disabled:opacity-30" aria-label="Subir">
                <Icon name="arrowUp" size={15} />
              </SafeButton>
              <SafeButton onClick={() => move(i, 1)} disabled={i === stages.length - 1 || !can('stages.update')}
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-500 hover:bg-surface disabled:opacity-30" aria-label="Descer">
                <Icon name="arrowDown" size={15} />
              </SafeButton>
              {can('stages.delete') && (
                <SafeButton onClick={() => remove(st.id)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500" aria-label="Excluir">
                  <Icon name="x" size={15} />
                </SafeButton>
              )}
            </div>
          </li>
        ))}
        {stages.length === 0 && <li className="py-4 text-center text-sm text-ink-400">Nenhuma fase. Adicione abaixo.</li>}
      </ul>

      {can('stages.create') && (
        <form onSubmit={add} className="mt-3 flex gap-2">
          <input value={novo} onChange={(e) => setNovo(e.target.value)} maxLength={120} placeholder="Nova fase (ex.: Pós-venda)" className={cn(inputCls, 'flex-1')} />
          <Btn icon="plus" type="submit" disabled={busy}>Adicionar</Btn>
        </form>
      )}
    </Card>
  );
}

/* ── Lista nome-só (cenários, ações) ──────────────────────── */
function NamedListEditor({ inputCls, path, titulo, desc, icon, placeholder }: {
  inputCls: string; path: 'scenarios' | 'actions'; titulo: string; desc: string; icon: IconName; placeholder: string;
}): React.JSX.Element {
  const { can } = useAuth();
  const [items, setItems] = useState<NamedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [novo, setNovo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<{ items: NamedItem[] }>(`/api/${path}`);
    setItems(r.items);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nome = novo.trim();
    if (!nome) return;
    setBusy(true);
    try {
      const r = await api.post<{ item: NamedItem }>(`/api/${path}`, { nome });
      setItems((xs) => [...xs, r.item]);
      setNovo('');
      toast.success('Item adicionado.');
    } catch (e2) { toast.error(e2 instanceof Error ? e2.message : 'Não foi possível adicionar.'); }
    finally { setBusy(false); }
  };
  const rename = async (id: number, nome: string): Promise<void> => {
    const t = nome.trim();
    if (!t) return;
    try { await api.patch(`/api/${path}/${id}`, { nome: t }); setItems((xs) => xs.map((x) => (x.id === id ? { ...x, nome: t } : x))); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível renomear.'); }
  };
  const remove = async (id: number): Promise<void> => {
    if (!(await confirmDialog('Excluir este item? Prospecções que o usavam ficam sem valor.'))) return;
    const before = items;
    setItems((xs) => xs.filter((x) => x.id !== id));
    try { await api.del(`/api/${path}/${id}`); toast.success('Item excluído.'); }
    catch { setItems(before); toast.error('Não foi possível excluir.'); }
  };

  if (loading) return <Spinner />;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-ink-900">{titulo}</h3>
      <p className="mt-0.5 text-xs text-ink-400">{desc}</p>

      <ul className="mt-4 space-y-2">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-2 rounded-xl border border-hairline bg-ink-50 p-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-ink-400 shadow-card"><Icon name={icon} size={15} /></span>
            <input defaultValue={it.nome} disabled={!can(`${path}.update`)} maxLength={120}
              onBlur={(e) => { if (e.target.value.trim() !== it.nome) void rename(it.id, e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="min-w-0 flex-1 rounded-lg border border-transparent bg-surface px-2 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200" />
            {can(`${path}.delete`) && (
              <SafeButton onClick={() => remove(it.id)}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-300 hover:bg-rose-50 hover:text-rose-500" aria-label="Excluir">
                <Icon name="x" size={15} />
              </SafeButton>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="py-4 text-center text-sm text-ink-400">Nada cadastrado. Adicione abaixo.</li>}
      </ul>

      {can(`${path}.create`) && (
        <form onSubmit={add} className="mt-3 flex gap-2">
          <input value={novo} onChange={(e) => setNovo(e.target.value)} maxLength={120} placeholder={placeholder} className={cn(inputCls, 'flex-1')} />
          <Btn icon="plus" type="submit" disabled={busy}>Adicionar</Btn>
        </form>
      )}
    </Card>
  );
}
