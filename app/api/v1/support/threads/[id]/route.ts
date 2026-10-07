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
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLS_MSG =
  "id, author_kind, author_id, body, media_url, media_storage_path, media_mime, media_name, media_size_bytes, created_at";

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

  // ── O ANEXO PRECISA DE URL ASSINADA ─────────────────────────────────────────
  //
  // O bucket `support-media` é PRIVADO (o anexo de um chamado pode ter dado do
  // negócio do cliente). O navegador não lê o path — precisa de uma URL
  // temporária. Sem isto, o anexo aparece como "arquivo" e o clique dá 404, que
  // é o sintoma mais confuso possível: o dado está lá, o link é que não abre.
  //
  // Assinatura em LOTE: uma chamada para todos os anexos do chamado, não uma por
  // mensagem. Um chamado com 10 prints faria 10 idas ao storage.
  const comAnexo = (mensagens ?? []).filter((m) => typeof m.media_storage_path === "string");
  let assinadas = new Map<string, string>();
  if (comAnexo.length > 0) {
    const admin = createAdminClient();
    const { data: urls } = await admin.storage
      .from("support-media")
      .createSignedUrls(
        comAnexo.map((m) => m.media_storage_path as string),
        60 * 60, // 1h: o suficiente para ler o chamado; curto o bastante para não virar link eterno
      );
    assinadas = new Map((urls ?? []).map((u) => [u.path ?? "", u.signedUrl ?? ""]));
  }

  const comUrl = (mensagens ?? []).map((m) => ({
    ...m,
    // `media_url` é o que a tela lê. Para anexo, é a assinada; para o que já
    // tiver URL direta (mídia de outro fluxo), a própria.
    media_url:
      m.media_url ??
      (typeof m.media_storage_path === "string"
        ? (assinadas.get(m.media_storage_path) ?? null)
        : null),
  }));

  return ok({ thread, mensagens: comUrl }, { requestId });
}
