// Raspagem de contatos na página da empresa. Os HTMLs abaixo são recortes do
// que a coocam.com.br serve de verdade — inclusive os defeitos: tel: sem DDI,
// wa.me com '+' no meio do número e o <link rel="author"> da agência no <head>,
// que numa varredura ingênua virava o "telefone" 5555555555.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { buscarPagina, buscarPaginaRenderizada } = vi.hoisted(() => ({
  buscarPagina: vi.fn(), buscarPaginaRenderizada: vi.fn(),
}));
vi.mock('../src/site.ts', () => ({ buscarPagina }));
vi.mock('../src/renderizar_site.ts', () => ({ buscarPaginaRenderizada }));

const {
  buscarContatosNoSite, extrairContatos, linksCandidatos, normalizarEmail, normalizarFone, pareceSPA,
} = await import('../src/contatos_site.ts');

const ORIGEM = 'https://www.acme.com.br/contato';
const extrair = (html: string) => extrairContatos(html, ORIGEM);

describe('normalizarFone', () => {
  it.each([
    ['(49) 3541-7000', '4935417000'],
    ['+4935417000', '4935417000'],          // tel: da coocam: '+' e DDD, sem o 55
    ['+49 3541-7000', '4935417000'],
    ['5549984070087', '49984070087'],       // wa.me com DDI
    ['55+49999812382', '49999812382'],      // '+' literal no meio, como o site serve
    ['(49) 9193-8900', '4991938900'],       // celular antigo de 8 dígitos ainda publicado
    ['0800 025 8969', '08000258969'],
    ['+55 0800 025 8969', '08000258969'],
  ])('%s -> %s', (bruto, esperado) => expect(normalizarFone(bruto)).toBe(esperado));

  it.each([
    ['5555555555', 'dígito repetido — veio de plus.google.com/5555555555 no <head>'],
    ['85579150469', 'CPF: 11 dígitos sem o 9 do celular'],
    ['4900000000', 'zeros de template'],
    ['4944444444', 'dígito repetido'],
    ['491234567', '9 dígitos: curto demais'],
    ['4935417000123', '13 dígitos sem DDI 55'],
    ['4915417000', 'assinante começando em 1'],
  ])('rejeita %s (%s)', (bruto) => expect(normalizarFone(bruto)).toBeNull());
});

describe('normalizarEmail', () => {
  it('normaliza caixa e espaço', () => {
    expect(normalizarEmail('  Vendas@Acme.COM.BR ')).toBe('vendas@acme.com.br');
  });
  it.each([
    'logo@2x.png',            // nome de arquivo com @ — não é contato de ninguém
    'abc@sentry.io',          // telemetria embutida pelo tema
    'a@example.com',
    'seuemail@acme.com.br',   // placeholder de template
    'nao-responda@acme.com.br',
    'sem-arroba.com.br',
  ])('descarta %s', (e) => expect(normalizarEmail(e)).toBeNull());
});

