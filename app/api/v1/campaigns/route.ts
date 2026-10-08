/**
 * POST /api/v1/campaigns — cria a campanha (ficha + passos + conexões).
 *
 * A cria fica em 'rascunho'; o disparo só começa no `activate`. É o passo de
 * REVISÃO da tela que separa os dois gestos — disparo em massa nunca pode ser
 * consequência colateral de "salvar".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { criarCampanhaSchema, mensagemDaValidacao } from "@/lib/schemas/campanha";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET — a lista de campanhas da organização (a tela de acompanhamento).
 * A RLS filtra por org; o papel vem do requireRole.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data: campanhas, error } = await supabase
    .from("campaigns")
    .select(
      "id, name, status, total_recipients, sent_count, failed_count, delivered_count, read_count, replied_count, created_at, window_start_hour, window_end_hour",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return fail("internal_error", "Não consegui listar as campanhas.", 500, { requestId });

  // ── MÉTRICAS reais (Fase 3): entregue/lido vêm da FONTE (messages), não dos
  // contadores da ficha. O dispatch liga o envio à linha de messages
  // (outbound_message_id); delivered/read é um fato de messages. `respondeu`
  // vem do marcos do recipient (replied_at).
  const ids = (campanhas ?? []).map((c) => c.id as string);
  let metricas: Record<string, { delivered: number; read: number; replied: number }> = {};
  if (ids.length > 0) {
    const { data: agregado } = await supabase
      .from("campaign_recipients")
      .select(
        "campaign_id, campaign_step_dispatches!inner(outbound_message_id, messages!inner(delivered_at, read_at)), replied_at",
      )
      .in("campaign_id", ids);
    // O Supabase JS não agrega; conta-se aqui (lista por campanha é curta).
    metricas = {};
    for (const row of (agregado ?? []) as unknown as Array<{
      campaign_id: string;
      replied_at: string | null;
      campaign_step_dispatches?: Array<{
        messages?: { delivered_at: string | null; read_at: string | null } | null;
      }>;
    }>) {
      const m = metricas[row.campaign_id] ?? { delivered: 0, read: 0, replied: 0 };
      if (row.replied_at) m.replied += 1;
      const dispatch = row.campaign_step_dispatches?.[0];
      if (dispatch?.messages?.delivered_at) m.delivered += 1;
      if (dispatch?.messages?.read_at) m.read += 1;
      metricas[row.campaign_id] = m;
    }
  }

  const comMetricas = (campanhas ?? []).map((c) => {
    const m = metricas[c.id as string] ?? { delivered: 0, read: 0, replied: 0 };
    return { ...c, delivered_count: m.delivered, read_count: m.read, replied_count: m.replied };
  });

  return ok(comMetricas, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = criarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", mensagemDaValidacao(parsed.error), 422, { requestId });
  }
  const dados = parsed.data;

  const supabase = await createClient();

  const { data: campanha, error: erroCampanha } = await supabase
    .from("campaigns")
    .insert({
      organization_id: authz.org.orgId,
      name: dados.name,
      status: "rascunho",
      channel_session_ids: dados.channel_session_ids,
      new_lead_strategy: dados.new_lead_strategy,
      new_lead_session_id: dados.new_lead_session_id ?? null,
      daily_limit: dados.daily_limit ?? null,
      window_start_hour: dados.window_start_hour ?? 8,
      window_end_hour: dados.window_end_hour ?? 20,
      allowed_weekdays: dados.allowed_weekdays ?? [1, 2, 3, 4, 5],
      audience: dados.audience as never,
      // Fase 4 — estes chegavam à rota mas o schema os descartava (não era
      // strict): a variação por IA e a recorrência nunca salvavam.
      ai_variation: dados.ai_variation ?? false,
      schedule_kind: dados.schedule_kind ?? "agora",
      scheduled_at: dados.scheduled_at ?? null,
      recurrence: (dados.recurrence ?? null) as never,
      uses_official: false, // o admin recalcula no activate a partir das conexões
      created_by: authz.user.id,
    })
    .select("id")
    .single();
  if (erroCampanha || !campanha) {
    return fail("internal_error", t("Não consegui criar a campanha."), 500, { requestId });
  }

  // As conexões na tabela filha (fonte de verdade) + os passos.
  const canais = dados.channel_session_ids.map((sid) => ({
    organization_id: authz.org.orgId,
    campaign_id: campanha.id as string,
    channel_session_id: sid,
  }));
  const { error: erroCanais } = await supabase.from("campaign_channels").insert(canais);
  if (erroCanais) {
    return fail("internal_error", t("Não consegui registrar as conexões."), 500, { requestId });
  }

  const passos = dados.steps.map((passo, i) => ({
    organization_id: authz.org.orgId,
    campaign_id: campanha.id as string,
    step_order: i + 1,
    body: passo.body ?? null,
    media_kind: passo.media_kind ?? null,
    media_storage_path: passo.media_storage_path ?? null,
    media_mime: passo.media_mime ?? null,
    delay_after_seconds: passo.delay_after_seconds ?? 0,
  }));
  const { error: erroPassos } = await supabase.from("campaign_steps").insert(passos);
  if (erroPassos) {
    return fail("internal_error", t("Não consegui registrar os passos."), 500, { requestId });
  }

  return ok({ id: campanha.id }, { requestId });
}