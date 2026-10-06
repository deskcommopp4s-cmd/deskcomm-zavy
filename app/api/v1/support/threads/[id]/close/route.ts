/**
 * POST /api/v1/support/threads/[id]/close — o usuário encerra o chamado (+ NPS).
 *
 * O NPS é opcional e vem NO MESMO pedido do fechamento: em pedido separado, quem
 * fecha e sai da tela nunca o envia — e a métrica viraria "só de quem clica duas
 * vezes", que é o oposto de uma amostra.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { fecharChamadoSchema } from "@/lib/schemas/suporte";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  // A guarda da sessão de suporte READ-ONLY: ela barra a ESCRITA no app, e as
  // policies RESTRICTIVE a barram no banco. Os dois lados — a doutrina do repo
  // e a catraca `suporte-cobertura-de-efeitos` cobram esta linha de todo handler
  // que muta.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "support_threads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = fecharChamadoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail("validation_failed", t("Nota inválida."), 422, { requestId });
  }

  const supabase = await createClient();

  const { data: thread } = await supabase
    .from("support_threads")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (!thread) return fail("not_found", t("Chamado não encontrado."), 404, { requestId });
  if (thread.status === "fechado") return ok({ ja_fechado: true }, { requestId });

  // `fechado` (não `resolvido`): o usuário encerrou. O CHECK da tabela exige
  // `closed_at` junto — por isso os dois campos vão na mesma escrita.
  const { error } = await supabase
    .from("support_threads")
    .update({
      status: "fechado",
      closed_at: new Date().toISOString(),
      nps: parsed.data.nps ?? null,
      nps_comment: parsed.data.nps_comment ?? null,
    })
    .eq("id", id);

  if (error) return fail("internal_error", t("Não consegui encerrar o chamado."), 500, { requestId });
  return ok({ fechado: true }, { requestId });
}
