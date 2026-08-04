// Cliente RDAP do registro.br com fetch mockado. Cobre os três estados de
// domínio (livre / confirmado / sem_titular), o portão nicbr_domainCount e a
// geração de candidatos. O throttle (700ms) roda de verdade entre os casos —
// mesma escolha do geocode.test.ts, sem fakes de timer.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { candidatosDominio, consultarDominio, contarDominios, dominioDeEmail } from '../src/rdap.ts';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => fetchMock.mockReset());

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body } as unknown as Response);
const naoEncontrado = (): Response =>
  ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
const erro = (): Response =>
  ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);

const comTitular = (identifier: string, type = 'cnpj'): unknown => ({
  entities: [{ roles: ['registrant'], publicIds: [{ type, identifier }] }],
});

describe('consultarDominio', () => {
  it('404 -> livre', async () => {
    fetchMock.mockResolvedValueOnce(naoEncontrado());
    expect(await consultarDominio('naoexiste.com.br')).toEqual({ estado: 'livre' });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/domain/naoexiste.com.br');
  });

  it('titular com CNPJ -> confirmado, sem máscara', async () => {
    fetchMock.mockResolvedValueOnce(ok(comTitular('01.257.995/0001-33')));
    expect(await consultarDominio('italac.com.br')).toEqual({
      estado: 'confirmado', titularCnpj: '01257995000133',
    });
  });

  // O caso que motivou o tipo: o registro.br responde 200 completo mas omite
  // publicIds quando a cota de divulgação do IP estourou. Não é "não é dele".
  it('registrado sem publicIds -> sem_titular', async () => {
    fetchMock.mockResolvedValueOnce(ok({ entities: [{ roles: ['registrant'] }] }));
    expect(await consultarDominio('frigol.com.br')).toEqual({ estado: 'sem_titular' });
  });

  it('sem entidades -> sem_titular', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    expect(await consultarDominio('x.com.br')).toEqual({ estado: 'sem_titular' });
  });

  it('entidade que não é registrant é ignorada', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      entities: [{ roles: ['administrative'], publicIds: [{ type: 'cnpj', identifier: '01257995000133' }] }],
    }));
    expect(await consultarDominio('x.com.br')).toEqual({ estado: 'sem_titular' });
  });

  it('publicId de outro tipo é ignorado', async () => {
    fetchMock.mockResolvedValueOnce(ok(comTitular('12345678901', 'cpf')));
    expect(await consultarDominio('x.com.br')).toEqual({ estado: 'sem_titular' });
  });

  it('identificador que não tem 14 dígitos é ignorado', async () => {
    fetchMock.mockResolvedValueOnce(ok(comTitular('123')));
    expect(await consultarDominio('x.com.br')).toEqual({ estado: 'sem_titular' });
  });

  it('5xx -> null (indeterminado, não conclui nada)', async () => {
    fetchMock.mockResolvedValueOnce(erro());
    expect(await consultarDominio('x.com.br')).toBeNull();
  });

  it('fetch lança -> null', async () => {
    fetchMock.mockRejectedValueOnce(new Error('net'));
    expect(await consultarDominio('x.com.br')).toBeNull();
  });
});

describe('contarDominios', () => {
  it('devolve nicbr_domainCount', async () => {
    fetchMock.mockResolvedValueOnce(ok({ nicbr_domainCount: 204 }));
    expect(await contarDominios('47.960.950/0001-21')).toBe(204);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/entity/47960950000121');
  });

  it('CNPJ sem cadastro (404) -> 0', async () => {
    fetchMock.mockResolvedValueOnce(naoEncontrado());
    expect(await contarDominios('11222333000181')).toBe(0);
  });

  it('campo ausente -> null (indeterminado)', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    expect(await contarDominios('11222333000181')).toBeNull();
  });

  it('erro de rede -> null', async () => {
    fetchMock.mockResolvedValueOnce(erro());
    expect(await contarDominios('11222333000181')).toBeNull();
  });
});

