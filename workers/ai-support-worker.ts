/**
 * ai-support-worker — a IA de suporte responde o chamado.
 *
 * ── O LUGAR DELA NA FILA ────────────────────────────────────────────────────
 *
 * Ela é o PRIMEIRO filtro (decisão do dono): responde o que dá para responder com
 * o retrato da conta e ESCALA o resto para uma pessoa. Escalar não é falha — é o
 * caminho previsto, e é o que impede a IA de inventar.
 *
 * ── A REGRA QUE NÃO PODE CEDER: ELA NÃO MEXE EM NADA ────────────────────────
 *
 * A leitura da conta passa por `poolDeLeituraDoSuporte` — a conexão que o BANCO
 * recusa a escrita (medido, com controle positivo). A ESCRITA desta worker é
 * APENAS nas tabelas `support_*`, pela conexão de escrita (`service_role`).
 *
 * ── POR QUE A LEITURA NÃO USA O `admin` ─────────────────────────────────────
 *
 * `service_role.rolbypassrls = true` (medido): policies não a alcançam. Se a
 * leitura da conta passasse pelo `admin`, não haveria trava nenhuma — a worker
 * poderia alterar a conta do cliente e nenhum teste de RLS acusaria. A trava é
 * a conexão, e é por isso que ela existe.
 */
import { generateObject } from "ai";
import { z } from "zod";

import { DEFAULT_BOT_MODEL, isAiGatewayConfigured } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logInvocation } from "@/lib/ai/log-invocation";
import { marcaDaSaida } from "@/lib/branding/saida";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerContaDoSuporte } from "@/lib/support/ia/contexto-da-conta";
import { promptDoSistemaDaConta } from "@/lib/support/ia/prompt";
import { poolDeLeituraDoSuporte } from "@/lib/support/leitura-readonly";

const TIMEOUT_MS = 30_000;
/** Quantas mensagens do chamado entram no contexto. O suficiente para o fio. */
const JANELA_DE_HISTORICO = 12;

const respostaSchema = z.object({
  resposta: z.string().min(1).describe("A resposta ao cliente, em português, direta e sem jargão."),
  escalar: z
    .boolean()
    .describe(
      "true quando uma pessoa da plataforma precisa assumir: pedido de mudança, dado fora do retrato, reclamação, cobrança, ou dúvida sem certeza.",
    ),
  motivo_curto: z.string().max(300).optional().describe("Quando escalar=true, o motivo em uma linha."),
});

export interface SupportResult {
  skipped: boolean;
  reason?: string;
  escalou?: boolean;
}

