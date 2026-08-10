import { useEffect, useMemo, useState } from 'react';
import { MapContainer, CircleMarker, Tooltip } from 'react-leaflet';
import { api } from '../lib/api.ts';
import { useSellers, SellerFilter } from '../lib/sellers.tsx';
import { loadTerritorioIds } from '../lib/companyFilter.tsx';
import { Btn, Card, EmptyState, ErrorState, PageHeader, Segmented, Spinner, cn } from '../lib/ui.tsx';
import { brl, brl0, csvNum } from '../lib/format.ts';
import { downloadCsv } from '../lib/export.ts';
import { ThemedTileLayer } from '../lib/mapTiles.tsx';

type Tab = 'vendas' | 'abc' | 'cobertura' | 'descartes';
type GroupBy = 'mes' | 'vendedor' | 'representada';

interface SalesRow { chave: string | number; label: string; total: string; qtd: number }
interface AbcCliente { company_id: number; razao_social: string; nome_fantasia: string | null; total: number; share: number; classe: string }
interface CoverageMun { id: number; nome: string; uf: string; lat: number; lon: number; potencial: number; clientes: number }
interface DescarteRow { motivo: string; qtd: number }

const ownerQs = (ownerId: 'todos' | number): string => (ownerId === 'todos' ? '' : `&user_id=${ownerId}`);

export function Reports(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('vendas');
  const sellers = useSellers();
  const [ownerId, setOwnerId] = useState<'todos' | number>('todos');

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Relatórios" subtitle="Vendas, clientes, cobertura de território e perdas."
        actions={<SellerFilter value={ownerId} onChange={setOwnerId} sellers={sellers} />} />
      <Segmented value={tab} onChange={setTab} options={[
        { value: 'vendas', label: 'Vendas', icon: 'trendingUp' },
        { value: 'abc', label: 'Curva ABC', icon: 'barChart' },
        { value: 'cobertura', label: 'Cobertura', icon: 'map' },
        { value: 'descartes', label: 'Perdas', icon: 'x' },
      ]} />
      {tab === 'vendas' && <Vendas ownerId={ownerId} />}
      {tab === 'abc' && <Abc ownerId={ownerId} />}
      {tab === 'cobertura' && <Cobertura ownerId={ownerId} />}
      {tab === 'descartes' && <Descartes ownerId={ownerId} />}
    </div>
  );
}

