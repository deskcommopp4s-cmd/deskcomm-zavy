-- ============================================================================
-- 0273 — Campanhas (disparos em massa). Base: DRAFT-migration-campanhas.sql
-- (mesa de análise, 2 rodadas) — com as correções de ordem e nome abaixo.
--
-- CORREÇÕES DO MEU LADO (medidas, não assumidas):
--   1. O draft criava `campaign_channels` DEPOIS do laço de RLS que a habilita →
--      falharia em runtime. Reordenado: as 5 tabelas primeiro; FKs, funções,
--      RLS e triggers depois.
--   2. O draft nomeava o reaper `fn_reaver_campaign_recipients` — typo de
--      "reaper". Renomeado para `fn_reaper_campaign_recipients`.
--   3. `messages.ack_at` NÃO existe no baseline (as ocorrências de "ack_at" no
--      grep eram `fallback_at` do platform_branding) → criado aqui, com índice.
--   4. GIN em `contacts.custom_fields` não existe (só o de crm_leads) → criado
--      aqui (pendência explícita da mesa).
--   5. Número da migration: 0273 (a maior aplicada é a 0272).
--
-- ⚠️ AS 6 DECISÕES DO DONO (05/10/2026) ESTÃO FECHADAS: não há bloqueio.
-- ============================================================================

-- ============================================================================
-- 1. campaigns — a ficha
-- ============================================================================
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  status text not null default 'rascunho',

  channel_session_ids uuid[] not null default '{}',
  new_lead_strategy text not null default 'rotacionar',
  new_lead_session_id uuid,

  daily_limit integer,
  window_start_hour smallint not null default 8,
  window_end_hour smallint not null default 20,
  allowed_weekdays smallint[] not null default '{1,2,3,4,5}',
  timezone text,

  ai_variation boolean not null default false,
  stop_on_reply boolean not null default true,
  stop_on_reply_scope text not null default 'contato',

  schedule_kind text not null default 'agora',
  scheduled_at timestamptz,
  recurrence jsonb,

  audience jsonb not null default '{}',

  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  delivered_count integer not null default 0,
  read_count integer not null default 0,
  replied_count integer not null default 0,
  failed_count integer not null default 0,

  uses_official boolean not null default false,

  paused_reason text,
  paused_at timestamptz,
  breaker_layer smallint,
  auto_paused boolean not null default false,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaigns_status_check check (
    status in ('rascunho','agendada','ativa','pausada','concluida','cancelada')
  ),
  constraint campaigns_strategy_check check (new_lead_strategy in ('rotacionar','fixa')),
  constraint campaigns_schedule_check check (schedule_kind in ('agora','agendado','recorrente')),
  constraint campaigns_scope_check check (stop_on_reply_scope in ('contato','campanha')),
  constraint campaigns_hours_check check (
    window_start_hour between 0 and 23
    and window_end_hour between 0 and 23
    and window_start_hour < window_end_hour
  ),
  constraint campaigns_daily_limit_check check (daily_limit is null or daily_limit > 0),
  -- A variação por IA é incompatível com canal oficial (template é fixo)
  constraint campaigns_variation_check check (not uses_official or ai_variation = false),
  unique (organization_id, id)
);

comment on table public.campaigns is
  'A ficha da campanha. daily_limit é cap ADICIONAL — o cap anti-ban do NÚMERO continua em channel_sessions.daily_message_limit, e o teto efetivo é o MENOR dos dois. A campanha e o atendimento COMPARTILHAM o teto do número: a tela tem de avisar com número.';
comment on column public.campaigns.audience is
  'O filtro de público (jsonb). NÃO existe include_opted_out: o opt-out é irrevogável. A materialização exclui is_blocked E force_human. Base legal de prospecção é DECISÃO DE NEGÓCIO do dono: a campanha não bloqueia por base legal.';
comment on column public.campaigns.uses_official is
  'Derivado das conexões: quando true, a campanha exige TEMPLATE, a variação por IA é impossível, o teto é CUSTO (não ban) e há minIntervalMs de 6s.';
comment on column public.campaigns.paused_reason is
  'Por que a campanha pausou. Com breaker_layer dizendo QUAL das 3 camadas disparou. Sem isto, a pausa automática é silenciosa.';

