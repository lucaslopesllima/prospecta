import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { Btn, Card, cn, inputCls as baseInputCls } from '../lib/ui.tsx';
import { Icon } from '../lib/icons.tsx';
import { LogoMark } from '../lib/logo.tsx';

// regra visível em tempo real (✓/○) — usuário não descobre o requisito só ao errar
function Rule({ ok, children }: { ok: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className={cn('flex items-center gap-1.5 text-xs', ok ? 'text-emerald-600' : 'text-ink-400')}>
      <span className={cn('grid h-4 w-4 place-items-center rounded-full', ok ? 'bg-emerald-100' : 'bg-ink-100')}>
        <Icon name={ok ? 'check' : 'x'} size={11} />
      </span>
      {children}
    </li>
  );
}

const inputCls = cn(baseInputCls, 'mt-1');

// Tela bloqueante do primeiro acesso: usuário criado pelo admin entra com a
// senha provisória e só segue depois de definir a senha definitiva.
export function ChangePassword(): React.JSX.Element {
  const { user, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [conf, setConf] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr('');
    if (nova.length < 6) { setErr('A nova senha precisa de ao menos 6 caracteres.'); return; }
    if (nova !== conf) { setErr('A confirmação não confere.'); return; }
    setBusy(true);
    try {
      // a troca rotaciona o token (token_version) — guarda o novo antes de qualquer chamada
      const r = await api.post<{ token: string }>('/api/account/password', { senha_atual: atual, nova_senha: nova });
      setToken(r.token);
      await refresh();
      navigate('/', { replace: true });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Erro ao trocar a senha');
    } finally { setBusy(false); }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-ink-50 p-4">
      <Card className="w-full max-w-sm p-6">
        <LogoMark size={40} className="rounded-xl shadow-sm shadow-black/20" />
        <h1 className="mt-4 text-lg font-bold tracking-tight text-ink-900">Defina sua senha</h1>
        <p className="mt-1 text-sm text-ink-500">
          Olá{user?.nome ? `, ${user.nome}` : ''}! Sua senha atual é provisória — escolha uma definitiva para continuar.
        </p>
        <form onSubmit={submit} className="mt-5 space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Senha provisória</span>
            <input type="password" value={atual} onChange={(e) => setAtual(e.target.value)} required autoFocus maxLength={200} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Nova senha</span>
            <input type="password" value={nova} onChange={(e) => setNova(e.target.value)} required minLength={6} maxLength={200} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Confirmar nova senha</span>
            <input type="password" value={conf} onChange={(e) => setConf(e.target.value)} required maxLength={200} className={inputCls} />
          </label>
          <ul className="space-y-1">
            <Rule ok={nova.length >= 6}>Ao menos 6 caracteres</Rule>
            <Rule ok={nova.length > 0 && nova === conf}>As senhas conferem</Rule>
          </ul>
          {err && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}
          <Btn type="submit" disabled={busy} className="w-full">{busy ? '…' : 'Salvar e continuar'}</Btn>
          <button type="button" onClick={logout} className="w-full text-center text-xs text-ink-400 hover:text-ink-600">
            Sair
          </button>
        </form>
      </Card>
    </div>
  );
}
