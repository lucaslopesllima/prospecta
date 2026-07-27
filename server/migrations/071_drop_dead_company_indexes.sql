-- 071 — remove índices de `companies` que nenhuma query do código consegue usar,
-- e habilita pg_stat_statements.
--
-- CRITÉRIO: não foi o contador `pg_stat_user_indexes.idx_scan`. O SaaS ainda não
-- tem volume de uso real, então idx_scan=0 significa "feature ainda não
-- exercitada", não "índice morto". O corte aqui é por CÓDIGO: só sai o índice
-- cuja coluna não aparece em NENHUM predicado (WHERE/JOIN) de nenhuma query —
-- aparecer em SELECT ou em expressão de score não torna um índice alcançável.
--
-- Por que importa: `companies` tem ~30M linhas e é reescrita inteira pelo ETL da
-- Receita. Todo índice presente é escrita amplificada na carga, e disputa o
-- buffer cache com o índice de cobertura da recomendação (companies_reco_cov_idx),
-- que é o único caminho quente de verdade.
--
-- Não é CONCURRENTLY porque o runner (server/scripts/migrate-lib.ts) envolve
-- cada migração numa transação. DROP INDEX é operação de catálogo: pega
-- ACCESS EXCLUSIVE na tabela, mas por instantes — a remoção dos arquivos é
-- adiada pro commit.

-- 2545 MB, GiST sobre companies.geom. Era o modo "território por raio" da
-- migração 005, aposentado pelas migrações 058/068 (proximidade passou a ser por
-- centroide de MUNICÍPIO, via CASE sobre municipio_id). Não existe mais nenhum
-- ST_DWithin/ST_Intersects/ST_Contains no servidor. O único ST_Centroid restante
-- (routes/recommend.ts) agrega municipios.geom, não companies.geom; e o
-- ST_Y/ST_X de companies.geom roda sobre linhas já buscadas por chave primária.
-- Ressalva: se a busca por raio voltar, recriar este índice.
DROP INDEX IF EXISTS companies_geom_ativa_idx;

-- 184 MB. cnae_principal nunca é filtro: a poda de candidatos é por cnae_divisao
-- (sql/recommend.ts:122, atendida por companies_divisao_ativa_idx, que fica), e o
-- match exato de CNAE é só um termo do score (`c.cnae_principal = ANY($5)` em
-- sql/recommend.ts:115), avaliado por linha já dentro do scan do território.
-- Mesmo que um filtro por CNAE exato seja adicionado, o scan sempre entra pelo
-- território primeiro — este índice seguiria inalcançável.
DROP INDEX IF EXISTS companies_cnae_ativa_idx;

-- 182 MB, GIN sobre cnae_secundarios. Nenhum operador de containment (@>, &&, <@)
-- em nenhuma query; a coluna só é projetada (routes/companies.ts:53). GIN é o
-- índice mais caro de manter na escrita — pesado no ETL, sem nenhum leitor.
-- Ressalva: se entrar busca por CNAE secundário, recriar.
DROP INDEX IF EXISTS companies_cnae_sec_gin_idx;

-- MANTIDOS de propósito, apesar de idx_scan=0:
--   companies_regiao_ativa_idx — `c.regiao = ANY($10::regiao_br[])` é predicado
--     vivo em sql/recommend.ts:180 (gate de regiões habilitadas).
--   todos os índices de 8-16 kB em orders/activities/whatsapp_*/finance_* — são
--     tabelas de tenant ainda vazias; custam nada e são o caminho de acesso
--     assim que houver dado.
--   índices TIGER do postgis_tiger_geocoder — do schema da extensão.

-- pg_stat_statements: sem ele não dá pra saber qual query está lenta nem qual
-- derrama temp file (a base já derramou 60 GB em arquivos temporários sem que
-- desse pra atribuir a nenhuma query). Exige a lib em shared_preload_libraries,
-- já adicionada nos dois compose files.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
