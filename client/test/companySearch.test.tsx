// CompanySearch: busca global de empresas (RFB) com debounce, dropdown, seleção,
// bloqueio de itens já no funil, e fechamento ao clicar fora.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompanySearch } from '../src/lib/companySearch.tsx';
import { api } from '../src/lib/api.ts';
import type { CompanyHit } from '../src/lib/types.ts';

vi.mock('../src/lib/api.ts', () => ({ api: { get: vi.fn(), invalidate: vi.fn() }, BUSCA_DEBOUNCE_MS: 300, ApiError: class extends Error {} }));
const m = vi.mocked(api);

const hit = (over: Partial<CompanyHit> = {}): CompanyHit => ({
  id: 1, cnpj: '11.222.333/0001-44', razao_social: 'Alvo Comercio LTDA', nome_fantasia: 'Loja Alvo',
  telefone1: null, telefone2: null, email: null, logradouro: null, numero: null, bairro: null,
  cep: null, uf: 'SP', cidade: 'São Paulo', ...over,
});

beforeEach(() => {
  m.get.mockReset();
  m.get.mockResolvedValue({ companies: [hit()] });
});

describe('CompanySearch', () => {
  it('não busca com menos de 3 caracteres', async () => {
    render(<CompanySearch onPick={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/Buscar empresa/), 'ab');
    await new Promise((r) => setTimeout(r, 400));
    expect(m.get).not.toHaveBeenCalled();
  });

  it('busca (debounce), abre dropdown e seleciona um resultado', async () => {
    const onPick = vi.fn();
    render(<CompanySearch onPick={onPick} />);
    const inp = screen.getByPlaceholderText(/Buscar empresa/);
    await userEvent.type(inp, 'alvo');
    expect(await screen.findByText('Loja Alvo', undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/São Paulo/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Loja Alvo'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect((inp as HTMLInputElement).value).toBe('');
  });

  it('mostra "Nenhuma empresa encontrada" e re-foca reabrindo', async () => {
    m.get.mockResolvedValue({ companies: [] });
    render(<CompanySearch onPick={vi.fn()} />);
    const inp = screen.getByPlaceholderText(/Buscar empresa/);
    await userEvent.type(inp, 'zzz');
    expect(await screen.findByText('Nenhuma empresa encontrada.', undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('reabre no foco quando já há resultados e fecha ao clicar fora', async () => {
    render(<CompanySearch onPick={vi.fn()} />);
    const inp = screen.getByPlaceholderText(/Buscar empresa/);
    await userEvent.type(inp, 'alvo');
    await screen.findByText('Loja Alvo', undefined, { timeout: 2000 });
    // clicar fora fecha
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText('Loja Alvo')).not.toBeInTheDocument());
    // foco reabre (hits.length truthy)
    fireEvent.focus(inp);
    expect(await screen.findByText('Loja Alvo')).toBeInTheDocument();
  });

  it('empresa já no funil aparece bloqueada quando disableInFunnel', async () => {
    m.get.mockResolvedValue({ companies: [hit({ in_funnel: true, nome_fantasia: null, cidade: null })] });
    const onPick = vi.fn();
    render(<CompanySearch onPick={onPick} disableInFunnel />);
    await userEvent.type(screen.getByPlaceholderText(/Buscar empresa/), 'alvo');
    const btn = await screen.findByTitle('Empresa já está no funil', undefined, { timeout: 2000 });
    expect(btn).toBeDisabled();
    expect(screen.getByText('no funil')).toBeInTheDocument();
    // razao_social usado quando nome_fantasia null
    expect(screen.getByText('Alvo Comercio LTDA')).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('mostra "Buscando…" enquanto a próxima busca não resolve', async () => {
    // 1ª busca resolve vazio (abre dropdown); 2ª fica pendente → estado loading com dropdown aberto
    let resolve2: (v: unknown) => void = () => {};
    m.get.mockResolvedValueOnce({ companies: [] })
      .mockImplementationOnce(() => new Promise((res) => { resolve2 = res; }));
    render(<CompanySearch onPick={vi.fn()} />);
    const inp = screen.getByPlaceholderText(/Buscar empresa/);
    await userEvent.type(inp, 'zzz');
    await screen.findByText('Nenhuma empresa encontrada.', undefined, { timeout: 2000 });
    await userEvent.type(inp, 'z');
    expect(await screen.findByText('Buscando…', undefined, { timeout: 2000 })).toBeInTheDocument();
    resolve2({ companies: [] });
  });
});
