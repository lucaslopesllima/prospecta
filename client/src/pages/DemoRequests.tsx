import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../lib/ui.tsx';
import type { Tone } from '../lib/ui.tsx';

type DemoStatus = 'novo' | 'contatado' | 'teste_agendado' | 'concluido' | 'arquivado';
interface DemoRequest {
  id: string;
  nome: string;
  email: string;
  telefone: string;
  empresa: string | null;
  mensagem: string | null;
  status: DemoStatus;
  created_at: string;
  updated_at: string;
}

const STATUS: Record<DemoStatus, { label: string; tone: Tone }> = {
  novo: { label: 'Novo', tone: 'brand' },
  contatado: { label: 'Contatado', tone: 'info' },
  teste_agendado: { label: 'Teste agendado', tone: 'warn' },
  concluido: { label: 'Concluído', tone: 'success' },
  arquivado: { label: 'Arquivado', tone: 'neutral' },
};

function quando(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function DemoRequests(): React.JSX.Element {
  const [leads, setLeads] = useState<DemoRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api.get<{ leads: DemoRequest[] }>('/api/leads', { signal: ac.signal }).then(
      (r) => { setLeads(r.leads); setLoading(false); },
      (e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof ApiError ? e.message : 'Falha ao carregar pedidos');
        setLoading(false);
      },
    );
    return () => ac.abort();
  }, []);

  const novos = useMemo(() => leads.filter((lead) => lead.status === 'novo').length, [leads]);

  async function changeStatus(lead: DemoRequest, status: DemoStatus): Promise<void> {
    setSavingId(lead.id);
    try {
      const r = await api.patch<{ lead: DemoRequest }>(`/api/leads/${lead.id}`, { status });
      setLeads((items) => items.map((item) => item.id === lead.id ? r.lead : item));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao atualizar pedido');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Pedidos de demonstração"
        subtitle={`${leads.length} pedido${leads.length === 1 ? '' : 's'} · ${novos} novo${novos === 1 ? '' : 's'}`} />

      {loading ? <Card><Spinner /></Card> : error && leads.length === 0 ? (
        <Card><EmptyState icon="alertCircle" title={error} hint="Recarregue a página para tentar novamente." /></Card>
      ) : leads.length === 0 ? (
        <Card><EmptyState icon="sparkles" title="Nenhum pedido ainda" hint="Solicitações enviadas pela landing aparecem aqui." /></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {leads.map((lead) => (
            <Card key={lead.id} className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold text-ink-900">{lead.nome}</h2>
                    <Badge tone={STATUS[lead.status].tone}>{STATUS[lead.status].label}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-ink-500">{lead.empresa || 'Empresa não informada'}</p>
                </div>
                <time className="text-xs text-ink-400" dateTime={lead.created_at}>{quando(lead.created_at)}</time>
              </div>

              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <a className="rounded-lg bg-ink-50 px-3 py-2 text-brand-600 hover:bg-brand-50" href={`mailto:${lead.email}`}>{lead.email}</a>
                <a className="rounded-lg bg-ink-50 px-3 py-2 text-brand-600 hover:bg-brand-50" href={`tel:${lead.telefone}`}>{lead.telefone}</a>
              </div>

              {lead.mensagem && <p className="rounded-lg border border-ink-100 bg-ink-50 p-3 text-sm text-ink-600">{lead.mensagem}</p>}

              <label className="flex items-center justify-between gap-3 border-t border-ink-100 pt-3 text-xs font-semibold text-ink-500">
                Status
                <select value={lead.status} disabled={savingId === lead.id}
                  onChange={(e) => void changeStatus(lead, e.target.value as DemoStatus)}
                  className="rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-700 outline-none focus:border-brand-500">
                  {Object.entries(STATUS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
                </select>
              </label>
            </Card>
          ))}
        </div>
      )}

      {error && leads.length > 0 && <p role="alert" className="text-sm text-rose-600">{error}</p>}
    </div>
  );
}