describe('extrairContatos', () => {
  // O bloco por pessoa da página real: rótulo, nome com cargo e três campos.
  const ficha = `
    <div class="col">
      <h4>Departamento Técnico</h4>
      <p>Silvio Zanon - Gerente</p>
      <p>Email: <a href="mailto:silvio@acme.com.br">silvio@acme.com.br</a></p>
      <p>Whats: <a href="https://api.whatsapp.com/send?phone=5549988321048">(49) 98832-1048</a></p>
      <p>Fone: <a href="tel:+4935417021">(49) 3541-7021</a></p>
    </div>`;

  it('agrupa nome, cargo, rótulo e os três canais num contato só', () => {
    expect(extrair(ficha)).toEqual([{
      nome: 'Silvio Zanon', cargo: 'Gerente', rotulo: 'Departamento Técnico',
      email: 'silvio@acme.com.br', telefone: '4935417021', whatsapp: '49988321048',
      origem: ORIGEM,
    }]);
  });

  it('não mistura duas pessoas seguidas', () => {
    const r = extrair(`${ficha}
      <div><p>Helan Paganini</p>
      <p>Email: <a href="mailto:helan@acme.com.br">helan@acme.com.br</a></p>
      <p>Fone: <a href="tel:+4935417025">(49) 3541-7025</a></p></div>`);
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ nome: 'Helan Paganini', email: 'helan@acme.com.br', telefone: '4935417025' });
    expect(r[1]!.whatsapp).toBeNull(); // o WhatsApp é do Silvio, não dele
  });

  // A mesma página lista os setores, um e-mail por linha. Cada um tem que sair
  // com o seu rótulo — é o que diz ao representante quem compra.
  it('lista de setores: um contato por rótulo', () => {
    const r = extrair(`
      <ul>
        <li>Comercialização Insumos <a href="mailto:fabricio@acme.com.br">fabricio@acme.com.br</a></li>
        <li>Departamento Vendas <a href="mailto:vendas@acme.com.br">vendas@acme.com.br</a></li>
        <li>Recursos Humanos <a href="mailto:rh@acme.com.br">rh@acme.com.br</a></li>
      </ul>`);
    expect(r.map((c) => [c.rotulo, c.email])).toEqual([
      ['Comercialização Insumos', 'fabricio@acme.com.br'],
      ['Departamento Vendas', 'vendas@acme.com.br'],
      ['Recursos Humanos', 'rh@acme.com.br'],
    ]);
  });

  it('nome com "link" dentro não é confundido com item de menu', () => {
    // "KaLINKa" casava com a palavra 'link' quando o stoplist não tinha
    // fronteira Unicode, e a pessoa perdia o nome.
    const r = extrair('<p>Kalinka Francoise da Silva</p><p><a href="mailto:k@acme.com.br">k</a></p>');
    expect(r[0]!.nome).toBe('Kalinka Francoise da Silva');
  });

  it('sigla de estado no fim é praça, não pessoa', () => {
    const r = extrair('<p>Campos Novos SC</p><p><a href="tel:+4935417000">(49) 3541-7000</a></p>');
    expect(r[0]!.nome).toBeNull();
    expect(r[0]!.rotulo).toBe('Campos Novos SC');
  });

  it('rótulo do campo não vira rótulo do contato nem separa a pessoa do telefone', () => {
    const r = extrair(`<p>Ana Paula Fernandes</p>
      <p>Fone:</p><p><a href="tel:+4935417021">(49) 3541-7021</a></p>`);
    expect(r).toEqual([expect.objectContaining({ nome: 'Ana Paula Fernandes', telefone: '4935417021' })]);
  });

  it('e-mail e telefone em texto puro, sem link', () => {
    const r = extrair('<footer>Fale com a gente: contato@acme.com.br · Fone (49) 3541-7000</footer>');
    expect(r).toEqual([expect.objectContaining({ email: 'contato@acme.com.br', telefone: '4935417000' })]);
  });

  it('classifica como WhatsApp pelo rótulo que vem antes do número', () => {
    const r = extrair('<p>Comercial</p><p>Fone: (49) 3541-7000 · Whats: (49) 99981-2382</p>');
    expect(r[0]).toMatchObject({ telefone: '4935417000', whatsapp: '49999812382' });
  });

  it('aceita 0800 publicado em link telefônico', () => {
    const r = extrair('<p>Central <a href="tel:+5508000258969">0800 025 8969</a></p>');
    expect(r).toEqual([expect.objectContaining({ rotulo: 'Central', telefone: '08000258969' })]);
  });

  it('desofusca "(arroba)" e "(ponto)"', () => {
    const r = extrair('<p>Comercial</p><p>vendas (arroba) acme (ponto) com (ponto) br</p>');
    expect(r[0]!.email).toBe('vendas@acme.com.br');
  });

  describe('falsos positivos que a página real produz', () => {
    it('ignora o <head> — é lá que mora o perfil da agência que fez o site', () => {
      const html = `<html><head>
        <link rel="author" href="https://plus.google.com/5555555555"/>
        <link rel="publisher" href="https://plus.google.com/5555555555"/>
        </head><body><p>Comercial</p><p>Fone: (49) 3541-7000</p></body></html>`;
      expect(extrair(html)).toEqual([expect.objectContaining({ telefone: '4935417000' })]);
    });

    it('sequência crua de dígitos só passa com rótulo de telefone por perto', () => {
      // 16933366509 é CPF, mas tem cara de celular de Ribeirão Preto.
      expect(extrair('<p>CPF do responsável: 16933366509</p>')).toEqual([]);
      expect(extrair('<p>Fone: 16933366509</p>')).toHaveLength(1);
    });

    it('não casa dentro de número maior', () => {
      expect(extrair('<p>CNPJ 11.222.333/0001-44 — Insc. 2170036557912345</p>')).toEqual([]);
    });

    it('contato dentro de comentário HTML não é contato publicado', () => {
      expect(extrair('<!-- <a href="mailto:antigo@acme.com.br">antigo</a> --><p>x</p>')).toEqual([]);
    });

    it('e-mail em <script> de configuração não entra', () => {
      expect(extrair('<script>var cfg={dsn:"https://k@o123.ingest.sentry.io/1"}</script>')).toEqual([]);
    });

    it('dígitos do e-mail não viram telefone', () => {
      const r = extrair('<p>Comercial</p><p>Contato: contato2024@acme.com.br</p>');
      expect(r).toEqual([expect.objectContaining({ email: 'contato2024@acme.com.br', telefone: null })]);
    });
  });
});

