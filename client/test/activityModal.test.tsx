// ActivityCreateModal (criar/editar atividade) + VisitModal (check-in geo + relatório).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityCreateModal, VisitModal, type EditableActivity } from '../src/lib/activityModal.tsx';
import { api } from '../src/lib/api.ts';
import { postField } from '../src/lib/offline.ts';
import { toast } from '../src/lib/toast.tsx';
import type { Activity } from '../src/lib/types.ts';

vi.mock('../src/lib/api.ts', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), invalidate: vi.fn() }, ApiError: class extends Error {} }));
vi.mock('../src/lib/offline.ts', () => ({ postField: vi.fn() }));
vi.mock('../src/lib/toast.tsx', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// useAuth: por padrão libera as permissões dos tipos de agendamento (whatsapp/email)
// e informa o e-mail do usuário (sugestão de remetente). Testes de gate sobrescrevem.
const canMock = vi.fn((_code: string) => true);
vi.mock('../src/lib/auth.tsx', () => ({ useAuth: () => ({ can: canMock, user: { email: 'eu@teste.com' } }) }));
const m = vi.mocked(api);
const pf = vi.mocked(postField);

const preset = new Date('2026-07-11T10:00:00');
const funnel = [{ company_id: 5, label: 'Alvo Comercio' }];
const represented = [{ id: 9, nome: 'Repres X' }];

beforeEach(() => {
  m.get.mockReset(); m.post.mockReset(); m.patch.mockReset();
  pf.mockReset();
  canMock.mockReset(); canMock.mockReturnValue(true);
  vi.mocked(toast.success).mockReset(); vi.mocked(toast.error).mockReset();
  // id vem string do pg (bigint) — reproduz o real p/ travar o bug de coerção.
  m.get.mockResolvedValue({ contacts: [{ id: '1', nome: 'Contato A', telefone: '11912345678' }] });
});

describe('ActivityCreateModal', () => {
  it('cria atividade preenchendo título, tipo, empresa, representada e contato', async () => {
    const onSaved = vi.fn();
    m.post.mockResolvedValueOnce({});
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByText('Nova atividade')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/Ligar para cliente/), 'Ligar');
    await userEvent.click(screen.getByText('Ligação'));
    // seleciona empresa do funil → carrega contatos
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], '5');
    expect(await screen.findByRole('option', { name: 'Contato A' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getAllByRole('combobox')[2], '1'); // contato
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/activities', expect.objectContaining({ titulo: 'Ligar', tipo: 'ligacao', company_id: 5, contact_id: 1 })));
    expect(toast.success).toHaveBeenCalledWith('Atividade criada.');
    expect(onSaved).toHaveBeenCalled();
  });

  it('valida título e data obrigatórios', async () => {
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(toast.error).toHaveBeenCalledWith('Informe o título da atividade.');
    // com título mas sem data
    await userEvent.type(screen.getByPlaceholderText(/Ligar para cliente/), 'X');
    const dt = screen.getByDisplayValue(/2026-07-11/);
    await userEvent.clear(dt);
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(toast.error).toHaveBeenCalledWith('Informe a data e hora.');
    expect(m.post).not.toHaveBeenCalled();
  });

  it('modo edição usa PATCH e representada carrega contatos', async () => {
    const activity: EditableActivity = { id: 42, titulo: 'Reunião', tipo: 'reuniao', start_at: '2026-07-12T14:00:00.000Z', company_id: null, represented_id: 9, contact_id: null };
    m.patch.mockResolvedValueOnce({});
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} activity={activity} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Editar atividade')).toBeInTheDocument();
    await waitFor(() => expect(m.get).toHaveBeenCalledWith('/api/contacts?represented_id=9'));
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('/api/activities/42', expect.objectContaining({ titulo: 'Reunião' })));
    expect(toast.success).toHaveBeenCalledWith('Atividade salva.');
  });

  it('presetCompanyId carrega contatos; erro no submit dispara toast', async () => {
    m.post.mockRejectedValueOnce(new Error('sem permissão'));
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} presetCompanyId={5} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(m.get).toHaveBeenCalledWith('/api/contacts?company_id=5'));
    await userEvent.type(screen.getByPlaceholderText(/Ligar para cliente/), 'Tarefa');
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem permissão'));
  });

  it('erro não-Error no submit usa mensagem padrão; falha ao carregar contatos zera lista', async () => {
    m.get.mockRejectedValue('boom'); // catch → setContacts([])
    m.post.mockRejectedValueOnce('str');
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} presetCompanyId={5} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/Ligar para cliente/), 'Tarefa');
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível salvar.'));
  });

  it('sem empresa/representada o contato fica desabilitado; trocar zera contato', async () => {
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={vi.fn()} />);
    const combos = screen.getAllByRole('combobox');
    const contatoSelect = combos[2] as HTMLSelectElement;
    expect(contatoSelect).toBeDisabled();
    expect(screen.getByText('Escolha empresa ou representada')).toBeInTheDocument();
    // seleciona representada → habilita e busca; depois volta pra sem vínculo → limpa contatos
    await userEvent.selectOptions(combos[1], '9');
    await waitFor(() => expect(contatoSelect).not.toBeDisabled());
    await userEvent.selectOptions(combos[1], '');
    await waitFor(() => expect(contatoSelect).toBeDisabled());
  });

  it('fecha ao clicar no backdrop', async () => {
    const onClose = vi.fn();
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText('Fechar'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('agenda WhatsApp: esconde título, valida número/mensagem, autofill do contato e POST schedule-direct', async () => {
    const onSaved = vi.fn();
    m.post.mockResolvedValueOnce({});
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={onSaved} />);
    await userEvent.click(screen.getByText('WhatsApp'));
    expect(screen.queryByPlaceholderText(/Ligar para cliente/)).not.toBeInTheDocument();
    // sem número → valida
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(toast.error).toHaveBeenCalledWith('Informe o número de WhatsApp.');
    // empresa + contato → puxa o telefone pro número
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], '5');
    await screen.findByRole('option', { name: 'Contato A' });
    await userEvent.selectOptions(screen.getAllByRole('combobox')[2], '1');
    const numero = screen.getByPlaceholderText(/91234-5678/) as HTMLInputElement;
    await waitFor(() => expect(numero.value).toBe('11912345678'));
    // edita o número manualmente (sobrescreve o autofill)
    await userEvent.clear(numero);
    await userEvent.type(numero, '11955550000');
    // sem mensagem → valida
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(toast.error).toHaveBeenCalledWith('Escreva a mensagem.');
    await userEvent.type(screen.getByPlaceholderText(/Texto da mensagem/), 'Olá!');
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/whatsapp/chats/schedule-direct',
      expect.objectContaining({ numero: '(11) 95555-0000', text: 'Olá!', company_id: 5, contact_id: 1 })));
    expect(toast.success).toHaveBeenCalledWith('WhatsApp agendado.');
    expect(onSaved).toHaveBeenCalled();
  });

  it('agenda E-mail: remetente sugerido, valida obrigatórios e destinatário, e POST email-schedules', async () => {
    const onSaved = vi.fn();
    m.post.mockResolvedValueOnce({});
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={onSaved} />);
    await userEvent.click(screen.getByText('E-mail'));
    expect((screen.getByPlaceholderText('seu@email.com') as HTMLInputElement).value).toBe('eu@teste.com');
    // sem destinatário → valida obrigatórios
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(toast.error).toHaveBeenCalledWith('Preencha remetente, destinatário, assunto e corpo.');
    await userEvent.type(screen.getByPlaceholderText('Assunto do e-mail'), 'Proposta');
    await userEvent.type(screen.getByPlaceholderText('Conteúdo do e-mail'), 'Segue');
    await userEvent.type(screen.getByPlaceholderText(/contato@empresa.com/), 'a@b.com, ruim');
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(toast.error).toHaveBeenCalledWith('Há e-mail de destinatário inválido.');
    await userEvent.clear(screen.getByPlaceholderText(/contato@empresa.com/));
    await userEvent.type(screen.getByPlaceholderText(/contato@empresa.com/), 'a@b.com');
    // edita remetente (mesmo valor) e a repetição para exercitar os handlers
    await userEvent.clear(screen.getByPlaceholderText('seu@email.com'));
    await userEvent.type(screen.getByPlaceholderText('seu@email.com'), 'eu@teste.com');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], '5'); // empresa vínculo
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], 'semanal'); // repetição
    await userEvent.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledWith('/api/email-schedules',
      expect.objectContaining({ remetente: 'eu@teste.com', destinatario: 'a@b.com', assunto: 'Proposta', corpo: 'Segue', company_id: 5, recorrencia: 'semanal' })));
    expect(toast.success).toHaveBeenCalledWith('E-mail agendado.');
    expect(onSaved).toHaveBeenCalled();
  });

  it('autofill do número funciona ao escolher o contato antes de trocar para WhatsApp', async () => {
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={vi.fn()} />);
    // ainda em "tarefa": escolhe empresa + contato (sem campo de número visível)
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], '5');
    await screen.findByRole('option', { name: 'Contato A' });
    await userEvent.selectOptions(screen.getAllByRole('combobox')[2], '1');
    // troca para WhatsApp → o número é preenchido pelo telefone do contato
    await userEvent.click(screen.getByText('WhatsApp'));
    const numero = screen.getByPlaceholderText(/91234-5678/) as HTMLInputElement;
    await waitFor(() => expect(numero.value).toBe('11912345678'));
  });

  it('sem permissão de agendamento os tipos WhatsApp/E-mail não aparecem', () => {
    canMock.mockReturnValue(false);
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText('WhatsApp')).not.toBeInTheDocument();
    expect(screen.queryByText('E-mail')).not.toBeInTheDocument();
  });

  it('modo edição não oferece os tipos de agendamento', () => {
    const activity: EditableActivity = { id: 7, titulo: 'T', tipo: 'tarefa', start_at: '2026-07-12T14:00:00.000Z', company_id: null, represented_id: null, contact_id: null };
    render(<ActivityCreateModal preset={preset} funnel={funnel} represented={represented} activity={activity} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText('WhatsApp')).not.toBeInTheDocument();
    expect(screen.queryByText('E-mail')).not.toBeInTheDocument();
  });
});

