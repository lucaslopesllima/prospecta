import { useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import type { CompanyDetail, Socio } from './types.ts';
import { Modal, SafeButton, Spinner } from './ui.tsx';
import { Icon } from './icons.tsx';
import { Cnae, seedCnae } from './cnae.tsx';
import { waLink, maskPhone } from './format.ts';
import { toast } from './toast.tsx';
import { EntityLabels } from './privateLabelPicker.tsx';
import { NewContactModal, EMPTY_CONTACT, type ContactForm } from './contactForm.tsx';

// Modal só-leitura com TODOS os dados da empresa no banco (RFB) + quadro societário.
const PORTE_LABEL: Record<string, string> = {
  nao_informado: 'Não informado', micro: 'Microempresa', pequeno: 'Pequeno porte', demais: 'Demais',
};
const FAIXA_ETARIA: Record<number, string> = {
  1: '0 a 12', 2: '13 a 20', 3: '21 a 30', 4: '31 a 40', 5: '41 a 50',
  6: '51 a 60', 7: '61 a 70', 8: '71 a 80', 9: 'Mais de 80',
};
const SOCIO_TIPO: Record<number, string> = { 1: 'Pessoa jurídica', 2: 'Pessoa física', 3: 'Estrangeiro' };
const PRECISAO_LABEL: Record<string, string> = {
  rua: 'endereço', rua_aprox: 'rua (aprox.)', cep: 'CEP', municipio: 'município',
};

const fmtCnpj = (s: string): string =>
  s.length === 14 ? s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : s;
const fmtBrl = (n: number): string => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCep = (s: string): string => (s.length === 8 ? s.replace(/^(\d{5})(\d{3})$/, '$1-$2') : s);
const fmtData = (s: string | null): string | null =>
  s ? (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).split('-').reverse().join('/') : s) : null;
const fmtSimNao = (s: string | null): string | null => (s === 'S' ? 'Sim' : s === 'N' ? 'Não' : null);
// Máscara padrão do app (format.ts): (11) 3333-4444 / (11) 93333-4444, com DDI
// 55 removido. Abaixo de 10 dígitos não é telefone — mostra como veio da RFB em
// vez de inventar um formato.
const fmtTel = (s: string | null): string | null => {
  if (!s) return null;
  return s.replace(/\D/g, '').length >= 10 ? maskPhone(s) : s;
};
function fmtEndereco(c: CompanyDetail): string {
  const linha1 = [c.logradouro, c.numero].filter(Boolean).join(', ');
  const partes = [linha1, c.complemento, c.bairro, c.cep ? `CEP ${fmtCep(c.cep)}` : null].filter(Boolean);
  return partes.join(' · ');
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col border-b border-ink-100 py-2 last:border-0 sm:flex-row sm:gap-3">
      <span className="w-44 shrink-0 text-xs font-medium text-ink-400">{label}</span>
      <span className="text-sm text-ink-700">{value || <span className="text-ink-300">—</span>}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-4 first:mt-0">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      {children}
    </div>
  );
}

