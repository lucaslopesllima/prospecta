// CompanyModal: modal só-leitura com todos os dados da empresa (RFB) + sócios,
// geolocalização (do banco ou sob demanda), telefone WhatsApp e dados brutos.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompanyModal } from '../src/lib/companyModal.tsx';
import { api, ApiError } from '../src/lib/api.ts';
import { toast } from '../src/lib/toast.tsx';
import type { CompanyDetail, Socio } from '../src/lib/types.ts';

vi.mock('../src/lib/api.ts', () => ({ api: { get: vi.fn(), post: vi.fn(), invalidate: vi.fn() }, ApiError: class extends Error { status: number; constructor(s: number, msg: string) { super(msg); this.status = s; } } }));
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const m = vi.mocked(api);

const company = (over: Partial<CompanyDetail> = {}): CompanyDetail => ({
  id: 1, cnpj: '11222333000144', razao_social: 'Alvo Comercio LTDA', nome_fantasia: 'Loja Alvo',
  cnae_principal: 4781400, cnae_descricao: 'Comércio varejista', cnae_secundarios: [4711301, 4712100],
  uf: 'SP', municipio_id: 100, cidade: 'São Paulo', regiao: 'Sudeste',
  porte: 'micro', capital_social: '100000', situacao_cadastral: 'Ativa', source: 'RFB',
  logradouro: 'Rua XV', numero: '100', complemento: 'Sala 2', bairro: 'Centro', cep: '01001000',
  telefone1: '1133334444', telefone2: '11', email: 'a@b.c', fax: '1133335555',
  data_inicio_atividade: '2010-05-01', matriz_filial: 1,
  natureza_juridica: 2062, natureza_descricao: 'Sociedade LTDA',
  qualificacao_responsavel: 49, qualificacao_descricao: 'Sócio-administrador',
  ente_federativo: null,
  motivo_situacao: 0, motivo_descricao: 'Sem motivo',
  data_situacao_cadastral: '2010-05-01', situacao_especial: null,
  data_situacao_especial: null,
  nome_cidade_exterior: null, pais: null, pais_nome: 'Brasil',
  opcao_simples: 'S', data_opcao_simples: '2011-01-01', data_exclusao_simples: null,
  opcao_mei: 'N', data_opcao_mei: null, data_exclusao_mei: null,
  lat: -23.5, lon: -46.6, raw_data: { extra: 'x' },
  geo_lat: -23.55, geo_lon: -46.63, geo_precisao: 'rua',
  ...over,
});

const socio = (over: Partial<Socio> = {}): Socio => ({
  identificador: 2, nome: 'João', cnpj_cpf: '***123***', qualificacao: 49,
  qualificacao_descricao: 'Sócio', data_entrada: '2010-05-01', faixa_etaria: 5,
  nome_representante: null, representante_legal: null, ...over,
});

beforeEach(() => {
  m.get.mockReset();
  m.post.mockReset();
  vi.mocked(toast.error).mockReset();
});