const activity = (over: Partial<Activity> = {}): Activity => ({
  id: 12, tipo: 'visita', titulo: 'Visita ACME', start_at: '2026-07-11T10:00:00.000Z', end_at: null,
  company_id: 5, status: 'pendente', razao_social: 'ACME LTDA',
  represented_id: null, contact_id: null, represented_nome: null, contact_nome: null, ...over,
});

describe('VisitModal', () => {
  const geo = { getCurrentPosition: vi.fn() };
  beforeEach(() => {
    geo.getCurrentPosition.mockReset();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geo });
  });

  it('check-in online: registra e salva relatório chamando onSaved', async () => {
    geo.getCurrentPosition.mockImplementation((ok: PositionCallback) => ok({ coords: { latitude: -23, longitude: -46 } } as GeolocationPosition));
    pf.mockResolvedValueOnce({ queued: false }); // checkin
    pf.mockResolvedValueOnce({ queued: false }); // report
    const onSaved = vi.fn();
    render(<VisitModal activity={activity()} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByText('ACME LTDA')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Check-in/ }));
    await waitFor(() => expect(pf).toHaveBeenCalledWith('/api/activities/12/checkin', { lat: -23, lon: -46 }, expect.any(String)));
    await screen.findByRole('button', { name: /Refazer/ });
    await userEvent.selectOptions(screen.getByRole('combobox'), 'Em negociação');
    await userEvent.type(screen.getByPlaceholderText(/enviar proposta/), 'Passo');
    await userEvent.type(screen.getByPlaceholderText(/Como foi a visita/), 'Boa');
    await userEvent.click(screen.getByRole('button', { name: /Salvar visita/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('check-in e relatório offline mostram aviso de fila', async () => {
    geo.getCurrentPosition.mockImplementation((ok: PositionCallback) => ok({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition));
    pf.mockResolvedValueOnce({ queued: true });
    render(<VisitModal activity={activity({ razao_social: null })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Check-in/ }));
    expect(await screen.findByText(/Check-in salvo offline/)).toBeInTheDocument();
    pf.mockResolvedValueOnce({ queued: true });
    await userEvent.click(screen.getByRole('button', { name: /Salvar visita/ }));
    expect(await screen.findByText(/Relatório salvo offline/)).toBeInTheDocument();
  });

  it('check-in com falha de rede e permissão negada', async () => {
    // permissão negada (error callback)
    geo.getCurrentPosition.mockImplementationOnce((_ok: PositionCallback, err: PositionErrorCallback) => err({} as GeolocationPositionError));
    render(<VisitModal activity={activity()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Check-in/ }));
    expect(await screen.findByText(/permissão negada/)).toBeInTheDocument();
    // sucesso na geo mas postField falha
    geo.getCurrentPosition.mockImplementation((ok: PositionCallback) => ok({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition));
    pf.mockRejectedValueOnce(new Error('x'));
    await userEvent.click(screen.getByRole('button', { name: /Check-in/ }));
    expect(await screen.findByText('Falha ao registrar check-in.')).toBeInTheDocument();
  });

  it('sem geolocalização avisa indisponível; relatório com erro mostra mensagem', async () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    pf.mockRejectedValueOnce(new Error('falhou'));
    render(<VisitModal activity={activity({ checkin_at: '2026-07-10T09:00:00.000Z', relatorio: { resultado: 'Pedido fechado', proximo_passo: 'p', texto: 't' } })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText(/Registrado/)).toBeInTheDocument(); // checkin_at inicial
    await userEvent.click(screen.getByRole('button', { name: /Refazer/ }));
    expect(await screen.findByText(/Geolocalização indisponível/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Salvar visita/ }));
    expect(await screen.findByText('Falha ao salvar o relatório.')).toBeInTheDocument();
  });

  it('fecha no backdrop e no botão fechar', async () => {
    const onClose = vi.fn();
    render(<VisitModal activity={activity()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('dialog'));
    for (const b of screen.getAllByRole('button', { name: 'Fechar' })) await userEvent.click(b);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
