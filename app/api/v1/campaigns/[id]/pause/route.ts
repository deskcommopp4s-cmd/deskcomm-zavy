/**
 * POST /api/v1/campaigns/[id]/pause — pausa MANUAL de uma campanha ativa.
 *
 * A pausa automática (o freio) grava `auto_paused=true` + `breaker_layer`; a
 * manual grava `auto_paused=false` + o motivo que a pessoa der. As duas nunca
 * voltam sozinhas — o desenho: "voltar sozinho depois de um ban é o pior
 * comportamento possível". Retomar é o `activate` de novo (reutilizado).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const motivo =
    body && typeof body.motivo === "string" && body.motivo.trim()
      ? body.motivo.trim().slice(0, 500)
      : "pausa manual";

  const supabase = await createClient();
  const { data: atual } = await supabase
    .from("campaigns")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!atual) return fail("not_found", t("Campanha não encontrada."), 404, { requestId });
  if (atual.status !== "ativa" && atual.status !== "agendada") {
    return fail("validation_failed", t("Só é possível pausar uma campanha ativa."), 409, { requestId });
  }

  const { error } = await supabase
    .from("campaigns")
    .update({
      status: "pausada",
      auto_paused: false,
      paused_reason: motivo,
      paused_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  if (error) return fail("internal_error", t("Não consegui pausar a campanha."), 500, { requestId });
  return ok({ id, status: "pausada" }, { requestId });
}