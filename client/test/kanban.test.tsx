// Funil kanban: board, colunas, KPIs, drag-drop otimista com revert.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Kanban } from '../src/pages/Kanban.tsx';
import { api } from '../src/lib/api.ts';
import { useAuth, type User } from '../src/lib/auth.tsx';

vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/auth.tsx', () => {
  const useAuth = vi.fn();
  return { useAuth, useOptionalUser: () => useAuth().user ?? null };
});
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn(async () => true) }));
const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);

// window.location.href é usado pelos atalhos de WhatsApp; substitui por um objeto simples.
const stubLocation = (): { href: string } => {
  const loc = { href: '' };
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: loc });
  return loc;
};

// GET com os endpoints do board; o caller passa overrides por rota.
const kanbanGet = (over: Record<string, unknown> = {}) => async (p: string): Promise<unknown> => {
  const routes: Record<string, unknown> = {
    '/api/kanban': { stages: STAGES, cards: [card({ id: 1 })] },
    '/api/represented': { empresas: [] },
    '/api/brands': { brands: [] },
    '/api/catalog': { items: [] },
    '/api/scenarios': { items: [] },
    '/api/actions': { items: [] },
    ...over,
  };
  for (const [k, v] of Object.entries(routes)) if (p === k) return v;
  if (p.startsWith('/api/contacts')) return (over['/api/contacts'] as unknown) ?? { contacts: [] };
  if (p.startsWith('/api/companies/')) return over['/api/companies'] as unknown;
  if (p.startsWith('/api/sample-requests')) return (over['/api/sample-requests'] as unknown) ?? { samples: [] };
  return { items: [] };
};

const admin: User = { id: 1, email: 'a@b.c', role: 'admin', org_id: 1, org_nome: 'Org' };

// O nome da etapa aparece no cabeçalho da coluna E nas <option> do filtro de
// etapa — pega só o cabeçalho (span) e sobe até a div da coluna.
const coluna = (nome: string): HTMLElement => {
  const header = screen.getAllByText(nome).find((el) => el.tagName === 'SPAN');
  return header!.closest('div')!.parentElement!;
};

const STAGES = [
  { id: 10, nome: 'Prospecção', ordem: 1 },
  { id: 11, nome: 'Negociação', ordem: 2 },
];
const card = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1, company_id: 100, stage_id: 10, status: 'prospect', valor_estimado: '5000', notas: null,
  owner_user_id: 1, represented_id: null, marca_id: null, cenario_id: null, acao_id: null,
  data_contato: null, previsao_data: null, updated_at: '',
  razao_social: 'Empresa Um LTDA', nome_fantasia: 'Loja Um', cnpj: '11222333000144',
  cnae_principal: 4781400, municipio_id: 100, uf: 'SP', cidade: 'São Paulo', porte: 'pequeno',
  // /api/kanban manda amostras_count (a lista completa é carregada no modal)
  representada: null, marca: null, cenario: null, acao: null, contatos: [], catalogo: [], amostras_count: 0, ...over,
});

beforeEach(() => {
  localStorage.clear(); // filtros do funil são persistidos: um teste não pode vazar no outro
  vi.mocked(m.get).mockReset();
  vi.mocked(m.patch).mockReset();
  vi.mocked(m.post).mockReset();
  vi.mocked(m.del).mockReset();
  m.del.mockResolvedValue({});
  m.patch.mockResolvedValue({ relationship: { status: 'prospect' } });
  useAuthMock.mockReturnValue({
    user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can: () => true,
  });
  m.get.mockImplementation(async (p: string) => {
    if (p === '/api/kanban') {
      return { stages: STAGES, cards: [
        card({ id: 1 }),
        card({ id: 2, razao_social: 'Empresa Dois SA', nome_fantasia: null, stage_id: 11, status: 'cliente', valor_estimado: '2000',
          amostras_count: 1 }),
      ] };
    }
    if (p === '/api/profile') return { profile: null };
    if (p === '/api/represented') return { empresas: [] };
    if (p === '/api/brands') return { brands: [] };
    if (p === '/api/catalog') return { items: [] };
    if (p.startsWith('/api/contacts')) return { contacts: [] };
    if (p.startsWith('/api/sample-requests')) return { samples: [] };
    return { items: [] }; // scenarios/actions
  });
});

