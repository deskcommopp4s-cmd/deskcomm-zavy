-- ============================================================================
-- 0266 — O KILL SWITCH GLOBAL DA QUALIFICAÇÃO DO LEAD (JEV / TypeSafe)
--
-- ## O que entra
--
-- Uma coluna em `platform_settings` (o singleton da INSTALAÇÃO, migration 0253):
--   qualificacao_jev_ativa boolean not null default true
--
-- É o interruptor GLOBAL do superadmin para a funcionalidade nova de qualificar
-- o lead com o provedor de decisão (Jev, da TypeSafe). O interruptor POR
-- ORGANIZAÇÃO é o binding habilitado em `ai_purpose_bindings`
-- (`purpose = 'qualificacao_do_lead'`, `is_enabled`), que também escolhe o
-- provedor. Ligar a função exige os dois.
--
-- ## Por que essa tabela, e não uma nova
--
-- `platform_settings` JÁ é o lugar da configuração da instalação: linha única
-- (`id = 1`), RLS ligada SEM policies, `anon`/`authenticated` revogados e leitura
-- e escrita só pelo `service_role` atrás do gate administrativo — o MESMO
-- desenho de `platform_branding` (0155) e `platform_meta_app` (0257). Criar uma
-- tabela nova para um booleano seria inventar mecanismo paralelo ao que o
-- superadmin já usa.
--
-- ## Por que o default é `true`
--
-- Um KILL SWITCH nasce ligado; o superadmin o desliga em emergência. O que
-- impede a funcionalidade de aparecer sozinha numa instalação que atualiza é o
-- INTERRUPTOR POR ORGANIZAÇÃO: sem um binding habilitado para
-- `qualificacao_do_lead`, o código nem olha o switch global e o comportamento é
-- idêntico ao de hoje (o classificador `stage_classifier` segue no lugar). A
-- ausência da LINHA (`platform_settings` sem `id = 1`) é lida como o default
-- (`true`) pelo mesmo motivo.
--
-- ## Idempotência
--
-- `add column if not exists`. O `update.sh` reaplica o baseline inteiro; sem o
-- `if not exists`, a segunda aplicação levantaria 42701. Sem backfill: a coluna
-- nasce com default e nenhuma linha existente precisa ser tocada.
-- ============================================================================

alter table public.platform_settings
  add column if not exists qualificacao_jev_ativa boolean not null default true;

comment on column public.platform_settings.qualificacao_jev_ativa is
  'Kill switch GLOBAL da qualificação do lead com um provedor de decisão (Jev/TypeSafe). Ligue/desligue pela instalação; o interruptor POR ORGANIZAÇÃO é o binding habilitado em ai_purpose_bindings (purpose=qualificacao_do_lead). Ausência da linha ou default true = ligado; o que mantém a funcionalidade desligada no upgrade é a ausência do binding.';

notify pgrst, 'reload schema';
