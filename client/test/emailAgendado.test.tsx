// Agendamento de e-mail: abas Agendados/Modelos, StatCards, filtros, CRUD de
// agendamentos (modal com destinatários/empresa/modelo) e de modelos.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailAgendado } from '../src/pages/EmailAgendado.tsx';
import { api } from '../src/lib/api.ts';
import { useAuth, type User } from '../src/lib/auth.tsx';
import { toast } from '../src/lib/toast.tsx';
import { confirmDialog } from '../src/lib/confirm.ts';

const hoisted = vi.hoisted(() => ({
  companyHit: {
    id: 42, cnpj: '12345678000199', razao_social: 'Cliente SA',
    nome_fantasia: 'Cliente', telefone1: null, email: 'compras@cliente.com',
  } as Record<string, unknown>,
}));

vi.mock('../src/lib/api.ts', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), invalidate: vi.fn() } };
});
vi.mock('../src/lib/auth.tsx', () => {
  const useAuth = vi.fn();
  return { useAuth, useOptionalUser: () => useAuth().user ?? null };
});
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../src/lib/confirm.ts', () => ({ confirmDialog: vi.fn() }));
vi.mock('../src/lib/companySearch.tsx', () => ({
  CompanySearch: ({ onPick }: { onPick: (c: unknown) => void }) => (
    <button type="button" onClick={() => onPick(hoisted.companyHit)}>mock-pick</button>
  ),
}));

const m = vi.mocked(api);
const useAuthMock = vi.mocked(useAuth);
const toastMock = vi.mocked(toast);
const confirmMock = vi.mocked(confirmDialog);

const admin: User = { id: 1, email: 'eu@x.com', role: 'admin', org_id: 1, org_nome: 'Org' };

const ISO = '2026-08-01T13:00:00.000Z';
const sched = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1, template_id: null, company_id: null, empresa: null, remetente: 'eu@x.com',
  destinatario: 'a@b.com', assunto: 'Oi', corpo: 'Texto', agendado_para: ISO,
  recorrencia: null, status: 'pendente', enviado_em: null, erro: null,
  owner_user_id: 1, created_at: ISO, updated_at: ISO, ...over,
});
const tpl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1, nome: 'Modelo A', assunto: 'Assunto A', corpo: 'Corpo A',
  owner_user_id: 1, created_at: ISO, updated_at: ISO, ...over,
});

let schedules: Record<string, unknown>[];
let templates: Record<string, unknown>[];

function setAuth(over: { can?: (c: string) => boolean } = {}): void {
  useAuthMock.mockReturnValue({
    user: admin, loading: false, login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
    can: over.can ?? (() => true), isOffice: true,
  });
}

beforeEach(() => {
  m.get.mockReset(); m.post.mockReset(); m.patch.mockReset(); m.del.mockReset();
  toastMock.success.mockReset(); toastMock.error.mockReset();
  confirmMock.mockReset(); confirmMock.mockResolvedValue(true);
  hoisted.companyHit.email = 'compras@cliente.com';
  schedules = []; templates = [];
  setAuth();
  m.get.mockImplementation(async (p: string) => {
    if (p === '/api/email-schedules') return { schedules };
    if (p === '/api/email-templates') return { templates };
    return {};
  });
});

describe('EmailAgendado — abas', () => {
  it('alterna entre Agendados e Modelos', async () => {
    render(<EmailAgendado />);
    expect(await screen.findByText('Nenhum e-mail agendado')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Modelos/ }));
    expect(await screen.findByText('Nenhum modelo ainda')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Agendados/ }));
    expect(await screen.findByText('Nenhum e-mail agendado')).toBeInTheDocument();
  });
});