-- ============================================================================
-- 2. campaign_steps — a sequência de mensagens
-- ============================================================================
create table if not exists public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  step_order smallint not null,
  body text,
  media_storage_path text,
  media_kind text,
  delay_after_seconds integer not null default 0,
  created_at timestamptz not null default now(),

  constraint campaign_steps_media_check check (
    media_kind is null or media_kind in ('image','document','voice')
  ),
  constraint campaign_steps_delay_check check (delay_after_seconds >= 0),
  unique (campaign_id, step_order)
);

comment on table public.campaign_steps is
  'Os passos da campanha, em ordem. delay_after_seconds é a espera ATÉ O PRÓXIMO passo. O áudio (media_kind=voice) passa pelo voice-transcode.ts NO UPLOAD.';

-- ============================================================================
-- 3. campaign_recipients — o estado do contato na esteira
-- ============================================================================
create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  contact_id uuid not null,

  channel_session_id uuid not null,
  conversation_id uuid,

  current_step smallint not null default 1,  -- 1 = o primeiro passo (os steps sao 1-based)
  status text not null default 'pendente',
  next_send_at timestamptz,

  claimed_until timestamptz,
  claimed_by text,

  outbound_message_id uuid,

  last_sent_at timestamptz,
  replied_at timestamptz,
  inhibited_reason text,

  attempts smallint not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaign_recipients_status_check check (
    status in ('pendente','enviando','enviado','entregue','lido','respondeu','falhou','parado')
  ),
  constraint campaign_recipients_clock_check check (
    (status in ('pendente','enviando') and next_send_at is not null)
    or status in ('enviado','entregue','lido','respondeu','falhou','parado')
  ),
  unique (campaign_id, contact_id),
  unique (organization_id, id)
);

comment on table public.campaign_recipients is
  'Estado de UM contato em UMA campanha. O estado de cada ENVIO vive em campaign_step_dispatches. A conexão é resolvida na inscrição.';
comment on column public.campaign_recipients.claimed_until is
  'Lease do worker. Enquanto futuro, a linha está reclamada. Expirado, o reaper devolve. Lição da 0146: a condição de lease é REPETIDA no WHERE do UPDATE.';
comment on column public.campaign_recipients.outbound_message_id is
  'A linha de messages deste envio. É o que liga o destinatário ao ack do webhook.';
comment on column public.campaign_recipients.inhibited_reason is
  'Por que este destinatário parou. NUNCA gravar is_blocked do contato aqui. Quando o lead responde, a campanha PAUSA para aquele CONTATO.';

-- Quem aplicou a 0273 com default 0 (antes da correção) recebe o novo default.
alter table public.campaign_recipients alter column current_step set default 1;

create index if not exists idx_campaign_recipients_due
  on public.campaign_recipients (campaign_id, status, next_send_at)
  where status = 'pendente';
create index if not exists idx_campaign_recipients_contato
  on public.campaign_recipients (organization_id, contact_id);
create index if not exists idx_campaign_recipients_lease
  on public.campaign_recipients (claimed_until) where status = 'enviando';

-- ============================================================================
-- 4. campaign_step_dispatches — o registro POR ENVIO
-- ============================================================================
create table if not exists public.campaign_step_dispatches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  recipient_id uuid not null,
  step_order smallint not null,
  outbound_message_id uuid references public.messages(id) on delete set null,
  status text not null default 'pendente',
  sent_at timestamptz,
  ack_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),

  constraint campaign_dispatches_status_check check (
    status in ('pendente','enviando','enviado','entregue','lido','falhou','parado')
  ),
  unique (recipient_id, step_order),
  unique (organization_id, id)
);

comment on table public.campaign_step_dispatches is
  'Um registro por ENVIO (destinatário × passo). delivered_at/read_at NÃO vivem aqui — a fonte é messages.';
comment on column public.campaign_step_dispatches.ack_at is
  'O instante do PRIMEIRO ack — o sinal rápido do freio. NÃO confundir com delivered_at (depende do celular do cliente ligar).';

create unique index if not exists uq_dispatch_outbound_message
  on public.campaign_step_dispatches (outbound_message_id)
  where outbound_message_id is not null;

-- ============================================================================
-- 5. campaign_channels — as conexões (uma campanha = UMA classe de provider)
-- ============================================================================
create table if not exists public.campaign_channels (
  campaign_id uuid not null,
  organization_id uuid not null,
  channel_session_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (campaign_id, channel_session_id)
);

