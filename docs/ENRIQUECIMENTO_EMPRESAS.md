# Enriquecimento de dados de empresas

Estratégias para obter dados de empresas além do que a Receita Federal fornece:
contatos, e-mails, telefones, pessoas, cargos, LinkedIn, redes sociais e sinais comerciais.

---

## 1. Fontes de dados

### Grátis / raspável

| Fonte | O que entrega | Observação |
|---|---|---|
| **Site da empresa** | e-mail, telefone, WhatsApp, endereço, produtos | Raspar `/contato`, `/sobre`, `/quem-somos`, rodapé, `mailto:`, `tel:`, links `wa.me/55...`. Rodapé costuma trazer o CNPJ — confirma o match. |
| **registro.br (RDAP)** | CNPJ do titular do domínio `.com.br` | **Casamento CNPJ ↔ domínio com certeza**, não heurística. Implementado — ver §2.4 para os limites reais da fonte. |
| **Google / Bing Search API** | descoberta de domínio, LinkedIn, redes | Serper.dev (~US$1/1000 queries), Brave Search API, SerpAPI. Query: `"RAZAO SOCIAL" contato email` ou `site:linkedin.com/company "nome fantasia"`. |
| **Google Maps / Places API** | telefone, site, horário, categoria real, fotos, reviews | Categoria do Places costuma ser melhor que o CNAE. Barato e excelente para PME. |
| **Instagram / Facebook** | bio com e-mail e WhatsApp | PME brasileira vive nessas redes. Graph API é limitada; achar via `site:instagram.com "nome"`. |
| **Juntas comerciais (JUCESP e estaduais)** | quadro societário histórico, capital social | |
| **Diário Oficial / DOU** | licitações, sócios, processos | |
| **Reclame Aqui** | porte real, canais de atendimento | |
| **CNEFE / IBGE** | geolocalização | Já integrado no Rovva (~93% da base com ponto real). |

### Pago

**Contatos e pessoas (internacional)**
- **Apollo.io** — API, pessoas + cargos, cobertura BR razoável.
- **Hunter.io** — melhor custo para "achar e-mail de pessoa X na empresa Y"; devolve o *pattern* (`nome.sobrenome@`) e verifica MX/SMTP.
- **Lusha**, **Snov.io**, **Dropcontact**, **Clearbit / Breeze** (HubSpot).

**Bases brasileiras**
- Econodata, Speedio, Cortex, Neoway, Casa dos Dados.
- CNPJá, ReceitaWS, BrasilAPI — base cadastral já normalizada, alguns com telefone/e-mail.

**LinkedIn**: scraping direto viola os Termos de Uso e resulta em bloqueio rápido.
Caminhos viáveis: Sales Navigator manual ou provider que já assume esse risco (Apollo, Lusha).

---

## 2. Métodos

### 2.1 Pipeline determinístico (fazer primeiro, sem IA)

```
CNPJ
  → razão social + nome fantasia + UF/município
  → busca web (Serper) → candidatos de domínio
  → valida domínio via WHOIS registro.br (CNPJ do titular bate?) → match forte
  → crawl do site (5–10 páginas) → regex de e-mail / telefone / WhatsApp / redes
  → Hunter ou Apollo pelo domínio → pessoas, cargos, padrão de e-mail
```

O WHOIS do `registro.br` expõe o CNPJ do titular do `.com.br`. É a forma mais confiável
de ligar empresa a domínio no Brasil, e o resto do pipeline depende disso.

### 2.4 registro.br: o que a fonte realmente permite

Medido contra o serviço real em 2026-08-03, ao implementar `server/src/rdap.ts`:

- **Não existe busca reversa.** `GET /entity/<cnpj>` devolve *quantos* domínios o CNPJ
  tem (`nicbr_domainCount`), nunca *quais*. As buscas RDAP (`/domains?entityHandle=…`,
  `?name=`, `?handle=`) respondem **501 Not Implemented**.
  Consequência: o fluxo é o inverso do intuitivo — gera-se candidatos de domínio a
  partir do nome e **confirma-se** cada um em `/domain/<d>`, comparando a raiz do CNPJ
  (8 dígitos, porque o domínio costuma estar na matriz e a empresa aberta pode ser filial).
  O registro.br não *descobre* o domínio; ele **prova** que um palpite está certo.

