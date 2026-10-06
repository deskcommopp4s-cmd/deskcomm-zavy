-- ============================================================================
-- 0268 — SUPORTE AO CLIENTE (chat na plataforma)
--
-- O usuário do cliente abre um CHAMADO de suporte DENTRO do CRM; a IA responde
-- primeiro (lê a conta em READ-ONLY) e escala para um humano da PLATAFORMA.
-- Nunca sai do sistema.
--
-- Nasce corrigida por refutação de 4 agentes (05/10/2026) e por 2 decisões do dono:
--   D1 — a PLATAFORMA paga a IA de suporte (não o cliente; não pode ser bloqueada
--        pelo teto de quem pede ajuda)
--   D2 — o ESCOPO de admin é protegido NO BANCO (não só na tela)
--
-- ⚠️ BLAST RADIUS (D2): `fn_is_platform_admin()` passa a exigir `scope='full'`.
-- MEDIDO em produção (05/10/2026): 1 admin, com `full` → NÃO altera nada hoje ✅
-- e exclui corretamente um futuro admin de suporte das 106 policies que a usam.
--
-- Decisão do dono (READ-ONLY ABSOLUTO): nem a IA nem o suporte humano alteram o
-- sistema do cliente — configuração, conversas, contatos ou leads. Ver o §8.
-- ============================================================================

-- ============================================================================
-- 1. O ESCOPO DE ADMIN (D2) — proteger no banco
-- ============================================================================

-- O CHECK atual só aceita 'full' e 'support_readonly' (baseline:1778).
-- 'support_readonly' já significa OUTRA COISA (força a impersonação a ser
-- read-only, migration 0220:29-30). Por isso o valor novo é 'suporte' —
-- distinto de propósito.
alter table public.platform_admins
  drop constraint if exists platform_admins_scope_check;
alter table public.platform_admins
  add constraint platform_admins_scope_check
  check (scope = any (array['full','support_readonly','suporte']));

comment on column public.platform_admins.scope is
  'PERFIL do admin de plataforma. full = tudo · suporte = SÓ os chamados de suporte (não vê tenants, LGPD, impersonate) · support_readonly = modo de impersonação read-only (outro eixo, da migration 0220). Quem governa o ACESSO é fn_is_platform_admin/fn_is_platform_support — não basta o valor da coluna.';

-- `fn_is_platform_admin()` passa a exigir `full`.
-- MEDIDO: os 106 usos da função estão TODOS em policies, no padrão
-- `... or public.fn_is_platform_admin()`. Mudar a FUNÇÃO cobre os 106 de uma vez.
create or replace function public.fn_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.platform_admins pa
     where pa.user_id = auth.uid()
       and pa.revoked_at is null
       and pa.scope = 'full'          -- ← a mudança: só o perfil TOTAL
  );
$$;
revoke execute on function public.fn_is_platform_admin() from public, anon;
grant execute on function public.fn_is_platform_admin() to authenticated, service_role;

comment on function public.fn_is_platform_admin() is
  'Admin de plataforma com perfil TOTAL. Exige scope=full: um admin de suporte NÃO satisfaz as 106 policies que usam esta função (tenants, LGPD, impersonate, dados de tenant). A mudança é segura: em 05/10/2026 havia 1 admin, com full.';

-- A função do SUPORTE: aceita `full` OU `suporte`.
create or replace function public.fn_is_platform_support()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.platform_admins pa
     where pa.user_id = auth.uid()
       and pa.revoked_at is null
       and pa.scope in ('full','suporte')
  );
$$;
revoke execute on function public.fn_is_platform_support() from public, anon;
grant execute on function public.fn_is_platform_support() to authenticated, service_role;

comment on function public.fn_is_platform_support() is
  'Quem pode ver/responder chamados de suporte: o admin total e o admin de suporte. NÃO serve para dado de tenant — só para as tabelas support_*.';

-- ============================================================================
-- 2. support_threads — o chamado
-- ============================================================================
create table if not exists public.support_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  opened_by uuid not null references auth.users(id) on delete cascade,
  assunto text,
  status text not null default 'aberto',
  assigned_to uuid references auth.users(id) on delete set null,
  escalated_at timestamptz,
  escalated_reason text,                -- CORREÇÃO C8: o payload de continuidade
  escalated_summary text,               --   (resumo do que aconteceu, não a conversa crua)
  closed_at timestamptz,
  nps smallint,
  nps_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_threads_status_check check (
    status in ('aberto','com_ia','com_humano','resolvido','fechado','ia_falhou')
  ),
  constraint support_threads_nps_check check (nps is null or nps between 0 and 10),
  -- CORREÇÃO C11: coerência de estado
  constraint support_threads_fechado_check check (
    (status in ('resolvido','fechado') and closed_at is not null)
    or status not in ('resolvido','fechado')
  ),
  constraint support_threads_humano_check check (
    status <> 'com_humano' or assigned_to is not null
  ),
  unique (organization_id, id)          -- substrato da FK composta dos filhos
);

