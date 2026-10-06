/**
 * POST /api/v1/support/threads/[id]/messages — o usuário responde no chamado.
 *
 * Chamado FECHADO não aceita resposta: a decisão do dono é "fechou → abrir novo".
 * Aceitar aqui faria o histórico ter dois lugares para a mesma conversa.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { responderChamadoSchema } from "@/lib/schemas/suporte";
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

  const parsed = responderChamadoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escreva uma mensagem."), 422, { requestId });
  }

  const supabase = await createClient();

  const { data: thread } = await supabase
    .from("support_threads")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (!thread) return fail("not_found", t("Chamado não encontrado."), 404, { requestId });
  if (thread.status === "fechado" || thread.status === "resolvido") {
    return fail(
      "validation_failed",
      t("Este chamado foi encerrado. Abra um novo para continuar."),
      409,
      { requestId },
    );
  }

  const { data, error } = await supabase
    .from("support_messages")
    .insert({
      organization_id: authz.org.orgId,
      thread_id: id,
      author_kind: "usuario",
      author_id: authz.user.id,
      body: parsed.data.body,
    })
    .select("id, created_at")
    .maybeSingle();

  if (error || !data) {
    return fail("internal_error", t("Não consegui enviar sua mensagem."), 500, { requestId });
  }

  // Um chamado que voltou a ter mensagem do cliente sai de "resolvido" se tiver
  // sido marcado como tal pelo humano — senão ele ficaria numa fila que ninguém
  // olha, com o cliente esperando.
  if (thread.status !== "aberto") {
    await supabase.from("support_threads").update({ status: "aberto" }).eq("id", id);
  }

  return ok({ id: data.id }, { requestId });
}
