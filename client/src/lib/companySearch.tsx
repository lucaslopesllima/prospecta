import { useEffect, useRef, useState } from 'react';
import { api, BUSCA_DEBOUNCE_MS } from './api.ts';
import type { CompanyHit } from './types.ts';
import { Icon } from './icons.tsx';
import { maskSearchCNPJ } from './format.ts';
import { cn } from './ui.tsx';

// Busca reutilizável na base global de empresas (RFB) para autopreencher
// cadastros (transportadoras, representadas, etc.). Digite CNPJ ou nome →
// escolha um resultado → onPick recebe a empresa para popular o formulário.
// Debounce de 300ms; aborta a requisição anterior a cada tecla.
export function CompanySearch({ onPick, placeholder = 'Buscar empresa por CNPJ ou nome…', disableInFunnel = false }: {
  onPick: (c: CompanyHit) => void;
  placeholder?: string;
  // Quando true, empresas já no funil aparecem opacas/desativadas (com tooltip)
  // em vez de selecionáveis. Usado onde duplicar relationship é proibido (Clientes).
  disableInFunnel?: boolean;
}): React.JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // mínimo 3 chars: acompanha o schema do servidor (trigram precisa de 3; com 2 vira seq scan)
    if (q.trim().length < 3) { setHits([]); setOpen(false); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      void api.get<{ companies: CompanyHit[] }>(`/api/companies/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then((r) => { setHits(r.companies); setOpen(true); })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, BUSCA_DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  // fecha o dropdown ao clicar fora
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (c: CompanyHit): void => {
    onPick(c);
    setQ(''); setHits([]); setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={q} onChange={(e) => setQ(maskSearchCNPJ(e.target.value))} onFocus={() => hits.length && setOpen(true)}
          maxLength={120} placeholder={placeholder}
          className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-3 text-sm text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200" />
        {loading && <span className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />}
      </div>
      {open && (
        <div className="absolute z-[1600] mt-1 max-h-72 w-full overflow-auto rounded-xl border border-ink-200 bg-surface shadow-pop">
          {hits.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-ink-400">{loading ? 'Buscando…' : 'Nenhuma empresa encontrada.'}</p>
          ) : hits.map((c) => {
            const blocked = disableInFunnel && c.in_funnel === true;
            return (
              <button key={c.id} type="button" disabled={blocked}
                onClick={() => !blocked && pick(c)}
                title={blocked ? 'Empresa já está no funil' : undefined}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 border-b border-ink-50 px-3 py-2 text-left transition last:border-0',
                  blocked ? 'cursor-not-allowed opacity-50' : 'hover:bg-ink-50',
                )}>
                <span className="flex w-full items-center gap-1.5 truncate text-sm font-medium text-ink-800">
                  <span className="truncate">{c.nome_fantasia || c.razao_social}</span>
                  {blocked && <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-500">no funil</span>}
                </span>
                <span className="truncate text-[11px] text-ink-400">
                  {c.cnpj}{c.cidade ? ` · ${c.cidade}/${c.uf}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
