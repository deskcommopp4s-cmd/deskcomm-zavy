-- ============================================================================
-- 0268 — CABEÇALHOS HTTP PRÓPRIOS NO BINDING DO PONTO
--
-- ## O que entra
--
--   1. `public.ai_purpose_bindings.headers` (jsonb): cabeçalhos extras enviados
--      ao provedor DAQUELE ponto, no formato `{ "Nome": "valor" }`. Nulo =
--      nenhum (o comportamento de antes).
--
-- ## Por que
--
-- O endereço próprio (`base_url`, migration sem número desta frente) resolveu
-- "apontar para outro endpoint" — mas há provedores OpenAI-compatíveis que
-- exigem mais que a URL: eles pedem um CABEÇALHO de roteamento próprio.
--
-- Medido no OpenCode Go (`https://opencode.ai/zen/go/v1/chat/completions`):
-- sem `x-opencode-session` a resposta é
--
--     400 {"type":"MissingSessionID",
--          "message":"Request is missing x-opencode-session and cannot be
--                     routed efficiently."}
--
-- e COM o cabeçalho é 200 e a geração vem. Ou seja: sem esta coluna, o operador
-- consegue configurar o endereço, o painel SALVA, e toda chamada falha com um
-- 400 que não aponta para o painel — o mesmo modo de falha do endereço próprio
-- ignorado, que já custou uma correção.
--
-- ## Segurança
--
-- A coluna guarda CABEÇALHOS, não credenciais: a chave continua em
-- `ai_provider_credentials` (cifrada, por organização). Um valor de cabeçalho
-- que seja secreto deve ser tratado como qualquer outro segredo de configuração
-- — mas o caminho canônico de segredo continua sendo o cofre de credenciais.
--
-- `Authorization` é RECUSADO na escrita (a rota valida): deixar o operador
-- sobrescrever o cabeçalho de autenticação transformaria o cofre em decoração,
-- e a chave apareceria em texto no banco.
--
-- ## Idempotência
--
-- `add column if not exists` — o `baseline.sql` é reaplicado a cada update
-- (`scripts/test-db.sh`, modo UPDATE), e um `alter table` sem guarda morreria
-- na segunda passada.
-- ============================================================================

alter table public.ai_purpose_bindings
  add column if not exists headers jsonb;

comment on column public.ai_purpose_bindings.headers is
  'Cabeçalhos HTTP extras enviados ao provedor DESTE ponto ({ "Nome": "valor" }). '
  'Nulo = nenhum. Existe para provedores que exigem cabeçalho de roteamento '
  '(ex.: x-opencode-session do OpenCode Go, cuja ausência responde 400). '
  'Authorization é recusado pela rota: a chave vive em ai_provider_credentials.';
