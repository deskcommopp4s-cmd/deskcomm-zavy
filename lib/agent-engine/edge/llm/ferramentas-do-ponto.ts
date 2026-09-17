/**
 * QUEM LEVA FERRAMENTAS NO REQUEST — a política, num lugar só.
 *
 * ## O problema que ela resolve
 *
 * O seam (`runModelCall`) é a única porta de saída para o provedor, e aceita
 * `tools` de qualquer chamador. Enquanto a decisão de mandar ferramentas morava
 * em cada call site, o número de pontos que as carregavam podia crescer sem que
 * ninguém visse: a definição de uma tool é um bloco fixo de schema que vai no
 * request TODA vez, e num ponto que responde uma palavra (classificador,
 * guardrail, checkpoint) ela é peso morto — token pago e latência por algo que
 * o modelo nunca vai chamar.
 *
 * ## Por que a fonte é o REGISTRO, e não uma lista nova aqui
 *
 * `lib/ai/pontos/registro.ts` já responde, para cada ponto do sistema, "que
 * capacidade o modelo precisa ter" — inclusive `exige.tools`. Uma segunda lista
 * neste arquivo divergiria da primeira no dia seguinte (é a mesma classe de
 * defeito que o registro foi criado para matar). E o registro é cobrado nos
 * dois sentidos por `tests/unit/pontos-de-ia-completude.test.ts`: ponto que o
 * código chama e não está lá, e ponto que está lá e ninguém chama.
 *
 * ## A regra, em uma frase
 *
 * **A chamada só leva `tools` se o PONTO declarar `exige.tools === true`.**
 *
 * O default é NÃO levar: ponto ausente do registro também perde as ferramentas.
 * Isso é de propósito — fail-closed. Um ponto oculto (que passasse `tools` sem
 * estar no registro) não vira um request caro silencioso; o teste de completude
 * reprova o insert antes, e o warn do seam aparece se ele escapar.
 *
 * ## "Tratar caso a caso" é o registro
 *
 * Para um ponto auxiliar ganhar uma ferramenta específica, ele declara
 * `exige.tools: true` no registro — e aí o painel de provedores passa a exigir
 * do modelo escolhido que saiba chamar ferramentas, que é a consequência certa:
 * escolher um modelo sem tool calling para um ponto que precisa de tool é o
 * defeito que aquela tela existe para impedir.
 */
import type { ToolSet } from 'ai';

import { PONTO_POR_ID } from '@/lib/ai/pontos/registro';

export interface FerramentasDecididas {
  /** O que de fato vai ao provedor (undefined quando o ponto não leva tools). */
  tools: ToolSet | undefined;
  /**
   * true quando o chamador passou ferramentas que o ponto NÃO declara — o caso
   * que o seam descarta e reporta. Dar visibilidade a ele é o que impede o
   * "descartado em silêncio" de esconder um call site que precisava de tools e
   * foi escrito contra um ponto errado.
   */
  descartadas: boolean;
}

/** O ponto declara que o modelo precisa chamar ferramentas? Ponto oculto ⇒ false. */
export function pontoUsaFerramentas(purpose: string): boolean {
  return PONTO_POR_ID.get(purpose)?.exige.tools === true;
}

/**
 * Aplica a política. Pura por construção: sem banco, sem log, sem relógio — a
 * decisão é testável sozinha, e o seam só executa o veredito.
 */
export function ferramentasDoPonto(
  purpose: string,
  tools: ToolSet | undefined,
): FerramentasDecididas {
  if (tools === undefined) return { tools: undefined, descartadas: false };
  if (pontoUsaFerramentas(purpose)) return { tools, descartadas: false };
  return { tools: undefined, descartadas: true };
}
