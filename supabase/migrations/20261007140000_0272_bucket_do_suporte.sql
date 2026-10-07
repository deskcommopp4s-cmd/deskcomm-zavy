-- 0272 — o bucket dos anexos do chamado de suporte.
--
-- ── POR QUE UM BUCKET PRÓPRIO, E NÃO O `whatsapp-media` ─────────────────────
--
-- Reusar `whatsapp-media` economizaria uma linha e misturaria duas coisas que
-- têm ciclos de vida diferentes: lá é mídia de CONVERSA do cliente com o
-- contato dele (o material do negócio); aqui é o print e o arquivo que o cliente
-- mandou para a PLATAFORMA pedindo ajuda. Apagar a conversa de um contato não
-- deve tocar no anexo de um chamado — nem o contrário.
--
-- O prefixo do path é `{organization_id}/...`, igual ao dos outros buckets: é o
-- que a policy de leitura usa, e é o que mantém a regra uniforme no repo.
--
-- ── QUEM ESCREVE ────────────────────────────────────────────────────────────
--
-- Só o `service_role`, pela rota de upload (`/api/v1/support/threads/[id]/
-- attachments`), que valida tipo e tamanho ANTES de subir. Não há policy de
-- escrita para `authenticated` de propósito: o cliente não escreve direto no
-- bucket — ele passa pela rota, que aplica o `validateOutboundMedia` e checa
-- que o chamado é dele. Sem isso, qualquer autenticado subiria arquivo de
-- qualquer tipo em qualquer path.
--
-- 50MB, igual ao `whatsapp-media`: o teto é do anexo, não do canal.

insert into storage.buckets (id, name, public, file_size_limit)
values ('support-media', 'support-media', false, 52428800)
on conflict (id) do nothing;

-- Leitura: quem é da organização do path. Mesma forma dos outros buckets —
-- `split_part(name, '/', 1)` é o `organization_id` que a rota grava.
drop policy if exists "support_media_read" on storage.objects;
create policy "support_media_read" on storage.objects for select to authenticated
  using (
    bucket_id = 'support-media'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid() and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );
