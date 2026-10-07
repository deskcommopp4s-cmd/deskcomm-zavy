-- 0269 — o aviso do suporte entra no vocabulário de `agent_inbox_items`.
--
-- A 0268 criou as tabelas do suporte, mas o aviso "a plataforma respondeu" precisa
-- nascer na Central do CLIENTE — e a CHECK de `kind` não conhecia o valor. Sem
-- esta migration o INSERT do aviso era recusado e o cliente só descobria a
-- resposta recarregando a tela.
--
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara este CHECK
-- com o union `InboxKind` do TypeScript: foi ele que pegou a divergência no CI
-- (o compilador NÃO pega esta).

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'suporte_resposta',
    'other'
  ));

notify pgrst, 'reload schema';
