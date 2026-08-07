import { useEffect, useState } from 'react';
import { api, ApiError, setToken } from '../lib/api.ts';
import type { AccountOrg, AccountUser } from '../lib/types.ts';
import { Btn, Card, cn, inputCls, PageHeader, Spinner } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { invalidCNPJ, isEmail, maskCNPJ, maskPhone, maskCEP, maskUF } from '../lib/format.ts';
import { toast } from '../lib/toast.tsx';
import { useAuth } from '../lib/auth.tsx';

const t = (s: string): string | null => (s.trim() === '' ? null : s.trim());

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>
      {children}
    </label>
  );
}

export function Account(): React.JSX.Element {
  const { user, refresh } = useAuth();
  const [org, setOrg] = useState<AccountOrg | null>(null);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [busyUpgrade, setBusyUpgrade] = useState(false);
  const [savedInfo, setSavedInfo] = useState(false);
  const [busyInfo, setBusyInfo] = useState(false);
  const [errInfo, setErrInfo] = useState('');

  const [cepBusy, setCepBusy] = useState(false);
  const [cepMsg, setCepMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // senha
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [conf, setConf] = useState('');
  const [busyPwd, setBusyPwd] = useState(false);
  const [msgPwd, setMsgPwd] = useState('');
  const [okPwd, setOkPwd] = useState(false);

  useEffect(() => {
    void api.get<{ org: AccountOrg; user: AccountUser }>('/api/account').then((r) => {
      setOrg(r.org);
      setEmail(r.user.email);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const set = (k: keyof AccountOrg) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setOrg((o) => (o ? { ...o, [k]: e.target.value } : o));

  // ViaCEP: preenche endereço a partir do CEP (8 dígitos).
  const buscarCep = async (raw: string): Promise<void> => {
    const cep = raw.replace(/\D/g, '');
    if (cep.length !== 8) return;
    setCepBusy(true); setCepMsg(null);
    try {
      const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const j = await resp.json() as { erro?: boolean; logradouro?: string; bairro?: string; localidade?: string; uf?: string; complemento?: string };
      if (j.erro) { setCepMsg({ ok: false, text: 'CEP não encontrado — preencha manualmente.' }); return; }
      setOrg((o) => o ? {
        ...o,
        logradouro: j.logradouro || o.logradouro,
        bairro: j.bairro || o.bairro,
        cidade: j.localidade || o.cidade,
        uf: j.uf || o.uf,
        complemento: o.complemento || j.complemento || o.complemento,
      } : o);
      setCepMsg({ ok: true, text: 'Endereço preenchido pelo CEP.' });
    } catch { setCepMsg({ ok: false, text: 'Não foi possível consultar o CEP — preencha manualmente.' }); }
    finally { setCepBusy(false); }
  };

  const onCep = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = maskCEP(e.target.value);
    setOrg((o) => (o ? { ...o, cep: v } : o));
    if (v.replace(/\D/g, '').length === 8) void buscarCep(v);
  };

  const saveInfo = async (): Promise<void> => {
    if (!org) return;
    if (!isEmail(email)) { toast.error('E-mail inválido.'); return; }
    if (invalidCNPJ(org.cnpj ?? '')) { toast.error('CNPJ inválido.'); return; }
    setBusyInfo(true); setErrInfo('');
    try {
      const r = await api.patch<{ org: AccountOrg; user: AccountUser }>('/api/account', {
        nome: org.nome.trim(), email: email.trim(),
        cnpj: t(org.cnpj ?? ''), telefone: t(org.telefone ?? ''),
        cep: t(org.cep ?? ''), logradouro: t(org.logradouro ?? ''), numero: t(org.numero ?? ''),
        complemento: t(org.complemento ?? ''), bairro: t(org.bairro ?? ''),
        cidade: t(org.cidade ?? ''), uf: t(org.uf ?? ''),
      });
      setOrg(r.org); setEmail(r.user.email);
      setSavedInfo(true); setTimeout(() => setSavedInfo(false), 2000);
      toast.success('Dados salvos.');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Erro ao salvar';
      setErrInfo(msg); toast.error(msg);
    } finally { setBusyInfo(false); }
  };

  const savePwd = async (): Promise<void> => {
    setMsgPwd(''); setOkPwd(false);
    if (nova.length < 6) { setMsgPwd('Nova senha precisa de ao menos 6 caracteres.'); return; }
    if (nova !== conf) { setMsgPwd('A confirmação não confere.'); return; }
    setBusyPwd(true);
    try {
      // a troca rotaciona o token (token_version) — guarda o novo para a sessão atual
      const r = await api.post<{ token: string }>('/api/account/password', { senha_atual: atual, nova_senha: nova });
      setToken(r.token);
      setOkPwd(true); setMsgPwd('Senha atualizada.');
      setAtual(''); setNova(''); setConf('');
      toast.success('Senha atualizada.');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Erro ao atualizar senha';
      setMsgPwd(msg); toast.error(msg);
    } finally { setBusyPwd(false); }
  };

  const upgrade = async (): Promise<void> => {
    setBusyUpgrade(true);
    try {
      const r = await api.post<{ org: AccountOrg }>('/api/account/upgrade');
      setOrg(r.org);
      setConfirmUpgrade(false);
      // repopula user.tipo_conta → menu ganha Equipe/Grupos/Carteiras sem relogar.
      await refresh();
      toast.success('Conta migrada para escritório.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Erro ao migrar conta');
    } finally { setBusyUpgrade(false); }
  };

  if (loading) return <div className="p-6"><Spinner /></div>;
  if (!org) return <div className="p-6 text-sm text-ink-400">Não foi possível carregar o perfil.</div>;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Meu perfil" subtitle="Dados do representante e segurança da conta." />

      <Card className="max-w-3xl p-4">
        <h3 className="text-sm font-semibold text-ink-900">Dados do representante</h3>
        <p className="mt-0.5 text-xs text-ink-400">Usados também como origem das rotas e na sua identificação.</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Nome / Razão social"><input value={org.nome} onChange={set('nome')} maxLength={120} className={inputCls} /></Field>
          {/* sem inputMode="numeric": CNPJ alfanumérico precisa de letras no teclado */}
          <Field label="CNPJ"><input value={org.cnpj ?? ''} autoCapitalize="characters"
            onChange={(e) => setOrg((o) => (o ? { ...o, cnpj: maskCNPJ(e.target.value) } : o))} placeholder="00.000.000/0000-00" className={inputCls} /></Field>
          <Field label="E-mail (login)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} className={inputCls} /></Field>
          <Field label="Telefone"><input value={org.telefone ?? ''} inputMode="tel"
            onChange={(e) => setOrg((o) => (o ? { ...o, telefone: maskPhone(e.target.value) } : o))} placeholder="(00) 00000-0000" className={inputCls} /></Field>
        </div>

        <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Endereço</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-6">
          <Field label="CEP" className="sm:col-span-2">
            <div className="relative">
              <input value={org.cep ?? ''} inputMode="numeric" onChange={onCep} onBlur={(e) => void buscarCep(e.target.value)}
                placeholder="00000-000" className={inputCls} />
              {cepBusy && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-ink-400">buscando…</span>}
            </div>
            {cepMsg && (
              <span className={cn('mt-1 inline-flex items-center gap-1 text-[11px]', cepMsg.ok ? 'text-emerald-600' : 'text-amber-600')}>
                <Icon name={cepMsg.ok ? 'check' : 'alertTriangle'} size={12} />{cepMsg.text}
              </span>
            )}
          </Field>
          <Field label="Logradouro" className="sm:col-span-3"><input value={org.logradouro ?? ''} onChange={set('logradouro')} maxLength={120} className={inputCls} /></Field>
          <Field label="Número" className="sm:col-span-1"><input value={org.numero ?? ''} onChange={set('numero')} maxLength={120} className={inputCls} /></Field>
          <Field label="Complemento" className="sm:col-span-2"><input value={org.complemento ?? ''} onChange={set('complemento')} maxLength={120} className={inputCls} /></Field>
          <Field label="Bairro" className="sm:col-span-2"><input value={org.bairro ?? ''} onChange={set('bairro')} maxLength={120} className={inputCls} /></Field>
          <Field label="Cidade" className="sm:col-span-1"><input value={org.cidade ?? ''} onChange={set('cidade')} maxLength={120} className={inputCls} /></Field>
          <Field label="UF" className="sm:col-span-1"><input value={org.uf ?? ''} maxLength={2}
            onChange={(e) => setOrg((o) => (o ? { ...o, uf: maskUF(e.target.value) } : o))} className={inputCls} /></Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Btn icon="check" onClick={() => saveInfo()} disabled={busyInfo}>{busyInfo ? '…' : 'Salvar dados'}</Btn>
          {savedInfo && <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600"><Icon name="check" size={16} /> Salvo</span>}
          {errInfo && <span className="text-sm text-rose-600">{errInfo}</span>}
        </div>
      </Card>

      <Card className="max-w-3xl p-4">
        <h3 className="text-sm font-semibold text-ink-900">Tipo de conta</h3>
        {org.tipo_conta === 'individual' ? (
          <>
            <p className="mt-0.5 text-xs text-ink-400">
              Conta <span className="font-semibold text-ink-600">Individual</span> — sem equipe, grupos ou carteiras.
            </p>
            {user?.is_admin && (
              confirmUpgrade ? (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="flex items-start gap-1.5 text-xs text-amber-800">
                    <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
                    Ação permanente — habilita Equipe, Grupos e Carteiras. Não é possível voltar para individual.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Btn icon="check" onClick={() => upgrade()} disabled={busyUpgrade}>
                      {busyUpgrade ? '…' : 'Confirmar migração'}
                    </Btn>
                    <Btn variant="soft" onClick={() => setConfirmUpgrade(false)} disabled={busyUpgrade}>Cancelar</Btn>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <Btn icon="users" variant="soft" onClick={() => setConfirmUpgrade(true)}>Migrar para escritório</Btn>
                </div>
              )
            )}
          </>
        ) : (
          <p className="mt-0.5 text-xs text-ink-400">
            Conta <span className="font-semibold text-ink-600">Escritório de representação</span> — equipe, grupos e carteiras habilitados.
          </p>
        )}
      </Card>

      <Card className="max-w-3xl p-4">
        <h3 className="text-sm font-semibold text-ink-900">Atualizar senha</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Senha atual"><input type="password" value={atual} onChange={(e) => setAtual(e.target.value)} maxLength={200} className={inputCls} /></Field>
          <Field label="Nova senha"><input type="password" value={nova} onChange={(e) => setNova(e.target.value)} maxLength={200} className={inputCls} /></Field>
          <Field label="Confirmar nova senha"><input type="password" value={conf} onChange={(e) => setConf(e.target.value)} maxLength={200} className={inputCls} /></Field>
        </div>
        {(nova || conf) && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {[{ ok: nova.length >= 6, txt: 'Ao menos 6 caracteres' }, { ok: nova.length > 0 && nova === conf, txt: 'As senhas conferem' }].map((r) => (
              <li key={r.txt} className={cn('inline-flex items-center gap-1.5 text-xs', r.ok ? 'text-emerald-600' : 'text-ink-400')}>
                <Icon name={r.ok ? 'check' : 'x'} size={12} />{r.txt}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Btn icon="check" onClick={() => savePwd()} disabled={busyPwd || !atual || !nova}>{busyPwd ? '…' : 'Atualizar senha'}</Btn>
          {msgPwd && <span className={cn('text-sm', okPwd ? 'text-emerald-600' : 'text-rose-600')}>{msgPwd}</span>}
        </div>
      </Card>
    </div>
  );
}
