-- 075 Contatos que se repetem entre empresas — sinal de "esse telefone/e-mail é
-- da contabilidade", não da empresa.
--
-- O telefone que a RFB publica é o do estabelecimento, e escritórios contábeis
-- cadastram o próprio número em centenas de clientes. Medindo a base: ~16% das
-- empresas têm telefone que aparece em 11+ CNPJs e ~20% em 4+.
--
-- A contagem é por CNPJ RAIZ distinto (left(cnpj,8)), não por linha: matriz e
-- filiais da mesma empresa compartilham telefone legitimamente e não podem ser
-- confundidas com contabilidade.
--
-- Só entram aqui os valores ACIMA do limite (> 3 CNPJs raiz) — a tabela fica na
-- casa das centenas de milhares em vez dos 28M da companies, e a presença da
-- linha já é a resposta: existe = compartilhado.
--
-- Tabela normal (não matview) de propósito: a carga é lenta demais para uma
-- migração de boot, então nasce VAZIA e é preenchida pelo script
-- `server/scripts/contatos-compartilhados.ts` (rodado junto do ETL). Vazia, o
-- recurso apenas não sinaliza nada — nenhuma tela quebra.
CREATE TABLE IF NOT EXISTS contato_compartilhado (
  tipo     text NOT NULL,   -- 'telefone' | 'email'
  valor    text NOT NULL,   -- telefone como está na RFB; e-mail em minúsculas
  empresas int  NOT NULL,   -- CNPJs raiz distintos que usam esse contato
  PRIMARY KEY (tipo, valor)
);
