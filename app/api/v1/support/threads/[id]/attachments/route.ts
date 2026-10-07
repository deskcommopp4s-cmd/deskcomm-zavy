/**
 * POST /api/v1/support/threads/[id]/attachments — o cliente anexa no chamado.
 *
 * ── POR QUE ESTA ROTA EXISTE (e não o cliente subir direto no bucket) ───────
 *
 * O bucket `support-media` não tem policy de escrita para `authenticated` — de
 * propósito. Se o cliente subisse direto, qualquer autenticado gravaria arquivo
 * de qualquer tipo em qualquer path. A rota é o funil: ela valida TIPO e
 * TAMANHO (`validateOutboundMedia`, o mesmo do canal) e confere que o chamado é
 * da organização de quem está enviando — ANTES de o arquivo existir no bucket.
 *
 * ── O ANEXO É UMA MENSAGEM ──────────────────────────────────────────────────
 *
 * Não há tabela de anexos: a 0268 pôs as colunas de mídia em `support_messages`,
 * espelhando `messages`. Então anexar é gravar uma mensagem com mídia — e isso
 * tem uma consequência boa: o gatilho `trg_support_message_acorda_a_ia` dispara
 * em `author_kind='usuario'`, ou seja, **o anexo também acorda a IA**. Sem
 * esforço extra, mandar um print é o mesmo que mandar texto.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto do corpo antes do parse — o `file.size` pós-parse é o autoritativo. */
const FOLGA_MULTIPART_BYTES = 1_048_576;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "support_threads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  // Anexar é raro, mas o upload é CARO (bytes no bucket). Teto por usuário, e
  // mais apertado que o de abrir chamado: 20 em 10 min dá para mandar os prints
  // de um problema inteiro sem virar porta de upload.
  const rl = await checkRateLimit(`support_attach:${authz.user.id}`, 20, 600);
  if (!rl.allowed) {
    return fail(
      "rate_limited",
      t("Muitos anexos seguidos. Aguarde alguns minutos."),
      429,
      { requestId, headers: { "Retry-After": "600" } },
    );
  }

  // O teto do CORPO primeiro: não vale ler 200MB para descobrir que é grande.
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
    // A mensagem do validador é a do canal ("Arquivo acima de 50MB.", "Tipo de
    // arquivo não suportado."). Reusar mantém a mesma frase onde a pessoa já viu.
    return fail(verdict.code, t(verdict.message), verdict.code === "payload_too_large" ? 413 : 422, {
      requestId,
    });
  }

  // Sessão de SESSÃO (não a admin) para o check de posse: quem filtra é a RLS.
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

  const bytes = Buffer.from(await file.arrayBuffer());
  // O path começa pelo `organization_id`: é o que a policy de leitura usa para
  // decidir quem vê o quê (`split_part(name, '/', 1)`).
  const storagePath = `${authz.org.orgId}/${id}/in-${randomUUID()}.${extFromMime(mime)}`;

  const admin = createAdminClient();
  const { error: erroUpload } = await admin.storage
    .from("support-media")
    .upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (erroUpload) {
    console.error("[support.attachments] upload falhou", erroUpload.message);
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  const { error: erroMsg } = await admin.from("support_messages").insert({
    organization_id: authz.org.orgId,
    thread_id: id,
    author_kind: "usuario",
    author_id: authz.user.id,
    // O CHECK da 0268 exige `body` OU mídia. Anexo sem legenda vai com `body`
    // nulo — e é por isso que o CHECK existe em OR, não em AND.
    body: typeof form?.get("body") === "string" ? (form.get("body") as string).slice(0, 8000) : null,
    media_storage_path: storagePath,
    media_mime: mime,
    media_size_bytes: bytes.length,
    media_name: file.name.slice(0, 200),
  });

  if (erroMsg) {
    // A mensagem não entrou: o arquivo no bucket fica órfão. Remover é o certo —
    // deixar bytes sem dono no bucket é lixo que ninguém varre.
    await admin.storage.from("support-media").remove([storagePath]);
    return fail("internal_error", t("Erro ao registrar o anexo."), 500, { requestId });
  }

  return ok({ storage_path: storagePath, name: file.name, mime, size: bytes.length }, { requestId });
}