- **O CNPJ do titular tem cota por IP: ~16 divulgações por minuto.** Estourando a cota,
  a resposta continua **200 e completa, só que sem o campo `publicIds`** — degrada
  calado, sem 429 e sem cabeçalho de rate limit. O mesmo domínio consultado com 3s de
  intervalo devolveu o CNPJ numa vez e omitiu na seguinte.
  **Armadilha:** ler "sem `publicIds`" como "não é desta empresa" gera falso negativo, e
  cachear esse falso negativo marca a empresa como "sem site" por semanas. Por isso o
  resultado tem três estados, e só `livre`/`confirmado` concluem algo — `sem_titular`
  devolve `indeterminado` e **não** é gravado.

- **Paralelismo derruba a conexão** (ECONNRESET, sem 429): 40 consultas simultâneas
  devolveram 5 resets. Consulta é sequencial, com throttle global.

- **Recall medido** numa amostra de 18 indústrias com capital > R$ 5M:
  7 confirmadas, 4 conclusivamente sem domínio, 7 indeterminadas por censura de cota.
  Sobre os casos conclusivos, ~64%. O gerador de candidatos derivado do nome é o teto
  aqui: `FRIGOARI`/`SUPREMAX` têm site mas em domínio que o nome não prevê. É esse o
  buraco que a busca web (Serper) preenche — ela vira **gerador de candidatos**, e o
  registro.br segue como **verificador**.

- **O melhor candidato é o domínio do e-mail da Receita**, não o nome. 17% da base
  tem e-mail de domínio próprio (83% é gmail/hotmail/etc.), e ele é dado do cadastro,
  não palpite. Por isso vai na frente da varredura por nome. Mas **continua passando
  pela confirmação por CNPJ**, e é aí que a coisa se prova necessária:
  - `contabilizei.com.br` e `maismei.com.br` estão entre os domínios de e-mail mais
    comuns da base inteira — são do contador;
  - VILLAR RAPOSO & CIA (CNPJ 05562939) usa `@novalar.com.br`, cujo titular é
    Eletro J. M. S/A (CNPJ 64035223) — franqueada usando o domínio da rede.

  Nos dois casos o domínio é plausível e errado, e só o CNPJ do titular denuncia.

- **Domínio registrado ≠ site no ar.** Dos 20 domínios confirmados por CNPJ, 12
  serviam página, 5 não tinham DNS nenhum (registrados só para e-mail) e 3 devolviam
  403/404. Metade dos que respondem só atende em `www`, alguns só em http, e
  `amazonbio.com.br` redireciona para o site do grupo. Daí `site.ts` resolver a URL
  real em cadeia (https apex → https www → http apex, seguindo redirects) em vez de
  montar `https://<dominio>` e torcer.

  403 é tratado como `bloqueado`, nunca como "sem site": `italac.com.br` barra bot e
  abre normal no navegador. Dizer ao representante que a empresa não tem site quando
  tem é pior que não afirmar nada.

- **Filial não é matriz no portão.** `/entity/<cnpj de filial>` devolve 404, que lido
  como "zero domínios" marcaria a empresa como sem site sem varrer nada. O portão
  resolve a matriz na base local (`matriz_filial = 1`, mesma raiz) antes de perguntar.

- **Cota é do IP, não do usuário.** Em produção todos os tenants dividem a mesma cota,
  o que reforça o modelo sob demanda (clique explícito) em vez de disparo automático
  ao abrir a ficha.

- **Política de uso:** a resposta RDAP vem com aviso de que a distribuição e o uso
  comercial/publicitário dos dados são proibidos. Por isso só o **domínio** é persistido
  e exibido; o CNPJ do titular serve de checagem e o contato administrativo (nome e
  e-mail de pessoa física) é deliberadamente ignorado — ver `rdap.ts`.

### 2.2 IA onde a regex falha

- **Extração estruturada** — HTML limpo (readability) → LLM barato (Haiku) com `tool_use`
  e schema forçado, retornando:
  ```json
  {
    "emails": [],
    "telefones": [],
    "pessoas": [{ "nome": "", "cargo": "", "email": "" }],
    "descricao": "",
    "produtos": [],
    "porte_estimado": ""
  }
  ```
  Resolve casos que regex não pega: *"Fale com João Silva, Diretor Comercial — (11) 9..."*.

