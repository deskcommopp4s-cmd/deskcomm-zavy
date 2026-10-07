/**
 * O PROMPT DA IA DE SUPORTE — o primeiro filtro do chamado.
 *
 * ── O QUE ELA É ─────────────────────────────────────────────────────────────
 *
 * A primeira resposta do chamado. Ela responde o que dá para responder com o
 * retrato da conta, e ESCALA o resto para uma pessoa — escalar não é falha, é o
 * caminho previsto (decisão do dono: "a IA PODE escalar sozinha; é obrigatório").
 *
 * ── AS TRÊS REGRAS QUE NÃO PODEM CEDER ──────────────────────────────────────
 *
 * 1. NÃO MEXE EM NADA. Ela lê a conta e responde — nunca altera configuração,
 *    conversa, contato ou negócio. É decisão do dono (read-only absoluto). Se a
 *    pessoa pedir "desliga o bot", ela NÃO desliga: explica e escala.
 *    A trava é do BANCO (a conexão recusa escrita), mas o prompt não pode
 *    PROMETER o que não faz — uma IA que diz "pronto, ajustei" quando não
 *    ajustou é pior que uma que escala.
 *
 * 2. NÃO INVENTA SOBRE A CONTA. O retrato abaixo é o que ela sabe. Se a
 *    pergunta pede um dado que não está ali, ela diz que não consegue ver e
 *    escala — nunca estima um número.
 *
 * 3. ESCALA SEM MEDO. Chamado de suporte com resposta errada custa mais que
 *    chamado esperando uma pessoa. Na dúvida, escala.
 */
import type { ContaDoSuporte } from "./contexto-da-conta";
import { retratoEmTexto } from "./contexto-da-conta";

export function promptDoSistemaDaConta(conta: ContaDoSuporte): string {
  return [
    "Você é o suporte do Deskcomm CRM. Fala com o CLIENTE da plataforma (o dono da conta),",
    "em português do Brasil, direto e sem jargão técnico.",
    "",
    "Você NÃO altera nada na conta — nem configuração, nem conversa, nem contato, nem negócio.",
    "Você LÊ o retrato abaixo e responde. Se pedirem para você mudar algo, explique o caminho",
    "(onde clicar) e escale — nunca diga que você ajustou.",
    "",
    "Se a resposta não estiver no retrato, diga que não consegue ver e escale. Não estime.",
    "",
    "RETRATO DA CONTA:",
    retratoEmTexto(conta),
    "",
    "Responda a mensagem do cliente. Se precisar de uma pessoa da plataforma (pedido de",
    "mudança, dado que você não vê, reclamação, cobrança, algo que você não tem certeza),",
    "marque escalar=true e escreva um motivo curto para quem vai assumir.",
  ].join("\n");
}

/**
 * O que o modelo devolve — tipado, para o worker nunca gravar texto solto nem
 * decidir escalada por heurística de palavra-chave.
 */
export const ESQUEMA_DA_RESPOSTA = {
  type: "object",
  properties: {
    resposta: {
      type: "string",
      description: "A resposta ao cliente, em português, direta e sem jargão.",
    },
    escalar: {
      type: "boolean",
      description:
        "true quando uma pessoa da plataforma precisa assumir: pedido de mudança, dado que não está no retrato, reclamação, cobrança, ou dúvida que você não tem certeza.",
    },
    motivo_curto: {
      type: "string",
      description: "Quando escalar=true, o motivo em uma linha, para quem vai assumir.",
    },
  },
  required: ["resposta", "escalar"],
  additionalProperties: false,
} as const;
