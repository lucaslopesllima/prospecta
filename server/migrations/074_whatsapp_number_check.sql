-- 074 Cache do "este número existe no WhatsApp?" (Evolution /chat/whatsappNumbers).
--
-- A chave é o número normalizado (DDI+DDD+número), NÃO a empresa: ~16% da base
-- RFB compartilha o mesmo telefone entre CNPJs (contabilidade/despachante), então
-- o cache por número evita a maior parte das chamadas à Evolution.
--
-- Tabela global, sem org_id: "o número está no WhatsApp" é propriedade do número,
-- não da organização. Só o disparo da conferência é feito pela instância da org.
-- Nada aqui é dado de tenant, então não há isolamento a proteger.
CREATE TABLE IF NOT EXISTS whatsapp_number_check (
  numero        text PRIMARY KEY,            -- dígitos normalizados, com DDI
  existe        boolean NOT NULL,
  jid           text,                        -- jid canônico devolvido pela Evolution
  verificado_em timestamptz NOT NULL DEFAULT now()
);
