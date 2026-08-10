// Pedidos: lista + KPIs, filtros, criação com tabela de preço vigente,
// transições de status (faturar pede NF), exclusão e importação CSV (admin).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Orders } from '../src/pages/Orders.tsx';
import { api } from '../src/lib/api.ts';
import { useAuth, type User } from '../src/lib/auth.tsx';
import { confirmDialog } from '../src/lib/confirm.ts';
import { downloadCsv } from '../src/lib/export.ts';
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn() }));
vi.mock('../src/lib/export.ts', () => ({ downloadCsv: vi.fn() }));

vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/auth.tsx', () => {
  const useAuth = vi.fn();
  return { useAuth, useOptionalUser: () => useAuth().user ?? null };
});
const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);

const admin: User = { id: 1, email: 'a@b.c', role: 'admin', org_id: 1, org_nome: 'Org' };

const order = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1, numero: 1, relationship_id: 7, company_id: 100, represented_id: 5,
  owner_user_id: 1, price_table_id: null, status: 'rascunho', validade: null,
  condicao_pagamento: null, transportadora: null, frete: '0', observacoes: null,
  total: '1000', nf_numero: null, emitido_em: null, faturado_em: null,
  created_at: '2026-06-01T12:00:00Z', updated_at: '2026-06-01T12:00:00Z',
  company_nome: 'Cliente Um LTDA', company_cnpj: '11222333000144',
  represented_nome: 'Indústria X', owner_email: 'a@b.c', owner_nome: null,
  items: [], ...over,
});

const CARD = {
  id: 7, company_id: 100, nome_fantasia: 'Cliente Um', razao_social: 'Cliente Um LTDA',
};
const TABLE = {
  id: 3, nome: 'Tabela 2026', represented_id: 5,
  items: [{ id: 1, catalog_item_id: 9, preco: '90', desconto_max_pct: '10', catalog_nome: 'Produto A', codigo: null }],
};

beforeEach(() => {
  vi.mocked(m.get).mockReset();
  vi.mocked(m.post).mockReset();
  vi.mocked(m.del).mockReset();
  vi.stubGlobal('alert', vi.fn());
  vi.mocked(confirmDialog).mockResolvedValue(true);
  useAuthMock.mockReturnValue({
    user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can: () => true,
  });
  m.get.mockImplementation(async (p: string) => {
    // a página pagina no servidor: /api/orders?limit=…&offset=…&status=…
    if (p.startsWith('/api/orders?')) {
      return { orders: [
        order({ id: 1, numero: 1, status: 'rascunho', total: '1000' }),
        order({ id: 2, numero: 2, status: 'faturado', total: '500', nf_numero: 'NF-7', company_nome: 'Cliente Dois SA' }),
      ] };
    }
    if (p.startsWith('/api/orders/')) return { order: order({ id: 1 }) };
    if (p === '/api/represented') return { empresas: [{ id: 5, nome: 'Indústria X', ativo: true }] };
    if (p === '/api/kanban') return { cards: [CARD] };
    if (p === '/api/catalog') return { items: [{ id: 9, nome: 'Produto A', codigo: null, descricao: null, preco: '100', represented_id: 5, ativo: true }] };
    if (p === '/api/carriers') return { carriers: [{ id: 4, nome: 'Transp X', cnpj: null, telefone: null, email: null, contato: null, observacoes: null, ativo: true }] };
    if (p.startsWith('/api/price-tables/active')) return { table: TABLE };
    return {};
  });
});

const mount = (path = '/pedidos'): ReturnType<typeof render> => render(
  <MemoryRouter initialEntries={[path]}><Orders /></MemoryRouter>,
);

