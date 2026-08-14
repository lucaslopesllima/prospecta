# AutoPost MCP — instruções para agentes

Use este guia para conectar Codex desktop, Codex CLI ou extensão IDE ao AutoPost.
ChatGPT web não lê configuração MCP local; nesse caso seria necessário publicar um
plugin próprio.

## Endpoint

- Transporte: Streamable HTTP
- URL de produção: `https://autopost.rovva.tech/mcp`
- Autenticação: Bearer token pessoal, vinculado a um único tenant

Nunca coloque token neste repositório, prompt, issue, log ou mensagem. Cada agente e
ambiente deve ter token próprio, com menor conjunto possível de escopos.

## 1. Solicitar ou emitir token

Administrador pode emitir token na VPS, dentro da raiz do projeto:

```bash
docker compose -f docker-compose.prod.yml exec autopost \
  python manage.py create-mcp-token \
  --email USUARIO@EXEMPLO.COM \
  --nome NOME-DO-AGENTE \
  --scopes read,generate,write,schedule \
  --dias 90
```

Segredo aparece uma única vez. Para agente que apenas consulta ou cria rascunhos,
remova `schedule`. Escopos disponíveis:

| Escopo | Permissão |
|---|---|
| `read` | Listar contas, templates e posts |
| `generate` | Gerar conteúdo usando provedor de IA configurado |
| `write` | Criar rascunhos |
| `schedule` | Agendar publicação real nas contas sociais |

## 2. Guardar segredo fora do projeto

Use variável de ambiente fornecida por gerenciador de segredos ou ambiente seguro:

```bash
read -rsp "Token AutoPost MCP: " AUTOPOST_MCP_TOKEN
export AUTOPOST_MCP_TOKEN
echo
```

Não grave token em `.env` do repositório. Não reutilize token de outro agente.

## 3. Configurar Codex

Pelo CLI:

```bash
codex mcp add autopost \
  --url https://autopost.rovva.tech/mcp \
  --bearer-token-env-var AUTOPOST_MCP_TOKEN
```

Configuração equivalente em `~/.codex/config.toml`:

```toml
[mcp_servers.autopost]
url = "https://autopost.rovva.tech/mcp"
bearer_token_env_var = "AUTOPOST_MCP_TOKEN"
default_tools_approval_mode = "writes"
```

Modo `writes` pede aprovação para geração, rascunho e agendamento. Leitura pode rodar
sem confirmação. Reinicie Codex desktop ou extensão após alterar configuração.

## 4. Validar conexão

```bash
codex mcp list
```

Servidor `autopost` deve aparecer como habilitado com autenticação Bearer. No Codex
desktop ou TUI, use `/mcp` e confirme que ferramentas abaixo aparecem:

| Ferramenta | Efeito |
|---|---|
| `autopost_listar_contas` | Lista contas sociais conectadas |
| `autopost_listar_templates` | Lista templates de conteúdo |
| `autopost_listar_posts` | Lista posts recentes |
| `autopost_gerar_post` | Gera texto, sem salvar ou publicar |
| `autopost_enviar_midia` | Envia JPEG/imagem/vídeo em base64 e retorna ID |
| `autopost_criar_rascunho` | Salva rascunho, sem publicar |
| `autopost_agendar_post` | Agenda feed e/ou Story para publicação futura |

## 5. Fluxo obrigatório para publicar

1. Liste contas e templates; nunca invente IDs.
2. Envie mídias com `autopost_enviar_midia`; para Instagram use JPEG. Cada chamada
   deve ficar abaixo do limite de 1 MB do corpo MCP.
3. Gere conteúdo e apresente ao usuário.
4. Crie rascunho com `media_ids` na ordem do carrossel (máximo 10).
5. Confirme contas, data, horário, fuso e formatos.
6. Chame `autopost_agendar_post` com `placements: ["feed", "story"]` somente após
   confirmação explícita. `feed` é padrão; Story usa primeira mídia como capa.
7. AutoPost publica cada conta/formato de forma independente; job roda a cada 60 segundos.

Para “publicar agora”, agende pelo menos um minuto no futuro. Data deve usar ISO 8601,
preferencialmente com offset, por exemplo `2026-08-14T10:00:00-03:00`.

## Diagnóstico

| Sintoma | Ação |
|---|---|
| `401 Unauthorized` | Verifique variável, expiração ou revogação do token |
| `403` ou escopo insuficiente | Emita novo token com escopo necessário e revogue antigo |
| Servidor não aparece | Reinicie cliente e confira `codex mcp list` |
| Conta não encontrada | Rode `autopost_listar_contas`; não reutilize ID de outro tenant |
| Agendamento rejeitado | Use horário futuro e conta com status `connected` |

## Rotação e revogação

Liste tokens sem revelar segredos:

```bash
docker compose -f docker-compose.prod.yml exec autopost \
  python manage.py list-mcp-tokens --email USUARIO@EXEMPLO.COM
```

Revogue token comprometido, substituído ou sem uso:

```bash
docker compose -f docker-compose.prod.yml exec autopost \
  python manage.py revoke-mcp-token --email USUARIO@EXEMPLO.COM --id ID
```

Referência oficial: [OpenAI Docs — Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
