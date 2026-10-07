/**
 * GET  /api/v1/admin/support/threads/[id] — o chamado e as mensagens (plataforma).
 * POST /api/v1/admin/support/threads/[id] — o humano responde.
 *
 * Ao responder, o chamado passa a `com_humano` e recebe `assigned_to`: é o que
 * tira ele da fila dos outros e diz quem está atendendo. Sem isso, dois
 * atendentes respondem a mesma pergunta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { responderChamadoSchema } from "@/lib/schemas/suporte";
import { createAdminClient } from "@/lib/supabase/admin";
import { podeAtenderSuporte } from "@/lib/support/escopo";

export const dynamic = "force-dynamic";

const COLS_MSG =
  "id, author_kind, author_id, body, media_url, media_mime, media_name, created_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const ctx = await requirePlatformAdmin();
  if (!podeAtenderSuporte(ctx)) {
    return fail("forbidden", "Seu perfil não atende suporte.", 403, { requestId });
  }
  const { id } = await params;
  const admin = createAdminClient();

  const { data: thread } = await admin
    .from("support_threads")
    .select("id, organization_id, opened_by, assunto, status, assigned_to, escalated_at, escalated_summary, closed_at, nps, nps_comment, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (!thread) return fail("not_found", "Chamado não encontrado.", 404, { requestId });

  const { data: mensagens, error } = await admin
    .from("support_messages")
    .select(COLS_MSG)
    .eq("thread_id", id)
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", "Erro ao carregar o chamado.", 500, { requestId });

  // A auditoria registra a LEITURA cross-tenant: sem ela não há trilha de quem
  // viu a conta de quem — e é exatamente o que uma auditoria de LGPD procura.
  await audit({
    action: "support.thread_read",
    organizationId: thread.organization_id,
    actorUserId: ctx.user.id,
    resourceId: id,
    metadata: { bypassed_rls: true, acting_as_platform_admin: true },
    requestId,
  });

  return ok({ thread, mensagens: mensagens ?? [] }, { requestId });
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  // A guarda da sessão de suporte READ-ONLY: ela barra a ESCRITA no app, e as
  // policies RESTRICTIVE a barram no banco. Os dois lados — a doutrina do repo
  // e a catraca `suporte-cobertura-de-efeitos` cobram esta linha de todo handler
  // que muta.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const ctx = await requirePlatformAdmin();
  if (!podeAtenderSuporte(ctx)) {
    return fail("forbidden", "Seu perfil não atende suporte.", 403, { requestId });
  }
  const { id } = await params;

  const parsed = responderChamadoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Escreva uma resposta.", 422, { requestId });
  }

  const admin = createAdminClient();

  const { data: thread } = await admin
    .from("support_threads")
    .select("id, organization_id, status")
    .eq("id", id)
    .maybeSingle();

  if (!thread) return fail("not_found", "Chamado não encontrado.", 404, { requestId });
  if (thread.status === "fechado") {
    return fail("validation_failed", "Este chamado foi encerrado.", 409, { requestId });
  }

  // A org vem DA THREAD (fonte confiável) — nunca do body.
  const { data, error } = await admin
    .from("support_messages")
    .insert({
      organization_id: thread.organization_id,
      thread_id: id,
      author_kind: "humano",
      author_id: ctx.user.id,
      body: parsed.data.body,
    })
    .select("id, created_at")
    .maybeSingle();

  if (error || !data) {
    return fail("internal_error", "Erro ao enviar a resposta.", 500, { requestId });
  }

  await admin
    .from("support_threads")
    .update({ status: "com_humano", assigned_to: ctx.user.id })
    .eq("id", id);

  /**
   * O aviso na Central do CLIENTE — não da plataforma.
   *
   * É o padrão que o follow-up já usa (`lib/followup/engine.ts`): o item nasce
   * com o `organization_id` do TENANT, então o sino da conta o conta. Criar com
   * `organization_id` nulo cairia num buraco — a rota da Central exclui itens de
   * plataforma por desenho ("nunca entram aqui"), e a refutação mediu que
   * NENHUM consumidor lê aquele valor. O aviso existiria no banco e ninguém o
   * veria, com o cliente esperando.
   *
   * O `ref_kind` leva o id do CHAMADO: o sino vira o botão que abre ele.
   */
  await admin.from("agent_inbox_items").insert({
    organization_id: thread.organization_id,
    kind: "suporte_resposta",
    severity: "info",
    title: "O suporte respondeu no seu chamado",
    body: parsed.data.body.slice(0, 200),
    ref_kind: "support_thread",
    ref_id: id,
  });

  await audit({
    action: "support.thread_replied",
    organizationId: thread.organization_id,
    actorUserId: ctx.user.id,
    resourceId: id,
    metadata: { bypassed_rls: true, acting_as_platform_admin: true },
    requestId,
  });

  return ok({ id: data.id }, { requestId });
}