describe('Orders', () => {
  it('lista pedidos com status, NF e KPIs (aberto / faturado)', async () => {
    mount();
    expect(await screen.findByText('Cliente Um LTDA')).toBeInTheDocument();
    // paginação vai no querystring da carga inicial
    const url = m.get.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/orders?'))!;
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('limit')).toBe('100');
    expect(qs.get('offset')).toBe('0');
    expect(screen.getByText('Rascunho', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Faturado', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/NF NF-7/)).toBeInTheDocument();
    // KPI + linha: aberto 1000, faturado 500
    expect(screen.getAllByText(/R\$\s?1\.000,00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/R\$\s?500,00/).length).toBeGreaterThan(0);
  });

  it('mantém somente filtros ou indicadores abertos', async () => {
    mount();
    await screen.findByText('Cliente Um LTDA');
    expect(screen.getByTitle('Recolher indicadores')).toBeInTheDocument();
    await userEvent.click(screen.getByTitle('Expandir filtros'));
    expect(screen.getByTitle('Recolher filtros')).toBeInTheDocument();
    expect(screen.getByTitle('Expandir indicadores')).toBeInTheDocument();
    expect(localStorage.getItem('pedidos:panel')).toBe('filtros');
  });

  it('filtra por status', async () => {
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.selectOptions(screen.getByLabelText('Filtrar por status'), 'faturado');
    expect(screen.queryByText('Cliente Um LTDA')).not.toBeInTheDocument();
    expect(screen.getByText('Cliente Dois SA')).toBeInTheDocument();
    // o filtro também vai para o servidor (paginado)
    await waitFor(() => {
      const urls = m.get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/orders?'));
      expect(urls.some((u) => new URLSearchParams(u.split('?')[1]).get('status') === 'faturado')).toBe(true);
    });
  });

  it('cria pedido com item do catálogo usando preço da tabela vigente', async () => {
    m.post.mockResolvedValueOnce({ order: order({ id: 9 }) });
    mount();
    await screen.findByText('Cliente Um LTDA');

    await userEvent.click(screen.getByRole('button', { name: /Novo pedido/ }));
    await userEvent.selectOptions(screen.getByLabelText('Cliente (funil) *'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Representada *'), '5');
    expect(await screen.findByText('Tabela 2026')).toBeInTheDocument(); // tabela vigente carregada

    await userEvent.selectOptions(screen.getByLabelText('Adicionar item do mostruário'), '9');
    // preço pré-preenchido vem da tabela (90), não do catálogo (100)
    expect(screen.getByLabelText('Preço * item 1')).toHaveValue('90');

    await userEvent.selectOptions(screen.getByLabelText('Transportadora'), '4');

    await userEvent.click(screen.getByRole('button', { name: 'Salvar pedido' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/orders', expect.objectContaining({
      company_id: 100,
      represented_id: 5,
      relationship_id: 7,
      price_table_id: 3,
      carrier_id: 4,
      status: 'rascunho',
      items: [expect.objectContaining({ catalog_item_id: 9, qtd: 1, preco_unit: 90 })],
    })));
  });

  it('?company_id= abre o modal pré-preenchido (botão do Kanban)', async () => {
    mount('/pedidos?company_id=100&relationship_id=7&represented_id=5');
    expect(await screen.findByText('Novo pedido', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByLabelText('Cliente (funil) *')).toHaveValue('100');
    expect(screen.getByLabelText('Representada *')).toHaveValue('5');
  });

  it('transição: enviar rascunho; faturar pede NF em modal', async () => {
    m.post.mockResolvedValue({ order: order({ id: 1, status: 'enviado' }) });
    mount();
    await screen.findByText('Cliente Um LTDA');

    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/orders/1/transition', { status: 'enviado', nf_numero: undefined }));

    // faturar abre modal de NF (substitui prompt nativo)
    await userEvent.click(screen.getByRole('button', { name: 'Faturar' })); // botão da linha (pedido 1 virou enviado)
    await userEvent.type(await screen.findByPlaceholderText('Número da NF'), 'NF-99');
    // segundo "Faturar" = submit do modal
    await userEvent.click(screen.getAllByRole('button', { name: 'Faturar' }).at(-1)!);
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/orders/1/transition', { status: 'faturado', nf_numero: 'NF-99' }));
  });

  it('excluir pedido em rascunho chama DELETE e some da lista', async () => {
    m.del.mockResolvedValueOnce({ deleted: true });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByLabelText('Excluir pedido 1'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/orders/1'));
    expect(screen.queryByText('Cliente Um LTDA')).not.toBeInTheDocument();
  });

  it('admin importa CSV de faturamento e vê o resultado', async () => {
    m.post.mockResolvedValueOnce({ processadas: 2, faturadas: 1, results: [] });
    mount();
    await screen.findByText('Cliente Um LTDA');

    await userEvent.click(screen.getByRole('button', { name: /Importar NF/ }));
    await userEvent.type(screen.getByPlaceholderText(/nf;data;cnpj;valor/), 'nf;data;cnpj;valor\n1;2026-06-01;11222333000144;500');
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));
    expect(await screen.findByText(/1 de 2 linha/)).toBeInTheDocument();
    expect(m.post).toHaveBeenCalledWith('/api/orders/import', expect.objectContaining({ csv: expect.stringContaining('nf;data') }));
  });

  it('vendedor não vê o botão de importação', async () => {
    // rep sem grupo com orders.import: pode operar pedidos, mas não importar NF
    useAuthMock.mockReturnValue({
      user: { ...admin, role: 'rep' }, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
      can: (c: string) => c !== 'orders.import',
    });
    mount();
    await screen.findByText('Cliente Um LTDA');
    expect(screen.queryByRole('button', { name: /Importar NF/ })).not.toBeInTheDocument();
  });

  it('exporta CSV dos pedidos', async () => {
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByRole('button', { name: /Exportar/ }));
    expect(vi.mocked(downloadCsv)).toHaveBeenCalled();
  });

  it('filtra por representada', async () => {
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.selectOptions(screen.getByLabelText('Filtrar por representada'), '5');
    await waitFor(() => expect(m.get.mock.calls.map((c) => String(c[0]))
      .some((u) => u.startsWith('/api/orders?') && new URLSearchParams(u.split('?')[1]).get('represented_id') === '5')).toBe(true));
  });

  // Regressão: /api/orders devolve represented_id/owner_user_id como STRING
  // (bigint do pg), mas o <select> guarda Number(). Sem coagir, o refino local
  // descartava TODA linha e a tabela ficava vazia ao filtrar.
  it('filtrar por representada com ids string não esvazia a lista', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) {
        return { orders: [order({ id: 1, represented_id: '5', owner_user_id: '1' })] };
      }
      if (p.startsWith('/api/orders/')) return { order: order({ id: 1 }) };
      if (p === '/api/represented') return { empresas: [{ id: '5', nome: 'Indústria X', ativo: true }] };
      if (p === '/api/kanban') return { cards: [CARD] };
      return {};
    });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.selectOptions(screen.getByLabelText('Filtrar por representada'), '5');
    // a linha tem de continuar visível depois do filtro
    await waitFor(() => expect(screen.getByText('Cliente Um LTDA')).toBeInTheDocument());
  });

  it('novo pedido: item do catálogo com imposto, item livre, cotação e salva', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) return { orders: [order({ id: 1, status: 'rascunho' })] };
      if (p.startsWith('/api/orders/')) return { order: order({ id: 1 }) };
      if (p === '/api/represented') return { empresas: [{ id: 5, nome: 'Indústria X', ativo: true }] };
      if (p === '/api/kanban') return { cards: [CARD] };
      if (p === '/api/catalog') return { items: [{ id: 9, nome: 'Produto A', codigo: null, descricao: null, preco: '100', unidade_medida: 'KG', represented_id: 5, ativo: true, icms_pct: '18' }] };
      if (p === '/api/carriers') return { carriers: [{ id: 4, nome: 'Transp X', cnpj: null, telefone: null, email: null, contato: null, observacoes: null, ativo: true }] };
      if (p.startsWith('/api/price-tables/active')) return { table: TABLE };
      if (p === '/api/tax-defaults') return { tax: { icms_pct: 12 } };
      return {};
    });
    m.post.mockResolvedValueOnce({ order: order({ id: 9 }) });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByRole('button', { name: /Novo pedido/ }));
    await userEvent.selectOptions(screen.getByLabelText('Cliente (funil) *'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Representada *'), '5');
    await screen.findByText('Tabela 2026');

    // item do catálogo (imposto do produto) + item livre e remoção
    await userEvent.selectOptions(screen.getByLabelText('Adicionar item do mostruário'), '9');
    await userEvent.click(screen.getByRole('button', { name: /Item livre/ }));
    await userEvent.click(screen.getByLabelText('Remover item 2'));

    await userEvent.type(screen.getByLabelText('Descrição item 1'), ' XL');
    await userEvent.type(screen.getByLabelText('Qtd * item 1'), '2');
    await userEvent.type(screen.getByLabelText('Desc % item 1'), '5');
    await userEvent.type(screen.getByPlaceholderText('ex.: 28/56 dias'), '30 dias');
    await userEvent.type(screen.getByLabelText('Frete (R$)'), '30');
    await userEvent.type(screen.getByPlaceholderText('Observações'), 'obs');
    await userEvent.click(screen.getByLabelText('É cotação'));
    fireEvent.change(screen.getByLabelText('Válida até'), { target: { value: '2026-08-01' } });

    await userEvent.click(screen.getByRole('button', { name: 'Salvar pedido' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/orders', expect.objectContaining({ status: 'cotacao' })));
  });

  it('abre pedido faturado em modo leitura com comissão', async () => {
    const item = {
      id: 1, catalog_item_id: 9, descricao_snapshot: 'Produto A', unidade_medida_snapshot: 'KG',
      qtd: '2', preco_unit: '90', desconto_pct: '0', icms_pct: '0', ipi_pct: '0', st_pct: '0', pis_pct: '0', cofins_pct: '0', iss_pct: '0',
    };
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) return { orders: [order({ id: 2, numero: 2, status: 'faturado', nf_numero: 'NF-7' })] };
      if (p === '/api/orders/2') return { order: order({ id: 2, numero: 2, status: 'faturado', nf_numero: 'NF-7', carrier_id: 88, carrier_nome: 'Antiga', items: [item] }) };
      if (p === '/api/represented') return { empresas: [{ id: 5, nome: 'Indústria X', ativo: true }] };
      if (p === '/api/kanban') return { cards: [CARD] };
      if (p === '/api/catalog') return { items: [] };
      if (p === '/api/carriers') return { carriers: [] };
      if (p.startsWith('/api/price-tables/active')) return { table: null };
      if (p.startsWith('/api/commissions?order_id=')) return { entries: [{ id: 1, status: 'divergente', valor_previsto: '100', valor_recebido: '80', percent_aplicado: '5', valor_vendedor: '40' }] };
      return {};
    });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByText('Cliente Um LTDA'));
    expect(await screen.findByText(/somente leitura/)).toBeInTheDocument();
    expect(await screen.findByText(/Comissão prevista/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Fechar' })[0]!);
  });

  it('imprime o pedido gerando o iframe', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) return { orders: [order({ id: 1, status: 'rascunho' })] };
      if (p === '/api/orders/1/print') return { html: '<h1>Pedido</h1>' };
      if (p === '/api/represented') return { empresas: [] };
      return {};
    });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByTitle('Imprimir / PDF'));
    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe');
      if (!el) throw new Error('sem iframe');
      return el as HTMLIFrameElement;
    });
    if (iframe.contentWindow) {
      iframe.contentWindow.focus = vi.fn();
      iframe.contentWindow.print = vi.fn();
    }
    fireEvent.load(iframe);
    expect(iframe).toBeTruthy();
  });

  it('erro ao imprimir não quebra a página', async () => {
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) return { orders: [order({ id: 1, status: 'rascunho' })] };
      if (p === '/api/orders/1/print') throw new Error('no print');
      if (p === '/api/represented') return { empresas: [] };
      return {};
    });
    document.querySelectorAll('iframe').forEach((f) => f.remove());
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByTitle('Imprimir / PDF'));
    await waitFor(() => expect(m.get).toHaveBeenCalledWith('/api/orders/1/print'));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('lista vazia mostra empty state', async () => {
    m.get.mockImplementation(async (p: string) => p.startsWith('/api/orders?') ? { orders: [] } : (p === '/api/represented' ? { empresas: [] } : {}));
    mount();
    expect(await screen.findByText('Nenhum pedido')).toBeInTheDocument();
  });

  it('carrega mais quando a página vem cheia', async () => {
    const many = Array.from({ length: 100 }, (_, i) => order({ id: i + 1, numero: i + 1 }));
    let call = 0;
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) { call++; return call === 1 ? { orders: many } : { orders: [order({ id: 101, numero: 101, company_nome: 'Extra SA' })] }; }
      if (p === '/api/represented') return { empresas: [] };
      return {};
    });
    mount();
    await screen.findByRole('button', { name: /Carregar mais/ });
    await userEvent.click(screen.getByRole('button', { name: /Carregar mais/ }));
    expect(await screen.findByText('Extra SA')).toBeInTheDocument();
  });

  it('coluna Vendedor aparece em conta escritório', async () => {
    useAuthMock.mockReturnValue({
      user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
      can: () => true, isOffice: true,
    });
    m.get.mockImplementation(async (p: string) => p.startsWith('/api/orders?') ? { orders: [order({ id: 1, owner_nome: 'Chefe' })] } : (p === '/api/represented' ? { empresas: [] } : {}));
    mount();
    expect(await screen.findByText('Chefe')).toBeInTheDocument();
  });

  it('linha entregue sem permissão de impressão não mostra ações', async () => {
    useAuthMock.mockReturnValue({
      user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
      can: (c: string) => c !== 'orders.print', isOffice: false,
    });
    m.get.mockImplementation(async (p: string) => p.startsWith('/api/orders?') ? { orders: [order({ id: 1, status: 'entregue' })] } : (p === '/api/represented' ? { empresas: [] } : {}));
    mount();
    await screen.findByText('Cliente Um LTDA');
    expect(screen.queryByTitle('Cancelar pedido')).not.toBeInTheDocument();
  });

  it('cancela um pedido pela linha', async () => {
    m.post.mockResolvedValueOnce({ order: order({ id: 1, status: 'cancelado' }) });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getAllByTitle('Cancelar pedido')[0]!);
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/orders/1/transition', { status: 'cancelado', nf_numero: undefined }));
  });

  it('modal de NF pode ser cancelado', async () => {
    m.get.mockImplementation(async (p: string) => p.startsWith('/api/orders?') ? { orders: [order({ id: 1, status: 'enviado' })] } : (p === '/api/represented' ? { empresas: [] } : {}));
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByRole('button', { name: 'Faturar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Número da NF')).not.toBeInTheDocument());
  });

  it('importação: erro exibe toast; cancelar e concluir fecham', async () => {
    m.post.mockRejectedValueOnce(new Error('ruim'));
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByRole('button', { name: /Importar NF/ }));
    await userEvent.type(screen.getByPlaceholderText(/nf;data;cnpj;valor/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    m.post.mockResolvedValueOnce({ processadas: 1, faturadas: 1 });
    await userEvent.click(screen.getByRole('button', { name: /Importar NF/ }));
    await userEvent.type(screen.getByPlaceholderText(/nf;data;cnpj;valor/), 'y');
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Concluir' }));
  });

  it('excluir pedido: falha reverte', async () => {
    m.del.mockRejectedValueOnce(new Error('x'));
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByLabelText('Excluir pedido 1'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/orders/1'));
    await waitFor(() => expect(screen.getByText('Cliente Um LTDA')).toBeInTheDocument());
  });

  it('novo pedido pré-preenchido de empresa fora do funil (relationship nulo)', async () => {
    m.post.mockResolvedValueOnce({ order: order({ id: 9 }) });
    mount('/pedidos?company_id=999');
    expect(await screen.findByText('Novo pedido', { selector: 'h3' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Representada *'), '5');
    await userEvent.selectOptions(screen.getByLabelText('Adicionar item do mostruário'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar pedido' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/orders', expect.objectContaining({ relationship_id: null })));
  });

  it('erro ao salvar pedido exibe toast', async () => {
    m.post.mockRejectedValueOnce(new Error('boom'));
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByRole('button', { name: /Novo pedido/ }));
    await userEvent.selectOptions(screen.getByLabelText('Cliente (funil) *'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Representada *'), '5');
    await userEvent.selectOptions(screen.getByLabelText('Adicionar item do mostruário'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar pedido' }));
    await waitFor(() => expect(m.post).toHaveBeenCalled());
  });

  it('vendedor vê a própria comissão no pedido faturado', async () => {
    useAuthMock.mockReturnValue({
      user: { ...admin, role: 'rep' }, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
      can: () => true, isOffice: true,
    });
    m.get.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/orders?')) return { orders: [order({ id: 2, numero: 2, status: 'faturado' })] };
      if (p === '/api/orders/2') return { order: order({ id: 2, numero: 2, status: 'faturado', items: [] }) };
      if (p === '/api/represented') return { empresas: [] };
      if (p === '/api/kanban') return { cards: [] };
      if (p === '/api/catalog') return { items: [] };
      if (p === '/api/carriers') return { carriers: [] };
      if (p.startsWith('/api/price-tables/active')) return { table: null };
      if (p.startsWith('/api/commissions?order_id=')) return { entries: [{ id: 1, status: 'recebida', valor_previsto: '100', valor_recebido: '100', percent_aplicado: '5', valor_vendedor: '40' }] };
      return {};
    });
    mount();
    await screen.findByText('Cliente Um LTDA');
    await userEvent.click(screen.getByText('Cliente Um LTDA'));
    expect(await screen.findByText(/Sua comissão prevista/)).toBeInTheDocument();
  });
});
