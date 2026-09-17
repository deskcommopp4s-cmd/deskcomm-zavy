/**
 * AS CHAMADAS AUXILIARES NÃO LEVAM FERRAMENTAS — provado no ponto onde o
 * request é montado.
 *
 * ## O que este arquivo prende
 *
 * O turno de um lead dispara mais de uma chamada de modelo: a principal
 * (`agent_turn`/`agent_preview`, que decide e AGE) e as auxiliares —
 * classificador de etapa, detecção de jailbreak, promessa semântica e o
 * checkpoint de fechamento. As auxiliares respondem uma palavra ou um JSON
 * curto e nunca chamam ferramenta. Carregar as definições de tool nelas é token
 * fixo pago a cada chamada e latência sem contrapartida.
 *
 * A decisão mora no SEAM (`runModelCall` → `ferramentasDoPonto`), e é lá que a
 * asserção morde: dar tools a uma auxiliar e ver o modelo recebê-las reprova
 * aqui, mesmo que o call site erre amanhã. A prova do lado principal (que NÃO
 * perde ferramenta nenhuma) está no mesmo lugar — se o filtro cortasse demais, o
 * `agent_preview` pararia de mandar tools e este arquivo também reprovaria.
 *
 * ## Sem banco e sem rede
 *
 * `pg.Pool` fingido (mesmo padrão de `seam-respeita-o-binding.test.ts`) e
 * registry espião que grava o que a fábrica de modelo recebeu. É o argumento que
 * chega ao provider — a única testemunha que não mente.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { classifyStage } from '@/lib/agent-engine/agent/stage-classifier';
import { runModelCall, tool } from '@/lib/agent-engine/edge/llm/run-model-call';
import { classifyJailbreak } from '@/lib/agent-engine/guardrails/jailbreak/classifier';
import { classifyPromise } from '@/lib/agent-engine/guardrails/promise/semantic';

const ORG = '11111111-1111-4111-8111-111111111111';
const cfg = { anthropicApiKey: 'fake', cacheTtl: '1h' as const };

/** ToolSet de exemplo — o conteúdo não importa, só a presença. */
const TOOLS = {
  crm_exemplo: tool({ description: 'tool de exemplo', inputSchema: z.object({}) }),
  crm_exemplo_dois: tool({ description: 'outra tool', inputSchema: z.object({}) }),
};

/**
 * `pg.Pool` fingido que responde às consultas do caminho (config da org,
 * binding do ponto, insert em llm_calls). Distinguir por trecho do SQL é
 * frágil de propósito: se o seam trocar a consulta, isto quebra alto em vez de
 * devolver `undefined` e medir o caminho errado.
 */
function poolFalso() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: 'anthropic',
              default_model: 'claude-padrao-da-org',
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes('from ai_purpose_bindings')) return { rows: [] };
    if (sql.includes('from ai_provider_credentials')) return { rows: [] };
    if (sql.includes('insert into llm_calls')) return { rows: [{ id: 'call-1' }] };
    return { rows: [] };
  });
  return { query } as never;
}

/** Registry que grava o que a fábrica recebeu — inclusive `options.tools`. */
function registryEspiao(capturado: Array<{ tools: unknown }>) {
  const fabrica = (provider: string) => (_apiKey: string, modelId: string) =>
    ({
      specificationVersion: 'v3',
      provider,
      modelId,
      doGenerate: async (options: { tools?: unknown }) => {
        capturado.push({ tools: options.tools ?? null });
        return {
          content: [{ type: 'text', text: 'new' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    }) as never;
  return {
    anthropic: fabrica('anthropic'),
    openai: fabrica('openai'),
    openrouter: fabrica('openrouter'),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function toolsQueChegaramAoModelo(
  purpose: string,
  tools: typeof TOOLS | undefined,
): Promise<unknown> {
  const capturado: Array<{ tools: unknown }> = [];
  await runModelCall(
    poolFalso(),
    cfg,
    {
      tenantId: ORG,
      purpose,
      messages: [{ role: 'user', content: 'oi' }],
      ...(tools !== undefined ? { tools } : {}),
    },
    { registry: registryEspiao(capturado) as never, log: log as never },
  );
  return capturado[0]?.tools ?? null;
}

function nomesDasFerramentas(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is { name: string } => typeof t === 'object' && t !== null && 'name' in t)
    .map((t) => t.name);
}

describe('o seam recusa ferramentas em ponto que não as declara', () => {
  // As quatro auxiliares nomeadas no turno, mais os outros classificadores que
  // compartilham o seam. Nenhuma delas age no funil nem no canal.
  it.each([
    'stage_classifier',
    'jailbreak_detect',
    'promise_semantic',
    'checkpoint',
    'compaction',
    'flush',
    'intent_router',
    'followup_classify',
    'followup_decide_timing',
  ])('%s vai SEM ferramentas, mesmo se alguém passar tools', async (purpose) => {
    const tools = await toolsQueChegaramAoModelo(purpose, TOOLS);
    expect(nomesDasFerramentas(tools), `${purpose} mandou definição de ferramenta`).toEqual([]);
  });

  it('agent_preview (a chamada que AGE) NÃO perde ferramenta nenhuma', async () => {
    const tools = await toolsQueChegaramAoModelo('agent_preview', TOOLS);
    expect(nomesDasFerramentas(tools).sort()).toEqual(['crm_exemplo', 'crm_exemplo_dois']);
  });

  it('agent_turn e operator_turn também mantêm as ferramentas', async () => {
    for (const purpose of ['agent_turn', 'operator_turn']) {
      const tools = await toolsQueChegaramAoModelo(purpose, TOOLS);
      expect(nomesDasFerramentas(tools).sort(), `${purpose} perdeu ferramentas`).toEqual([
        'crm_exemplo',
        'crm_exemplo_dois',
      ]);
    }
  });
});

describe('os call sites auxiliares chegam ao modelo sem ferramentas', () => {
  it('classificador de etapa', async () => {
    const capturado: Array<{ tools: unknown }> = [];
    await classifyStage(
      poolFalso(),
      cfg,
      { tenantId: ORG, leadId: null },
      { context: { messages: [] } as never, currentStage: 'new' },
      { registry: registryEspiao(capturado) as never, log: log as never },
    );
    expect(capturado[0]?.tools ?? null).toBeNull();
  });

  it('detecção de jailbreak', async () => {
    const capturado: Array<{ tools: unknown }> = [];
    await classifyJailbreak(
      poolFalso(),
      cfg,
      { tenantId: ORG, leadId: null },
      { message: 'oi' },
      { registry: registryEspiao(capturado) as never, log: log as never },
    );
    expect(capturado[0]?.tools ?? null).toBeNull();
  });

  it('promessa semântica', async () => {
    const capturado: Array<{ tools: unknown }> = [];
    await classifyPromise(
      poolFalso(),
      cfg,
      { tenantId: ORG, leadId: null },
      { candidate: 'oi' },
      { registry: registryEspiao(capturado) as never, log: log as never },
    );
    expect(capturado[0]?.tools ?? null).toBeNull();
  });
});