describe('EmailAgendado — SchedulesTab', () => {
  it('mostra stats, badges e filtra por status', async () => {
    schedules = [
      sched({ id: 1, status: 'pendente', assunto: 'Pendente1', empresa: 'ACME', recorrencia: 'semanal' }),
      sched({ id: 2, status: 'enviado', assunto: 'Enviado2', enviado_em: ISO }),
      sched({ id: 3, status: 'erro', assunto: 'Erro3', erro: 'SMTP falhou', agendado_para: 'data-ruim', recorrencia: 'nenhuma' }),
      sched({ id: 4, status: 'cancelado', assunto: 'Cancelado4' }),
    ];
    render(<EmailAgendado />);
    expect(await screen.findByText('Pendente1')).toBeInTheDocument();
    // stats
    expect(screen.getByText('Total agendados').parentElement).toHaveTextContent('4');
    expect(screen.getByText('SMTP falhou', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('ACME')).toBeInTheDocument();
    expect(screen.getByText('Semanal')).toBeInTheDocument();

    // filtro Enviados: some os pendentes/erro/cancelado
    await userEvent.click(screen.getByRole('button', { name: 'Enviados' }));
    expect(screen.queryByText('Pendente1')).not.toBeInTheDocument();
    expect(screen.getByText('Enviado2')).toBeInTheDocument();
  });

  it('filtro sem resultados mostra aviso', async () => {
    schedules = [sched({ id: 1, status: 'pendente' })];
    render(<EmailAgendado />);
    await screen.findByText('Oi', { selector: 'p.truncate' });
    await userEvent.click(screen.getByRole('button', { name: 'Enviados' }));
    expect(screen.getByText('Nenhum agendamento neste filtro.')).toBeInTheDocument();
  });

  it('cancela e remove agendamentos', async () => {
    schedules = [sched({ id: 1, status: 'pendente', destinatario: 'x@y.com' })];
    m.patch.mockResolvedValueOnce({ schedule: sched({ id: 1, status: 'cancelado' }) });
    m.del.mockResolvedValueOnce({});
    render(<EmailAgendado />);
    await screen.findByText('Oi', { selector: 'p.truncate' });

    await userEvent.click(screen.getByTitle('Cancelar envio'));
    // scope: agendamento avulso cancela só a ocorrência ('one'); série usa 'serie'.
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/email-schedules/1', { status: 'cancelado', scope: 'one' }));
    expect(toastMock.success).toHaveBeenCalledWith('Envio cancelado.');

    await userEvent.click(screen.getByLabelText('Remover agendamento'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/email-schedules/1?scope=one'));
    expect(toastMock.success).toHaveBeenCalledWith('Agendamento removido.');
  });

  it('trata cancelamento negado, cancelamento com erro e remoção cancelada/erro', async () => {
    schedules = [sched({ id: 1, status: 'pendente' })];
    render(<EmailAgendado />);
    await screen.findByText('Oi', { selector: 'p.truncate' });

    // cancelar negado no confirm
    confirmMock.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByTitle('Cancelar envio'));
    expect(m.patch).not.toHaveBeenCalled();

    // cancelar com erro
    m.patch.mockRejectedValueOnce(new Error('cancel-fail'));
    await userEvent.click(screen.getByTitle('Cancelar envio'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('cancel-fail'));

    // remover negado
    confirmMock.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByLabelText('Remover agendamento'));
    expect(m.del).not.toHaveBeenCalled();

    // remover com erro -> reverte
    m.del.mockRejectedValueOnce(new Error('rm-fail'));
    await userEvent.click(screen.getByLabelText('Remover agendamento'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Não foi possível remover.'));
  });

  it('gating: sem permissões esconde ações', async () => {
    schedules = [sched({ id: 1, status: 'pendente' })];
    setAuth({ can: () => false });
    render(<EmailAgendado />);
    await screen.findByText('Oi', { selector: 'p.truncate' });
    expect(screen.queryByRole('button', { name: 'Novo agendamento' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Editar agendamento')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Cancelar envio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remover agendamento')).not.toBeInTheDocument();
  });
});

describe('EmailAgendado — ScheduleModal (criar)', () => {
  it('cria agendamento com empresa, modelo e destinatário', async () => {
    templates = [tpl({ id: 1 })];
    m.post.mockResolvedValueOnce({ schedule: sched({ id: 9 }) });
    render(<EmailAgendado />);
    await screen.findByText('Nenhum e-mail agendado');
    await userEvent.click(screen.getByRole('button', { name: 'Novo agendamento' }));
    await screen.findByRole('heading', { name: 'Novo agendamento' });

    // edita o remetente (onChange)
    const remet = screen.getByPlaceholderText('seu@email.com');
    await userEvent.clear(remet);
    await userEvent.type(remet, 'novo@x.com');

    // empresa com e-mail -> vira chip
    await userEvent.click(screen.getByText('mock-pick'));
    expect(await screen.findByText('compras@cliente.com')).toBeInTheDocument();
    expect(screen.getByText('Cliente')).toBeInTheDocument();

    // adiciona outro destinatário via Enter + inválido
    const recip = screen.getByPlaceholderText('adicionar outro…');
    await userEvent.type(recip, 'invalido{Enter}');
    expect(toastMock.error).toHaveBeenCalledWith('E-mail inválido: invalido');
    await userEvent.type(recip, 'outro@x.com{Enter}');
    expect(await screen.findByText('outro@x.com')).toBeInTheDocument();
    // remove um chip
    await userEvent.click(screen.getByLabelText('Remover outro@x.com'));

    // aplica modelo -> preenche assunto/corpo (o 1º select é o de modelo)
    await userEvent.selectOptions(document.querySelector('select')!, '1');
    expect(screen.getByDisplayValue('Assunto A')).toBeInTheDocument();
    // volta para sem modelo (applyTemplate null)
    await userEvent.selectOptions(document.querySelector('select')!, '');

    // reaplica modelo p/ ter assunto/corpo
    await userEvent.selectOptions(document.querySelector('select')!, '1');

    // define data/hora e recorrência
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: '2026-09-10T10:30' } });
    await userEvent.selectOptions(screen.getAllByRole('combobox').at(-1)!, 'diaria');

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/email-schedules', expect.objectContaining({
      company_id: 42, template_id: 1, recorrencia: 'diaria',
    })));
    expect(toastMock.success).toHaveBeenCalledWith('E-mail agendado.');
  });

  it('empresa sem e-mail avisa; validação bloqueia envio incompleto', async () => {
    hoisted.companyHit.email = null;
    m.post.mockRejectedValueOnce(new Error('save-fail'));
    render(<EmailAgendado />);
    await screen.findByText('Nenhum e-mail agendado');
    await userEvent.click(screen.getByRole('button', { name: 'Novo agendamento' }));
    await screen.findByRole('heading', { name: 'Novo agendamento' });

    await userEvent.click(screen.getByText('mock-pick'));
    expect(toastMock.error).toHaveBeenCalledWith('Empresa sem e-mail na base — informe o destinatário manualmente.');

    // salvar incompleto (sem destinatário/assunto/corpo/data)
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(toastMock.error).toHaveBeenCalledWith('Preencha remetente, ao menos um destinatário, assunto, corpo e a data/hora.');

    // preenche tudo e força erro de POST (destinatário via blur)
    const recip = screen.getByPlaceholderText('contato@empresa.com');
    await userEvent.type(recip, 'dest@x.com');
    fireEvent.blur(recip);
    await userEvent.type(screen.getByPlaceholderText('Assunto do e-mail'), 'Assunto');
    await userEvent.type(screen.getByPlaceholderText('Conteúdo do e-mail'), 'Corpo');
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: '2026-09-10T10:30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('save-fail'));
  });

  it('fecha pelo backdrop e mantém aberto ao clicar dentro', async () => {
    render(<EmailAgendado />);
    await screen.findByText('Nenhum e-mail agendado');
    await userEvent.click(screen.getByRole('button', { name: 'Novo agendamento' }));
    const heading = await screen.findByRole('heading', { name: 'Novo agendamento' });

    // clique dentro (stopPropagation) mantém aberto
    await userEvent.click(heading);
    expect(screen.getByRole('heading', { name: 'Novo agendamento' })).toBeInTheDocument();

    // backdrop fecha. `fireEvent.click` não basta: o véu do Modal só fecha
    // quando o gesto COMEÇA nele (pointerdown+pointerup), para arrastar
    // seleção de dentro do form e soltar fora não descartar o que foi digitado.
    await userEvent.click(screen.getByRole('dialog'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Novo agendamento' })).not.toBeInTheDocument());
  });
});

