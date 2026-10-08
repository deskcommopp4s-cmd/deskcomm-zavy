-- 0275 — o bucket da mídia de campanha (A1, Fase 2).
--
-- Bucket PROPRIO, não o `support-media` nem o `whatsapp-media`: a mídia de
-- campanha é um ASSET da organização (reusado por todos os destinatários), e
-- apagar uma conversa/suporte não deve tocar nela. Path `{organization_id}/...`
-- (a mesma regra dos outros buckets). Escrita só pelo service_role (a rota de
-- upload valida tipo/tamanho antes de subir); leitura por organização do path.
-- 50MB, como os vizinhos.

insert into storage.buckets (id, name, public, file_size_limit)
values ('campaign-media', 'campaign-media', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "campaign_media_read" on storage.objects;
create policy "campaign_media_read" on storage.objects for select to authenticated
  using (
    bucket_id = 'campaign-media'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid() and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );
