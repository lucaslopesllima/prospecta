// descobrirDominio com o cliente RDAP mockado e banco de verdade: cobre a
// cascata de cache (company_dominio -> rdap_domain -> portão -> varredura) e,
// principalmente, a regra de não cachear negativo quando o registro.br censura.
//
// rdap_domain e company_dominio são globais e sobrevivem entre rodadas da suíte
// (mesma pegadinha do routes-company-whatsapp.test.ts). Por isso TODO nome de
// empresa leva TAG: o domínio derivado do nome muda a cada execução e a rodada
// nunca lê o cache da anterior.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { consultarDominio, contarDominios, resolverSite } = vi.hoisted(() => ({
  consultarDominio: vi.fn(),
  contarDominios: vi.fn(),
  resolverSite: vi.fn(),
}));
vi.mock('../src/rdap.ts', async (orig) => ({
  ...(await orig<typeof import('../src/rdap.ts')>()),
  consultarDominio, contarDominios,
}));
// Sem este mock a sondagem sai para a internet de verdade dentro do teste.
vi.mock('../src/site.ts', () => ({ resolverSite }));

const { descobrirDominio } = await import('../src/enriquecimento.ts');
const { one, query, pool } = await import('../src/db.ts');

afterAll(() => pool.end());
beforeEach(() => {
  consultarDominio.mockReset();
  contarDominios.mockReset();
  resolverSite.mockReset();
  contarDominios.mockResolvedValue(10); // portão aberto por padrão
  resolverSite.mockImplementation((d: string) =>
    Promise.resolve({ url: `https://${d}/`, status: 'vivo' }));
});

const TAG = String(Date.now()).slice(-8);
const nome = (b: string): string => `${b}${TAG}`;
const dom = (b: string, tld = 'com.br'): string => `${b.toLowerCase()}${TAG}.${tld}`;

// CNPJ com RAIZ única por empresa: makeCompany() do helpers gera a rodada
// inteira sob a mesma raiz, e a busca por "irmão" (matriz/filial) casaria entre
// testes diferentes. Os 6 primeiros dígitos também variam por rodada.
let n = 0;
const raizUnica = (): string => TAG.slice(0, 6) + String(++n).padStart(2, '0');

async function empresa(razao: string, fantasia: string | null = null, email: string | null = null): Promise<{
  id: number; cnpj: string; razao_social: string; nome_fantasia: string | null; email: string | null;
}> {
  const cnpj = `${raizUnica()}0001${String(n % 100).padStart(2, '0')}`;
  const r = await one<{ id: number }>(
    `INSERT INTO companies (cnpj, razao_social, nome_fantasia, email, cnae_principal, uf, regiao)
     VALUES ($1, $2, $3, $4, 4781400, 'SP', 'SE') RETURNING id`,
    [cnpj, razao, fantasia, email],
  );
  return { id: Number(r!.id), cnpj, razao_social: razao, nome_fantasia: fantasia, email };
}

const salvo = (id: number) =>
  one<{ dominio: string | null; confianca: number }>(
    'SELECT dominio, confianca FROM company_dominio WHERE company_id = $1', [id]);

