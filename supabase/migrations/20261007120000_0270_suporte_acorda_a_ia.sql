-- 0270 — a mensagem do CLIENTE acorda a IA do suporte.
--
-- A 0268 criou as tabelas; a 0269 pôs o aviso no vocabulário da Central. Faltava
-- o elo: quando o cliente escreve no chamado, alguém precisa saber.
--
-- ── POR QUE UM TRIGGER, E NÃO O ROUTE ───────────────────────────────────────
--
-- O `POST /support/threads/[id]/messages` poderia emitir o evento. Mas aí o
-- caminho ficaria dependente de TODA porta que gravar uma mensagem de cliente —
-- a rota, um script de importação, um conserto manual — lembrar de emitir. O
-- gatilho garante que a mensagem do cliente SEMPRE acorda a IA, por qualquer
-- porta. É o mesmo desenho do `fn_emit_event_on_lead_change`.
--
-- ── SÓ `usuario` ────────────────────────────────────────────────────────────
--
-- `author_kind = 'ia'` NÃO dispara. Sem esta condição a IA responderia a própria
-- resposta, para sempre: um laço que só apareceria na fatura da plataforma.
-- `humano` também não: quem respondeu foi uma pessoa, e a IA não deve atropelar.
--
-- ── O READ-ONLY NÃO É AFETADO ───────────────────────────────────────────────
--
-- O gatilho escreve em `event_log` a partir de um INSERT em `support_messages`.
-- A conexão de LEITURA da IA (`poolDeLeituraDoSuporte`) nunca insere ali — ela
-- só lê a conta. As duas coisas não se cruzam.

create or replace function public.fn_support_message_acorda_a_ia()
returns trigger
  language plpgsql security definer
  set search_path to 'public'
as $$
begin
  -- Só a mensagem do CLIENTE acorda a IA. `ia` re-dispararia para sempre;
  -- `humano` atropelaria quem já assumiu.
  if new.author_kind <> 'usuario' then
    return new;
  end if;

  -- `entity_id` = o CHAMADO: o worker lê `payload.thread_id` e cai nele como
  -- reserva. O payload carrega o id da mensagem para a telemetria poder apontar
  -- qual mensagem gerou a resposta.
  perform public.emit_event(
    'support.message',
    'support_thread',
    new.thread_id,
    jsonb_build_object('thread_id', new.thread_id, 'message_id', new.id),
    '{}'::jsonb,
    new.organization_id
  );
  return new;
end;
$$;

-- A função nasce com EXECUTE para `public` (default do Postgres) e o `anon`
-- herdaria. Trigger function não precisa de EXECUTE para ninguém — o gatilho
-- roda como o DONO da tabela. Revogar é o que fecha a porta.
revoke all on function public.fn_support_message_acorda_a_ia() from public, anon, authenticated;

drop trigger if exists trg_support_message_acorda_a_ia on public.support_messages;
create trigger trg_support_message_acorda_a_ia
  after insert on public.support_messages
  for each row execute function public.fn_support_message_acorda_a_ia();

notify pgrst, 'reload schema';
