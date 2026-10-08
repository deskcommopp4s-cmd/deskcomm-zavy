/**
 * GET /api/v1/campaigns/[id] — o detalhe da campanha (o clique no Acompanhamento).
 *
 * Devolve o que o operador precisa para ENTENDER a campanha: status (e por que
 * pausou), os contadores reais (entregue/lido/respondeu vêm de `messages`), os
 * passos e os destinatários com o nome do contato.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { criarCampanhaSchema, mensagemDaValidacao } from "@/lib/schemas/campanha";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();

  const { data: campanha } = await supabase
    .from("campaigns")
    .select(
      // Os campos de CONFIGURAÇÃO vão junto: o mesmo GET alimenta o modo edição
      // (o formulário precisa de nome, conexões, público, passos, janela, teto,
      // variação por IA e agendamento/recorrência para reabrir preenchido).
      "id, name, status, auto_paused, paused_reason, breaker_layer, paused_at, total_recipients, sent_count, failed_count, channel_session_ids, new_lead_strategy, new_lead_session_id, daily_limit, window_start_hour, window_end_hour, allowed_weekdays, audience, schedule_kind, scheduled_at, recurrence, ai_variation, created_at",
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });

  const { data: passos } = await supabase
    .from("campaign_steps")
    .select("step_order, body, media_kind, media_storage_path, media_mime, media_name:media_storage_path, delay_after_seconds")
    .eq("campaign_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("step_order", { ascending: true });

  const { data: destinatarios } = await supabase
    .from("campaign_recipients")
    .select("id, status, current_step, attempts, last_error, next_send_at, last_sent_at, contacts:contact_id(display_name, phone_number)")
    .eq("campaign_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("updated_at", { ascending: false })
    .limit(200);

  // Os contadores reais (entregue/lido/respondeu) vêm da FONTE (messages).
  const { data: dispatches } = await supabase
    .from("campaign_step_dispatches")
    .select("messages:outbound_message_id(delivered_at, read_at)")
    .eq("organization_id", authz.org.orgId)
    .in(
      "recipient_id",
      (destinatarios ?? []).map((d) => d.id as string),
    );

  let entregues = 0;
  let lidas = 0;
  for (const d of (dispatches ?? []) as unknown as Array<{
    messages?: { delivered_at: string | null; read_at: string | null } | null;
  }>) {
    if (d.messages?.delivered_at) entregues += 1;
    if (d.messages?.read_at) lidas += 1;
  }
  const respondidos = (destinatarios ?? []).filter((d) => d.status === "respondeu").length;

  return ok(
    {
      campanha,
      passos: passos ?? [],
      destinatarios: (destinatarios ?? []).map((d) => {
        const c = (d as unknown as { contacts?: { display_name?: string | null; phone_number?: string | null } }).contacts;
        return {
          id: d.id,
          status: d.status,
          current_step: d.current_step,
          attempts: d.attempts,
          last_error: d.last_error,
          last_sent_at: d.last_sent_at,
          // O rótulo canônico do contato (nome → telefone → "Sem nome"), nunca
          // a cadeia à mão — a catraca `rotulo-do-contato` existe para isso.
          nome: rotuloDoContato(c ?? null),
        };
      }),
      contadores: {
        entregues,
        lidas,
        respondidos,
      },
    },
    { requestId },
  );
}

/**
 * PUT /api/v1/campaigns/[id] — salva a edição de uma campanha EM RASCUNHO.
 *
 * Aceita o MESMO payload do POST (a tela reusa o formulário inteiro: nome,
 * conexões, público, passos, janela, teto, variação por IA, agendamento e
 * recorrência). Só rascunho: uma campanha ativa/pausada já tem público
 * materializado — mexer nos passos no meio do disparo é outro problema (o
 * caminho é pausar/retomar, ou um novo disparo).
 *
 * Conexões e passos são REESCRITOS (delete + insert): a lista do formulário é a
 * fonte de verdade, e editar um passo é substituir o conjunto, não remendar.
 */
export async function PUT(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = criarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", mensagemDaValidacao(parsed.error), 422, { requestId });
  }
  const dados = parsed.data;

  const supabase = await createClient();

  const { data: atual } = await supabase
    .from("campaigns")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Campanha não encontrada.", 404, { requestId });
  if (atual.status !== "rascunho") {
    return fail("validation_failed", "Só é possível editar uma campanha em rascunho.", 409, { requestId });
  }

  const { error: erroCampanha } = await supabase
    .from("campaigns")
    .update({
      name: dados.name,
      channel_session_ids: dados.channel_session_ids,
      new_lead_strategy: dados.new_lead_strategy,
      new_lead_session_id: dados.new_lead_session_id ?? null,
      daily_limit: dados.daily_limit ?? null,
      window_start_hour: dados.window_start_hour ?? 8,
      window_end_hour: dados.window_end_hour ?? 20,
      allowed_weekdays: dados.allowed_weekdays ?? [1, 2, 3, 4, 5],
      audience: dados.audience as never,
      ai_variation: dados.ai_variation ?? false,
      schedule_kind: dados.schedule_kind ?? "agora",
      scheduled_at: dados.scheduled_at ?? null,
      recurrence: (dados.recurrence ?? null) as never,
      uses_official: false, // recalculado no activate, a partir das conexões
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroCampanha) {
    return fail("internal_error", t("Não consegui salvar a campanha."), 500, { requestId });
  }

  const { error: erroLimpaCanais } = await supabase
    .from("campaign_channels")
    .delete()
    .eq("campaign_id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroLimpaCanais) {
    return fail("internal_error", t("Não consegui salvar as conexões."), 500, { requestId });
  }
  const canais = dados.channel_session_ids.map((sid) => ({
    organization_id: authz.org.orgId,
    campaign_id: id,
    channel_session_id: sid,
  }));
  const { error: erroCanais } = await supabase.from("campaign_channels").insert(canais);
  if (erroCanais) return fail("internal_error", t("Não consegui salvar as conexões."), 500, { requestId });

  const { error: erroLimpaPassos } = await supabase
    .from("campaign_steps")
    .delete()
    .eq("campaign_id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroLimpaPassos) {
    return fail("internal_error", t("Não consegui salvar os passos."), 500, { requestId });
  }
  const passos = dados.steps.map((passo, i) => ({
    organization_id: authz.org.orgId,
    campaign_id: id,
    step_order: i + 1,
    body: passo.body ?? null,
    media_kind: passo.media_kind ?? null,
    media_storage_path: passo.media_storage_path ?? null,
    media_mime: passo.media_mime ?? null,
    delay_after_seconds: passo.delay_after_seconds ?? 0,
  }));
  const { error: erroPassos } = await supabase.from("campaign_steps").insert(passos);
  if (erroPassos) return fail("internal_error", t("Não consegui salvar os passos."), 500, { requestId });

  return ok({ id }, { requestId });
}