describe('EmailAgendado — ScheduleModal (editar)', () => {
  it('edita um agendamento pendente', async () => {
    schedules = [sched({ id: 1, status: 'pendente', destinatario: 'a@b.com, c@d.com', recorrencia: 'mensal' })];
    m.patch.mockResolvedValueOnce({ schedule: sched({ id: 1, assunto: 'Editado' }) });
    render(<EmailAgendado />);
    await screen.findByText('Oi', { selector: 'p.truncate' });
    await userEvent.click(screen.getByLabelText('Editar agendamento'));
    await screen.findByText('Editar agendamento');
    // chips vindos do destinatário
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
    expect(screen.getByText('c@d.com')).toBeInTheDocument();

    const assunto = screen.getByDisplayValue('Oi');
    await userEvent.clear(assunto);
    await userEvent.type(assunto, 'Novo assunto');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/email-schedules/1', expect.objectContaining({ assunto: 'Novo assunto' })));
    expect(toastMock.success).toHaveBeenCalledWith('Agendamento salvo.');
  });

  it('editar com data inválida e fechar pelo X', async () => {
    schedules = [sched({ id: 1, status: 'cancelado', agendado_para: 'data-ruim' })];
    render(<EmailAgendado />);
    await screen.findByText('Oi', { selector: 'p.truncate' });
    await userEvent.click(screen.getByLabelText('Editar agendamento'));
    await screen.findByText('Editar agendamento');
    // toLocalInput inválido -> campo vazio
    expect((document.querySelector('input[type="datetime-local"]') as HTMLInputElement).value).toBe('');
    await userEvent.click(screen.getByLabelText('Fechar'));
    await waitFor(() => expect(screen.queryByText('Editar agendamento')).not.toBeInTheDocument());
  });
});

