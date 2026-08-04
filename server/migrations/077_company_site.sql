-- A URL que o domínio confirmado realmente serve.
--
-- Domínio registrado não é site no ar: numa amostra de 20 domínios confirmados
-- por CNPJ no registro.br, 5 não tinham DNS (registrados só para e-mail) e 3
-- respondiam 403/404. Guardar só o domínio faria a ficha prometer um site que
-- não abre. site_url é o que o representante clica; site_status explica o vazio.
--
-- site_status: 'vivo' | 'bloqueado' | 'sem_pagina' | 'sem_dns'  (ver site.ts)
--   bloqueado = WAF barrou o nosso acesso, mas o site existe -> ainda é clicável.
ALTER TABLE company_dominio
  ADD COLUMN IF NOT EXISTS site_url    text,
  ADD COLUMN IF NOT EXISTS site_status text;