function SociosBloco({ socios }: { socios: Socio[] }): React.JSX.Element {
  if (!socios.length) return <p className="text-sm text-ink-300">Nenhum sócio informado.</p>;
  return (
    <div className="divide-y divide-ink-100">
      {socios.map((s, i) => (
        <div key={i} className="py-2">
          <p className="text-sm font-medium text-ink-700">{s.nome || '—'}</p>
          <p className="text-xs text-ink-400">
            {[s.qualificacao_descricao,
              s.identificador != null ? SOCIO_TIPO[s.identificador] : null,
              s.cnpj_cpf || null,
              s.data_entrada ? `desde ${fmtData(s.data_entrada)}` : null,
              s.faixa_etaria ? `${FAIXA_ETARIA[s.faixa_etaria] ?? ''} anos` : null,
            ].filter(Boolean).join(' · ')}
          </p>
          {s.nome_representante && (
            <p className="text-xs text-ink-400">Repr.: {s.nome_representante}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// Veredito da conferência no WhatsApp por telefone. null = indeterminado
// (Evolution fora do ar, desligada ou org demo) — nesse caso o atalho de
// conversa continua como sempre foi; só `false` tira o link.
type WaCheck = { telefone1: boolean | null; telefone2: boolean | null };

// Quantas empresas (CNPJ raiz distinto) usam o mesmo contato. Só vem preenchido
// acima do limite do servidor; null = contato exclusivo desta empresa.
type Compartilhado = { telefone1: number | null; telefone2: number | null; email: number | null };
// Resposta de /api/companies/:id/dominio. 'indeterminado' = o registro.br não
// respondeu o titular (cota por IP); não é o mesmo que "a empresa não tem site".
type SiteBusca = {
  dominio: string | null;
  status: 'achou' | 'nao_encontrado' | 'indeterminado';
  // site_url é a URL que o domínio serve de fato (www/http certos, pós-redirect).
  // Domínio confirmado sem site_url = registrado só para e-mail ou fora do ar.
  site_url: string | null;
  site_status: 'vivo' | 'bloqueado' | 'sem_pagina' | 'sem_dns' | null;
  // 100 = CNPJ do titular confirmado no registro.br. 70 = domínio do e-mail que
  // a empresa declarou à Receita, fora do .br, que o registro.br não verifica.
  // 40 = site da MARCA que a empresa opera, registrado por outro CNPJ.
  confianca: number;
  fonte: string;
  // Preenchido só quando fonte === 'marca': o nome de quem registrou o domínio.
  titular: string | null;
};

const SEM_SITE: Record<string, string> = {
  sem_dns: 'domínio registrado, sem site publicado',
  sem_pagina: 'domínio registrado, site fora do ar',
};

// Contato publicado no site da empresa. NÃO está no banco: vem da raspagem e só
// vira registro se o representante clicar "adicionar aos contatos". Por isso a
// lista não tem id — a identidade dela é o próprio valor.
type ContatoSite = {
  nome: string | null;
  cargo: string | null;
  rotulo: string | null;   // setor/unidade a que o contato pertence
  email: string | null;
  telefone: string | null; // dígitos com DDD, sem o 55
  whatsapp: string | null;
  origem: string;          // página onde apareceu
};
// bloqueado = o site respondeu barrando robô (WAF). Lista vazia aí NÃO é
// "empresa sem contato publicado" — é "não deu para ler", e a tela tem que
// dizer a diferença. colcci.com.br devolve 403 com página de desafio.
type BuscaContatosSite = { contatos: ContatoSite[]; paginas: string[]; bloqueado: boolean };

// "i" ao lado do contato que se repete em várias empresas: quase sempre é o
// telefone/e-mail do escritório de contabilidade, não de quem decide a compra.
function AvisoContabilidade({ empresas }: { empresas: number }): React.JSX.Element {
  return (
    <span title={`Provável contato de contabilidade — aparece em ${empresas} empresas diferentes.`}
      className="inline-flex items-center gap-1 text-amber-600">
      <Icon name="info" size={13} />
      <span className="text-xs">provável contabilidade</span>
    </span>
  );
}

export function CompanyModal({ companyId, onClose }: { companyId: number; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<CompanyDetail | null>(null);
  const [socios, setSocios] = useState<Socio[]>([]);
  const [geo, setGeo] = useState<{ lat: number; lon: number; precisao: string } | null>(null);
  const [wa, setWa] = useState<WaCheck | null>(null);
  const [waPend, setWaPend] = useState(true);
  const [shared, setShared] = useState<Compartilhado | null>(null);
  const [err, setErr] = useState(false);
  // Site: diferente do WhatsApp e do geocode, NÃO dispara ao abrir o modal. A
  // busca no registro.br leva alguns segundos e consome uma cota por IP que é
  // compartilhada por todos os usuários — só sai com clique explícito.
  const [site, setSite] = useState<SiteBusca | null>(null);
  const [sitePend, setSitePend] = useState(false);
  // Contatos raspados do site. Também só com clique: são vários fetchs no
  // servidor da empresa. Nada disso é gravado — quem grava é o "adicionar".
  const [contatos, setContatos] = useState<BuscaContatosSite | null>(null);
  const [contatosPend, setContatosPend] = useState(false);
  const [novoContato, setNovoContato] = useState<ContactForm | null>(null);

  useEffect(() => {
    setData(null); setSocios([]); setGeo(null); setShared(null); setErr(false);
    setSite(null); setSitePend(false);
    setContatos(null); setContatosPend(false); setNovoContato(null);
    // Conferência dispara junto com o carregamento (não depende dos dados na
    // tela: o servidor lê os telefones da empresa). Falha vira indeterminado.
    setWa(null); setWaPend(true);
    void api.get<{ whatsapp: WaCheck }>(`/api/companies/${companyId}/whatsapp`)
      .then((r) => setWa(r.whatsapp))
      .catch(() => undefined)
      .finally(() => setWaPend(false));
    void api.get<{ company: CompanyDetail; socios: Socio[]; compartilhado?: Compartilhado }>(`/api/companies/${companyId}`)
      .then((r) => {
        setData(r.company); setSocios(r.socios ?? []); setShared(r.compartilhado ?? null);
        seedCnae(r.company.cnae_principal, r.company.cnae_descricao); // já temos a descrição
        if (r.company.geo_lat != null && r.company.geo_lon != null) {
          setGeo({ lat: r.company.geo_lat, lon: r.company.geo_lon, precisao: r.company.geo_precisao ?? 'rua' });
        } else {
          // geocodifica o endereço sob demanda (cacheia no banco)
          void api.get<{ geocode: { lat: number; lon: number; precisao: string } }>(`/api/companies/${companyId}/geocode`)
            .then((gr) => setGeo(gr.geocode)).catch(() => undefined);
        }
      }).catch(() => setErr(true));
  }, [companyId]);

  const raw = data?.raw_data && Object.keys(data.raw_data).length > 0 ? data.raw_data : null;

  // Telefone formatado que abre a conversa direto na tela do WhatsApp (cria/vincula
  // o chat pela empresa), mesmo comportamento do funil — não usa mais o wa.me externo.
  //
  // O atalho só some quando a conferência afirma que o número NÃO está no
  // WhatsApp. Enquanto ela roda, o telefone aparece sem link (com o indicador);
  // se ela não conseguir responder, o link fica como sempre foi.
  const telWa = (s: string | null, campo: keyof WaCheck): React.ReactNode => {
    const fmt = fmtTel(s);
    if (!fmt) return null;
    if (!waLink(s)) return fmt;
    if (waPend) {
      return (
        <span className="inline-flex items-center gap-1.5 text-ink-700">
          {fmt}
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
          <span className="text-xs text-ink-400">conferindo WhatsApp…</span>
        </span>
      );
    }
    if (wa?.[campo] === false) {
      return (
        <span className="inline-flex items-center gap-1.5 text-ink-700">
          {fmt}<span className="text-xs text-ink-300">sem WhatsApp</span>
        </span>
      );
    }
    return (
      <SafeButton type="button" title="Abrir conversa no WhatsApp"
        onClick={() =>
          api.post<{ chat: { id: number } }>('/api/whatsapp/chats/from-company', { company_id: companyId, numero: s! })
            .then((r) => { window.location.href = `/whatsapp?chat=${r.chat.id}`; })
            .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Falha ao abrir WhatsApp'))
        }
        className="inline-flex items-center gap-1 text-emerald-600 hover:underline">
        {fmt}<Icon name="whatsapp" size={13} />
      </SafeButton>
    );
  };

  const buscarSite = (): void => {
    setSitePend(true);
    void api.get<{ dominio: SiteBusca }>(`/api/companies/${companyId}/dominio`)
      .then((r) => setSite(r.dominio))
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Falha ao buscar o site'))
      .finally(() => setSitePend(false));
  };

  const buscarContatos = (): void => {
    if (!site?.site_url) return;
    setContatosPend(true);
    void api.get<BuscaContatosSite>(
      `/api/companies/${companyId}/contatos-site?site_url=${encodeURIComponent(site.site_url)}`,
    )
      .then(setContatos)
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Falha ao ler o site'))
      .finally(() => setContatosPend(false));
  };

  // Pré-preenche o cadastro de contato padrão, com a empresa já selecionada.
  // Contato institucional (sem nome próprio) entra com o rótulo do setor no
  // nome — "Departamento Vendas" é o que o representante reconhece na lista
  // depois; deixar em branco travaria o formulário, que exige nome.
  const paraForm = (c: ContatoSite): ContactForm => {
    const empresa = data ? data.nome_fantasia || data.razao_social : null;
    const tel = c.whatsapp ?? c.telefone;
    return {
      ...EMPTY_CONTACT,
      nome: c.nome ?? c.rotulo ?? empresa ?? '',
      cargo: (c.nome ? c.cargo ?? c.rotulo : c.cargo) ?? '',
      email: c.email ?? '',
      telefone: tel ? maskPhone(tel) : '',
      company_id: companyId,
      company_name: empresa,
    };
  };

  // 4 estados: não buscado / buscando / achou / não deu. 'indeterminado' é o
  // registro.br tendo censurado a consulta por cota — é diferente de "não tem
  // site" e por isso oferece tentar de novo em vez de afirmar a ausência.
  const linhaSite = (): React.ReactNode => {
    if (sitePend) {
      return (
        <span className="inline-flex items-center gap-1.5 text-ink-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
          <span className="text-xs">procurando no registro.br…</span>
        </span>
      );
    }
    // Domínio confirmado e servindo página: é o site, abre direto. 'bloqueado'
    // (WAF barrou nossa sondagem) também abre — no navegador do usuário funciona.
    if (site?.site_url) {
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <a href={site.site_url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline">
            {site.dominio}
          </a>
          {/* O domínio é de OUTRO CNPJ: é o site da marca que a empresa opera,
              não o dela. Dizer de quem é evita que o representante ache que
              está falando com a loja quando abrir os contatos de lá. */}
          {site.fonte === 'marca' ? (
            <span className="text-xs text-amber-600"
              title={`Domínio registrado por ${site.titular ?? 'outra empresa'}, confirmado no registro.br. A empresa opera a marca; o site não é dela.`}>
              site da marca{site.titular ? ` · ${site.titular}` : ''}
            </span>
          ) : site.confianca < 100 && (
            <span className="text-xs text-ink-400" title="Domínio do e-mail declarado na Receita; o registro.br não confirma titularidade fora do .br">
              não confirmado
            </span>
          )}
        </span>
      );
    }
    // Domínio confirmado mas sem site: mostra o domínio (serve de pista para o
    // e-mail: contato@dominio) e explica por que não há link.
    if (site?.dominio) {
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-ink-700">{site.dominio}</span>
          <span className="text-xs text-ink-400">
            {SEM_SITE[site.site_status ?? ''] ?? 'sem site confirmado'}
          </span>
        </span>
      );
    }
    const rotulo = site === null ? 'buscar site'
      : site.status === 'indeterminado' ? 'tentar de novo' : 'buscar de novo';
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {site?.status === 'nao_encontrado' && <span className="text-xs text-ink-300">nenhum site encontrado</span>}
        {site?.status === 'indeterminado' && (
          <span className="text-xs text-amber-600">o registro.br não confirmou agora</span>
        )}
        <SafeButton type="button" onClick={buscarSite}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
          <Icon name="search" size={12} />{rotulo}
        </SafeButton>
      </span>
    );
  };

  // Contato + o aviso de contabilidade, quando o valor se repete em outras
  // empresas. Sem o dado (script ainda não rodou) a linha fica como antes.
  const comAviso = (node: React.ReactNode, empresas: number | null | undefined): React.ReactNode => {
    if (!node) return node;
    if (empresas == null) return node;
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {node}<AvisoContabilidade empresas={empresas} />
      </span>
    );
  };

  // Lista raspada do site. Cada linha vira contato só se o usuário mandar; o
  // botão abre o cadastro de sempre, já com a empresa e os canais preenchidos.
  const blocoContatosSite = (): React.ReactNode => {
    if (contatosPend) {
      return (
        <span className="inline-flex items-center gap-1.5 text-ink-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
          <span className="text-xs">lendo as páginas de contato do site…</span>
        </span>
      );
    }
    if (!contatos) {
      return (
        <SafeButton type="button" onClick={buscarContatos}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
          <Icon name="search" size={12} />buscar contatos no site
        </SafeButton>
      );
    }
    if (contatos.contatos.length === 0) {
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {/* Distinguir "não tem" de "não deixou ler" é o ponto: o site pode
              estar cheio de contatos e só bloquear robô. Aí o caminho é abrir. */}
          {contatos.bloqueado ? (
            <span className="text-xs text-amber-600">
              o site bloqueia leitura automática — abra o site para ver os contatos
            </span>
          ) : (
            <span className="text-xs text-ink-300">
              nada publicado nas {contatos.paginas.length} página(s) lidas
            </span>
          )}
          <SafeButton type="button" onClick={buscarContatos}
            className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
            <Icon name="search" size={12} />buscar de novo
          </SafeButton>
        </span>
      );
    }
    return (
      <div className="divide-y divide-ink-100">
        {contatos.contatos.map((c, i) => (
          <div key={`${c.email ?? ''}|${c.telefone ?? ''}|${c.whatsapp ?? ''}|${i}`}
            className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-700">{c.nome ?? c.rotulo ?? 'Contato'}</p>
              <p className="text-xs text-ink-400">
                {[
                  c.nome ? c.cargo ?? c.rotulo : c.cargo,
                  c.email,
                  c.telefone ? maskPhone(c.telefone) : null,
                  c.whatsapp ? `${maskPhone(c.whatsapp)} (WhatsApp)` : null,
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <SafeButton type="button" title="Adicionar aos contatos" onClick={() => setNovoContato(paraForm(c))}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-xs text-brand-600 transition hover:bg-ink-50">
              <Icon name="plus" size={12} />adicionar
            </SafeButton>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
    <Modal onClose={onClose} width="xl"
      title={<span className="inline-flex items-center gap-2"><Icon name="building" size={17} className="text-ink-400" /> Dados da empresa</span>}>
        <div className="py-1">
          {err ? (
            <p className="py-8 text-center text-sm text-ink-400">Não foi possível carregar.</p>
          ) : !data ? (
            <div className="py-8"><Spinner /></div>
          ) : (
            <>
              <Section title="Identificação">
                <InfoRow label="Razão social" value={data.razao_social} />
                <InfoRow label="Nome fantasia" value={data.nome_fantasia} />
                <InfoRow label="CNPJ" value={fmtCnpj(data.cnpj)} />
                <InfoRow label="Matriz / Filial" value={data.matriz_filial === 1 ? 'Matriz' : data.matriz_filial === 2 ? 'Filial' : null} />
                <InfoRow label="Natureza jurídica" value={data.natureza_descricao ?? (data.natureza_juridica?.toString() || null)} />
                <InfoRow label="Porte" value={PORTE_LABEL[data.porte] ?? data.porte} />
                <InfoRow label="Capital social" value={fmtBrl(Number(data.capital_social))} />
              </Section>

              <Section title="Atividade">
                <InfoRow label="CNAE principal" value={<Cnae code={data.cnae_principal} full />} />
                <InfoRow label="CNAEs secundários" value={data.cnae_secundarios?.length
                  ? <span className="flex flex-col gap-y-1">{data.cnae_secundarios.map((cod) => <Cnae key={cod} code={cod} full />)}</span>
                  : null} />
                <InfoRow label="Início de atividade" value={fmtData(data.data_inicio_atividade)} />
              </Section>

              <Section title="Endereço">
                <InfoRow label="Endereço" value={fmtEndereco(data)} />
                <InfoRow label="Cidade / UF" value={[data.cidade, data.uf].filter(Boolean).join(' · ')} />
                <InfoRow label="Região" value={data.regiao} />
                <InfoRow label="Cidade exterior" value={data.nome_cidade_exterior} />
                <InfoRow label="País" value={data.pais_nome ?? (data.pais?.toString() || null)} />
                <InfoRow label="Localização" value={geo
                  ? `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} · ${PRECISAO_LABEL[geo.precisao] ?? geo.precisao}`
                  : <span className="text-ink-300">localizando…</span>} />
              </Section>

              <Section title="Contato">
                <InfoRow label="Telefone 1" value={comAviso(telWa(data.telefone1, 'telefone1'), shared?.telefone1)} />
                <InfoRow label="Telefone 2" value={comAviso(telWa(data.telefone2, 'telefone2'), shared?.telefone2)} />
                <InfoRow label="Fax" value={fmtTel(data.fax)} />
                <InfoRow label="E-mail" value={comAviso(data.email, shared?.email)} />
                <InfoRow label="Site" value={linhaSite()} />
              </Section>

              {/* Só faz sentido com site no ar: a raspagem lê páginas dele. */}
              {site?.site_url && (
                <Section title="Contatos no site">
                  {/* Site da marca: quem atende ali é o dono da marca, não esta
                      empresa. Sem este aviso o representante ligaria para a
                      fábrica achando que fala com a loja. */}
                  {site.fonte === 'marca' && (
                    <p className="mb-1.5 text-xs text-amber-600">
                      São contatos de {site.titular ?? 'quem registrou o domínio'}, dona da marca — não da empresa aberta.
                    </p>
                  )}
                  {blocoContatosSite()}
                </Section>
              )}

              {/* EntityLabels se auto-oculta se a API negar (sem permissão) —
                  por isso este bloco não consulta o contexto de auth: o modal é
                  reaproveitado em telas/testes montados fora do AuthProvider. */}
              <EntityLabels kind="company" id={companyId} title="Private labels" />


              <Section title="Situação cadastral">
                <InfoRow label="Situação" value={data.situacao_cadastral} />
                <InfoRow label="Data da situação" value={fmtData(data.data_situacao_cadastral)} />
                <InfoRow label="Motivo" value={data.motivo_descricao ?? (data.motivo_situacao?.toString() || null)} />
                <InfoRow label="Situação especial" value={data.situacao_especial} />
                <InfoRow label="Data sit. especial" value={fmtData(data.data_situacao_especial)} />
              </Section>

              <Section title="Tributário">
                <InfoRow label="Opção Simples" value={fmtSimNao(data.opcao_simples)} />
                <InfoRow label="Entrada Simples" value={fmtData(data.data_opcao_simples)} />
                <InfoRow label="Saída Simples" value={fmtData(data.data_exclusao_simples)} />
                <InfoRow label="MEI" value={fmtSimNao(data.opcao_mei)} />
                <InfoRow label="Entrada MEI" value={fmtData(data.data_opcao_mei)} />
                <InfoRow label="Saída MEI" value={fmtData(data.data_exclusao_mei)} />
              </Section>

              <Section title={`Quadro societário${socios.length ? ` (${socios.length})` : ''}`}>
                <SociosBloco socios={socios} />
              </Section>

              <Section title="Outros">
                <InfoRow label="Resp. (qualificação)" value={data.qualificacao_descricao ?? (data.qualificacao_responsavel?.toString() || null)} />
                <InfoRow label="Ente federativo" value={data.ente_federativo} />
                <InfoRow label="Fonte" value={data.source} />
              </Section>

              {raw && (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Dados brutos (RFB)</p>
                  <pre className="overflow-x-auto rounded-xl bg-ink-50 p-3 text-xs text-ink-600">{JSON.stringify(raw, null, 2)}</pre>
                </div>
              )}
            </>
          )}
        </div>
    </Modal>
    {/* Irmão, não filho: dentro do overlay da empresa o clique no cadastro
        subiria até ele e fecharia os dois modais de uma vez. */}
    {novoContato && <NewContactModal initial={novoContato} onClose={() => setNovoContato(null)} />}
    </>
  );
}
