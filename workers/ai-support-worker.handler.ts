/**
 * O handler da IA de suporte no event_log.
 *
 * Consome `support.message` — o evento que o gatilho da migration 0270 emite
 * quando o CLIENTE escreve no chamado. A resposta da própria IA NÃO re-dispara:
 * o gatilho só dispara em `author_kind = 'usuario'` (senão a IA conversaria
 * consigo mesma, para sempre).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { processSupportMessage } from "@/workers/ai-support-worker";

export const AI_SUPPORT_HANDLER_KEY = "ai-support-worker.v1";

export const aiSupportHandler: EventHandler = {
  key: AI_SUPPORT_HANDLER_KEY,
  events: ["support.message"],
  async handle(row): Promise<HandlerResult> {
    const result = await processSupportMessage(row);
    return {
      consumer_key: AI_SUPPORT_HANDLER_KEY,
      status: "ok",
      detail: result.skipped
        ? `skip:${result.reason ?? "?"}`
        : result.escalou
          ? "escalou"
          : "respondeu",
    };
  },
};