comment on table public.support_threads is
  'Um CHAMADO de suporte (1 thread = 1 chamado). O `organization_id` é do CLIENTE que pede; quem responde é a PLATAFORMA. `opened_by` é o usuário do cliente — é o que dá o histórico por usuário.';
comment on column public.support_threads.status is
  'aberto → com_ia → (com_humano | resolvido | ia_falhou) → fechado. `ia_falhou` existe para o caso em que a IA não conseguiu responder — sem ele a thread ficaria em com_ia para sempre, sem sinal.';
comment on column public.support_threads.escalated_summary is
  'O resumo do handoff IA→humano (o que aconteceu e por quê). A doutrina do repo (sistema-vivo, invariante 2) exige contexto pronto para continuar — não a conversa crua.';
comment on column public.support_threads.organization_id is
  '⚠️ NUNCA aceitar do request body. A validação está na policy de escrita (fn_user_org_ids) — sem ela, a IA leria a conta de OUTRO cliente (a exfiltração que a refutação achou).';

-- ============================================================================
-- 3. support_messages — as mensagens
-- ============================================================================
-- CORREÇÃO C7: mídia em COLUNAS (espelhando `messages`), não em jsonb — a
-- cascata de LGPD só varre colunas (`messages.media_storage_path`), e um jsonb
-- sobreviveria à exclusão do titular.
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  thread_id uuid not null,
  author_kind text not null,
  author_id uuid,
  body text,
  -- mídia (espelha messages: media_url, media_mime, media_size_bytes, media_storage_path)
  media_url text,
  media_mime text,
  media_size_bytes bigint,
  media_storage_path text,
  media_name text,
  created_at timestamptz not null default now(),

  constraint support_messages_author_check check (author_kind in ('usuario','ia','humano')),
  -- CORREÇÃO C11: coerência autor
  constraint support_messages_autor_id_check check (
    (author_kind = 'ia' and author_id is null)
    or (author_kind in ('usuario','humano') and author_id is not null)
  ),
  -- mensagem vazia não existe
  constraint support_messages_conteudo_check check (
    body is not null and btrim(body) <> '' or media_storage_path is not null
  ),
  -- CORREÇÃO C7: FK COMPOSTA — sem ela, mensagem órfã ou org divergente
  constraint support_messages_thread_fk
    foreign key (organization_id, thread_id)
    references public.support_threads (organization_id, id)
    on delete cascade
);

comment on table public.support_messages is
  'Mensagens do chamado. `author_kind`: usuario (do cliente) | ia (a plataforma) | humano (a equipe). A mídia usa as MESMAS colunas de `messages` de propósito: a cascata de LGPD varre coluna, não jsonb — anexo em jsonb sobreviveria ao pedido de exclusão.';
comment on column public.support_messages.media_storage_path is
  '⚠️ Precisa entrar na cascata de LGPD (fn_lgpd_cascade_redact_contact) e na storage_redaction_queue. Hoje a cascata só conhece messages.media_storage_path.';

-- ============================================================================
-- 4. ÍNDICES (CORREÇÃO C11) — as 3 queries quentes do fluxo
-- ============================================================================
create index if not exists idx_support_threads_do_usuario
  on public.support_threads (opened_by, created_at desc);
create index if not exists idx_support_threads_da_plataforma
  on public.support_threads (status, created_at desc);
create index if not exists idx_support_threads_da_org
  on public.support_threads (organization_id, status, created_at desc);
create index if not exists idx_support_threads_atribuidos
  on public.support_threads (assigned_to) where assigned_to is not null;
create index if not exists idx_support_messages_da_thread
  on public.support_messages (organization_id, thread_id, created_at);

-- ============================================================================
-- 5. TRIGGER de updated_at (CORREÇÃO C11)
-- ============================================================================
drop trigger if exists trg_support_threads_updated_at on public.support_threads;
create trigger trg_support_threads_updated_at
  before update on public.support_threads
  for each row execute function public.fn_set_updated_at();

