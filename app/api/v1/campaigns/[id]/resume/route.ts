/**
 * POST /api/v1/campaigns/[id]/resume — retoma uma campanha pausada.
 *
 * Pausa não volta sozinha (o desenho); retomar é gesto HUMANO e explícito. Só
 * uma campanha PAUSADA retoma: uma concluída/cancelada não (o público já
 * terminou — o caminho é um novo disparo). Os destinatários pendentes seguem
 * pendentes; não há rematerialização.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("campaigns")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", "Campanha não encontrada.", 404, { requestId });
  if (atual.status !== "pausada") {
    return fail("validation_failed", "Só é possível retomar uma campanha pausada.", 409, { requestId });
  }

  const { error } = await supabase
    .from("campaigns")
    .update({ status: "ativa", auto_paused: false, paused_reason: null, paused_at: null, breaker_layer: null })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", "Não consegui retomar a campanha.", 500, { requestId });

  return ok({ id, status: "ativa" }, { requestId });
}