describe('CompanyModal', () => {
  it('erro no carregamento mostra mensagem', async () => {
    m.get.mockRejectedValue(new Error('falha'));
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    expect(await screen.findByText('Não foi possível carregar.')).toBeInTheDocument();
  });

  it('renderiza todos os dados com geo do banco e sócios', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company(), socios: [socio(), socio({ identificador: null, cnpj_cpf: null, data_entrada: null, faixa_etaria: null, nome_representante: 'Repr X', nome: null, qualificacao_descricao: null })] };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    expect(await screen.findByText('Alvo Comercio LTDA')).toBeInTheDocument();
    expect(screen.getByText('11.222.333/0001-44')).toBeInTheDocument(); // fmtCnpj 14 dígitos
    expect(screen.getByText('Matriz')).toBeInTheDocument();
    expect(screen.getByText('Sociedade LTDA')).toBeInTheDocument();
    expect(screen.getByText(/-23.55000, -46.63000/)).toBeInTheDocument(); // geo do banco
    expect(screen.getByText('Repr X', { exact: false })).toBeInTheDocument();
    // dados brutos (raw_data não vazio)
    expect(screen.getByText(/Dados brutos/)).toBeInTheDocument();
  });

  it('sem geo no banco geocodifica sob demanda; sócios vazios; filial; fallbacks', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return {
        company: company({
          geo_lat: null, geo_lon: null, geo_precisao: null, nome_fantasia: null,
          matriz_filial: 2, natureza_descricao: null, natureza_juridica: 2062,
          porte: 'desconhecido', cnae_secundarios: [], pais_nome: null, pais: 76,
          opcao_simples: 'N', opcao_mei: null, raw_data: {},
          motivo_descricao: null, motivo_situacao: 5,
          qualificacao_descricao: null, qualificacao_responsavel: 49,
          data_inicio_atividade: 'texto-nao-data', cnpj: '123',
        }),
        socios: [],
      };
      if (p === '/api/companies/1/geocode') return { geocode: { lat: -1, lon: -2, precisao: 'inexistente' } };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    expect(await screen.findByText('Filial')).toBeInTheDocument();
    expect(screen.getByText('Nenhum sócio informado.')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument(); // fmtCnpj não-14
    expect(screen.getByText('desconhecido')).toBeInTheDocument(); // PORTE_LABEL fallback
    await waitFor(() => expect(screen.getByText(/-1.00000, -2.00000/)).toBeInTheDocument());
    expect(screen.getByText(/inexistente/)).toBeInTheDocument(); // PRECISAO_LABEL fallback
    // sem raw_data
    expect(screen.queryByText(/Dados brutos/)).not.toBeInTheDocument();
  });

  it('geocode sob demanda que falha é ignorado (fica "localizando…")', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company({ geo_lat: null, geo_lon: null }), socios: [] };
      if (p === '/api/companies/1/geocode') throw new Error('geo falhou');
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    expect(await screen.findByText('localizando…')).toBeInTheDocument();
  });

  it('telefone abre WhatsApp; erro dispara toast', async () => {
    const orig = window.location;
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: '' } });
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company({ telefone2: null, fax: null }), socios: [] };
      return {};
    });
    m.post.mockResolvedValueOnce({ chat: { id: 7 } });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    await screen.findByText('Alvo Comercio LTDA');
    const waBtn = screen.getByTitle('Abrir conversa no WhatsApp');
    await userEvent.click(waBtn);
    await waitFor(() => expect(window.location.href).toBe('/whatsapp?chat=7'));

    m.post.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await userEvent.click(screen.getByTitle('Abrir conversa no WhatsApp'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: orig });
  });

  it('telefone curto (sem waLink) mostra texto sem botão', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company({ telefone1: '123', telefone2: null }), socios: [] };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    await screen.findByText('Alvo Comercio LTDA');
    expect(screen.queryByTitle('Abrir conversa no WhatsApp')).not.toBeInTheDocument();
  });

  // Conferência no WhatsApp (GET /api/companies/:id/whatsapp), disparada ao abrir.
  // Só o veredito `false` tira o atalho de conversa — pendente segura o link e
  // indeterminado (falha/Evolution fora) o mantém como sempre foi.
  it('enquanto confere mostra loading e não oferece o atalho', async () => {
    let liberar!: (v: unknown) => void;
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company({ telefone2: null }), socios: [] };
      if (p === '/api/companies/1/whatsapp') return new Promise((res) => { liberar = res; });
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    expect(await screen.findByText('conferindo WhatsApp…')).toBeInTheDocument();
    expect(screen.queryByTitle('Abrir conversa no WhatsApp')).not.toBeInTheDocument();

    liberar({ whatsapp: { telefone1: true, telefone2: null } });
    expect(await screen.findByTitle('Abrir conversa no WhatsApp')).toBeInTheDocument();
    expect(screen.queryByText('conferindo WhatsApp…')).not.toBeInTheDocument();
  });

  it('número que não está no WhatsApp perde o link', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company({ telefone2: null, fax: null }), socios: [] };
      if (p === '/api/companies/1/whatsapp') return { whatsapp: { telefone1: false, telefone2: null } };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    expect(await screen.findByText('sem WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('(11) 33334444')).toBeInTheDocument(); // o número continua visível
    expect(screen.queryByTitle('Abrir conversa no WhatsApp')).not.toBeInTheDocument();
  });

  it('conferência indeterminada (ou que falha) mantém o atalho', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company({ telefone2: null, fax: null }), socios: [] };
      if (p === '/api/companies/1/whatsapp') throw new Error('rede caiu');
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    await screen.findByText('Alvo Comercio LTDA');
    await waitFor(() => expect(screen.getByTitle('Abrir conversa no WhatsApp')).toBeInTheDocument());
    expect(screen.queryByText('sem WhatsApp')).not.toBeInTheDocument();
  });

  it('fecha no backdrop, no X e não fecha ao clicar no corpo', async () => {
    const onClose = vi.fn();
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company(), socios: [] };
      return {};
    });
    const { container } = render(<CompanyModal companyId={1} onClose={onClose} />);
    await screen.findByText('Alvo Comercio LTDA');
    // clique no corpo interno não fecha (stopPropagation)
    await userEvent.click(screen.getByText('Alvo Comercio LTDA'));
    expect(onClose).not.toHaveBeenCalled();
    // X fecha
    await userEvent.click(screen.getByRole('button', { name: '' }).closest('button')!);
    // backdrop fecha
    await userEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalled();
  });
});
