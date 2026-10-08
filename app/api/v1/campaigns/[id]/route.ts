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
      "id, name, status, auto_paused, paused_reason, breaker_layer, paused_at, total_recipients, sent_count, failed_count, window_start_hour, window_end_hour, allowed_weekdays, scheduled_at, ai_variation, created_at",
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", "Campanha não encontrada.", 404, { requestId });

  const { data: passos } = await supabase
    .from("campaign_steps")
    .select("step_order, body, media_kind, media_name:media_storage_path, delay_after_seconds")
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
          nome: c?.display_name ?? c?.phone_number ?? "—",
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
