-- 0271 — "escalado, aguardando alguém pegar" é um estado legítimo, e o CHECK o proibia.
--
-- ── O DEFEITO QUE ISSO CONSERTA (medido em 07/10/2026) ──────────────────────
--
-- A 0268 escreveu: `support_threads_humano_check = (status <> 'com_humano' OR
-- assigned_to IS NOT NULL)`. A intenção era boa — "com_humano" significa que
-- uma pessoa está NELA — mas o produto tem DOIS momentos distintos:
--
--   1. a IA escalou e NINGUÉM pegou ainda (a fila da plataforma);
--   2. alguém pegou e está atendendo.
--
-- O CHECK tratava os dois como um só, e o momento 1 — o mais comum — era
-- recusado pelo banco. Medido com um chamado real: a IA escalou, o aviso nasceu
-- na Central do cliente, e o `update` do chamado bateu em
-- `violates check constraint "support_threads_humano_check"` — em SILÊNCIO,
-- porque o código não checava o erro. O chamado ficou `aberto` com o cliente já
-- avisado de que uma pessoa assumiria.
--
-- `com_humano` passa a significar "está com a plataforma" (com ou sem dono). O
-- dono, quando existe, continua em `assigned_to`. Quem quiser distinguir os dois
-- momentos usa `assigned_to IS NULL`.
alter table public.support_threads
  drop constraint if exists support_threads_humano_check;

alter table public.support_threads
  add constraint support_threads_humano_check check (
    (status <> 'com_humano') or (assigned_to is not null) or (escalated_at is not null)
  );

notify pgrst, 'reload schema';
