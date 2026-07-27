// Fecha gaps de format.ts (maskMoney/clampNum/waLink) e do cache em memória do
// api.ts (cachePrefix/cachedGet/invalidate). api real; fetch global mockado.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskMoney, maskMoneyBR, decBR, clampNum, waLink, csvNum } from '../src/lib/format.ts';
import { api } from '../src/lib/api.ts';

describe('format — maskMoney/clampNum/waLink', () => {
  it('maskMoney: só dígitos, vírgula única, 2 casas e teto de inteiros', () => {
    expect(maskMoney('R$ 12,5')).toBe('12,5');
    expect(maskMoney('1234')).toBe('1234');
    expect(maskMoney('12,567')).toBe('12,56');
    expect(maskMoney('123456789012345', 4)).toBe('1234');
  });
  it('maskMoneyBR: agrupa milhar, vírgula única com 2 casas e teto de inteiros', () => {
    expect(maskMoneyBR('')).toBe('');
    expect(maskMoneyBR('1000000')).toBe('1.000.000');
    expect(maskMoneyBR('R$ 1.234.567,89')).toBe('1.234.567,89');   // reaplicar é idempotente
    expect(maskMoneyBR('1234,567')).toBe('1.234,56');
    expect(maskMoneyBR('12,3,4')).toBe('12,34');                    // só a 1ª vírgula é decimal
    expect(maskMoneyBR('-500')).toBe('500');                        // sem negativo
    expect(maskMoneyBR('123456789012345', 4)).toBe('1.234');
  });
  it('decBR: lê o ponto como milhar (dec sozinho daria NaN)', () => {
    expect(decBR('1.234.567,89')).toBe(1234567.89);
    expect(decBR('1000')).toBe(1000);
    expect(decBR('')).toBeNaN();
    expect(decBR('  ')).toBeNaN();
    expect(decBR(null)).toBeNaN();
  });
  it('clampNum: capa em [min,max], NaN→min, aceita vírgula', () => {
    expect(clampNum(5, 0, 10)).toBe(5);
    expect(clampNum(-3, 0, 10)).toBe(0);
    expect(clampNum(99, 0, 10)).toBe(10);
    expect(clampNum('abc', 2, 10)).toBe(2);
    expect(clampNum('3,5', 0, 10)).toBe(3.5);
  });
  it('waLink: null sem dígitos, prefixa 55 quando ausente', () => {
    expect(waLink(null)).toBeNull();
    expect(waLink('123')).toBeNull();
    expect(waLink('(11) 3333-4444')).toBe('https://wa.me/551133334444');
    expect(waLink('5511999998888')).toBe('https://wa.me/5511999998888');
  });
  it('csvNum: número pt-BR com 2 casas; inválido → 0,00', () => {
    expect(csvNum(1234.5)).toBe('1234,50');
    expect(csvNum('abc')).toBe('0,00');
  });
});

describe('api — cache em memória de GETs de referência', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    api.invalidate();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prefixo cacheável deduplica; invalidate por recurso e geral', async () => {
    await api.get('/api/cnae/labels?codes=1');
    await api.get('/api/cnae/labels?codes=1'); // mesma URL → cache, sem novo fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await api.get('/api/stages'); // outro recurso cacheável → +1
    expect(fetchMock).toHaveBeenCalledTimes(2);

    api.invalidate('/api/cnae'); // limpa só cnae
    await api.get('/api/cnae/labels?codes=1');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    api.invalidate(); // limpa tudo
    await api.get('/api/stages');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('path não-cacheável não passa pelo cache', async () => {
    await api.get('/api/whatsapp/status');
    await api.get('/api/whatsapp/status');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('erro não fica cacheado (próxima chamada refaz)', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '{"error":"x"}' });
    await expect(api.get('/api/catalog')).rejects.toThrow();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    await api.get('/api/catalog'); // refaz porque o erro não cacheou
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('mutação invalida o cache do recurso tocado', async () => {
    await api.get('/api/catalog'); // cacheia
    fetchMock.mockClear();
    await api.post('/api/catalog', { nome: 'x' }); // mutação invalida
    await api.get('/api/catalog'); // refaz
    // 1 POST + 1 GET (o GET não veio do cache)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
