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
import { criarCampanhaSchema } from "@/lib/schemas/campanha";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = criarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados da campanha inválidos."), 422, { requestId });
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
    delay_after_seconds: passo.delay_after_seconds ?? 0,
  }));
  const { error: erroPassos } = await supabase.from("campaign_steps").insert(passos);
  if (erroPassos) {
    return fail("internal_error", t("Não consegui registrar os passos."), 500, { requestId });
  }

  return ok({ id: campanha.id }, { requestId });
}