describe('EmailAgendado — TemplatesTab', () => {
  const goTemplates = async (): Promise<void> => {
    await userEvent.click(screen.getByRole('button', { name: /Modelos/ }));
    await screen.findByText('Modelos de e-mail');
  };

  it('cria um modelo (com validação, cancelar e ordenação)', async () => {
    templates = [tpl({ id: 5, nome: 'Zeta' })]; // já existe um -> onSaved usa o comparador de ordenação
    m.post.mockResolvedValueOnce({ template: tpl({ id: 2, nome: 'Novo' }) });
    render(<EmailAgendado />);
    await goTemplates();
    await userEvent.click(screen.getByRole('button', { name: 'Novo modelo' }));
    await screen.findByRole('heading', { name: 'Novo modelo' });

    // validação
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(toastMock.error).toHaveBeenCalledWith('Preencha nome, assunto e corpo.');

    // cancela (onClose da TemplatesTab) e reabre
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Novo modelo' })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Novo modelo' }));
    await screen.findByRole('heading', { name: 'Novo modelo' });

    await userEvent.type(screen.getByPlaceholderText(/Apresentação inicial/), 'Novo');
    await userEvent.type(screen.getByPlaceholderText('Assunto do e-mail'), 'Assunto');
    await userEvent.type(screen.getByPlaceholderText('Conteúdo do e-mail'), 'Corpo');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/email-templates', { nome: 'Novo', assunto: 'Assunto', corpo: 'Corpo' }));
    expect(toastMock.success).toHaveBeenCalledWith('Modelo criado.');
  });

  it('edita, salva com erro e remove modelos', async () => {
    templates = [tpl({ id: 1, nome: 'Modelo A' })];
    m.patch.mockRejectedValueOnce(new Error('tpl-fail'));
    render(<EmailAgendado />);
    await goTemplates();
    expect(screen.getByText('Modelo A')).toBeInTheDocument();

    // editar -> erro no patch
    await userEvent.click(screen.getByLabelText('Editar modelo'));
    await screen.findByText('Editar modelo');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('tpl-fail'));

    // editar -> sucesso
    m.patch.mockResolvedValueOnce({ template: tpl({ id: 1, nome: 'Modelo A2' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Modelo salvo.'));

    // remover
    m.del.mockResolvedValueOnce({});
    await userEvent.click(screen.getByLabelText('Remover modelo'));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith('/api/email-templates/1'));
    expect(toastMock.success).toHaveBeenCalledWith('Modelo removido.');
  });

  it('remoção cancelada e com erro; gating', async () => {
    templates = [tpl({ id: 1, nome: 'Modelo A' })];
    render(<EmailAgendado />);
    await goTemplates();

    confirmMock.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByLabelText('Remover modelo'));
    expect(m.del).not.toHaveBeenCalled();

    m.del.mockRejectedValueOnce(new Error('d'));
    await userEvent.click(screen.getByLabelText('Remover modelo'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Não foi possível remover.'));
  });

  it('gating de permissões nos modelos', async () => {
    templates = [tpl({ id: 1 })];
    setAuth({ can: () => false });
    render(<EmailAgendado />);
    await userEvent.click(screen.getByRole('button', { name: /Modelos/ }));
    await screen.findByText('Modelos de e-mail');
    expect(screen.queryByRole('button', { name: 'Novo modelo' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Editar modelo')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remover modelo')).not.toBeInTheDocument();
  });
});