- **Desambiguação** — dados 5 resultados de busca, qual é a empresa certa? O LLM compara
  razão social + cidade + CNAE contra o snippet. Regex não resolve isso.

- **Classificação comercial** — o que a empresa realmente vende, aderência ao ICP e sinais
  de compra (está contratando? abrindo filial? expandindo?). Vira feature do score de
  recomendação.

- **Normalização de cargo** — "Sócio-Proprietário" / "Head de Suprimentos" / "Comprador"
  → nível hierárquico + flag de decisor de compra. Alimenta a priorização do representante.

### 2.3 Busca agêntica

A Messages API da Anthropic tem **web search** e **web fetch** server-side: o modelo busca
e lê sozinho, basta definir o schema de saída. Uma chamada resolve "acha contatos da
empresa X" sem crawler próprio. Custo por empresa é maior, então serve para
**enriquecimento sob demanda** (usuário clica "buscar dados"), não para a base inteira.

Alternativas: **Perplexity API**, **Exa.ai** (busca semântica feita para agente; tem
endpoint de *find similar companies*, ótimo para lookalike de ICP).

---

## 3. Arquitetura sugerida no Rovva

- **Tabela `company_enrichment` separada da cadastral**:
  `company_id, source, field, value, confidence, collected_at, raw_json`.
  Nunca sobrescrever o dado da Receita — camada por cima, com proveniência.

- **Fila de jobs** (pg-boss ou tabela `enrichment_jobs` + worker). Enriquecimento é lento
  e falha com frequência; não pode ser síncrono no request.

- **Cache por domínio, não por CNPJ** — matriz e filiais compartilham o mesmo site.

- **Tiering de custo**:
  - grátis para todos: Maps + crawl do site próprio;
  - pago (Apollo/Hunter): sob demanda, consumindo crédito do plano.

  Enriquecer 60M de CNPJs a US$0,01 é inviável. Enriquecer os 200 que o representante
  realmente prospecta custa US$2.

- **Confidence score por campo**, exibido na UI com a fonte
  ("e-mail do site oficial" vs "padrão inferido"). Aumenta a confiança do representante
  e protege o produto.

---

## 4. LGPD

- Dado de **pessoa jurídica** (CNPJ, e-mail `contato@`, telefone comercial): uso livre.
- Dado de **pessoa física** (nome, cargo, e-mail nominal, perfil LinkedIn) é dado pessoal,
  mesmo em contexto profissional. Base legal aplicável: **legítimo interesse**
  (art. 7º, IX da LGPD) para prospecção B2B. Exige:
  - origem do dado registrada;
  - opt-out simples e funcional;
  - não coletar dado sensível.
- Registrar sempre `source` e `collected_at` — é o que sustenta a defesa em fiscalização.
- Scraping de LinkedIn: risco jurídico e de bloqueio. Preferir provider licenciado.

---

## 5. Ordem de implementação recomendada

1. ~~**WHOIS registro.br + resolução do site**~~ — **feito** (migrações
   `076_company_dominio.sql` e `077_company_site.sql`; `server/src/rdap.ts`,
   `site.ts` e `enriquecimento.ts`; `GET /api/companies/:id/dominio`; botão
   "buscar site" no modal da empresa). Limites da fonte em §2.4.

   Ponto em aberto: e-mail de domínio próprio **fora do .br** entra com
   `confianca = 70` e fonte `email_rfb`, porque o registro.br não cobre esses
   TLDs — a UI marca "não confirmado". É o único caminho sem prova de
   titularidade, e o caso VILLAR RAPOSO/novalar mostra que domínio de e-mail
   erra. Se aparecer falso positivo, é só remover o `porEmail()` de
   `enriquecimento.ts` e a garantia de "só domínio confirmado" volta inteira.
2. **Crawler do site próprio** — agora que o domínio é conhecido, raspar
   `/contato`, `/sobre`, rodapé e `wa.me` é o próximo maior ganho, e custo zero.
   É aqui que entra a tabela `company_enrichment` (campo/valor/confiança/fonte).
3. **Busca web (Serper) como gerador de candidatos** — cobre as empresas cujo
   domínio não sai do nome; o registro.br continua sendo o verificador.
4. **Google Places** — telefone, site e categoria real.
5. **Extractor com LLM** (Haiku, schema forçado) sobre o HTML coletado.
6. **Apollo / Hunter sob demanda** — pessoas, cargos e e-mails nominais.