comment on table public.campaign_channels is
  'As conexões de uma campanha. Uma campanha = UMA classe de provider (oficial OU não oficial). O array campaigns.channel_session_ids vira espelho de leitura.';

-- ============================================================================
-- 6. FKs COMPOSTAS — sem elas, organization_id não é confiável e a RLS é teatro
-- ============================================================================
alter table public.campaigns
  drop constraint if exists fk_campaigns_org;
alter table public.campaigns
  add constraint fk_campaigns_org
    foreign key (organization_id) references public.organizations(id) on delete cascade;

alter table public.campaign_recipients
  drop constraint if exists fk_recipients_campaign_org;
alter table public.campaign_recipients
  add constraint fk_recipients_campaign_org
    foreign key (organization_id, campaign_id)
    references public.campaigns(organization_id, id) on delete cascade;
-- FKs SIMPLES para tabelas existentes: o repo não usa FK composta para
-- contacts/conversations/channel_sessions — as PKs delas são só `id`, e o
-- isolamento entre contas é a RLS (`fn_user_org_ids()`). O draft propôs
-- compostas aqui, mas isso exigiria ALTER em 3 tabelas grandes num padrão que o
-- repo não usa em lugar nenhum. (Medido: nenhum `references ...(organization_id`
-- existente no baseline.)
alter table public.campaign_recipients
  drop constraint if exists fk_recipients_contact;
alter table public.campaign_recipients
  add constraint fk_recipients_contact
    foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.campaign_recipients
  drop constraint if exists fk_recipients_session;
alter table public.campaign_recipients
  add constraint fk_recipients_session
    foreign key (channel_session_id) references public.channel_sessions(id) on delete restrict;
alter table public.campaign_recipients
  drop constraint if exists fk_recipients_conversation;
alter table public.campaign_recipients
  add constraint fk_recipients_conversation
    foreign key (conversation_id) references public.conversations(id) on delete set null;

alter table public.campaign_steps
  drop constraint if exists fk_steps_campaign_org;
alter table public.campaign_steps
  add constraint fk_steps_campaign_org
    foreign key (organization_id, campaign_id)
    references public.campaigns(organization_id, id) on delete cascade;

alter table public.campaign_step_dispatches
  drop constraint if exists fk_dispatches_recipient_org;
alter table public.campaign_step_dispatches
  add constraint fk_dispatches_recipient_org
    foreign key (organization_id, recipient_id)
    references public.campaign_recipients(organization_id, id) on delete cascade;

alter table public.campaign_channels
  drop constraint if exists fk_channels_campaign_org;
alter table public.campaign_channels
  add constraint fk_channels_campaign_org
    foreign key (organization_id, campaign_id)
    references public.campaigns(organization_id, id) on delete cascade;
alter table public.campaign_channels
  drop constraint if exists fk_channels_session;
alter table public.campaign_channels
  add constraint fk_channels_session
    foreign key (channel_session_id) references public.channel_sessions(id) on delete cascade;

-- ============================================================================
-- 7. CLAIM ATÔMICO COM LEASE — o molde da 0054 + a lição da 0146
-- ============================================================================
create or replace function public.fn_claim_due_campaign_recipients(
  p_limit int,
  p_lease_seconds int
)
returns setof public.campaign_recipients
language sql
security definer
set search_path = public
as $$
  with travados as (
    select r.id
      from public.campaign_recipients r
     where r.status = 'pendente'
       and r.next_send_at <= now()
       and (r.claimed_until is null or r.claimed_until < now())
     order by r.next_send_at
     limit p_limit
     for update skip locked
  )
  update public.campaign_recipients r
     set status = 'enviando',
         claimed_until = now() + make_interval(secs => p_lease_seconds),
         claimed_by = pg_backend_pid()::text,
         updated_at = now()
   where r.id in (select id from travados)
     -- ⚠️ lição da 0146: a condição de lease repetida AQUI
     and (r.claimed_until is null or r.claimed_until < now())
  returning r.*;
$$;

revoke all on function public.fn_claim_due_campaign_recipients(int, int)
  from public, anon, authenticated;

comment on function public.fn_claim_due_campaign_recipients(int, int) is
  'Claim atômico do worker de campanha. SKIP LOCKED + LEASE. A condição de lease é repetida no WHERE do UPDATE de propósito — lição da 0146.';

