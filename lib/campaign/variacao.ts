/**
 * A VARIAÇÃO POR IA DA CAMPANHA (A1, Fase 4) — ponto `campanha_variacao`.
 *
 * ── O QUE FAZ ───────────────────────────────────────────────────────────────
 *
 * Reescreve o texto do passo "mantendo a estrutura" (decisão do dono): não é
 * "reescreva como quiser" — é "diga o mesmo de outro jeito, na mesma forma".
 * Um texto com PLACEHOLDERS para nome/tags pode variar por destinatário sem
 * virar template idêntico em massa (o gate `spinning`/a cara de robô).
 *
 * ── QUEM PAGA (decisão B3) ──────────────────────────────────────────────────
 *
 * O dono: "as campanhas consomem os CRÉDITOS DE IA DO CLIENTE". Portanto a
 * invocação é logada como `bot_respond` (bot respondendo) e entra no
 * orçamento da organização — ao contrário do suporte, onde a plataforma paga.
 *
 * ── SÓ NO NÃO OFICIAL ───────────────────────────────────────────────────────
 *
 * A campanha com canal OFICIAL exige TEMPLATE (texto fixo) — variação seria
 * mentira. A tela desabilita; aqui o worker também não varia (o `campaign`
 * carrega `uses_official` e `ai_variation`; a regra `not uses_official or
 * ai_variation = false` já está no CHECK da 0273).
 */
import { generateObject } from "ai";
import { z } from "zod";

import { DEFAULT_BOT_MODEL, isAiGatewayConfigured } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logInvocation } from "@/lib/ai/log-invocation";

/** O literal é o que `pontos-de-ia-completude` varre no código-fonte. */
const PONTO = "campanha_variacao";

const schemaDaVariacao = z.object({
  // OBRIGATORIO, nunca .optional(): o provedor (DeepSeek) recusa o schema
  // quando `required` nao lista todas as propriedades (lição do suporte).
  variacao: z
    .string()
    .min(1)
    .describe("A mesma mensagem, dita de outro jeito, mantendo a estrutura e o tom."),
});

export interface VariacaoResultado {
  ok: boolean;
  texto?: string;
  motivo?: string;
}

/**
 * Varia o texto do passo para UM destinatário. Devolve `{ok:false}` (sem
 * lançar) quando não há gateway/chave — o worker decide o desfecho (mandar o
 * original ou reagendar depende da régua do chamador).
 */
export async function variarTextoDaCampanha(
  organizationId: string,
  textoBase: string,
  contexto: { nome?: string | null; tags?: string[] },
): Promise<VariacaoResultado> {
  if (!isAiGatewayConfigured()) return { ok: false, motivo: "ai_gateway_key_missing" };

  const resolvido = await resolverModeloDoPonto(PONTO, organizationId, DEFAULT_BOT_MODEL);
  if (!resolvido) return { ok: false, motivo: "ai_gateway_key_missing" };

  const inicio = Date.now();
  try {
    const gerada = await generateObject({
      model: resolvido.model,
      schema: schemaDaVariacao,
      system:
        "Você varia o texto de uma campanha de WhatsApp mantendo a MESMA estrutura e o mesmo tom. " +
        "Não muda o sentido nem inventa informação. Substitua o {nome} pelo nome da pessoa quando houver. " +
        "Responda só o texto variado.",
      prompt: `Nome: ${contexto.nome ?? "(sem nome)"}\nEtiquetas: ${(contexto.tags ?? []).join(", ") || "(nenhuma)"}\n\nTexto original:\n${textoBase}`,
      temperature: 0.7,
      maxOutputTokens: 800,
    });

    const usage = gerada.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    logInvocation({
      organization_id: organizationId,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      // `bot_respond`: bot respondendo — entra no orçamento da ORGANIZAÇÃO (B3:
      // a campanha consome os créditos de IA do cliente).
      invocation_kind: "bot_respond",
      model: resolvido.modelId,
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      latency_ms: Date.now() - inicio,
      cost_cents: 0,
      finish_reason: "stop",
    });

    const texto = gerada.object.variacao.trim();
    if (!texto) return { ok: false, motivo: "variacao_vazia" };
    return { ok: true, texto };
  } catch (err) {
    logInvocation({
      organization_id: organizationId,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      invocation_kind: "bot_respond",
      model: resolvido.modelId,
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: Date.now() - inicio,
      cost_cents: 0,
      finish_reason: "error",
      error_payload: { message: err instanceof Error ? err.message.slice(0, 200) : String(err) },
    });
    return { ok: false, motivo: "erro_do_provedor" };
  }
}