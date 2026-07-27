import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { Btn, cn } from '../lib/ui.tsx';
import { Icon, type IconName } from '../lib/icons.tsx';
import { isEmail } from '../lib/format.ts';

const FEATURES: { icon: IconName; title: string; desc: string }[] = [
  { icon: 'target', title: 'Recomendação explicável', desc: 'Empresas ranqueadas por CNAE, proximidade e porte.' },
  { icon: 'map', title: 'Território no mapa', desc: 'Veja onde estão as melhores oportunidades.' },
  { icon: 'columns', title: 'Funil leve', desc: 'Kanban e agenda sem a complexidade de um CRM pesado.' },
];

export function Login(): React.JSX.Element {
  const { user, login, register } = useAuth();
  // TEMPORÁRIO: cadastro público bloqueado — mode fica travado em 'login' e o
  // seletor Entrar/Criar conta está comentado abaixo. Para reabrir, restaurar
  // `const [mode, setMode] = ...` e descomentar o bloco do seletor.
  const [mode] = useState<'login' | 'register'>('login');
  const [tipoConta, setTipoConta] = useState<'individual' | 'escritorio'>('individual');
  const [orgNome, setOrgNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr('');
    // só no cadastro: no login o formato não importa (a senha decide) e não
    // vale bloquear um e-mail legado que o type="email" nativo aceitou.
    if (mode === 'register' && !isEmail(email)) { setErr('E-mail inválido.'); return; }
    setBusy(true);
    try {
      if (mode === 'login') await login(email, senha);
      else await register(orgNome, email, senha, tipoConta);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* brand panel */}
      <div data-chrome className="relative hidden flex-col justify-between overflow-hidden bg-ink-900 p-10 text-white lg:flex">
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 h-72 w-72 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 shadow-sm shadow-brand-600/30">
            <Icon name="target" size={20} />
          </span>
          <span className="text-lg font-bold tracking-tight">Rovva</span>
        </div>
        <div className="relative space-y-6">
          <h2 className="max-w-sm text-2xl font-bold leading-snug tracking-tight">
            Prospecção inteligente para representantes comerciais.
          </h2>
          <ul className="space-y-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-brand-200">
                  <Icon name={f.icon} size={18} />
                </span>
                <div>
                  <p className="text-sm font-semibold">{f.title}</p>
                  <p className="text-sm text-ink-300">{f.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* form */}
      <div className="grid place-items-center bg-ink-50 p-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-sm shadow-brand-600/30">
              <Icon name="target" size={20} />
            </span>
            <span className="text-lg font-bold tracking-tight text-ink-900">Rovva</span>
          </div>

          <h1 className="text-xl font-bold tracking-tight text-ink-900">
            {mode === 'login' ? 'Bem-vindo de volta' : 'Crie sua conta'}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {mode === 'login' ? 'Entre para ver suas recomendações.' : 'Comece a prospectar em minutos.'}
          </p>

          {/* TEMPORÁRIO: cadastro público bloqueado (o server também rejeita /api/auth/register).
          <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-ink-100 p-1 text-sm font-medium">
            {(['login', 'register'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={cn('rounded-lg py-2 transition-colors', mode === m ? 'bg-surface text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-700')}>
                {m === 'login' ? 'Entrar' : 'Criar conta'}
              </button>
            ))}
          </div>
          */}

          <form onSubmit={submit} className="mt-5 space-y-3">
            {mode === 'register' && (
              <TipoContaPicker value={tipoConta} onChange={setTipoConta} />
            )}
            {mode === 'register' && (
              <Field
                label={tipoConta === 'individual' ? 'Seu nome / razão social' : 'Nome do escritório'}
                value={orgNome}
                onChange={setOrgNome}
                placeholder={tipoConta === 'individual' ? 'João Silva Representações' : 'Minha Representação'}
                autoFocus
                maxLength={120}
              />
            )}
            <Field label="E-mail" type="email" value={email} onChange={setEmail} placeholder="voce@empresa.com" autoFocus={mode === 'login'} maxLength={160} />
            <Field label="Senha" type="password" value={senha} onChange={setSenha} placeholder="mínimo 6 caracteres" maxLength={200} />
            {err && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}
            <Btn type="submit" disabled={busy} className="w-full">
              {busy ? '…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
            </Btn>
          </form>
        </div>
      </div>
    </div>
  );
}

// Escolha do tipo de conta no cadastro. Default individual: erro recuperável
// (individual→escritório tem upgrade em /conta; o inverso não).
function TipoContaPicker({ value, onChange }: {
  value: 'individual' | 'escritorio';
  onChange: (v: 'individual' | 'escritorio') => void;
}): React.JSX.Element {
  const opts: { v: 'individual' | 'escritorio'; icon: IconName; title: string; desc: string }[] = [
    { v: 'individual', icon: 'target', title: 'Individual', desc: 'Represento sozinho(a)' },
    { v: 'escritorio', icon: 'users', title: 'Escritório', desc: 'Tenho equipe de vendedores' },
  ];
  return (
    <fieldset>
      <legend className="text-xs font-semibold text-ink-600">Tipo de conta</legend>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {opts.map((o) => {
          const active = value === o.v;
          return (
            <label key={o.v}
              className={cn('flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition',
                active ? 'border-brand-400 bg-brand-50/40 ring-2 ring-brand-200' : 'border-ink-200 hover:border-ink-300')}>
              <input type="radio" name="tipo_conta" value={o.v} checked={active}
                onChange={() => onChange(o.v)} className="sr-only" />
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
                <Icon name={o.icon} size={16} className={active ? 'text-brand-600' : 'text-ink-400'} />
                {o.title}
              </span>
              <span className="text-xs text-ink-500">{o.desc}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Field(props: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoFocus?: boolean; maxLength?: number;
}): React.JSX.Element {
  const isPwd = props.type === 'password';
  const [show, setShow] = useState(false);
  const type = isPwd ? (show ? 'text' : 'password') : (props.type ?? 'text');
  return (
    <label className="block">
      <span className="text-xs font-semibold text-ink-600">{props.label}</span>
      <div className="relative mt-1">
        <input
          type={type}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          required
          autoFocus={props.autoFocus}
          maxLength={props.maxLength}
          className={cn('w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200',
            isPwd && 'pr-10')}
        />
        {isPwd && (
          <button type="button" onClick={() => setShow((s) => !s)} tabIndex={-1}
            aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
            className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-600">
            <Icon name={show ? 'eyeOff' : 'eye'} size={17} />
          </button>
        )}
      </div>
    </label>
  );
}