describe('linksCandidatos', () => {
  const html = `
    <a href="/contato">Fale conosco</a>
    <a href="/sobre">Sobre</a>
    <a href="https://www.acme.com.br/unidades">Unidades</a>
    <a href="/contato#form">âncora do mesmo</a>
    <a href="/produtos">Produtos</a>
    <a href="https://instagram.com/acme">Instagram</a>
    <a href="https://outrofornecedor.com.br/contato">Fornecedor</a>
    <a href="/catalogo-contato.pdf">Catálogo</a>
    <a href="javascript:void(0)">JS</a>`;

  it('fica no próprio domínio e só nas páginas que rendem contato', () => {
    expect(linksCandidatos(html, 'https://www.acme.com.br/')).toEqual([
      'https://www.acme.com.br/contato',
      'https://www.acme.com.br/sobre',
      'https://www.acme.com.br/unidades',
    ]);
  });

  it('www e apex são o mesmo site', () => {
    expect(linksCandidatos('<a href="https://acme.com.br/contato">c</a>', 'https://www.acme.com.br/'))
      .toEqual(['https://acme.com.br/contato']);
  });

  it('base inválida não derruba a extração', () => {
    expect(linksCandidatos(html, 'não é url')).toEqual([]);
  });
});

describe('buscarContatosNoSite', () => {
  const pagina = (url: string, html: string, status = 200) => ({ url, html, status });
  beforeEach(() => {
    buscarPagina.mockReset();
    buscarPaginaRenderizada.mockReset();
    buscarPaginaRenderizada.mockResolvedValue(null);
  });

  it('reconhece casca de SPA, sem confundir página estática', () => {
    expect(pareceSPA('<div id="app"></div><script src="/app.js"></script>')).toBe(true);
    expect(pareceSPA('<main><p>Site institucional</p></main><script src="/menu.js"></script>')).toBe(false);
  });

  it('segue o link de contato e mescla o que achou nas duas páginas', async () => {
    buscarPagina.mockImplementation(async (u: string) => {
      if (u === 'https://acme.com.br/') {
        return pagina(u, '<a href="/contato">Contato</a><p>Comercial</p><p>Fone: (49) 3541-7000</p>');
      }
      if (u === 'https://acme.com.br/contato') {
        return pagina(u, `<p>Departamento Vendas</p>
          <p><a href="mailto:vendas@acme.com.br">vendas@acme.com.br</a></p>
          <p>Fone: (49) 3541-7000</p>`);
      }
      return null;
    });

    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.paginas).toEqual(['https://acme.com.br/', 'https://acme.com.br/contato']);
    // O mesmo telefone nas duas páginas vira UMA linha, com o e-mail junto.
    expect(r.contatos).toEqual([
      expect.objectContaining({ email: 'vendas@acme.com.br', telefone: '4935417000' }),
    ]);
  });

  it('telefone da central não funde duas pessoas com e-mails diferentes', async () => {
    buscarPagina.mockImplementation(async (u: string) =>
      u === 'https://acme.com.br/'
        ? pagina(u, `<div><p>Silvio Zanon</p><p>Email: <a href="mailto:silvio@acme.com.br">s</a></p>
             <p>Fone: (49) 3541-7000</p></div>
           <div><p>Helan Paganini</p><p>Email: <a href="mailto:helan@acme.com.br">h</a></p>
             <p>Fone: (49) 3541-7000</p></div>`)
        : null);
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.contatos.map((c) => [c.nome, c.email])).toEqual([
      ['Silvio Zanon', 'silvio@acme.com.br'],
      ['Helan Paganini', 'helan@acme.com.br'],
    ]);
  });

  it('tenta caminhos comuns quando o menu não linka contato', async () => {
    buscarPagina.mockImplementation(async (u: string) =>
      u === 'https://acme.com.br/contato'
        ? pagina(u, '<p>Comercial</p><p><a href="mailto:c@acme.com.br">c</a></p>')
        : u === 'https://acme.com.br/' ? pagina(u, '<p>site em flash</p>') : null);

    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.contatos).toHaveLength(1);
    expect(buscarPagina).toHaveBeenCalledWith('https://acme.com.br/contato');
  });

  it('não lê duas vezes a mesma página final (redirect de /contatos para /contato)', async () => {
    buscarPagina.mockImplementation(async (u: string) =>
      u === 'https://acme.com.br/'
        ? pagina(u, '<p>x</p>')
        : pagina('https://acme.com.br/contato', '<p>Comercial</p><p>Fone: (49) 3541-7000</p>'));

    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.paginas).toEqual(['https://acme.com.br/', 'https://acme.com.br/contato']);
    expect(r.contatos).toHaveLength(1);
  });

  it('respeita o teto de páginas', async () => {
    buscarPagina.mockImplementation(async (u: string) => pagina(u, '<p>nada</p>'));
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.paginas.length).toBeLessThanOrEqual(6);
  });

  it('home fora do ar -> resultado vazio, sem tentar as outras páginas', async () => {
    buscarPagina.mockResolvedValue(null);
    expect(await buscarContatosNoSite('https://acme.com.br/'))
      .toEqual({ contatos: [], paginas: [], bloqueado: false });
    expect(buscarPagina).toHaveBeenCalledTimes(1);
  });

  // colcci.com.br devolve 403 com uma página de WAF de 14 KB. Lista vazia ali
  // não é "site sem contato" — é "não deu para ler", e a tela precisa saber.
  it('WAF barrando o robô -> bloqueado, não "nada publicado"', async () => {
    buscarPagina.mockResolvedValue(pagina('https://acme.com.br/', '<p>challenge</p>', 403));
    expect(await buscarContatosNoSite('https://acme.com.br/'))
      .toEqual({ contatos: [], paginas: [], bloqueado: true });
    expect(buscarPagina).toHaveBeenCalledTimes(1);
  });

  it('WAF simples é recuperado pelo navegador, sem resolver CAPTCHA', async () => {
    buscarPagina.mockResolvedValue(pagina('https://acme.com.br/', '<p>challenge</p>', 403));
    buscarPaginaRenderizada.mockImplementation(async (u: string) => ({
      ...pagina(u, '<p>Comercial</p><p>Fone: (49) 3541-7000</p>'), bloqueado: false,
    }));
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.bloqueado).toBe(false);
    expect(r.contatos).toEqual([expect.objectContaining({ telefone: '4935417000' })]);
  });

  it('Lightpanda falha -> Chromium assume', async () => {
    buscarPagina.mockResolvedValue(pagina('https://acme.com.br/', '<p>challenge</p>', 403));
    buscarPaginaRenderizada.mockImplementation(async (u: string, _base: string | undefined, motor: string) =>
      motor === 'lightpanda'
        ? { ...pagina(u, '<p>Service Unavailable</p>', 503), bloqueado: false }
        : { ...pagina(u, '<p>Comercial</p><p>Fone: (49) 3541-7000</p>'), bloqueado: false });
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.contatos).toEqual([expect.objectContaining({ telefone: '4935417000' })]);
    expect(buscarPaginaRenderizada.mock.calls.map((c) => c[2]).slice(0, 2)).toEqual(['lightpanda', 'chromium']);
  });

  it('SPA é renderizada e segue link criado pelo JavaScript', async () => {
    const shell = '<div id="app"></div><script src="/app.js"></script>';
    buscarPagina.mockImplementation(async (u: string) =>
      u === 'https://acme.com.br/' ? pagina(u, shell) : pagina(u, shell, 404));
    buscarPaginaRenderizada.mockImplementation(async (u: string) => {
      if (u === 'https://acme.com.br/') {
        return { ...pagina(u, '<a href="/contato">Contato</a>'), bloqueado: false };
      }
      if (u === 'https://acme.com.br/contato') {
        return { ...pagina(u, '<p>Vendas</p><a href="mailto:vendas@acme.com.br">vendas</a>', 404), bloqueado: false };
      }
      return null;
    });
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.contatos).toEqual([expect.objectContaining({ email: 'vendas@acme.com.br' })]);
    expect(r.paginas).toContain('https://acme.com.br/contato');
  });

  it('página interna que responde 404 é ignorada, sem marcar bloqueio', async () => {
    buscarPagina.mockImplementation(async (u: string) =>
      u === 'https://acme.com.br/'
        ? pagina(u, '<a href="/contato">c</a><p>Comercial</p><p>Fone: (49) 3541-7000</p>')
        : pagina(u, '<p>não achei</p>', 404));
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.paginas).toEqual(['https://acme.com.br/']);
    expect(r.bloqueado).toBe(false);
    expect(r.contatos).toHaveLength(1);
  });

  it('quem vende vem antes de quem não compra', async () => {
    buscarPagina.mockImplementation(async (u: string) =>
      u === 'https://acme.com.br/'
        ? pagina(u, `<ul>
            <li>Recursos Humanos <a href="mailto:rh@acme.com.br">rh</a></li>
            <li>Departamento Contábil <a href="mailto:contabil@acme.com.br">c</a></li>
            <li>Atendimento <a href="mailto:sac@acme.com.br">sac</a></li>
            <li>Departamento Vendas <a href="mailto:vendas@acme.com.br">v</a></li>
          </ul>`)
        : null);
    const r = await buscarContatosNoSite('https://acme.com.br/');
    expect(r.contatos.map((c) => c.email)).toEqual([
      'vendas@acme.com.br', 'sac@acme.com.br', 'rh@acme.com.br', 'contabil@acme.com.br',
    ]);
  });
});