describe('descobrirDominio', () => {
  it('confirma pelo CNPJ do titular e grava com confiança 100', async () => {
    const e = await empresa('ACME COMERCIO LTDA', nome('ACME'));
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });

    expect(await descobrirDominio(e)).toEqual({
      dominio: dom('acme'), site_url: `https://${dom('acme')}/`, site_status: 'vivo',
      status: 'achou', fonte: 'registrobr', confianca: 100, cached: false,
    });
    expect(consultarDominio).toHaveBeenCalledWith(dom('acme'));
    expect(await salvo(e.id)).toEqual({ dominio: dom('acme'), confianca: 100 });
  });

  // ZALTANA na amostra real: domínio confirmado por CNPJ, mas sem DNS nenhum —
  // registrado só para e-mail. O domínio continua útil (contato@dominio), então
  // é devolvido; o que não existe é a URL.
  it('domínio confirmado sem site: guarda o domínio, site_url nulo', async () => {
    const e = await empresa('ZALTANA PESCADOS LTDA', nome('ZALTANA'));
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
    resolverSite.mockResolvedValue({ url: null, status: 'sem_dns' });

    expect(await descobrirDominio(e)).toMatchObject({
      dominio: dom('zaltana'), site_url: null, site_status: 'sem_dns', status: 'achou',
    });
    expect(await one('SELECT site_url, site_status FROM company_dominio WHERE company_id = $1', [e.id]))
      .toEqual({ site_url: null, site_status: 'sem_dns' });
  });

  // WAF barrando a sondagem não pode virar "sem site": a URL segue clicável.
  it('site bloqueado por WAF ainda devolve URL', async () => {
    const e = await empresa('ITALAC LTDA', nome('ITALAC'));
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
    resolverSite.mockResolvedValue({ url: `https://${dom('italac')}/`, status: 'bloqueado' });
    expect(await descobrirDominio(e)).toMatchObject({
      site_url: `https://${dom('italac')}/`, site_status: 'bloqueado',
    });
  });

  it('site com www é gravado com a URL final, não com o domínio cru', async () => {
    const e = await empresa('MALINSKI MADEIRAS LTDA', nome('MALINSKI'));
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
    resolverSite.mockResolvedValue({ url: `https://www.${dom('malinski')}/`, status: 'vivo' });
    const r = await descobrirDominio(e);
    expect(r.dominio).toBe(dom('malinski'));
    expect(r.site_url).toBe(`https://www.${dom('malinski')}/`);
  });

  // O domínio do e-mail declarado na Receita é o único candidato que não é
  // palpite, então vai à frente dos derivados do nome.
  describe('domínio do e-mail da Receita', () => {
    it('e-mail .br de domínio próprio é o primeiro candidato', async () => {
      const e = await empresa('NOME QUE NAO VIRA DOMINIO LTDA', nome('NQNVD'), `vendas@${dom('mailbr')}`);
      consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });

      expect((await descobrirDominio(e)).dominio).toBe(dom('mailbr'));
      expect(consultarDominio.mock.calls[0]![0]).toBe(dom('mailbr'));
    });

    it('provedor gratuito é ignorado, cai nos candidatos do nome', async () => {
      const e = await empresa('KRONOS LTDA', nome('KRONOS'), 'kronos.vendas@gmail.com');
      consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
      expect((await descobrirDominio(e)).dominio).toBe(dom('kronos'));
      expect(consultarDominio.mock.calls[0]![0]).toBe(dom('kronos'));
    });

    // contabilizei.com.br e maismei.com.br estão entre os domínios de e-mail
    // mais comuns da base. São do contador, e o CNPJ do titular denuncia isso.
    it('domínio do contador não passa na confirmação por CNPJ', async () => {
      const e = await empresa('HELIOS LTDA', nome('HELIOS'), `fiscal@${dom('contabil')}`);
      consultarDominio
        .mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: '99888777000166' }) // contador
        .mockResolvedValue({ estado: 'livre' });
      const r = await descobrirDominio(e);
      expect(r).toMatchObject({ dominio: null, status: 'nao_encontrado' });
    });

    // Fora do .br o registro.br não responde, então não dá para confirmar posse.
    it('e-mail .com com site no ar entra com confiança 70', async () => {
      const e = await empresa('ARES LTDA', nome('ARES'), 'contato@ares-global.com');
      consultarDominio.mockResolvedValue({ estado: 'livre' }); // nada do nome bate
      resolverSite.mockResolvedValue({ url: 'https://ares-global.com/', status: 'vivo' });

      expect(await descobrirDominio(e)).toMatchObject({
        dominio: 'ares-global.com', site_url: 'https://ares-global.com/',
        status: 'achou', fonte: 'email_rfb', confianca: 70,
      });
      // nunca consultado no registro.br: gravaria "domínio livre" errado no cache
      expect(consultarDominio.mock.calls.map((c) => c[0])).not.toContain('ares-global.com');
    });

    it('e-mail .com sem site no ar não vira domínio', async () => {
      const e = await empresa('HERA LTDA', nome('HERA'), 'contato@hera-morta.com');
      consultarDominio.mockResolvedValue({ estado: 'livre' });
      resolverSite.mockImplementation((d: string) => Promise.resolve(
        d === 'hera-morta.com' ? { url: null, status: 'sem_dns' } : { url: `https://${d}/`, status: 'vivo' }));
      expect((await descobrirDominio(e)).status).toBe('nao_encontrado');
    });

    it('e-mail .com resgata mesmo quando o portão fecha', async () => {
      const e = await empresa('ATENA LTDA', nome('ATENA'), 'contato@atena-corp.com');
      contarDominios.mockResolvedValue(0); // nenhum domínio .br
      resolverSite.mockResolvedValue({ url: 'https://atena-corp.com/', status: 'vivo' });
      expect(await descobrirDominio(e)).toMatchObject({
        dominio: 'atena-corp.com', confianca: 70, fonte: 'email_rfb',
      });
      expect(consultarDominio).not.toHaveBeenCalled();
    });

    it('e-mail vazio ou malformado não quebra nada', async () => {
      const e = await empresa('IRIS LTDA', nome('IRIS'), 'sem-arroba');
      consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
      expect((await descobrirDominio(e)).dominio).toBe(dom('iris'));
    });
  });

  // O domínio fica na matriz (0001) e a empresa aberta pode ser filial.
  it('casa pela raiz do CNPJ, não pelo CNPJ inteiro', async () => {
    const e = await empresa('BETA INDUSTRIA LTDA', nome('BETA'));
    const matriz = `${e.cnpj.slice(0, 8)}000199`; // mesma raiz, sufixo diferente
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: matriz });
    expect((await descobrirDominio(e)).dominio).toBe(dom('beta'));
  });

  it('titular de outra raiz não é a empresa', async () => {
    const e = await empresa('GAMA LTDA', nome('GAMA'));
    consultarDominio.mockResolvedValue({ estado: 'confirmado', titularCnpj: '11111111000199' });
    const r = await descobrirDominio(e);
    expect(r).toMatchObject({ dominio: null, status: 'nao_encontrado' });
    expect(await salvo(e.id)).toEqual({ dominio: null, confianca: 0 });
  });

  it('todos os candidatos livres -> não encontrado, cacheado', async () => {
    const e = await empresa('DELTA LTDA', nome('DELTA'));
    consultarDominio.mockResolvedValue({ estado: 'livre' });
    expect((await descobrirDominio(e)).status).toBe('nao_encontrado');
    expect(await salvo(e.id)).toEqual({ dominio: null, confianca: 0 });
  });

  // O ponto central: censura do registro.br não pode virar "empresa sem site".
  it('sem_titular -> indeterminado e NÃO grava negativo', async () => {
    const e = await empresa('EPSILON LTDA', nome('EPSILON'));
    consultarDominio.mockResolvedValue({ estado: 'sem_titular' });
    expect((await descobrirDominio(e)).status).toBe('indeterminado');
    expect(await salvo(e.id)).toBeNull(); // nada cacheado -> tenta de novo depois
  });

  it('falha de rede -> indeterminado e NÃO grava negativo', async () => {
    const e = await empresa('ZETA LTDA', nome('ZETA'));
    consultarDominio.mockResolvedValue(null);
    expect((await descobrirDominio(e)).status).toBe('indeterminado');
    expect(await salvo(e.id)).toBeNull();
  });

  it('acerto depois de um livre continua a varredura', async () => {
    // 1º candidato = nome inteiro; 2º = sem a palavra genérica TRANSPORTES.
    const e = await empresa('OMEGA TRANSPORTES LTDA', `${nome('OMEGA')} TRANSPORTES`);
    consultarDominio
      .mockResolvedValueOnce({ estado: 'livre' })
      .mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
    expect((await descobrirDominio(e)).dominio).toBe(dom('omega'));
    expect(consultarDominio).toHaveBeenCalledTimes(2);
  });

  it('segunda chamada vem do cache de company_dominio, sem tocar o RDAP', async () => {
    const e = await empresa('KAPPA LTDA', nome('KAPPA'));
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
    await descobrirDominio(e);
    consultarDominio.mockClear();

    expect(await descobrirDominio(e)).toEqual({
      dominio: dom('kappa'), site_url: `https://${dom('kappa')}/`, site_status: 'vivo',
      status: 'achou', fonte: 'registrobr', confianca: 100, cached: true,
    });
    expect(consultarDominio).not.toHaveBeenCalled();
  });

  it('negativo cacheado também não reconsulta', async () => {
    const e = await empresa('LAMBDA LTDA', nome('LAMBDA'));
    consultarDominio.mockResolvedValue({ estado: 'livre' });
    await descobrirDominio(e);
    consultarDominio.mockClear();

    expect(await descobrirDominio(e)).toMatchObject({ status: 'nao_encontrado', cached: true });
    expect(consultarDominio).not.toHaveBeenCalled();
  });

  // Matriz e filial compartilham o site: a segunda empresa da raiz não varre.
  it('reaproveita domínio já confirmado para outro CNPJ da mesma raiz', async () => {
    const e1 = await empresa('SIGMA LTDA', nome('SIGMA'));
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e1.cnpj });
    await descobrirDominio(e1);

    const filial = { ...e1, id: (await empresa('SIGMA LTDA FILIAL')).id, cnpj: `${e1.cnpj.slice(0, 8)}000288` };
    consultarDominio.mockClear();
    contarDominios.mockClear();
    resolverSite.mockClear();
    expect(await descobrirDominio(filial)).toEqual({
      dominio: dom('sigma'), site_url: `https://${dom('sigma')}/`, site_status: 'vivo',
      status: 'achou', fonte: 'registrobr', confianca: 100, cached: false,
    });
    // o site da matriz é reaproveitado: não sonda o servidor da empresa de novo
    expect(resolverSite).not.toHaveBeenCalled();
    expect(consultarDominio).not.toHaveBeenCalled();
    expect(contarDominios).not.toHaveBeenCalled(); // nem o portão é gasto
  });

  it('portão: CNPJ sem nenhum domínio encerra sem varrer', async () => {
    const e = await empresa('TAU LTDA', nome('TAU'));
    contarDominios.mockResolvedValue(0);
    expect((await descobrirDominio(e)).status).toBe('nao_encontrado');
    expect(consultarDominio).not.toHaveBeenCalled();
    expect(await salvo(e.id)).toEqual({ dominio: null, confianca: 0 });
  });

  // Regressão: o portão perguntava pelo CNPJ da filial, o registro.br respondia
  // 404 (=0 domínios) e a empresa era marcada "sem site" sem varrer nada.
  it('portão pergunta pela matriz, não pela filial aberta', async () => {
    const m = await empresa('FILIALTESTE MADEIRAS LTDA', nome('FILIALTESTE'));
    await query('UPDATE companies SET matriz_filial = 1 WHERE id = $1', [m.id]);
    const filial = { ...m, id: (await empresa('FILIALTESTE MADEIRAS LTDA')).id, cnpj: `${m.cnpj.slice(0, 8)}000930` };
    await query('UPDATE companies SET matriz_filial = 2, cnpj = $2 WHERE id = $1', [filial.id, filial.cnpj]);

    contarDominios.mockResolvedValue(3);
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: m.cnpj });

    expect((await descobrirDominio(filial)).dominio).toBe(dom('filialteste'));
    expect(contarDominios).toHaveBeenCalledWith(m.cnpj); // o da matriz
  });

  it('sem matriz na base, o portão usa o CNPJ da própria empresa', async () => {
    const e = await empresa('ORFA LTDA', nome('ORFA'));
    contarDominios.mockResolvedValue(0);
    expect((await descobrirDominio(e)).status).toBe('nao_encontrado');
    expect(contarDominios).toHaveBeenCalledWith(e.cnpj);
  });

  it('portão indeterminado (null) varre assim mesmo', async () => {
    const e = await empresa('UPSILON LTDA', nome('UPSILON'));
    contarDominios.mockResolvedValue(null);
    consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
    expect((await descobrirDominio(e)).dominio).toBe(dom('upsilon'));
  });

  it('empresa sem nome aproveitável não gera consulta nenhuma', async () => {
    const e = await empresa('LTDA', 'ME');
    expect((await descobrirDominio(e)).status).toBe('nao_encontrado');
    expect(consultarDominio).not.toHaveBeenCalled();
  });

  it('respeita o teto de 5 consultas por empresa', async () => {
    const e = await empresa(`${nome('ALFA')} BETA GAMA DELTA EPSILON ZETA LTDA`, `${nome('ALFA')} BETA GAMA DELTA`);
    consultarDominio.mockResolvedValue({ estado: 'livre' });
    await descobrirDominio(e);
    expect(consultarDominio.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('tenta ind.br e agr.br para o candidato mais provável', async () => {
    const e = await empresa('PSI LTDA', nome('PSI'));
    consultarDominio.mockResolvedValue({ estado: 'livre' });
    await descobrirDominio(e);
    expect(consultarDominio.mock.calls.map((c) => c[0]))
      .toEqual([dom('psi'), dom('psi', 'ind.br'), dom('psi', 'agr.br')]);
  });

  describe('cache por domínio (rdap_domain)', () => {
    it('domínio já confirmado no cache não é reconsultado', async () => {
      const e = await empresa('RHO LTDA', nome('RHO'));
      await query(
        'INSERT INTO rdap_domain (dominio, registrado, titular_cnpj) VALUES ($1, true, $2)',
        [dom('rho'), e.cnpj],
      );
      // cai no atalho do "irmão" (mesma raiz) antes mesmo da varredura
      expect((await descobrirDominio(e)).dominio).toBe(dom('rho'));
      expect(consultarDominio).not.toHaveBeenCalled();
    });

    it('domínio livre no cache é pulado sem consulta', async () => {
      const e = await empresa('CHI LTDA', nome('CHI'));
      await query(
        'INSERT INTO rdap_domain (dominio, registrado, titular_cnpj) VALUES ($1, false, NULL)',
        [dom('chi')],
      );
      consultarDominio.mockResolvedValue({ estado: 'livre' });
      await descobrirDominio(e);
      expect(consultarDominio.mock.calls.map((c) => c[0])).not.toContain(dom('chi'));
    });

    // TTL curto: registrado sem CNPJ segue indeterminado enquanto vale o cache.
    it('cache de sem_titular mantém o resultado indeterminado', async () => {
      const e = await empresa('IOTA LTDA', nome('IOTA'));
      await query(
        'INSERT INTO rdap_domain (dominio, registrado, titular_cnpj) VALUES ($1, true, NULL)',
        [dom('iota')],
      );
      consultarDominio.mockResolvedValue({ estado: 'livre' }); // demais candidatos
      const r = await descobrirDominio(e);
      expect(r.status).toBe('indeterminado');
      expect(consultarDominio.mock.calls.map((c) => c[0])).not.toContain(dom('iota'));
      expect(await salvo(e.id)).toBeNull();
    });

    it('grava no cache o que consultou', async () => {
      const e = await empresa('NUFF LTDA', nome('NUFF'));
      consultarDominio.mockResolvedValueOnce({ estado: 'confirmado', titularCnpj: e.cnpj });
      await descobrirDominio(e);
      expect(await one('SELECT registrado, titular_cnpj FROM rdap_domain WHERE dominio = $1', [dom('nuff')]))
        .toEqual({ registrado: true, titular_cnpj: e.cnpj });
    });
  });
});
