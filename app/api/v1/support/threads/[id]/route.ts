/**
 * GET /api/v1/support/threads/[id] — o chamado e as mensagens dele.
 *
 * Confirma que o chamado é visível ANTES de listar as mensagens: sem isso, um
 * id de outro cliente devolveria a lista VAZIA (a RLS esconde as mensagens) em
 * vez de 404 — e "vazio" e "não é seu" pareceriam a mesma coisa.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLS_MSG =
  "id, author_kind, author_id, body, media_url, media_mime, media_name, created_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "support_threads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();

  const { data: thread } = await supabase
    .from("support_threads")
    .select("id, assunto, status, escalated_at, closed_at, nps, created_at, updated_at")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (!thread) return fail("not_found", t("Chamado não encontrado."), 404, { requestId });

  const { data: mensagens, error } = await supabase
    .from("support_messages")
    .select(COLS_MSG)
    .eq("thread_id", id)
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", t("Não consegui carregar o chamado."), 500, { requestId });
  return ok({ thread, mensagens: mensagens ?? [] }, { requestId });
}
