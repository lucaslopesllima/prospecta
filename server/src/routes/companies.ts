import type { FastifyInstance } from 'fastify';
import { one, query } from '../db.ts';
import { requireAuth, requirePermission } from '../auth.ts';
import { geocodeAddr } from '../geocode.ts';
import { checkWhatsappNumbers } from '../whatsapp.ts';
import { descobrirDominio } from '../enriquecimento.ts';
import { buscarContatosNoSite } from '../contatos_site.ts';

// Read-only lookup into the global companies pool (mesma fonte do recommend/funil).
// Retorna TODOS os campos da empresa (com códigos RFB decodificados) + quadro societário.
export function companyRoutes(app: FastifyInstance): void {
  // Busca rápida na base global (CNPJ ou razão/fantasia) para autopreencher
  // cadastros (transportadoras, representadas, etc.). q só com dígitos vira
  // prefixo de CNPJ (índice pattern_ops); senão prefixo de razão/fantasia
  // (btree COLLATE "C") com fallback ILIKE trigram pra completar os 10.
  // minLength 3: <3 chars o GIN trgm não indexa o padrão -> ILIKE '%x%' vira
  // seq scan na base inteira (mesma regra do recommend).
  app.get('/api/companies/search', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 3 } } } },
  }, async (req) => {
    const { q } = req.query as { q: string };
    const orgId = req.auth!.orgId;
    const digits = q.replace(/\D/g, '');
    // in_funnel: empresa já tem relationship neste org (qualquer status). O client
    // usa pra exibir o resultado opaco/desativado em vez de escondê-lo.
    // source <> 'demo': as empresas fictícias da base de demonstração (migração
    // 073) estão no mesmo pool global e não podem vazar para a busca de nenhum
    // tenant — mesma regra do recommend.
    const SELECT = `
      SELECT c.id, c.cnpj, c.razao_social, c.nome_fantasia, c.telefone1, c.telefone2, c.email,
             c.logradouro, c.numero, c.bairro, c.cep, c.uf, m.nome AS cidade,
             EXISTS (SELECT 1 FROM company_relationships r WHERE r.org_id = $2 AND r.company_id = c.id) AS in_funnel
      FROM companies c LEFT JOIN municipios m ON m.id = c.municipio_id
      WHERE c.source <> 'demo'`;
    // CNPJ quando o termo não tem letras (só dígitos + máscara) e ≥4 dígitos.
    // Casado com maskSearchCNPJ no client, que formata o CNPJ na busca.
    if (digits.length >= 4 && !/[a-zA-Z]/.test(q)) {
      const companies = await query(
        `${SELECT} AND c.cnpj LIKE $1 ORDER BY c.cnpj LIMIT 10`,
        [`${digits}%`, orgId],
      );
      return { companies };
    }
    // Nome em dois estágios. 1º prefixo (btree COLLATE "C", criado pelo
    // deploy.sh — a base é ~toda uppercase): resolve o caso dominante (usuário
    // digitando o nome do início) em poucos ms. O COLLATE "C" nos dois lados é
    // o que permite ao planner derivar range scan do LIKE 'X%' num banco
    // en_US.utf8. Escapa %_\ para o termo não virar wildcard (e um '%' inicial
    // não degenerar em seq scan de 30M linhas).
    const prefixo = q.trim().toUpperCase().replace(/[\\%_]/g, (m) => `\\${m}`) + '%';
    const prefixHits = await query<{ id: number; razao_social: string }>(
      `(${SELECT} AND c.razao_social COLLATE "C" LIKE $1
        ORDER BY c.razao_social COLLATE "C" LIMIT 10)
       UNION
       (${SELECT} AND c.nome_fantasia COLLATE "C" LIKE $1
        ORDER BY c.nome_fantasia COLLATE "C" LIMIT 10)
       ORDER BY razao_social LIMIT 10`,
      [prefixo, orgId],
    );
    if (prefixHits.length >= 10) return { companies: prefixHits };
    // 2º substring (GIN trigram) só para completar os 10. LIMIT numa subquery,
    // ORDER BY só nos que sobraram: ordenar o match set inteiro de um termo
    // curto ("pad" casa 86k empresas) visitava 80k páginas de heap antes do
    // corte — era isso que deixava a busca em centenas de ms.
    const resto = await query(
      `SELECT * FROM (
         ${SELECT} AND c.id <> ALL($3::bigint[])
          AND (c.razao_social ILIKE '%' || $1 || '%' OR c.nome_fantasia ILIKE '%' || $1 || '%')
         LIMIT $4
       ) s ORDER BY s.razao_social`,
      [q.trim(), orgId, prefixHits.map((c) => c.id), 10 - prefixHits.length],
    );
    return { companies: [...prefixHits, ...resto] };
  });

  app.get('/api/companies/:id', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const company = await one(
      `SELECT c.id, c.cnpj, c.razao_social, c.nome_fantasia,
              c.cnae_principal, cr.descricao AS cnae_descricao, c.cnae_secundarios,
              c.uf, c.municipio_id, m.nome AS cidade, c.regiao,
              c.porte, c.capital_social, c.situacao_cadastral, c.source,
              c.logradouro, c.numero, c.complemento, c.bairro, c.cep,
              c.telefone1, c.telefone2, c.email, c.fax,
              c.data_inicio_atividade, c.matriz_filial,
              c.natureza_juridica, rn.descricao AS natureza_descricao,
              c.qualificacao_responsavel, rq.descricao AS qualificacao_descricao,
              c.ente_federativo,
              c.motivo_situacao, rmo.descricao AS motivo_descricao,
              c.data_situacao_cadastral, c.situacao_especial, c.data_situacao_especial,
              c.nome_cidade_exterior, c.pais, rp.descricao AS pais_nome,
              c.opcao_simples, c.data_opcao_simples, c.data_exclusao_simples,
              c.opcao_mei, c.data_opcao_mei, c.data_exclusao_mei,
              ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon,
              gc.lat AS geo_lat, gc.lon AS geo_lon, gc.precisao AS geo_precisao,
              c.raw_data
       FROM companies c
       LEFT JOIN municipios m ON m.id = c.municipio_id
       LEFT JOIN cnae_reference cr ON cr.codigo = c.cnae_principal
       LEFT JOIN company_geocode gc ON gc.company_id = c.id
       LEFT JOIN rfb_natureza rn ON rn.codigo = c.natureza_juridica
       LEFT JOIN rfb_qualificacao rq ON rq.codigo = c.qualificacao_responsavel
       LEFT JOIN rfb_motivo rmo ON rmo.codigo = c.motivo_situacao
       LEFT JOIN rfb_pais rp ON rp.codigo = c.pais
       WHERE c.id = $1`,
      [id],
    );
    if (!company) return reply.code(404).send({ error: 'empresa não encontrada' });

    // quadro societário (ligado pelo cnpj_base = 8 primeiros dígitos do CNPJ).
    // O cnpj já veio na consulta acima — passa direto, sem re-selecionar a empresa.
    const socios = await query(
      `SELECT s.identificador, s.nome, s.cnpj_cpf,
              s.qualificacao, q.descricao AS qualificacao_descricao,
              s.data_entrada, s.faixa_etaria,
              s.nome_representante, s.representante_legal
       FROM socios s
       LEFT JOIN rfb_qualificacao q ON q.codigo = s.qualificacao
       WHERE s.cnpj_base = left($1, 8)::char(8)
       ORDER BY s.nome`,
      [company.cnpj],
    );
    // Contatos que se repetem em outras empresas (migração 075) — a tela usa
    // para avisar "provável contato de contabilidade". Só existe linha quando o
    // contato passou do limite, então presença = compartilhado. Tabela vazia
    // (script ainda não rodou) simplesmente não sinaliza nada.
    // `one()` devolve as colunas como unknown — estreita só o que é lido aqui.
    const ct = company as { telefone1: string | null; telefone2: string | null; email: string | null };
    const tels = [ct.telefone1, ct.telefone2].filter(Boolean) as string[];
    const shared = await query<{ tipo: string; valor: string; empresas: number }>(
      `SELECT tipo, valor, empresas FROM contato_compartilhado
        WHERE (tipo = 'telefone' AND valor = ANY($1::text[]))
           OR (tipo = 'email'    AND valor = $2)`,
      [tels, ct.email ? ct.email.toLowerCase() : null],
    );
    const nTel = (v: string | null): number | null =>
      (v ? shared.find((s) => s.tipo === 'telefone' && s.valor === v)?.empresas ?? null : null);
    const compartilhado = {
      telefone1: nTel(ct.telefone1),
      telefone2: nTel(ct.telefone2),
      email: ct.email ? shared.find((s) => s.tipo === 'email')?.empresas ?? null : null,
    };

    return { company, socios, compartilhado };
  });

  // Confere na Evolution se os telefones da empresa existem no WhatsApp.
  // Disparado pelo modal de detalhes ao abrir; resultado cacheado por número
  // (whatsapp_number_check, TTL 90d), então a segunda abertura não sai do banco.
  //
  // true = existe · false = não existe · null = indeterminado (Evolution fora,
  // desligada ou org demo). O client só remove o atalho de conversa no `false`.
  app.get('/api/companies/:id/whatsapp', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const c = await one<{ telefone1: string | null; telefone2: string | null }>(
      'SELECT telefone1, telefone2 FROM companies WHERE id = $1', [id],
    );
    if (!c) return reply.code(404).send({ error: 'empresa não encontrada' });
    const veredito = await checkWhatsappNumbers(req.auth!.orgId, [c.telefone1, c.telefone2]);
    return {
      whatsapp: {
        telefone1: c.telefone1 ? veredito.get(c.telefone1) ?? null : null,
        telefone2: c.telefone2 ? veredito.get(c.telefone2) ?? null : null,
      },
    };
  });

  // Geocodifica o endereço da empresa sob demanda (lat/lon exato) e cacheia.
  // Fallback: centroide do município (não cacheado, pra permitir nova tentativa).
  app.get('/api/companies/:id/geocode', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const cached = await one(
      'SELECT lat, lon, precisao, fonte FROM company_geocode WHERE company_id = $1', [id],
    );
    if (cached) return { geocode: { ...cached, cached: true } };

    const c = await one<{
      logradouro: string | null; numero: string | null; bairro: string | null;
      cep: string | null; cidade: string | null; uf: string | null; lat: number | null; lon: number | null;
    }>(
      `SELECT c.logradouro, c.numero, c.bairro, c.cep, m.nome AS cidade, c.uf,
              ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon
       FROM companies c LEFT JOIN municipios m ON m.id = c.municipio_id
       WHERE c.id = $1`, [id],
    );
    if (!c) return reply.code(404).send({ error: 'empresa não encontrada' });

    const g = await geocodeAddr(c);
    if (g) {
      await query(
        `INSERT INTO company_geocode (company_id, lat, lon, precisao, fonte)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id) DO UPDATE
           SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, precisao = EXCLUDED.precisao,
               fonte = EXCLUDED.fonte, atualizado_em = now()`,
        [id, g.lat, g.lon, g.precisao, g.fonte],
      );
      return { geocode: { ...g, cached: false } };
    }
    // sem geocode -> centroide do município
    return { geocode: { lat: c.lat, lon: c.lon, precisao: 'municipio', fonte: 'rfb', cached: false } };
  });

  // Descobre o site próprio da empresa no registro.br, sob demanda (o usuário
  // clica "buscar site" na ficha). Não é instantâneo: pode gastar até 8 consultas
  // com throttle de 350ms, então o client precisa exibir carregando.
  //
  // dominio null = varreu e não encontrou. confianca 100 = o CNPJ raiz do titular
  // do domínio bate com o da empresa; não existe meio-termo nesta fonte.
  app.get('/api/companies/:id/dominio', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      querystring: { type: 'object', properties: { forcar: { type: 'boolean' } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { forcar = false } = req.query as { forcar?: boolean };
    const c = await one<{
      id: number; cnpj: string; razao_social: string; nome_fantasia: string | null; email: string | null;
    }>(
      'SELECT id, cnpj, razao_social, nome_fantasia, email FROM companies WHERE id = $1', [id],
    );
    if (!c) return reply.code(404).send({ error: 'empresa não encontrada' });
    return { dominio: await (forcar ? descobrirDominio(c, { ignorarCache: true }) : descobrirDominio(c)) };
  });

  // Raspa os contatos publicados no site da empresa. Depende do site já
  // descoberto (rota acima) — é o único dado que a descoberta persiste.
  //
  // O resultado NÃO é gravado: vai para a tela e o representante escolhe o que
  // vira contato, pelo POST /api/contacts de sempre. Contato de site é dado de
  // pessoa em boa parte dos casos (nome + celular do gerente), e guardar só o
  // que foi escolhido mantém a coleta na medida do uso, como já vale para o
  // contato administrativo do RDAP (ver migração 076).
  app.get('/api/companies/:id/contatos-site', {
    preHandler: [requireAuth, requirePermission('prospeccao.view')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const c = await one<{ site_url: string | null }>(
      'SELECT site_url FROM company_dominio WHERE company_id = $1', [id],
    );
    // 409 e não 404: a empresa existe, o que falta é a busca do site. O client
    // só mostra o botão depois de achar o site, então isto é rede de segurança.
    if (!c?.site_url) return reply.code(409).send({ error: 'busque o site da empresa primeiro' });
    return buscarContatosNoSite(c.site_url);
  });
}
