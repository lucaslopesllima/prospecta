// Tela de login: alterna login/registro, submete, mostra erro, redireciona logado.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Login } from '../src/pages/Login.tsx';
import { useAuth } from '../src/lib/auth.tsx';
import { api } from '../src/lib/api.ts';

vi.mock('../src/lib/auth.tsx', () => ({ useAuth: vi.fn() }));
vi.mock('../src/lib/api.ts', () => ({ api: { get: vi.fn() }, ApiError: class extends Error {} }));
const useAuthMock = vi.mocked(useAuth);
const apiMock = vi.mocked(api);

const authState = (over: Partial<ReturnType<typeof useAuth>> = {}): ReturnType<typeof useAuth> => ({
  user: null, loading: false,
  login: vi.fn(), register: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
  ...over,
});

const mount = (): ReturnType<typeof render> => render(
  <MemoryRouter initialEntries={['/login']}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<div>HOME</div>} />
    </Routes>
  </MemoryRouter>,
);

// A aba "Criar conta" só existe se o servidor disser que o cadastro está aberto
// (/api/config). Default dos testes: aberto — os casos de registro dependem dela.
beforeEach(() => {
  useAuthMock.mockReturnValue(authState());
  apiMock.get.mockReset();
  apiMock.get.mockResolvedValue({ signup_enabled: true });
});

// Espera o efeito de /api/config resolver e devolve a aba de cadastro.
const abaCriarConta = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Criar conta' });

describe('Login', () => {
  it('submete credenciais no modo login', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    useAuthMock.mockReturnValue(authState({ login }));
    mount();

    await userEvent.type(screen.getByPlaceholderText('voce@empresa.com'), 'eu@org.com');
    await userEvent.type(screen.getByPlaceholderText('mínimo 6 caracteres'), 'senha123');
    await userEvent.click(screen.getAllByRole('button', { name: 'Entrar' }).at(-1)!); // tab + submit têm o mesmo nome
    expect(login).toHaveBeenCalledWith('eu@org.com', 'senha123');
  });

  it('modo registro tem tipo de conta com Individual pré-selecionado', async () => {
    useAuthMock.mockReturnValue(authState());
    mount();
    await userEvent.click(await abaCriarConta());

    const individual = screen.getByRole('radio', { name: /Individual/ }) as HTMLInputElement;
    const escritorio = screen.getByRole('radio', { name: /Escritório/ }) as HTMLInputElement;
    expect(individual.checked).toBe(true);
    expect(escritorio.checked).toBe(false);
    // default individual → label/placeholder do nome
    expect(screen.getByPlaceholderText('João Silva Representações')).toBeInTheDocument();
  });

  it('registro default (individual) chama register com tipo_conta', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    useAuthMock.mockReturnValue(authState({ register }));
    mount();

    await userEvent.click(await abaCriarConta());
    await userEvent.type(screen.getByPlaceholderText('João Silva Representações'), 'Minha Org');
    await userEvent.type(screen.getByPlaceholderText('voce@empresa.com'), 'eu@org.com');
    await userEvent.type(screen.getByPlaceholderText('mínimo 6 caracteres'), 'senha123');
    await userEvent.click(screen.getAllByRole('button', { name: 'Criar conta' })[1]!);
    expect(register).toHaveBeenCalledWith('Minha Org', 'eu@org.com', 'senha123', 'individual');
  });

  it('escolher Escritório muda o label do nome e o tipo enviado', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    useAuthMock.mockReturnValue(authState({ register }));
    mount();

    await userEvent.click(await abaCriarConta());
    await userEvent.click(screen.getByRole('radio', { name: /Escritório/ }));
    await userEvent.type(screen.getByPlaceholderText('Minha Representação'), 'Meu Escritório');
    await userEvent.type(screen.getByPlaceholderText('voce@empresa.com'), 'eu@org.com');
    await userEvent.type(screen.getByPlaceholderText('mínimo 6 caracteres'), 'senha123');
    await userEvent.click(screen.getAllByRole('button', { name: 'Criar conta' })[1]!);
    expect(register).toHaveBeenCalledWith('Meu Escritório', 'eu@org.com', 'senha123', 'escritorio');
  });

  it('mostra a mensagem de erro da API', async () => {
    const login = vi.fn().mockRejectedValue(new Error('credenciais inválidas'));
    useAuthMock.mockReturnValue(authState({ login }));
    mount();

    await userEvent.type(screen.getByPlaceholderText('voce@empresa.com'), 'eu@org.com');
    await userEvent.type(screen.getByPlaceholderText('mínimo 6 caracteres'), 'senhaerrada');
    await userEvent.click(screen.getAllByRole('button', { name: 'Entrar' }).at(-1)!);
    expect(await screen.findByText('credenciais inválidas')).toBeInTheDocument();
  });

  it('usuário logado é redirecionado para /', () => {
    useAuthMock.mockReturnValue(authState({
      user: { id: 1, email: 'a@b.c', role: 'admin', org_id: 1 },
    }));
    mount();
    expect(screen.getByText('HOME')).toBeInTheDocument();
  });

  it('cadastro fechado no servidor esconde a aba "Criar conta"', async () => {
    apiMock.get.mockResolvedValue({ signup_enabled: false });
    mount();
    expect(await screen.findByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar conta' })).toBeNull();
    expect(apiMock.get).toHaveBeenCalledWith('/api/config');
  });

  it('/api/config fora do ar deixa só o login', async () => {
    apiMock.get.mockRejectedValue(new Error('offline'));
    mount();
    expect(await screen.findByRole('heading', { name: 'Bem-vindo de volta' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar conta' })).toBeNull();
  });

  it('alterna a visibilidade da senha', async () => {
    mount();
    const toggle = screen.getByRole('button', { name: 'Mostrar senha' });
    const senha = document.querySelector('input[type="password"]')!;
    expect(senha).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Ocultar senha' })).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull(); // virou text
  });
});
