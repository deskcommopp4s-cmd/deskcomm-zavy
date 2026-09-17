/**
 * A POLÍTICA DE FERRAMENTAS DO SEAM — pura, sem banco e sem rede.
 *
 * A regra é uma só: a chamada leva `tools` quando o PONTO declara
 * `exige.tools === true` no registro canônico (`lib/ai/pontos/registro.ts`).
 * Este arquivo prende os dois lados da régua — quem leva e quem NÃO leva — para
 * que uma refatoração futura não devolva o peso morto das definições de tool a
 * uma chamada que só responde uma palavra.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ferramentasDoPonto, pontoUsaFerramentas } from './ferramentas-do-ponto';
import { tool } from 'ai';

/** ToolSet mínimo — o conteúdo não importa para a política, só a presença. */
const TOOLS = {
  crm_exemplo: tool({
    description: 'tool de exemplo',
    inputSchema: z.object({}),
  }),
};

describe('quem leva ferramentas', () => {
  it('os pontos que AGEM no funil levam', () => {
    for (const purpose of ['agent_turn', 'agent_preview', 'operator_turn']) {
      expect(pontoUsaFerramentas(purpose), `${purpose} deveria declarar tools`).toBe(true);
      expect(ferramentasDoPonto(purpose, TOOLS).tools, `${purpose} perdeu as ferramentas`).toBe(TOOLS);
    }
  });

  it('os auxiliares que só classificam/resumem NÃO levam', () => {
    // São os quatro call sites que o turno dispara além da chamada principal
    // (classificador de etapa, jailbreak, promessa semântica e checkpoint) mais
    // a compactação — todos respondem uma palavra ou um JSON curto, nenhum age.
    for (const purpose of [
      'stage_classifier',
      'jailbreak_detect',
      'promise_semantic',
      'checkpoint',
      'compaction',
      'flush',
      'intent_router',
      'followup_classify',
      'followup_decide_timing',
      'draft_suggestion',
      'automation_ai_message',
    ]) {
      expect(pontoUsaFerramentas(purpose), `${purpose} não deveria exigir tools`).toBe(false);
      const r = ferramentasDoPonto(purpose, TOOLS);
      expect(r.tools, `${purpose} não pode mandar ferramentas`).toBeUndefined();
      expect(r.descartadas, `${purpose} deveria reportar o descarte`).toBe(true);
    }
  });

  it('não passar ferramentas nunca vira "descarte"', () => {
    // `undefined` é ausência, não descarte — o warn do seam não pode disparar
    // para todo mundo que, corretamente, não manda tools.
    for (const purpose of ['stage_classifier', 'agent_turn', 'ponto_oculto']) {
      expect(ferramentasDoPonto(purpose, undefined)).toEqual({ tools: undefined, descartadas: false });
    }
  });

  it('ponto AUSENTE do registro perde as ferramentas (fail-closed)', () => {
    // Um ponto oculto que passasse tools não pode virar request caro em
    // silêncio: o default é não levar, e o warn do seam aparece. O insert no
    // registro é cobrado por pontos-de-ia-completude.test.ts.
    expect(pontoUsaFerramentas('ponto_que_ninguem_registrou')).toBe(false);
    expect(ferramentasDoPonto('ponto_que_ninguem_registrou', TOOLS).descartadas).toBe(true);
  });
});