describe('Kanban', () => {
  it('renderiza colunas, cards e KPIs (valor total, clientes)', async () => {
    render(<Kanban />);
    expect(await screen.findByText('Loja Um')).toBeInTheDocument();
    expect(coluna('Prospecção')).toBeInTheDocument();
    expect(coluna('Negociação')).toBeInTheDocument();
    expect(screen.getAllByText('Empresa Dois SA').length).toBeGreaterThan(0); // título + razão social
    // valor em funil 5000+2000 sem centavos (brl0)
    expect(screen.getByText(/R\$[\s ]7\.000/)).toBeInTheDocument();
  });

  it('drag-drop move o card (PATCH stage_id) de forma otimista', async () => {
    m.patch.mockResolvedValueOnce({});
    render(<Kanban />);
    const cardEl = (await screen.findByText('Loja Um')).closest('[draggable]')!;
    const colNegociacao = coluna('Negociação');

    fireEvent.dragStart(cardEl);
    fireEvent.dragOver(colNegociacao);
    fireEvent.drop(colNegociacao);

    expect(m.patch).toHaveBeenCalledWith('/api/relationships/1', { stage_id: 11 });
  });

  it('falha no PATCH recarrega o board (revert)', async () => {
    m.patch.mockRejectedValueOnce(new Error('offline'));
    render(<Kanban />);
    const cardEl = (await screen.findByText('Loja Um')).closest('[draggable]')!;
    const colNegociacao = coluna('Negociação');

    const kanbanCalls = (): number => m.get.mock.calls.filter((c) => c[0] === '/api/kanban').length;
    const antes = kanbanCalls();
    fireEvent.dragStart(cardEl);
    fireEvent.drop(colNegociacao);
    await waitFor(() => expect(kanbanCalls()).toBe(antes + 1)); // load() de revert
  });

  it('soltar na mesma coluna não chama a API', async () => {
    render(<Kanban />);
    const cardEl = (await screen.findByText('Loja Um')).closest('[draggable]')!;
    const colProspeccao = coluna('Prospecção');
    fireEvent.dragStart(cardEl);
    fireEvent.drop(colProspeccao);
    expect(m.patch).not.toHaveBeenCalled();
  });

  it('botão +Amostra: abre, fecha e solicita amostra', async () => {
    m.get.mockImplementation(kanbanGet({ '/api/catalog': { items: [{ id: 1, nome: 'Prod', ativo: true }] } }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getAllByRole('button', { name: /\+Amostra/ })[0]!);
    const sm = (await screen.findByText('Solicitar amostra')).closest('.fixed') as HTMLElement;
    await userEvent.click(within(sm).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Solicitar amostra')).not.toBeInTheDocument());
    await userEvent.click(screen.getAllByRole('button', { name: /\+Amostra/ })[0]!);
    const sm2 = (await screen.findByText('Solicitar amostra')).closest('.fixed') as HTMLElement;
    await userEvent.selectOptions(within(sm2).getByLabelText('Produto do catálogo *'), '1');
    m.post.mockResolvedValueOnce({ sample: { id: 1 } });
    await userEvent.click(within(sm2).getByRole('button', { name: 'Solicitar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/sample-requests', expect.objectContaining({ catalog_item_id: 1 })));
  });

  it('sinal de amostra abre a lista, exclui e fecha', async () => {
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [card({ id: 2, amostras_count: 1, stage_id: 11 })] },
      '/api/sample-requests': { samples: [{ id: 5, produto_snapshot: 'Amostra Z', status: 'solicitada', quantidade: null, data_prevista: null, contato: null }] },
    }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByRole('button', { name: /1 amostra/ }));
    expect(await screen.findByRole('heading', { name: 'Amostras' })).toBeInTheDocument();
    await screen.findByText('Amostra Z');
    await userEvent.click(screen.getByTitle('Excluir')); // exclui → onChanged
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/sample-requests/5'));
    await userEvent.click(screen.getByText('Amostras').closest('.fixed')!); // backdrop → onClose
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Amostras' })).not.toBeInTheDocument());
  });

  it('alterna filtros e indicadores, persistindo no localStorage', async () => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByTitle('Expandir filtros'));
    expect(localStorage.getItem('funil:filtersOpen')).toBe('1');
    await userEvent.click(screen.getByTitle('Recolher indicadores'));
    expect(localStorage.getItem('funil:kpisOpen')).toBe('0');
  });

  it('clicar no board recolhe os filtros; clicar dentro do painel mantém aberto', async () => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByTitle('Expandir filtros'));
    expect(localStorage.getItem('funil:filtersOpen')).toBe('1');

    // clique dentro do painel (um dos selects do filtro) não fecha
    await userEvent.click(screen.getByLabelText('Etapa'));
    expect(localStorage.getItem('funil:filtersOpen')).toBe('1');

    await userEvent.click(coluna('Negociação')); // clique no board = fora do painel
    await waitFor(() => expect(screen.getByTitle('Expandir filtros')).toBeInTheDocument());
    expect(localStorage.getItem('funil:filtersOpen')).toBe('0');
  });

  it('botão Buscar recarrega o board sem fechar os filtros', async () => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByTitle('Expandir filtros'));
    const kanbanCalls = (): number => m.get.mock.calls.filter((c) => c[0] === '/api/kanban').length;
    const antes = kanbanCalls();
    await userEvent.click(screen.getByRole('button', { name: /Buscar/ }));
    await waitFor(() => expect(kanbanCalls()).toBe(antes + 1));
    expect(localStorage.getItem('funil:filtersOpen')).toBe('1'); // painel segue aberto
    expect(screen.getByTitle('Recolher filtros')).toBeInTheDocument();
  });

  it('filtro de etapa deixa só a coluna escolhida no board', async () => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByTitle('Expandir filtros'));
    await userEvent.selectOptions(screen.getByLabelText('Etapa'), '11');
    await waitFor(() => expect(screen.queryByText('Loja Um')).not.toBeInTheDocument()); // card da etapa 10 sai
    expect(coluna('Negociação')).toBeInTheDocument();
    expect(screen.getAllByText('Prospecção').every((el) => el.tagName === 'OPTION')).toBe(true); // coluna some
    expect(localStorage.getItem('funil:filtros')).toContain('"stage":"11"');
  });

  it('filtros de status, cenário e ação escondem os cards que não batem', async () => {
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [
        card({ id: 1, cenario_id: 4, acao_id: 8 }),
        card({ id: 2, nome_fantasia: 'Loja Dois', status: 'cliente', cenario_id: 5, acao_id: 9 }),
      ] },
      '/api/scenarios': { items: [{ id: 4, nome: 'Cenário A' }, { id: 5, nome: 'Cenário B' }] },
      '/api/actions': { items: [{ id: 8, nome: 'Ação A' }, { id: 9, nome: 'Ação B' }] },
    }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByTitle('Expandir filtros'));

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'cliente');
    await waitFor(() => expect(screen.queryByText('Loja Um')).not.toBeInTheDocument());
    expect(screen.getByText('Loja Dois')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Cenário'), '4'); // cenário do card 1
    await waitFor(() => expect(screen.queryByText('Loja Dois')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Limpar filtros/ }));
    await screen.findByText('Loja Um');
    await userEvent.selectOptions(screen.getByLabelText('Ação (próximo nível)'), '9');
    await waitFor(() => expect(screen.queryByText('Loja Um')).not.toBeInTheDocument());
    expect(screen.getByText('Loja Dois')).toBeInTheDocument();
  });

  it('filtro por private label usa os vínculos da empresa do card', async () => {
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [
        card({ id: 1, private_labels: [{ id: 5, nome: 'Label X', cor: '#ff0000' }] }),
        card({ id: 2, nome_fantasia: 'Loja Dois', private_labels: [] }),
      ] },
      // ids das labels vêm string do pg (bigint) — o filtro coage os dois lados
      '/api/private-labels': { labels: [{ id: '5', nome: 'Label X', cor: '#ff0000' }] },
    }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    // aparece como chip no card (span) e como <option> do filtro
    expect(screen.getAllByText('Label X').some((el) => el.tagName === 'SPAN')).toBe(true);
    await userEvent.click(screen.getByTitle('Expandir filtros'));
    await userEvent.selectOptions(screen.getByLabelText('Private label'), '5');
    await waitFor(() => expect(screen.queryByText('Loja Dois')).not.toBeInTheDocument());
    expect(screen.getByText('Loja Um')).toBeInTheDocument();
  });

  it('dragLeave limpa o destaque da coluna sob o card', async () => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    const col = coluna('Negociação');
    fireEvent.dragOver(col);
    fireEvent.dragLeave(col);
    expect(screen.getByText('Loja Um')).toBeInTheDocument();
  });

  it('card mostra marca/contato/catálogo e o atalho de WhatsApp navega', async () => {
    const loc = stubLocation();
    m.post.mockResolvedValueOnce({ chat: { id: 77 } });
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [card({ id: 1,
        marca: 'ACME', contatos: [{ id: 1, nome: 'Fulano' }], catalogo: [{ id: 1, nome: 'Produto Z' }],
        telefone1: '11999998888' })] },
    }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    expect(screen.getByText(/ACME/)).toBeInTheDocument();
    expect(screen.getByText(/Produto Z/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /WhatsApp/ }));
    expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/from-company', { company_id: 100, numero: '11999998888' });
    await waitFor(() => expect(loc.href).toBe('/whatsapp?chat=77'));
  });

  it('atalho de WhatsApp trata erro sem navegar', async () => {
    stubLocation();
    m.post.mockRejectedValueOnce(new Error('falhou'));
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [card({ id: 1, telefone1: '11999998888' })] },
    }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getByRole('button', { name: /WhatsApp/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalled());
  });

  it('menu "mover para": abre, fecha pelo overlay e troca de etapa', async () => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getAllByRole('button', { name: /Mover para outra etapa/ })[0]!);
    let menu = await screen.findByRole('menu');
    // etapa atual fica desabilitada
    expect(within(menu).getByRole('menuitem', { name: /Prospecção/ })).toBeDisabled();
    // fecha pelo overlay (onCloseMenu)
    fireEvent.click(menu.previousElementSibling!);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    // reabre e move
    await userEvent.click(screen.getAllByRole('button', { name: /Mover para outra etapa/ })[0]!);
    menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Negociação/ }));
    expect(m.patch).toHaveBeenCalledWith('/api/relationships/1', { stage_id: 11 });
  });

  it('clicar no nome da empresa abre o modal de dados', async () => {
    m.get.mockImplementation(kanbanGet({
      '/api/companies': { company: {
        id: 100, razao_social: 'Empresa Um LTDA', nome_fantasia: 'Loja Um', cnpj: '11222333000144',
        cnae_principal: 4781400, capital_social: '1000', porte: 'pequeno', matriz_filial: 1,
        geo_lat: -23, geo_lon: -46, geo_precisao: 'rua', raw_data: {},
      }, socios: [] },
    }));
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getAllByTitle('Ver dados da empresa')[0]!);
    expect(await screen.findByText('Dados da empresa')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Dados da empresa').closest('.fixed')!);
    await waitFor(() => expect(screen.queryByText('Dados da empresa')).not.toBeInTheDocument());
  });

  // fixtures ricas para o modal de edição
  const editMock = (): void => {
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [card({ id: 1,
        contatos: [{ id: 1, nome: 'Contato A', cargo: 'CEO', telefone: '11988887777' }],
        catalogo: [{ id: 1, nome: 'Prod A', codigo: 'P1' }] })] },
      '/api/represented': { empresas: [{ id: 7, nome: 'Rep X' }] },
      '/api/brands': { brands: [{ id: 3, nome: 'Marca Y', represented_id: 7 }] },
      '/api/catalog': { items: [{ id: 1, nome: 'Prod A', codigo: 'P1', ativo: true }, { id: 2, nome: 'Prod B', codigo: 'P2', ativo: true }] },
      '/api/scenarios': { items: [{ id: 1, nome: 'Cenário 1' }] },
      '/api/actions': { items: [{ id: 1, nome: 'Ação 1' }] },
      '/api/contacts': { contacts: [
        { id: 1, nome: 'Contato A', cargo: 'CEO', telefone: '11988887777' },
        { id: 2, nome: 'Contato B', cargo: null, telefone: null },
      ] },
    }));
  };
  const openEdit = async (): Promise<HTMLElement> => {
    render(<Kanban />);
    await screen.findByText('Loja Um');
    await userEvent.click(screen.getAllByRole('button', { name: /Editar prospecção/ })[0]!);
    return (await screen.findByRole('heading', { name: 'Loja Um' })).closest('.fixed') as HTMLElement;
  };

  it('modal de edição: preenche campos, mexe em contatos/catálogo e salva', async () => {
    stubLocation();
    editMock();
    m.post.mockResolvedValue({ chat: { id: 1 } });
    m.patch.mockResolvedValue({ relationship: { status: 'descartado' } });
    const d = await openEdit();

    await userEvent.selectOptions(within(d).getByLabelText('Etapa do funil'), ''); // Sem etapa (numOrNull '')
    await userEvent.selectOptions(within(d).getByLabelText('Status'), 'descartado');
    await userEvent.type(within(d).getByLabelText('Motivo do descarte'), 'Preço alto');
    await userEvent.selectOptions(within(d).getByLabelText('Representada'), '7');
    await userEvent.selectOptions(within(d).getByLabelText('Marca'), '3');
    await userEvent.selectOptions(within(d).getByLabelText('Cenário atual'), '1');
    await userEvent.selectOptions(within(d).getByLabelText('Ação para próximo nível'), '1');
    fireEvent.change(within(d).getByLabelText('Data do contato'), { target: { value: '2099-01-01' } });
    fireEvent.change(within(d).getByLabelText('Previsão de faturamento (data)'), { target: { value: '2099-02-01' } });
    await userEvent.type(within(d).getByLabelText('Valor estimado (R$)'), '1500');

    // contato já selecionado tem atalho de WhatsApp
    await userEvent.click(within(d).getByRole('button', { name: 'Iniciar conversa' }));
    // adiciona o Contato B disponível e remove
    await userEvent.selectOptions(within(d).getByRole('option', { name: /Adicionar contato/ }).closest('select')!, '2');
    await userEvent.click(within(d).getAllByRole('button', { name: 'Remover' })[0]!);
    // catálogo: adiciona Prod B e remove um item selecionado
    await userEvent.selectOptions(within(d).getByRole('option', { name: /Adicionar item do catálogo/ }).closest('select')!, '2');
    const remCat = within(d).getAllByRole('button', { name: 'Remover' });
    await userEvent.click(remCat[remCat.length - 1]!); // remove item do catálogo (onClick catálogo)
    await userEvent.type(within(d).getByLabelText('Notas'), 'observação livre');

    m.patch.mockResolvedValueOnce({ relationship: { status: 'descartado' } });
    await userEvent.click(within(d).getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/relationships/1',
      expect.objectContaining({ status: 'descartado', motivo_descarte: 'Preço alto', represented_id: 7, marca_id: 3 })));
  });

  // Regressão: /api/contacts devolve o bigint do pg como STRING ("2"), enquanto os
  // ids dentro do card vêm de json_agg como NUMBER. Sem coagir os dois lados, o
  // contato escolhido nunca virava pill e seguia listado como disponível — na
  // prática, "não dá para selecionar o contato na prospecção".
  it('modal de edição: contato com id string (bigint do pg) é selecionável', async () => {
    m.get.mockImplementation(kanbanGet({
      '/api/kanban': { stages: STAGES, cards: [card({ id: 1,
        contatos: [{ id: 1, nome: 'Contato A', cargo: 'CEO' }] })] },
      '/api/contacts': { contacts: [
        { id: '1', nome: 'Contato A', cargo: 'CEO', telefone: null },
        { id: '2', nome: 'Contato B', cargo: null, telefone: null },
      ] },
    }));
    const d = await openEdit();
    const sel = within(d).getByRole('option', { name: /Adicionar contato/ }).closest('select')!;

    // o já vinculado é reconhecido: virou pill (tem "Remover") e saiu do dropdown
    await waitFor(() => expect(within(d).getAllByRole('button', { name: 'Remover' })).toHaveLength(1));
    expect(within(sel).queryByRole('option', { name: /Contato A/ })).toBeNull();

    // selecionar o disponível também funciona
    await userEvent.selectOptions(sel, '2');
    await waitFor(() => expect(within(d).getAllByRole('button', { name: 'Remover' })).toHaveLength(2));
    expect(within(sel).queryByRole('option', { name: /Contato B/ })).toBeNull();

    m.patch.mockResolvedValueOnce({ relationship: { status: 'prospect' } });
    await userEvent.click(within(d).getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/relationships/1',
      expect.objectContaining({ contato_ids: [1, 2] })));
  });

  it('modal de edição: falha ao salvar mantém o modal aberto', async () => {
    editMock();
    m.patch.mockRejectedValueOnce(new Error('offline'));
    const d = await openEdit();
    await userEvent.click(within(d).getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.patch).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'Loja Um' })).toBeInTheDocument();
    // fecha o modal (onClose do EditModal)
    await userEvent.click(within(d).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Loja Um' })).not.toBeInTheDocument());
  });

  it('modal de edição: cria novo contato (valida e-mail) e vincula', async () => {
    editMock();
    const d = await openEdit();
    // abre e cancela (onCancel), depois reabre
    await userEvent.click(within(d).getByTitle('Criar novo contato'));
    await userEvent.click(within((await screen.findByText('Criar novo contato')).closest('.fixed') as HTMLElement).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Criar novo contato')).not.toBeInTheDocument());
    await userEvent.click(within(d).getByTitle('Criar novo contato'));
    const nc = (await screen.findByText('Criar novo contato')).closest('.fixed') as HTMLElement;
    await userEvent.type(within(nc).getByPlaceholderText('Nome *'), 'Novo Contato');
    await userEvent.type(within(nc).getByPlaceholderText('E-mail'), 'invalido');
    await userEvent.click(within(nc).getByRole('button', { name: /Criar/ }));
    expect(m.post).not.toHaveBeenCalled();
    await userEvent.clear(within(nc).getByPlaceholderText('E-mail'));
    await userEvent.type(within(nc).getByPlaceholderText('E-mail'), 'a@b.c');
    await userEvent.type(within(nc).getByPlaceholderText('Telefone'), '11988887777');
    await userEvent.type(within(nc).getByPlaceholderText('Cargo'), 'Gerente');
    m.post.mockResolvedValueOnce({ contact: { id: 9, nome: 'Novo Contato' } });
    await userEvent.click(within(nc).getByRole('button', { name: /Criar/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/contacts', expect.objectContaining({ nome: 'Novo Contato', email: 'a@b.c' })));
  });

  it('modal de edição: cria novo produto no catálogo', async () => {
    editMock();
    const d = await openEdit();
    await userEvent.click(within(d).getByTitle('Criar novo produto'));
    await userEvent.click(within((await screen.findByText('Criar novo produto')).closest('.fixed') as HTMLElement).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Criar novo produto')).not.toBeInTheDocument());
    await userEvent.click(within(d).getByTitle('Criar novo produto'));
    const np = (await screen.findByText('Criar novo produto')).closest('.fixed') as HTMLElement;
    await userEvent.type(within(np).getByPlaceholderText('Nome *'), 'Prod Novo');
    await userEvent.type(within(np).getByPlaceholderText('Código / SKU'), 'SKU9');
    await userEvent.type(within(np).getByPlaceholderText('Preço (R$)'), '99');
    await userEvent.selectOptions(within(np).getByRole('combobox'), '7');
    m.post.mockResolvedValueOnce({ item: { id: 9, nome: 'Prod Novo', ativo: true } });
    await userEvent.click(within(np).getByRole('button', { name: /Criar/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/catalog', expect.objectContaining({ nome: 'Prod Novo', represented_id: 7 })));
  });

  it('modal de edição: abre e salva um novo compromisso', async () => {
    editMock();
    const d = await openEdit();
    await userEvent.click(within(d).getByRole('button', { name: /Criar compromisso/ }));
    // fecha (onClose). Escopado no modal de atividade: o EditModal por baixo
    // também tem um X "Fechar", então a busca global acha dois.
    const av = (await screen.findByText('Nova atividade')).closest('.fixed') as HTMLElement;
    await userEvent.click(within(av).getByLabelText('Fechar'));
    await waitFor(() => expect(screen.queryByText('Nova atividade')).not.toBeInTheDocument());
    // reabre e salva (onSaved)
    await userEvent.click(within(d).getByRole('button', { name: /Criar compromisso/ }));
    const am = (await screen.findByText('Nova atividade')).closest('.fixed') as HTMLElement;
    await userEvent.type(within(am).getByPlaceholderText(/Ligar para cliente/), 'Ligar amanhã');
    m.post.mockResolvedValueOnce({});
    await userEvent.click(within(am).getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/activities', expect.objectContaining({ titulo: 'Ligar amanhã' })));
  });

  it('modal de edição: remover do funil (otimista)', async () => {
    editMock();
    const d = await openEdit();
    await userEvent.click(within(d).getByRole('button', { name: /Remover do funil/ }));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/relationships/1'));
    await waitFor(() => expect(screen.queryByText('Loja Um')).not.toBeInTheDocument());
  });

  it('modal de edição: remover do funil recarrega o board em falha', async () => {
    editMock();
    m.del.mockRejectedValueOnce(new Error('offline'));
    const d = await openEdit();
    const kanbanCalls = (): number => m.get.mock.calls.filter((c) => c[0] === '/api/kanban').length;
    const antes = kanbanCalls();
    await userEvent.click(within(d).getByRole('button', { name: /Remover do funil/ }));
    await waitFor(() => expect(kanbanCalls()).toBeGreaterThan(antes));
  });
});
