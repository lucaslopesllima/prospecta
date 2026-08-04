// resolverSite com DNS e fetch mockados. Cobre a cadeia https/www/http, os
// quatro estados e o bloqueio de SSRF (domínio de terceiro apontando para a
// rede interna do compose ou para o metadata da VPS).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));

const { resolverSite } = await import('../src/site.ts');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterAll(() => vi.unstubAllGlobals());

const publico = [{ address: '200.160.2.3', family: 4 }];
beforeEach(() => {
  fetchMock.mockReset();
  lookup.mockReset();
  lookup.mockResolvedValue(publico);
});

const pagina = (bytes = 5000, status = 200): Response => ({
  status,
  headers: new Headers(),
  arrayBuffer: async () => new ArrayBuffer(bytes),
} as unknown as Response);

const redireciona = (location: string): Response => ({
  status: 301,
  headers: new Headers({ location }),
  arrayBuffer: async () => new ArrayBuffer(0),
} as unknown as Response);

const url = (i: number): string => String(fetchMock.mock.calls[i]![0]);

describe('resolverSite', () => {
  it('apex responde -> vivo, sem tentar www', async () => {
    fetchMock.mockResolvedValueOnce(pagina());
    expect(await resolverSite('acme.com.br')).toEqual({ url: 'https://acme.com.br/', status: 'vivo' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(0)).toBe('https://acme.com.br/');
  });

  // Metade da amostra real só atendia em www.
  it('apex falha -> tenta https://www', async () => {
    fetchMock.mockRejectedValueOnce(new Error('conn')).mockResolvedValueOnce(pagina());
    expect(await resolverSite('acme.com.br')).toMatchObject({ status: 'vivo' });
    expect(url(1)).toBe('https://www.acme.com.br/');
  });

  it('https falha nos dois -> tenta http', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('conn'))
      .mockRejectedValueOnce(new Error('conn'))
      .mockResolvedValueOnce(pagina());
    expect(await resolverSite('acme.com.br')).toMatchObject({ status: 'vivo' });
    expect(url(2)).toBe('http://acme.com.br/');
  });

  it('segue redirect e devolve a URL final', async () => {
    fetchMock
      .mockResolvedValueOnce(redireciona('https://www.vitasal.com.br/'))
      .mockResolvedValueOnce(pagina());
    expect(await resolverSite('vitamais.com.br')).toEqual({
      url: 'https://www.vitasal.com.br/', status: 'vivo',
    });
  });

  it('redirect relativo é resolvido contra a origem', async () => {
    fetchMock.mockResolvedValueOnce(redireciona('/br/')).mockResolvedValueOnce(pagina());
    expect((await resolverSite('acme.com.br')).url).toBe('https://acme.com.br/br/');
  });

  it('excesso de redirects não vira loop infinito', async () => {
    fetchMock.mockResolvedValue(redireciona('https://acme.com.br/x'));
    expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(12); // 3 alvos x 4 saltos
  });

  // italac.com.br: 403 para bot, site normal no navegador. Afirmar "sem site"
  // seria pior que não afirmar nada.
  it('403 -> bloqueado, com URL clicável', async () => {
    fetchMock.mockResolvedValue(pagina(0, 403));
    expect(await resolverSite('italac.com.br')).toEqual({
      url: 'https://italac.com.br/', status: 'bloqueado',
    });
  });

  it('404 em tudo -> sem_pagina', async () => {
    fetchMock.mockResolvedValue(pagina(0, 404));
    expect(await resolverSite('acme.com.br')).toEqual({ url: null, status: 'sem_pagina' });
  });

  it('corpo minúsculo (placeholder de registrar) não conta como site', async () => {
    fetchMock.mockResolvedValue(pagina(120));
    expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
  });

  // 5 dos 20 domínios confirmados na amostra: registrados só para e-mail.
  it('sem DNS no apex e no www -> sem_dns, sem nenhum fetch', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await resolverSite('zaltanapescados.com.br')).toEqual({ url: null, status: 'sem_dns' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DNS só no www ainda sonda', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND')).mockResolvedValue(publico);
    fetchMock.mockResolvedValueOnce(pagina());
    expect((await resolverSite('acme.com.br')).status).toBe('vivo');
  });

  describe('SSRF: domínio de terceiro apontando para dentro', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'rede privada'],
      ['172.16.0.9', 'rede privada'],
      ['192.168.1.10', 'rede privada'],
      ['169.254.169.254', 'metadata da nuvem'],
      ['100.64.0.1', 'CGNAT'],
      ['0.0.0.0', 'rota default'],
      ['::1', 'loopback IPv6'],
      ['fd00::1', 'ULA IPv6'],
      ['fe80::1', 'link-local IPv6'],
      ['::ffff:127.0.0.1', 'IPv4 mapeado em IPv6'],
      ['192.0.0.1', 'IETF protocol assignments'],
      ['198.18.0.1', 'benchmarking'],
      ['198.19.0.1', 'benchmarking'],
      ['224.0.0.1', 'multicast'],
    ])('%s (%s) não é buscado', async (addr) => {
      lookup.mockResolvedValue([{ address: addr, family: addr.includes(':') ? 6 : 4 }]);
      expect(await resolverSite('malicioso.com.br')).toEqual({ url: null, status: 'sem_dns' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('basta UM endereço interno para recusar o host', async () => {
      lookup.mockResolvedValue([{ address: '200.160.2.3', family: 4 }, { address: '127.0.0.1', family: 4 }]);
      expect((await resolverSite('malicioso.com.br')).status).toBe('sem_dns');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // O perigo real do redirect: o 1º salto é público, o 2º aponta pra dentro.
    it('redirect para IP interno é barrado no salto', async () => {
      lookup.mockImplementation((h: string) =>
        h === 'interno.com.br'
          ? Promise.resolve([{ address: '169.254.169.254', family: 4 }])
          : Promise.resolve(publico));
      fetchMock.mockResolvedValue(redireciona('https://interno.com.br/'));
      expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
      // nenhuma chamada saiu para o host interno
      expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes('interno'))).toBe(true);
    });

    it('redirect para URL malformada é descartado', async () => {
      fetchMock.mockResolvedValue({
        status: 301, headers: new Headers({ location: 'http://[inválido' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);
      expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
    });

    it('redirect para esquema não-http é barrado', async () => {
      fetchMock.mockResolvedValue(redireciona('file:///etc/passwd'));
      expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
    });

    it('lista de endereços vazia é recusada', async () => {
      lookup.mockResolvedValue([]);
      expect((await resolverSite('acme.com.br')).status).toBe('sem_dns');
    });
  });

  it('redirect sem header location encerra o salto', async () => {
    fetchMock.mockResolvedValue({
      status: 302, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);
    expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
  });

  it('corpo ilegível não derruba a leitura do status', async () => {
    fetchMock.mockResolvedValue({
      status: 200, headers: new Headers(),
      arrayBuffer: async () => { throw new Error('stream'); },
    } as unknown as Response);
    expect((await resolverSite('acme.com.br')).status).toBe('sem_pagina');
  });
});
