/**
 * POST /api/v1/campaigns/media — sobe um arquivo para usar como passo de mídia
 * da campanha (A1, Fase 2).
 *
 * ── POR QUE POR AQUI, E NÃO DIRETO NO BUCKET ────────────────────────────────
 *
 * O bucket `campaign-media` NÃO tem policy de escrita para `authenticated` (de
 * propósito). Esta rota é o funil: valida TIPO e TAMANHO (`validateOutboundMedia`,
 * o mesmo do canal) e confere que a requisição é de um `agent` da org — antes de
 * o byte existir.
 *
 * O mime do ARQUIVO é o que o worker repassa ao caminho de envio. Para Voz
 * (media_kind=voice), o arquivo deve ser convertido NO UPLOAD uma vez pela
 * disciplina do `voice-transcode.ts` — ver o desenho; nesta rota o kind é
 * derivado do mime (image/document; voice é tratado pelo transcoder no worker).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const FOLGA_MULTIPART_BYTES = 1_048_576;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > 50 * 1_048_576 + FOLGA_MULTIPART_BYTES) {
    return fail("payload_too_large", t("Arquivo acima de 50MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Nenhum arquivo enviado."), 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    return fail(verdict.code, t(verdict.message), verdict.code === "payload_too_large" ? 413 : 422, {
      requestId,
    });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Path `{org}/campaigns/{uuid}.{ext}` — o gate isMediaPathOwnedBy aceita o
  // prefixo `{org}/campaigns/` da MESMA org.
  const storagePath = `${authz.org.orgId}/campaigns/${randomUUID()}.${extFromMime(mime)}`;

  const admin = createAdminClient();
  const { error: erroUpload } = await admin.storage
    .from("campaign-media")
    .upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (erroUpload) {
    console.error("[campaigns.media] upload falhou", erroUpload.message);
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  const media_kind = mime.startsWith("image/")
    ? "image"
    : mime.startsWith("audio/")
      ? "voice"
      : "document";

  return ok({ media_storage_path: storagePath, media_mime: mime, media_kind }, { requestId });
}