export async function processSupportMessage(event: EventRow): Promise<SupportResult> {
  const threadId = (event.payload?.["thread_id"] as string | undefined) ?? event.entity_id ?? null;
  if (!threadId) return { skipped: true, reason: "missing_thread_id" };

  try {
    if (!isAiGatewayConfigured()) return { skipped: true, reason: "ai_gateway_key_missing" };

    const resolvido = await // O literal é o que `pontos-de-ia-completude` varre no código-fonte: uma
    // const com o mesmo valor não conta, e o teste reprova ("registro sem
    // emissor"). Ele existe para impedir ponto no registro que ninguém chama.
    resolverModeloDoPonto("suporte_atendimento", event.organization_id, DEFAULT_BOT_MODEL);
    if (!resolvido) return { skipped: true, reason: "ai_gateway_key_missing" };

    const admin = createAdminClient();

    // ── O chamado (filtro de org programático, nunca do payload) ────────────
    const { data: thread } = await admin
      .from("support_threads")
      .select("id, organization_id, status, assunto")
      .eq("id", threadId)
      .eq("organization_id", event.organization_id)
      .maybeSingle();
    if (!thread) return { skipped: true, reason: "thread_not_found" };

    // Chamado já fechado/resolvido não recebe resposta — quem reabre é o cliente
    // com um chamado novo (decisão do dono: 1 thread = 1 chamado).
    if (thread.status === "fechado" || thread.status === "resolvido") {
      return { skipped: true, reason: "thread_closed" };
    }

    // ── O histórico do chamado ──────────────────────────────────────────────
    const { data: mensagens } = await admin
      .from("support_messages")
      .select("author_kind, body, created_at")
      .eq("thread_id", threadId)
      .eq("organization_id", event.organization_id)
      .order("created_at", { ascending: true })
      .limit(JANELA_DE_HISTORICO);

    const historico = (mensagens ?? [])
      .filter((m) => typeof m.body === "string" && m.body.trim())
      .map((m) => `${m.author_kind === "usuario" ? "Cliente" : "Suporte"}: ${m.body}`)
      .join("\n");

    // ── O retrato da conta — pela conexão READ-ONLY ─────────────────────────
    const dsn = process.env.SUPABASE_DB_URL ?? "";
    if (!dsn) return { skipped: true, reason: "missing_db_url" };
    const conta = await lerContaDoSuporte(poolDeLeituraDoSuporte(dsn), event.organization_id);

    // ── A chamada ───────────────────────────────────────────────────────────
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    const start = Date.now();
    let gerado: z.infer<typeof respostaSchema>;
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const out = await generateObject({
        model: resolvido.model,
        schema: respostaSchema,
        system: promptDoSistemaDaConta(conta, (await marcaDaSaida(event.organization_id)).nome),
        prompt: historico || "(o cliente ainda não escreveu nada)",
        temperature: 0.2,
        maxOutputTokens: 800,
        abortSignal: abort.signal,
      });
      gerado = out.object;
      const usage = out.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      tokensIn = usage?.inputTokens ?? 0;
      tokensOut = usage?.outputTokens ?? 0;
    } finally {
      clearTimeout(timer);
    }

    // ── A resposta na conversa do chamado ───────────────────────────────────
    const { error: erroInsert } = await admin.from("support_messages").insert({
      organization_id: event.organization_id,
      thread_id: threadId,
      author_kind: "ia",
      author_id: null, // o CHECK exige null para `ia`
      body: gerado.resposta.slice(0, 8000),
    });
    if (erroInsert) {
      // Sem a resposta gravada, escalar é a única saída honesta: o cliente não
      // pode ficar sem retorno porque o INSERT falhou.
      await escalar(admin, threadId, event.organization_id, "falha ao gravar a resposta da IA");
      logInvocation({
        organization_id: event.organization_id,
        agent_id: null,
        conversation_id: null,
        message_id: null,
        // `bot_respond` é o valor do vocabulário que descreve "um bot
        // respondeu". O custo do suporte é da PLATAFORMA (D1), mas
        // `llm_calls.organization_id` é NOT NULL e carrega o tenant — a
        // atribuição por plataforma é pendência separada.
        invocation_kind: "bot_respond",
        model: resolvido.modelId,
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        latency_ms: Date.now() - start,
        cost_cents: 0,
        finish_reason: "error",
        error_payload: { message: erroInsert.message.slice(0, 300) },
      });
      return { skipped: false, escalou: true };
    }

    if (gerado.escalar) {
      await escalar(
        admin,
        threadId,
        event.organization_id,
        gerado.motivo_curto ?? "a IA pediu ajuda de uma pessoa",
      );
    } else {
      await admin
        .from("support_threads")
        .update({ status: "com_ia" })
        .eq("id", threadId)
        .eq("organization_id", event.organization_id);
    }

    logInvocation({
      organization_id: event.organization_id,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      invocation_kind: "bot_respond",
      model: resolvido.modelId,
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      latency_ms: Date.now() - start,
      cost_cents: 0,
      finish_reason: "stop",
    });
    return { skipped: false, escalou: gerado.escalar };
  } catch (err) {
    // O chamado NUNCA fica sem dono: qualquer exceção escala para uma pessoa.
    // Engolir aqui deixaria o cliente esperando uma resposta que não vem.
    const motivo = err instanceof Error ? err.message.slice(0, 300) : "erro desconhecido";
    try {
      const admin = createAdminClient();
      await escalar(admin, threadId, event.organization_id, `a IA falhou: ${motivo}`);
    } catch {
      // Se nem escalar der, o `throw` deixa o event_log marcar como morto e a
      // Central da plataforma acusa. Silêncio seria o pior desfecho.
      throw err;
    }
    return { skipped: false, escalou: true };
  }
}

/** Escala para uma pessoa: o chamado ganha dono, motivo e o aviso na Central. */
async function escalar(
  admin: ReturnType<typeof createAdminClient>,
  threadId: string,
  organizationId: string,
  motivo: string,
): Promise<void> {
  await admin
    .from("support_threads")
    .update({
      status: "com_humano",
      escalated_at: new Date().toISOString(),
      escalated_reason: motivo.slice(0, 500),
      escalated_summary: motivo.slice(0, 500),
    })
    .eq("id", threadId)
    .eq("organization_id", organizationId);

  // O aviso nasce na Central do CLIENTE — o padrão do follow-up. `ref_kind`
  // leva o id do CHAMADO: o sino vira o botão que abre ele.
  await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: "suporte_resposta",
    severity: "warn",
    title: "Seu chamado foi para uma pessoa do suporte",
    body: motivo.slice(0, 200),
    ref_kind: "support_thread",
    ref_id: threadId,
  });
}
