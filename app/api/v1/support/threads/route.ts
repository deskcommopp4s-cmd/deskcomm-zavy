/**
 * GET  /api/v1/support/threads — os chamados DE QUEM ESTÁ LOGADO.
 * POST /api/v1/support/threads — abre um chamado (a thread + a 1ª mensagem).
 *
 * ─── Por que o cliente de SESSÃO, e não o admin ──────────────────────────────
 *
 * Esta é uma rota acionada por usuário final — a regra de `lib/supabase/admin.ts`
 * proíbe o admin client aqui. Usando o cliente de sessão, quem filtra é a RLS:
 * a policy de SELECT libera só `opened_by = auth.uid()` (mais o admin da org e a
 * plataforma), e a de INSERT EXIGE `organization_id in fn_user_org_ids()`.
 *
 * Esse segundo ponto é o que fecha o furo que a refutação achou: sem ele, o
 * usuário abriria a thread com o `organization_id` de OUTRO cliente, a IA leria
 * a org DA THREAD e devolveria a conta da vítima na thread do atacante.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { abrirChamadoSchema } from "@/lib/schemas/suporte";

export const dynamic = "force-dynamic";

const COLS_THREAD =
  "id, assunto, status, assigned_to, escalated_at, closed_at, nps, created_at, updated_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "support_threads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  // A RLS já limita ao `opened_by`; o `.eq` é a segunda barreira, e o
  // `.order` casa com o índice (opened_by, created_at desc).
  const { data, error } = await supabase
    .from("support_threads")
    .select(COLS_THREAD)
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return fail("internal_error", t("Não consegui listar seus chamados."), 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
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

  // ── O TETO DO "ABRIR CHAMADO" ──────────────────────────────────────────────
  //
  // Abrir chamado e raro: quem abre, abre um. O teto existe para o caso que nao
  // e uso — um script, um bug de front em laco, alguem clicando 40 vezes. Sem
  // ele, cada clique vira chamado na fila da plataforma E uma chamada de IA
  // (o gatilho acorda a IA em toda mensagem de cliente).
  //
  // 5 por 10 min por USUARIO, nao por IP: a chave e a pessoa autenticada, e
  // duas pessoas atras do mesmo NAT nao competem entre si.
  const rl = await checkRateLimit(`support_open:${authz.user.id}`, 5, 600);
  if (!rl.allowed) {
    return fail(
      "rate_limited",
      t("Você abriu muitos chamados seguidos. Tente de novo em alguns minutos."),
      429,
      { requestId, headers: { "Retry-After": "600" } },
    );
  }

  const parsed = abrirChamadoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escreva o que você precisa."), 422, { requestId });
  }

  const supabase = await createClient();

  const { data: thread, error: erroThread } = await supabase
    .from("support_threads")
    .insert({
      organization_id: authz.org.orgId,
      opened_by: authz.user.id,
      assunto: parsed.data.assunto ?? null,
      status: "aberto",
    })
    .select("id")
    .maybeSingle();

  // `23514` = violação de CHECK. A policy de INSERT exige a org do usuário, então
  // um `organization_id` forjado falha aqui — e a mensagem diz isso sem expor o
  // motivo interno.
  if (erroThread || !thread) {
    return fail("internal_error", t("Não consegui abrir o chamado."), 500, { requestId });
  }

  const { error: erroMsg } = await supabase.from("support_messages").insert({
    organization_id: authz.org.orgId,
    thread_id: thread.id,
    author_kind: "usuario",
    author_id: authz.user.id,
    body: parsed.data.body,
  });

  if (erroMsg) {
    // A thread sem a 1ª mensagem é um chamado mudo. Desfaz para não deixar
    // um chamado vazio na lista — o usuário tenta de novo.
    await supabase.from("support_threads").delete().eq("id", thread.id);
    return fail("internal_error", t("Não consegui abrir o chamado."), 500, { requestId });
  }

  return ok({ id: thread.id }, { requestId });
}
