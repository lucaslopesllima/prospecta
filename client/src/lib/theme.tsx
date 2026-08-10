// Tema claro/escuro/sistema. `theme` guarda a escolha; `resolvedTheme` informa
// qual paleta está ativa quando a escolha segue o sistema operacional.
// A classe `.dark` no <html> é a fonte da verdade visual (ver index.css).
// O FOUC é evitado por um script inline em index.html que roda antes do React.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './icons.tsx';
import { cn } from './ui.tsx';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<Theme, 'system'>;

const STORAGE_KEY = 'theme';

const prefersDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

// Primeira carga sem preferência salva: segue o SO. Depois sempre o que o
// usuário escolheu no toggle.
const readStored = (): Theme => {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
};

// Reflete o tema na <html>: classe .dark + meta theme-color.
function applyTheme(theme: ResolvedTheme): void {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0e111b' : '#ffffff');
}

type Ctx = { theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (t: Theme) => void; toggle: () => void };
const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const resolvedTheme: ResolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t === 'system' ? (prefersDark() ? 'dark' : 'light') : t);
  }, []);

  const toggle = useCallback(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'), [resolvedTheme, setTheme]);

  // Em modo sistema, acompanha troca do SO em tempo real.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => setSystemDark(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // garante que o DOM reflita o estado inicial (caso difira do script anti-FOUC)
  useEffect(() => { applyTheme(resolvedTheme); }, [resolvedTheme]);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme, toggle }), [theme, resolvedTheme, setTheme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme deve ser usado dentro de <ThemeProvider>');
  return ctx;
}

// Switch deslizante claro↔escuro. `variant` casa com as duas top bars.
export function ThemeToggle({ variant = 'light' }: { variant?: 'light' | 'dark' }): React.JSX.Element {
  const { resolvedTheme, toggle } = useTheme();
  const dark = resolvedTheme === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={toggle}
      aria-label={dark ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
      title={dark ? 'Tema escuro' : 'Tema claro'}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
        variant === 'dark' ? 'focus-visible:ring-offset-ink-900' : 'focus-visible:ring-offset-surface',
        dark ? 'bg-brand-600' : variant === 'dark' ? 'bg-white/20' : 'bg-ink-200',
      )}
    >
      <span
        className={cn(
          'grid h-5 w-5 place-items-center rounded-full bg-surface text-ink-600 shadow transition-transform',
          dark ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      >
        <Icon name={dark ? 'moon' : 'sun'} size={12} />
      </span>
    </button>
  );
}

const THEME_OPTIONS: { value: Theme; label: string; icon: 'sun' | 'moon' | 'monitor' }[] = [
  { value: 'light', label: 'Claro', icon: 'sun' },
  { value: 'dark', label: 'Escuro', icon: 'moon' },
  { value: 'system', label: 'Sistema', icon: 'monitor' },
];

export function ThemeSelector({ compact = false }: { compact?: boolean }): React.JSX.Element {
  // Também renderiza isolado em páginas/testes sem Provider; no app real usa o
  // contexto global. Mantém `useTheme` estrito para consumidores de estado.
  const context = useContext(ThemeContext);
  const [standalone, setStandalone] = useState<Theme>(readStored);
  const theme = context?.theme ?? standalone;
  const setTheme = context?.setTheme ?? ((value: Theme): void => {
    setStandalone(value);
    localStorage.setItem(STORAGE_KEY, value);
    applyTheme(value === 'system' ? (prefersDark() ? 'dark' : 'light') : value);
  });
  return (
    <div role="group" aria-label="Tema da interface"
      className="inline-flex max-w-full rounded-xl border border-hairline bg-ink-100 p-1">
      {THEME_OPTIONS.map((option) => (
        <button key={option.value} type="button" onClick={() => setTheme(option.value)}
          aria-label={compact ? option.label : undefined}
          aria-pressed={theme === option.value}
          className={cn(
            'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors',
            theme === option.value
              ? 'bg-surface text-brand-700 shadow-card'
              : 'text-ink-500 hover:bg-surface/50 hover:text-ink-800',
          )}>
          <Icon name={option.icon} size={15} />
          {!compact && option.label}
        </button>
      ))}
    </div>
  );
}
