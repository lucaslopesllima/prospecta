-- Descoberta do site próprio da empresa via registro.br (RDAP).
--
-- Por que duas tabelas:
--
-- 1) rdap_domain — cache GLOBAL por domínio, não por empresa. Matriz e filiais
--    compartilham o mesmo site, e candidatos genéricos ("transportes.com.br")
--    são gerados a partir de milhares de razões sociais diferentes. Chavear por
--    domínio faz o hit rate subir muito e poupa o registro.br, que derruba a
--    conexão sob paralelismo. Mesmo desenho de whatsapp_number_check (074).
--
--    Guarda deliberadamente SÓ o CNPJ do titular. A resposta RDAP também traz
--    nome/e-mail do contato administrativo — dado de pessoa física, que não
--    entra no banco: para confirmar "este domínio é desta empresa" o CNPJ basta.
--
-- 2) company_dominio — resultado por empresa, incluindo o negativo. dominio NULL
--    = já procurou e não achou; sem isso toda abertura da ficha refaria a
--    varredura inteira contra o registro.br. Espelha company_geocode (016).
--
-- Nada é escrito em companies: o ETL da Receita faz ON CONFLICT DO UPDATE e
-- sobrescreveria o dado enriquecido no próximo ciclo (etl.ts:248).

CREATE TABLE IF NOT EXISTS rdap_domain (
  dominio       text PRIMARY KEY,          -- ex.: 'acme.com.br', minúsculo, sem www
  registrado    boolean NOT NULL,          -- false = 404 no RDAP (domínio livre)
  titular_cnpj  char(14),                  -- só dígitos; NULL quando titular é PF ou não informado
  verificado_em timestamptz NOT NULL DEFAULT now()
);

-- Busca pelo titular: "que domínios já confirmei para este CNPJ raiz?".
CREATE INDEX IF NOT EXISTS rdap_domain_titular_idx
  ON rdap_domain (titular_cnpj) WHERE titular_cnpj IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_dominio (
  company_id    bigint PRIMARY KEY REFERENCES companies(id),
  dominio       text,                      -- NULL = varreu e não encontrou
  fonte         text        NOT NULL,      -- 'registrobr'
  -- 100 = CNPJ raiz do titular bate com o da empresa (confirmação exata).
  -- Reservado <100 para candidatos vindos de busca web/crawl, sem WHOIS.
  confianca     smallint    NOT NULL,
  candidatos    smallint    NOT NULL DEFAULT 0,  -- domínios testados até decidir
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
