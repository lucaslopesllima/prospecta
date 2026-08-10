// CompanyModal: modal só-leitura com todos os dados da empresa (RFB) + sócios,
// geolocalização (do banco ou sob demanda), telefone WhatsApp e dados brutos.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    expect(screen.getByText('(11) 3333-4444')).toBeInTheDocument(); // o número continua visível
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

  // Aviso de contabilidade: o servidor manda em quantas empresas o contato se
  // repete; sem o dado (script de carga ainda não rodou) nada é sinalizado.
  it('contato repetido em outras empresas ganha o aviso de contabilidade', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return {
        company: company({ telefone2: null, fax: null }), socios: [],
        compartilhado: { telefone1: 37, telefone2: null, email: 52 },
      };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    await screen.findByText('Alvo Comercio LTDA');
    expect(screen.getAllByText('provável contabilidade')).toHaveLength(2); // telefone1 + e-mail
    expect(screen.getAllByTitle(/aparece em 37 empresas diferentes/)[0]).toBeInTheDocument();
  });

  it('sem dado de contato compartilhado não mostra aviso', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company(), socios: [] }; // sem `compartilhado`
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    await screen.findByText('Alvo Comercio LTDA');
    expect(screen.queryByText('provável contabilidade')).not.toBeInTheDocument();
  });

  it('telefone sai mascarado no padrão BR', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return {
        company: company({ telefone1: '11933334444', telefone2: '1133334444', fax: null }), socios: [],
      };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={vi.fn()} />);
    await screen.findByText('Alvo Comercio LTDA');
    expect(screen.getByText('(11) 93333-4444')).toBeInTheDocument(); // celular
    expect(screen.getByText('(11) 3333-4444')).toBeInTheDocument();  // fixo
  });

  // Raspagem dos contatos publicados no site. Depende do site já descoberto, e
  // nada do que ela devolve é gravado: só o que o usuário mandar adicionar.
  describe('contatos no site', () => {
    const SITE = {
      dominio: 'alvo.com.br', status: 'achou', site_url: 'https://www.alvo.com.br/',
      site_status: 'vivo', confianca: 100, fonte: 'registrobr', titular: null,
    };
    const CONTATOS = {
      contatos: [
        {
          nome: 'Silvio Zanon', cargo: 'Gerente', rotulo: 'Departamento Técnico',
          email: 'silvio@alvo.com.br', telefone: '4935417021', whatsapp: '49988321048',
          origem: 'https://www.alvo.com.br/contato',
        },
        {
          nome: null, cargo: null, rotulo: 'Departamento Vendas',
          email: 'vendas@alvo.com.br', telefone: null, whatsapp: null,
          origem: 'https://www.alvo.com.br/contato',
        },
      ],
      paginas: ['https://www.alvo.com.br/', 'https://www.alvo.com.br/contato'],
      bloqueado: false,
    };

    const abrirComSite = async (contatos: unknown = CONTATOS, site: unknown = SITE): Promise<void> => {
      m.get.mockImplementation(async (p: string) => {
        if (p === '/api/companies/1') return { company: company(), socios: [] };
        if (p === '/api/companies/1/dominio') return { dominio: site };
        if (p === '/api/companies/1/contatos-site') {
          if (contatos instanceof Error) throw contatos;
          return contatos;
        }
        return {};
      });
      render(<CompanyModal companyId={1} onClose={vi.fn()} />);
      await screen.findByText('Alvo Comercio LTDA');
      await userEvent.click(screen.getByText('buscar site'));
      await screen.findByText((site as { dominio: string }).dominio);
    };

    it('o botão só existe depois de achar o site', async () => {
      m.get.mockImplementation(async (p: string) =>
        (p === '/api/companies/1' ? { company: company(), socios: [] } : {}));
      render(<CompanyModal companyId={1} onClose={vi.fn()} />);
      await screen.findByText('Alvo Comercio LTDA');
      expect(screen.queryByText('buscar contatos no site')).not.toBeInTheDocument();
    });

    it('lista os contatos raspados, com pessoa e setor', async () => {
      await abrirComSite();
      await userEvent.click(screen.getByText('buscar contatos no site'));
      expect(await screen.findByText('Silvio Zanon')).toBeInTheDocument();
      expect(screen.getByText(/Gerente · silvio@alvo\.com\.br/)).toBeInTheDocument();
      // telefone e WhatsApp saem mascarados, e o WhatsApp identificado
      expect(screen.getByText(/\(49\) 3541-7021 · \(49\) 98832-1048 \(WhatsApp\)/)).toBeInTheDocument();
      // contato institucional entra pelo rótulo do setor
      expect(screen.getByText('Departamento Vendas')).toBeInTheDocument();
      expect(screen.getAllByText('adicionar')).toHaveLength(2);
    });

    it('adicionar abre o cadastro já com a empresa e os canais preenchidos', async () => {
      await abrirComSite();
      await userEvent.click(screen.getByText('buscar contatos no site'));
      await screen.findByText('Silvio Zanon');
      await userEvent.click(screen.getAllByText('adicionar')[0]!);

      expect(await screen.findByText('Novo contato')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Nome *')).toHaveValue('Silvio Zanon');
      expect(screen.getByPlaceholderText('Cargo (ex.: Comprador)')).toHaveValue('Gerente');
      expect(screen.getByPlaceholderText('E-mail')).toHaveValue('silvio@alvo.com.br');
      // WhatsApp na frente do fixo: é por onde o representante fala
      expect(screen.getByPlaceholderText('Telefone')).toHaveValue('(49) 98832-1048');
      // empresa já selecionada, sem passar pela busca ("Loja Alvo" também está
      // na ficha atrás, então a checagem é dentro do chip do formulário)
      const chip = screen.getByLabelText('Remover empresa').parentElement!;
      expect(within(chip).getByText('Loja Alvo')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/Empresa-prospect/)).not.toBeInTheDocument();
    });

    it('contato sem nome próprio entra com o setor no nome', async () => {
      await abrirComSite();
      await userEvent.click(screen.getByText('buscar contatos no site'));
      await screen.findByText('Departamento Vendas');
      await userEvent.click(screen.getAllByText('adicionar')[1]!);
      expect(await screen.findByText('Novo contato')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Nome *')).toHaveValue('Departamento Vendas');
      expect(screen.getByPlaceholderText('E-mail')).toHaveValue('vendas@alvo.com.br');
    });

    it('site sem contato publicado diz quantas páginas leu e oferece repetir', async () => {
      await abrirComSite({ contatos: [], paginas: ['https://www.alvo.com.br/'], bloqueado: false });
      await userEvent.click(screen.getByText('buscar contatos no site'));
      expect(await screen.findByText(/nada publicado nas 1 página\(s\) lidas/)).toBeInTheDocument();
      expect(screen.getByText('buscar de novo')).toBeInTheDocument();
    });

    // colcci.com.br: 403 com página de WAF. Dizer "nada publicado" mandaria o
    // representante embora de um site que tem os contatos todos lá.
    it('site que barra robô não é anunciado como "sem contato"', async () => {
      await abrirComSite({ contatos: [], paginas: [], bloqueado: true });
      await userEvent.click(screen.getByText('buscar contatos no site'));
      expect(await screen.findByText(/bloqueia leitura automática/)).toBeInTheDocument();
      expect(screen.queryByText(/nada publicado/)).not.toBeInTheDocument();
    });

    // Loja franqueada COLCCI: colcci.com.br é da AMC TEXTIL. A ficha mostra o
    // site, mas dizendo de quem é — senão o representante liga para a fábrica
    // achando que fala com a loja.
    it('site da marca é rotulado, com o titular', async () => {
      await abrirComSite(CONTATOS, {
        ...SITE, dominio: 'colcci.com.br', site_url: 'https://colcci.com.br/',
        fonte: 'marca', confianca: 40, titular: 'AMC TEXTIL LTDA',
      });
      expect(screen.getByText(/site da marca · AMC TEXTIL LTDA/)).toBeInTheDocument();
      expect(screen.queryByText('não confirmado')).not.toBeInTheDocument();
      // e o aviso acompanha a lista de contatos
      expect(screen.getByText(/contatos de AMC TEXTIL LTDA, dona da marca/i)).toBeInTheDocument();
    });

    it('falha na raspagem vira toast, sem quebrar o modal', async () => {
      await abrirComSite(new Error('site fora do ar'));
      await userEvent.click(screen.getByText('buscar contatos no site'));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(screen.getByText('buscar contatos no site')).toBeInTheDocument();
    });
  });

  it('fecha no backdrop, no X e não fecha ao clicar no corpo', async () => {
    const onClose = vi.fn();
    m.get.mockImplementation(async (p: string) => {
      if (p === '/api/companies/1') return { company: company(), socios: [] };
      return {};
    });
    render(<CompanyModal companyId={1} onClose={onClose} />);
    await screen.findByText('Alvo Comercio LTDA');
    // clique no corpo interno não fecha (stopPropagation)
    await userEvent.click(screen.getByText('Alvo Comercio LTDA'));
    expect(onClose).not.toHaveBeenCalled();
    // X fecha (o Modal compartilhado dá aria-label ao botão — antes era anônimo)
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    // backdrop fecha; o role=dialog fica no painel interno acessível.
    await userEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalled();
  });
});
