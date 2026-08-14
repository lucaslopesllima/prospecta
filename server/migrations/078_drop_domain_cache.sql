-- Busca de site deve consultar fontes novamente em toda solicitação.
-- Remove caches antigos e respectivos dados persistidos.
DROP TABLE IF EXISTS company_dominio;
DROP TABLE IF EXISTS rdap_domain;