-- ============================================================================
-- 6. RLS (CORREÇÃO C4) — UMA policy com OR interno, NÃO duas permissivas
-- ============================================================================
-- Duas policies permissivas são OR-adas: a de organization_id sozinha liberaria
-- QUALQUER membro da org e a restrição por opened_by desapareceria (o repo já
-- pagou esse erro — MANIFEST 0035). Por isso: UMA policy, OR dentro.
alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists support_threads_select on public.support_threads;
create policy support_threads_select on public.support_threads
  for select to authenticated
  using (
    opened_by = auth.uid()
    or public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_support()
  );

-- CORREÇÃO C5 — A VALIDAÇÃO DA ORG NA ESCRITA (o furo de exfiltração).
-- Sem o `organization_id in fn_user_org_ids()`, o usuário cria a thread com a
-- org da VÍTIMA, a IA lê a org DA THREAD e devolve a conta dela na thread dele.
drop policy if exists support_threads_insert on public.support_threads;
create policy support_threads_insert on public.support_threads
  for insert to authenticated
  with check (
    opened_by = auth.uid()
    and organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists support_threads_update on public.support_threads;
create policy support_threads_update on public.support_threads
  for update to authenticated
  using (
    opened_by = auth.uid()
    or public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_support()
  )
  with check (
    opened_by = auth.uid()
    or public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_support()
  );

-- As MENSAGENS herdam a visibilidade da THREAD via EXISTS (nunca org-flat).
drop policy if exists support_messages_select on public.support_messages;
create policy support_messages_select on public.support_messages
  for select to authenticated
  using (
    exists (
      select 1
        from public.support_threads t
       where t.id = support_messages.thread_id
         and t.organization_id = support_messages.organization_id
         and (
           t.opened_by = auth.uid()
           or public.fn_role_at_least(t.organization_id, 'admin')
           or public.fn_is_platform_support()
         )
    )
  );

drop policy if exists support_messages_insert on public.support_messages;
create policy support_messages_insert on public.support_messages
  for insert to authenticated
  with check (
    exists (
      select 1
        from public.support_threads t
       where t.id = support_messages.thread_id
         and t.organization_id = support_messages.organization_id
         and t.organization_id in (select public.fn_user_org_ids())
         and (t.opened_by = auth.uid() or public.fn_is_platform_support())
    )
  );

revoke all on public.support_threads from anon;
revoke all on public.support_messages from anon;
grant select, insert, update on public.support_threads to authenticated;
grant select, insert on public.support_messages to authenticated;
grant all on public.support_threads, public.support_messages to service_role;

-- ============================================================================
-- 7. A TRAVA DO READ-ONLY (CORREÇÃO C6)
-- ============================================================================
-- As travas da migration 0220 são aplicadas por um LOOP ONE-SHOT sobre as
-- tabelas que existiam NAQUELE instante (0220:104-125). Estas tabelas nascem
-- DEPOIS → sem a trava → uma sessão `support_readonly` faria CRUD via PostgREST.
--
-- O helper REAL é `fn_support_write_allowed(<coluna de org>)` (0220:118-124).
-- A regra do loop: tabela onde `authenticated` NÃO tem insert/update/delete
-- mantém ZERO policies (server-only). Aqui `authenticated` TEM escrita, então
-- as três policies restritivas entram.

drop policy if exists support_write_insert on public.support_threads;
create policy support_write_insert on public.support_threads
  as restrictive for insert to authenticated
  with check (public.fn_support_write_allowed(organization_id));

drop policy if exists support_write_update on public.support_threads;
create policy support_write_update on public.support_threads
  as restrictive for update to authenticated
  using (public.fn_support_write_allowed(organization_id))
  with check (public.fn_support_write_allowed(organization_id));

drop policy if exists support_write_delete on public.support_threads;
create policy support_write_delete on public.support_threads
  as restrictive for delete to authenticated
  using (public.fn_support_write_allowed(organization_id));

drop policy if exists support_write_insert on public.support_messages;
create policy support_write_insert on public.support_messages
  as restrictive for insert to authenticated
  with check (public.fn_support_write_allowed(organization_id));

drop policy if exists support_write_update on public.support_messages;
create policy support_write_update on public.support_messages
  as restrictive for update to authenticated
  using (public.fn_support_write_allowed(organization_id))
  with check (public.fn_support_write_allowed(organization_id));

drop policy if exists support_write_delete on public.support_messages;
create policy support_write_delete on public.support_messages
  as restrictive for delete to authenticated
  using (public.fn_support_write_allowed(organization_id));

-- ============================================================================
-- 8. READ-ONLY ABSOLUTO (decisão do dono) — a IA e o humano NÃO alteram nada
-- ============================================================================
-- REGRA: a IA de suporte e o suporte humano NÃO podem alterar o sistema do
-- cliente — nem configuração, nem conversas, nem contatos, nem leads.
-- Prerrogativa irrevogável: READ ONLY.
--
-- DOIS ATORES, DOIS MECANISMOS (o mesmo buraco não serve para os dois):
--
-- (a) O SUPORTE HUMANO — usa uma sessão `authenticated`, que OBEDECE as
--     policies. As 3 policies RESTRICTIVE do §7 (`support_write_*` com
--     `fn_support_write_allowed`) bloqueiam a escrita.
--     E há GUARDA MECÂNICA: `tests/invariants/suporte-temporario.test.ts`
--     (linhas 86-88) REPROVA qualquer tabela onde `authenticated` tenha
--     escrita e não tenha as 3 travas → tabela nova sem a trava = CI vermelho.
--
-- (b) A IA — usa `service_role`, que IGNORA as policies.
--     MEDIDO em produção: `service_role.rolbypassrls = true`.
--     As policies NÃO a alcançam. A trava tem de ser outra: a CONEXÃO nasce
--     em modo somente-leitura, e o PRÓPRIO BANCO recusa a escrita.
--
--     MEDIDO (05/10/2026), com controle positivo:
--       begin read only; update ... where false;
--         → ERROR: cannot execute UPDATE in a read-only transaction   ✅ recusa
--       begin; update ... where false;
--         → UPDATE 0  (passou — o instrumento está vivo)              ✅ controle
--
--     IMPLEMENTAÇÃO (Fase 3, quando a IA entrar) — a conexão de LEITURA do
--     módulo de suporte:
--       set default_transaction_read_only = on;   -- por conexão/pool
--     ou, no `pg`:
--       new Pool({ options: '-c default_transaction_read_only=on' })
--
--     O módulo de suporte NUNCA usa a conexão de escrita para ler a conta.
--     Escrever na conversa de suporte (a tabela support_messages) é outra
--     conexão — a de escrita, que só toca as tabelas `support_*`.
--
-- [ ] GUARDA MECÂNICA a criar: teste que REPROVA se o módulo de leitura do
--     suporte abrir conexão sem `default_transaction_read_only`.
--     (Regra em texto não é garantia — GLOBAL_RULES §2.1.)

-- ============================================================================
-- [D1] O ORÇAMENTO DA PLATAFORMA — a plataforma paga a IA de suporte
-- ============================================================================
-- DECISÃO DO DONO: a IA de suporte é CUSTO DE OPERAÇÃO DA PLATAFORMA — não do
-- cliente, e não pode ser bloqueada pelo teto de quem está pedindo ajuda.
--
-- O orçamento de IA hoje é POR ORGANIZAÇÃO (ai_budgets.organization_id NOT NULL).
-- A plataforma não tem org. O lugar é o SINGLETON da instalação:
--   platform_settings (id=1) — hoje só tem signup_mode.
--
-- A implementação (Fase 3, quando a IA entrar):
--   alter table public.platform_settings
--     add column if not exists ai_monthly_limit_cents integer,
--     add column if not exists ai_month_consumed_cents numeric(12,4) not null default 0;
--   + o ponto `suporte_atendimento` loga contra ESTE orçamento, nunca contra a
--     org do cliente.

-- ============================================================================
-- PENDÊNCIAS OBRIGATÓRIAS (o repo exige — não são opcionais)
-- ============================================================================
-- [ ] Apêndice idempotente no supabase/baseline.sql
-- [ ] Linha no supabase/migrations/MANIFEST.md
-- [ ] Entrada em TABLES do invariante de RLS (rls-completude-varredura)
-- [ ] CASCATA LGPD: incluir support_threads + support_messages na redação E no
--     export do titular, e os anexos na storage_redaction_queue
--     ⚠️ É DÚVIDA JURÍDICA: qual a base para reter a conversa de suporte após
--     o pedido de exclusão? → perguntar ao dono
-- [ ] RATE LIMIT no create (um cliente abre 10 mil chamados, cada um com IA)
-- [ ] AUDITORIA de leitura cross-tenant (audit com bypassed_rls)
-- [ ] O evento para o BADGE (support_messages não emite nada hoje → sino mudo)
-- [ ] O REAPER (com_ia sem resposta / com_humano sem atendimento)
-- [ ] Reservar o número da migration (o maior hoje é 0267)