function Vendas({ ownerId }: { ownerId: 'todos' | number }): React.JSX.Element {
  const [groupBy, setGroupBy] = useState<GroupBy>('mes');
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api.get<{ rows: SalesRow[] }>(`/api/reports/sales?group_by=${groupBy}${ownerQs(ownerId)}`)
      .then((r) => { if (!cancelled) setRows(r.rows); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Falha ao carregar relatório.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupBy, ownerId, retryKey]);

  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.total)), 0);

  const exportar = (): void => downloadCsv(`vendas-por-${groupBy}`, ['Agrupador', 'Pedidos', 'Total'],
    rows.map((r) => [r.label, r.qtd, csvNum(r.total)]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={groupBy} onChange={setGroupBy} options={[
          { value: 'mes', label: 'Por mês' },
          { value: 'vendedor', label: 'Por vendedor' },
          { value: 'representada', label: 'Por representada' },
        ]} />
        {rows.length > 0 && <Btn variant="soft" size="sm" icon="download" onClick={exportar}>Exportar CSV</Btn>}
      </div>
      {loading ? <Spinner /> : error ? <ErrorState hint={error} onRetry={() => setRetryKey((v) => v + 1)} /> : rows.length === 0 ? (
        <EmptyState icon="trendingUp" title="Sem vendas no período" hint="Faturamento dos últimos 12 meses." />
      ) : (
        <Card className="p-4">
          <p className="mb-3 text-sm text-ink-500">Total: <span className="font-bold text-ink-800">{brl(total)}</span></p>
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={String(r.chave)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[10rem_minmax(3rem,1fr)_7rem]">
                <span className="min-w-0 truncate text-sm text-ink-700">{r.label}</span>
                <div className="col-span-2 row-start-2 h-2 overflow-hidden rounded-full bg-ink-100 sm:col-span-1 sm:row-auto">
                  <div className="h-full rounded-full bg-brand-400" style={{ width: `${max > 0 ? (Number(r.total) / max) * 100 : 0}%` }} />
                </div>
                <span className="tabnums col-start-2 row-start-1 text-right text-sm font-semibold text-ink-800 sm:col-auto sm:row-auto">{brl0(Number(r.total))}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

const ABC_TONE: Record<string, string> = { A: 'bg-emerald-500', B: 'bg-amber-500', C: 'bg-ink-400' };

function Abc({ ownerId }: { ownerId: 'todos' | number }): React.JSX.Element {
  const [clientes, setClientes] = useState<AbcCliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api.get<{ clientes: AbcCliente[] }>(`/api/reports/abc?${ownerQs(ownerId).slice(1)}`)
      .then((r) => { if (!cancelled) setClientes(r.clientes); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Falha ao carregar curva ABC.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ownerId, retryKey]);

  const exportar = (): void => downloadCsv('curva-abc', ['Cliente', 'Faturamento', 'Share %', 'Classe'],
    clientes.map((c) => [c.nome_fantasia || c.razao_social, csvNum(c.total), c.share, c.classe]));

  // subtotais por classe (A/B/C): nº de clientes, faturamento e % do total — torna o 80/20 evidente
  const resumo = useMemo(() => {
    const totalGeral = clientes.reduce((s, c) => s + c.total, 0) || 1;
    const map = new Map<string, { n: number; total: number }>();
    for (const c of clientes) {
      const g = map.get(c.classe) ?? { n: 0, total: 0 };
      g.n++; g.total += c.total; map.set(c.classe, g);
    }
    return (['A', 'B', 'C'] as const).filter((k) => map.has(k))
      .map((k) => ({ classe: k, ...map.get(k)!, share: (map.get(k)!.total / totalGeral) * 100 }));
  }, [clientes]);

  if (loading) return <Spinner />;
  if (error) return <ErrorState hint={error} onRetry={() => setRetryKey((v) => v + 1)} />;
  if (clientes.length === 0) return <EmptyState icon="barChart" title="Sem faturamento" hint="Curva ABC dos últimos 12 meses." />;

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center justify-between p-4">
        <p className="text-sm text-ink-500">{clientes.length} cliente(s) — últimos 12 meses</p>
        <Btn variant="soft" size="sm" icon="download" onClick={exportar}>Exportar CSV</Btn>
      </div>
      <div className="grid grid-cols-1 gap-2 px-4 pb-3 sm:grid-cols-3">
        {resumo.map((g) => (
          <div key={g.classe} className="flex items-center gap-2 rounded-xl border border-ink-100 px-3 py-2">
            <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white', ABC_TONE[g.classe])}>{g.classe}</span>
            <div className="min-w-0">
              <p className="tabnums text-sm font-bold text-ink-800">{brl0(g.total)} <span className="text-xs font-medium text-ink-400">({g.share.toFixed(0)}%)</span></p>
              <p className="text-[11px] text-ink-400">{g.n} cliente(s)</p>
            </div>
          </div>
        ))}
      </div>
      {/* min-w: sem ele a tabela obedece ao container estreito e espreme as
          colunas até quebrar letra a letra — o overflow-x do Card nunca rola. */}
      <table className="w-full min-w-[560px] text-sm">
        <thead className="sticky top-0 z-10 [&>tr>th]:bg-surface">
          <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2">Cliente</th>
            <th className="px-4 py-2 text-right">Faturamento</th>
            <th className="px-4 py-2 text-right">Share</th>
            <th className="px-4 py-2 text-center">Classe</th>
          </tr>
        </thead>
        <tbody>
          {clientes.map((c) => (
            <tr key={c.company_id} className="border-b border-hairline last:border-0">
              <td className="px-4 py-2 font-medium text-ink-800">{c.nome_fantasia || c.razao_social}</td>
              <td className="tabnums px-4 py-2 text-right text-ink-700">{brl(c.total)}</td>
              <td className="tabnums px-4 py-2 text-right text-ink-500">{c.share}%</td>
              <td className="px-4 py-2 text-center">
                <span className={cn('inline-block h-6 w-6 rounded-full text-center text-xs font-bold leading-6 text-white', ABC_TONE[c.classe])}>{c.classe}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Cobertura({ ownerId }: { ownerId: 'todos' | number }): React.JSX.Element {
  const [municipios, setMunicipios] = useState<CoverageMun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  // território vem do filtro da tela de busca (mesma config da recomendação).
  const munis = loadTerritorioIds();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    if (munis.length === 0) { setMunicipios([]); setLoading(false); return; }
    const qs = new URLSearchParams(ownerQs(ownerId).slice(1));
    qs.set('munis', munis.join(','));
    void api.get<{ municipios: CoverageMun[] }>(`/api/reports/coverage?${qs.toString()}`)
      .then((r) => { if (!cancelled) setMunicipios(r.municipios); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Falha ao carregar cobertura.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // munis derivado de localStorage; recalcula por ownerId/quantidade de municípios.
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ownerId, munis.join(','), retryKey]);

  const center = useMemo<[number, number]>(() => {
    const m = municipios[0];
    return m ? [m.lat, m.lon] : [-15.78, -47.93];
  }, [municipios]);

  if (loading) return <Spinner />;
  if (error) return <ErrorState hint={error} onRetry={() => setRetryKey((v) => v + 1)} />;
  if (municipios.length === 0) {
    return <EmptyState icon="map" title="Sem território" hint="Defina os municípios no filtro da tela de Empresas recomendadas." />;
  }

  const totPot = municipios.reduce((s, m) => s + m.potencial, 0);
  const totCli = municipios.reduce((s, m) => s + m.clientes, 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">
        {municipios.length} município(s) · {totCli} cliente(s) de {totPot.toLocaleString('pt-BR')} empresas ativas
      </p>
      <Card className="overflow-hidden p-0">
        <div className="h-80 w-full">
          <MapContainer center={center} zoom={6} className="h-full w-full" scrollWheelZoom>
            <ThemedTileLayer />
            {municipios.map((m) => {
              const cobertura = m.potencial > 0 ? m.clientes / m.potencial : 0;
              const cor = m.clientes > 0 ? (cobertura >= 0.05 ? '#10b981' : '#f59e0b') : '#94a3b8';
              return (
                <CircleMarker key={m.id} center={[m.lat, m.lon]}
                  radius={Math.min(6 + Math.log10(m.potencial + 1) * 5, 26)}
                  pathOptions={{ color: cor, fillColor: cor, fillOpacity: 0.5, weight: 1.5 }}>
                  <Tooltip>{m.nome}/{m.uf}: {m.clientes} cliente(s) · {m.potencial} potenciais</Tooltip>
                </CircleMarker>
              );
            })}
          </MapContainer>
        </div>
      </Card>
    </div>
  );
}

function Descartes({ ownerId }: { ownerId: 'todos' | number }): React.JSX.Element {
  const [motivos, setMotivos] = useState<DescarteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api.get<{ motivos: DescarteRow[] }>(`/api/reports/descartes?${ownerQs(ownerId).slice(1)}`)
      .then((r) => { if (!cancelled) setMotivos(r.motivos); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Falha ao carregar perdas.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ownerId, retryKey]);

  if (loading) return <Spinner />;
  if (error) return <ErrorState hint={error} onRetry={() => setRetryKey((v) => v + 1)} />;
  if (motivos.length === 0) return <EmptyState icon="x" title="Sem perdas registradas" hint="Negócios descartados aparecem aqui por motivo." />;

  const total = motivos.reduce((s, m) => s + m.qtd, 0);
  const max = motivos.reduce((m, x) => Math.max(m, x.qtd), 0);

  return (
    <Card className="p-4">
      <p className="mb-3 text-sm text-ink-500">{total} negócio(s) descartado(s)</p>
      <div className="space-y-2">
        {motivos.map((m) => (
          <div key={m.motivo} className="flex items-center gap-3">
            <span className="w-44 shrink-0 truncate text-sm text-ink-700">{m.motivo}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
              <div className="h-full rounded-full bg-rose-400" style={{ width: `${max > 0 ? (m.qtd / max) * 100 : 0}%` }} />
            </div>
            <span className="tabnums w-10 shrink-0 text-right text-sm font-semibold text-ink-800">{m.qtd}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