describe('dominioDeEmail', () => {
  it('extrai o domínio próprio', () => {
    expect(dominioDeEmail('Vendas@Malinski.com.BR')).toBe('malinski.com.br');
  });

  it('aceita domínio fora do .br', () => {
    expect(dominioDeEmail('contato@ares-global.com')).toBe('ares-global.com');
  });

  // 83% da base cai aqui — consultar o registro.br por gmail.com é desperdício.
  it.each([
    'x@gmail.com', 'x@hotmail.com', 'x@outlook.com', 'x@yahoo.com.br',
    'x@bol.com.br', 'x@uol.com.br', 'x@terra.com.br', 'x@ig.com.br',
    'x@icloud.com', 'x@live.com', 'x@globo.com', 'x@r7.com',
  ])('%s -> null (provedor gratuito)', (email) => {
    expect(dominioDeEmail(email)).toBeNull();
  });

  // O domínio do contador PASSA aqui de propósito: quem o descarta é a
  // confirmação por CNPJ no registro.br, não uma lista de nomes.
  it('domínio de contabilidade não é filtrado aqui', () => {
    expect(dominioDeEmail('fiscal@contabilizei.com.br')).toBe('contabilizei.com.br');
  });

  it.each([
    ['', 'vazio'], [null, 'null'], [undefined, 'undefined'],
    ['sem-arroba', 'sem @'], ['a@', 'sem domínio'], ['a@semponto', 'sem ponto'],
  ])('%s (%s) -> null', (email) => {
    expect(dominioDeEmail(email as string | null | undefined)).toBeNull();
  });

  it('limpa lixo e ponto final sobrando', () => {
    expect(dominioDeEmail('a@ acme.com.br.')).toBe('acme.com.br');
  });
});

describe('candidatosDominio', () => {
  it('fantasia vem antes da razão social', async () => {
    // ITALAC é a marca; GOIASMINAS é a razão. O domínio real é italac.com.br.
    const c = candidatosDominio('GOIASMINAS INDUSTRIA DE LATICINIOS LTDA', 'ITALAC');
    expect(c[0]).toBe('italac');
    expect(c).toContain('goiasminaslaticinios');
  });

  it('remove tipo societário e pontuação', () => {
    expect(candidatosDominio('MALINSKI MADEIRAS LTDA')).toContain('malinskimadeiras');
  });

  it('quebra a sigla depois do hífen', () => {
    const c = candidatosDominio('FEDERACAO DE TIRO ESPORTIVO - FROTEC');
    expect(c).toContain('federacaotiroesportivofrotec');
  });

  it('gera versão sem palavras genéricas', () => {
    const c = candidatosDominio('BUDNY INDUSTRIA E COMERCIO DE ALIMENTOS LTDA');
    expect(c).toContain('budnyalimentos'); // sem INDUSTRIA/COMERCIO/DE/E
    expect(c).toContain('budny');
  });

  it('normaliza acento e caixa', () => {
    expect(candidatosDominio('Indústria Ação Ltda')).toContain('industriaacao');
  });

  it('sem fantasia usa só a razão social', () => {
    expect(candidatosDominio('RICAL COMERCIO LTDA', null)).toContain('rical');
  });

  it('nome que vira vazio não gera candidato', () => {
    expect(candidatosDominio('LTDA', 'ME')).toEqual([]);
  });

  it('nome só de palavras genéricas ainda gera o slug cheio', () => {
    // 'COMERCIO E INDUSTRIA' -> enxuto fica vazio, mas o slug cheio serve.
    expect(candidatosDominio('COMERCIO E INDUSTRIA')).toEqual(['comercioeindustria']);
  });

  it('descarta candidato com menos de 3 chars', () => {
    expect(candidatosDominio('AB CD', 'XY')).not.toContain('xy');
  });

  it('descarta candidato com mais de 40 chars', () => {
    const gigante = 'ASSOCIACAO NACIONAL DOS PRODUTORES RURAIS INDEPENDENTES DO VALE';
    expect(candidatosDominio(gigante).every((c) => c.length <= 40)).toBe(true);
  });

  it('deduplica e limita a 6', () => {
    const c = candidatosDominio('ALFA BETA GAMA DELTA EPSILON ZETA LTDA', 'ALFA BETA GAMA');
    expect(c.length).toBeLessThanOrEqual(6);
    expect(new Set(c).size).toBe(c.length);
  });
});
