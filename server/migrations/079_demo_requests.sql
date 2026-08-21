-- Pedidos de demonstração recebidos pelo formulário público da landing.
CREATE TABLE IF NOT EXISTS demo_requests (
  id          bigserial PRIMARY KEY,
  nome        text NOT NULL,
  email       text NOT NULL,
  telefone    text NOT NULL,
  empresa     text,
  mensagem    text,
  status      text NOT NULL DEFAULT 'novo'
              CHECK (status IN ('novo', 'contatado', 'teste_agendado', 'concluido', 'arquivado')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demo_requests_created_at ON demo_requests (created_at DESC);
