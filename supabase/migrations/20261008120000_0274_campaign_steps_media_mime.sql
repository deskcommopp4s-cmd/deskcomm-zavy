-- 0274 — campaign_steps.media_mime (A1, Fase 2: o worker manda mídia).
--
-- O worker repassa `media_mime` ao caminho de envio (sendMessageHandler grava o
-- mime na linha de messages). O campo nasce agora; a 0273 criou media_kind e
-- media_storage_path mas não o mime. Aditivo e idempotente.
alter table public.campaign_steps
  add column if not exists media_mime text;

comment on column public.campaign_steps.media_mime is
  'O mime do arquivo do passo (ex.: image/png, application/pdf). O worker o repassa ao caminho de envio para gravar na linha de messages.';

notify pgrst, 'reload schema';
