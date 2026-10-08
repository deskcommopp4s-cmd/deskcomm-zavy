/**
 * POST /api/v1/campaigns/[id]/activate — materializa o público e ativa a
 * campanha (A1, Fase 1).
 *
 * Separado do CREATE de propósito: a tela tem o passo "Revisão" entre salvar e
 * disparar (a mesa: disparo irreversível em 1 clique não existe). Este gesto é
 * o único que tira a campanha de 'rascunho'.
 *
 * O `audience` vem no body e é SALVO na ficha (para auditoria/re-executar) e
 * materializado em `campaign_recipients` com a afinidade resolvida.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import pg from "pg";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { materializarPublico } from "@/lib/campaign/audience";
import { loadEnv } from "@/lib/agent-engine/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { ativarCampanhaSchema } from "@/lib/schemas/campanha";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: loadEnv().SUPABASE_DB_URL, max: 4 });
  return _pool;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = ativarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Filtro de público inválido."), 422, { requestId });
  }

  const supabase = await createClient();

  // A campanha da ORG (a RLS filtra por org) — nunca de outra conta.
  const { data: campanha } = await supabase
    .from("campaigns")
    .select("id, status, new_lead_strategy, new_lead_session_id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!campanha) return fail("not_found", t("Campanha não encontrada."), 404, { requestId });
  if (campanha.status === "ativa" || campanha.status === "concluida") {
    return fail("validation_failed", t("Campanha já está ativa."), 409, { requestId });
  }

  // As conexões (fonte de verdade), só as da org.
  const { data: canais } = await supabase
    .from("campaign_channels")
    .select("channel_session_id")
    .eq("campaign_id", id)
    .eq("organization_id", authz.org.orgId);
  const idsDosCanais = (canais ?? []).map((c) => c.channel_session_id as string).filter(Boolean);
  if (idsDosCanais.length === 0) {
    return fail("validation_failed", t("A campanha não tem conexões."), 422, { requestId });
  }

  // `uses_official`: nenhum canal precisa de template na Fase 1 (todos não
  // oficiais na prática). Se uma sessão oficial entrar, a Fase 2 recalcula.
  const { error: erroAudience } = await supabase
    .from("campaigns")
    .update({ audience: parsed.data.audience as never })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroAudience) {
    return fail("internal_error", t("Não consegui salvar o filtro."), 500, { requestId });
  }

  try {
    const resultado = await materializarPublico(
      pool(),
      authz.org.orgId,
      id,
      parsed.data.audience,
      idsDosCanais,
      campanha.new_lead_strategy as "rotacionar" | "fixa",
      (campanha.new_lead_session_id as string | null) ?? null,
    );
    return ok({ entrados: resultado.entrados, elegiveis: resultado.elegiveis }, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro desconhecido";
    return fail("validation_failed", msg, 422, { requestId });
  }
}