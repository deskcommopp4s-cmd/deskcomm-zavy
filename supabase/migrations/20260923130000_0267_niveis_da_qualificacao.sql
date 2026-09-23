-- ============================================================================
-- 0267 — OS TRÊS NÍVEIS DE HABILITAÇÃO DA QUALIFICAÇÃO DO LEAD (JEV / TypeSafe)
--
-- ## O que entra
--
--   1. O COFRE DE CREDENCIAL DE PLATAFORMA (`public.platform_decision_credentials`).
--      A chave do provedor de DECISÃO (o Jev, da TypeSafe) deixa de ser BYOK
--      (`ai_provider_credentials`, uma por organização) e passa a ser da
--      INSTALAÇÃO: o superadmin cadastra UMA vez e a organizações usam. A
--      prateleira é por PROVIDER, para um segundo provedor de decisão entrar sem
--      migration nova.
--
--   2. O INTERRUPTOR POR ORGANIZAÇÃO (`organizations.qualificacao_jev_ativa`):
--      o superadmin libera a funcionalidade tenant a tenant. Default `false` —
--      ninguém ganha a feature sem liberação explícita.
--
-- ## Os TRÊS níveis, e por que o efetivo é o AND dos três
--
--   1. GLOBAL (superadmin, a instalação): `platform_settings.qualificacao_jev_ativa`
--      (migration 0266) — já existia.
--   2. POR ORGANIZAÇÃO (superadmin): `organizations.qualificacao_jev_ativa` — NOVO aqui.
--   3. NA CONTA (admin da própria organização): `ai_purpose_bindings.is_enabled` — já existia.
--
--   Efetivo = os três ligados. Qualquer um desligado ⇒ o classificador de etapa
--   atual assume, comportamento idêntico ao de hoje.
--
-- ## Por que o cofre é uma tabela NOVA, e não uma coluna em `ai_provider_credentials`
--
-- `ai_provider_credentials.organization_id` é NOT NULL: a tabela é, por desenho,
-- de tenant. A credencial da instalação não pertence a organização nenhuma, e
-- enfiá-la ali exigiria afrouxar o NOT NULL e poluir a view `_safe` do BYOK. O
-- padrão da família `platform_*` (`platform_branding` 0155, `platform_settings`
-- 0253, `platform_meta_app` 0257) é exatamente este: objeto de instalação, RLS
-- ligada sem policies, `anon`/`authenticated` revogados, leitura e escrita só
-- pelo `service_role` atrás do gate administrativo.
--
-- ## Por que as colunas são as MESMAS de `ai_provider_credentials`
--
-- A cifra é a mesma (`lib/crypto/aes_gcm.ts`, AES-256-GCM com a chave em
-- `AI_CRED_AES_KEY`), então as colunas são as mesmas: `ciphertext`/`iv`/`tag`
-- (bytea) e `last4` (text, só os últimos 4 para a tela identificar sem decifrar).
-- Nenhuma criptografia nova.
--
-- ## Idempotência
--
-- `add column if not exists` + `create table if not exists`, `revoke`/`grant`
-- reaplicáveis, trigger recriado com `drop ... if exists`. O `update.sh`
-- reaplica o baseline inteiro; a segunda aplicação não pode levantar.
-- ============================================================================

-- ── Nível 2: o superadmin libera a feature para uma organização ──────────────
--
-- Default `false` de propósito: ninguém ganha a funcionalidade sem que o
-- superadmin a libere. É o oposto do kill switch GLOBAL (0266), que nasce
-- ligado — lá o default protege a operação; aqui protege quem nunca pediu a
-- feature de a ver aparecendo sozinha.
alter table public.organizations
  add column if not exists qualificacao_jev_ativa boolean not null default false;

comment on column public.organizations.qualificacao_jev_ativa is
  'Nível 2 dos três da qualificação do lead (Jev/TypeSafe): o SUPERADMIN libera a feature para esta organização. Default false — ninguém ganha sem liberação. O nível 1 é platform_settings.qualificacao_jev_ativa; o nível 3 é ai_purpose_bindings.is_enabled (purpose=qualificacao_do_lead). Efetivo = os três ligados.';

-- ── Nível 1 (credencial): o cofre da chave de plataforma ─────────────────────
create table if not exists public.platform_decision_credentials (
  provider text primary key,
  api_key_encrypted bytea not null,
  api_key_iv bytea not null,
  api_key_tag bytea not null,
  api_key_last4 text not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.platform_decision_credentials is
  'A chave do provedor de DECISÃO desta INSTALAÇÃO (Jev/TypeSafe e futuros), uma linha por provedor. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — o PostgREST não a serve. A leitura decifra com AI_CRED_AES_KEY (lib/crypto/aes_gcm.ts); nenhuma rota devolve a chave em claro.';
comment on column public.platform_decision_credentials.api_key_encrypted is
  'Cifrado por encryptKey (AES-256-GCM, chave em AI_CRED_AES_KEY). Nunca gravar em claro: sem a chave mestra o save RECUSA.';
comment on column public.platform_decision_credentials.api_key_last4 is
  'Os 4 últimos caracteres da chave, em claro, só para a tela identificar qual está cadastrada. A chave inteira nunca volta ao browser.';
comment on column public.platform_decision_credentials.is_active is
  'Desligar sem apagar. A escada de chave só considera linha ativa antes de cair para o ambiente.';

alter table public.platform_decision_credentials enable row level security;

revoke all on public.platform_decision_credentials from anon, authenticated;
grant select, insert, update on public.platform_decision_credentials to service_role;

drop trigger if exists trg_platform_decision_credentials_updated_at on public.platform_decision_credentials;
create trigger trg_platform_decision_credentials_updated_at
  before update on public.platform_decision_credentials
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