-- ============================================================================
-- 8. REAPER — sem ele, o estado "enviando" vira terminal
-- ============================================================================
create or replace function public.fn_reaper_campaign_recipients(
  p_max_attempts int default 5
)
returns integer
language sql
security definer
set search_path = public
as $$
  with expirados as (
    update public.campaign_recipients r
       set status = case
             when r.attempts + 1 >= p_max_attempts then 'falhou'
             else 'pendente'
           end,
           attempts = r.attempts + 1,
           claimed_until = null,
           claimed_by = null,
           last_error = 'lease_expirado',
           updated_at = now()
     where r.status = 'enviando'
       and r.claimed_until < now()
    returning 1
  )
  select count(*)::int from expirados;
$$;

revoke all on function public.fn_reaper_campaign_recipients(smallint)
  from public, anon, authenticated;

comment on function public.fn_reaper_campaign_recipients(smallint) is
  'Devolve à fila o destinatário cujo lease expirou. A idempotência do envio é o sink (chave campaign_id+recipient_id+step_order), que reconcilia por messages.metadata.idempotency_key antes de reenviar.';

-- ============================================================================
-- 9. RLS + grants — padrão do repo (tabela tenant-aware)
-- ============================================================================
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.campaign_steps enable row level security;
alter table public.campaign_step_dispatches enable row level security;
alter table public.campaign_channels enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','campaign_recipients','campaign_steps','campaign_step_dispatches',
    'campaign_channels'
  ] loop
    -- A catraca 0150 (rbac-config-ia-canais) reprova tabela NOVA com policy ALL
    -- so-tenancy sem fn_role_at_least. O padrao novo e por comando + papel.
    -- Papel minimo: agent (campanha e operacao: quem atende cria; viewer nao).
    -- A permissao refinada (quem pode disparar) e Fase 4 do desenho.
    -- Drop das policies ANTIGAS (tenant_isolation_*_all) — a 0273 foi aplicada
    -- com o molde `for all`; a catraca 0150 reprovaria se as duas coexistissem.
    execute format('drop policy if exists tenant_isolation_%1$s_all on public.%1$s', t);
    execute format('drop policy if exists tenant_isolation_%1$s_select on public.%1$s', t);
    execute format(
      'create policy tenant_isolation_%1$s_select on public.%1$s for select to authenticated '
      'using (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, ''agent''))', t);
    execute format('drop policy if exists tenant_isolation_%1$s_insert on public.%1$s', t);
    execute format(
      'create policy tenant_isolation_%1$s_insert on public.%1$s for insert to authenticated '
      'with check (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, ''agent''))', t);
    execute format('drop policy if exists tenant_isolation_%1$s_update on public.%1$s', t);
    execute format(
      'create policy tenant_isolation_%1$s_update on public.%1$s for update to authenticated '
      'using (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, ''agent'')) '
      'with check (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, ''agent''))', t);
    execute format('drop policy if exists tenant_isolation_%1$s_delete on public.%1$s', t);
    execute format(
      'create policy tenant_isolation_%1$s_delete on public.%1$s for delete to authenticated '
      'using (organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, ''agent''))', t);
    execute format('revoke all on public.%1$s from anon', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
    execute format('grant all on public.%1$s to service_role', t);
  end loop;
end $$;

-- ============================================================================
-- 10. Triggers de updated_at
-- ============================================================================
drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_campaign_recipients_updated_at on public.campaign_recipients;
create trigger trg_campaign_recipients_updated_at
  before update on public.campaign_recipients
  for each row execute function public.fn_set_updated_at();

-- ============================================================================
-- 11. ack_at em MESSAGES (o produtor do ack do freio)
-- ============================================================================
alter table public.messages
  add column if not exists ack_at timestamptz;

comment on column public.messages.ack_at is
  'O instante do PRIMEIRO ack (servidor aceitou, ack>=1) — o sinal RÁPIDO. NÃO confundir com delivered_at: medido, o delivered tem mediana de 7 min e p90 de 34h. É o sinal que o freio de ban silencioso usa.';

create index if not exists idx_messages_sem_ack
  on public.messages (organization_id, channel_session_id, sent_at desc)
  where direction = 'outbound' and ack_at is null;

-- ============================================================================
-- 12. GIN em contacts.custom_fields (o filtro por campo personalizado)
-- ============================================================================
create index if not exists idx_contacts_custom_fields_gin
  on public.contacts using gin (custom_fields jsonb_path_ops);

notify pgrst, 'reload schema';