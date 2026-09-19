/**
 * O PROMPT DA CHAMADA PRINCIPAL PASSA A TER CONTABILIDADE POR BLOCO.
 *
 * ## O defeito que estes testes guardam
 *
 * Medido em produção: `agent_turn` gravou **107.128** tokens de entrada em
 * `llm_calls`, mas a soma dos blocos conhecidos (playbook + skills + memória +
 * ferramentas + histórico capado em `history_token_window`) fechava em ~15.500.
 * Os ~90 mil restantes não tinham explicação em lugar nenhum.
 *
 * A hipótese verificável no código: `GenerateTextResult.usage` do AI SDK é
 * **agregado entre os passos** do laço de tool-calls (cada passo reenvia o
 * prompt inteiro, com os resultados de ferramenta engordando a fita). O número
 * guardado não é o tamanho de UM request — é a soma dos reenvios.
 *
 * ## O que este arquivo mede
 *
 * 1. As funções PURAS classificam o que infla o prompt (texto × resultado ×
 *    chamada de ferramenta) e contam os passos.
 * 2. O SEAM (`runModelCall`) EMITE as duas linhas com os campos esperados —
 *    mesmo com o logger falso dos testes vizinhos.
 */
import { describe, expect, it, vi } from "vitest";

import {
  medirComposicaoDoPrompt,
  medirMensagens,
  medirPassos,
} from "@/lib/agent-engine/edge/llm/composicao-do-prompt";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";

const ORG = "33333333-3333-4333-8333-333333333333";

/** Pool mínimo que satisfaz o seam: config da org + binding + linha de llm_calls. */
function poolFalso() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("left join ai_budgets")) {
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao", params: {}, enabled_models: [] },
            // `off` desliga o gate de orçamento — a medição não é o assunto aqui.
            teto: 0,
            modo: "off",
            efetivo_em: null,
            limiar_pct: 80,
          },
        ],
      };
    }
    if (sql.includes("ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { pool: { query } as never, query };
}

function loggerFalso() {
  const linhas: Array<{ nivel: string; msg: string; campos: Record<string, unknown> }> = [];
  const push = (nivel: string) => (msg: string, campos: Record<string, unknown> = {}) =>
    void linhas.push({ nivel, msg, campos });
  return { linhas, log: { info: push("info"), warn: push("warn"), error: push("error") } };
}

describe("classificação das mensagens (puro)", () => {
  it("separa TEXTO de RESULTADO de ferramenta e de CHAMADA de ferramenta", () => {
    const c = medirMensagens([
      { role: "user", content: "oi" } as never,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "get_lead_context",
            input: { lead: "x" },
          },
        ],
      } as never,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "get_lead_context",
            output: { type: "text", value: "R".repeat(100) },
          },
        ],
      } as never,
    ]);
    expect(c.quantidade).toBe(3);
    expect(c.texto_chars).toBe(2);
    expect(c.chamada_de_ferramenta_chars).toBeGreaterThan(0);
    // O resultado de ferramenta é o que infla: 100 chars de payload têm de aparecer.
    expect(c.resultado_de_ferramenta_chars).toBeGreaterThanOrEqual(100);
    expect(c.chars).toBe(
      c.texto_chars +
        c.resultado_de_ferramenta_chars +
        c.chamada_de_ferramenta_chars +
        c.outras_chars,
    );
  });

  it("conteúdo string conta como texto (sem envelope)", () => {
    const c = medirMensagens([{ role: "user", content: "abcde" } as never]);
    expect(c.texto_chars).toBe(5);
  });
});

describe("composição do request inicial (puro)", () => {
  it("soma system + ferramentas + mensagens e mede as partes nomeadas do system", () => {
    const composicao = medirComposicaoDoPrompt({
      system: "PLAYBOOK",
      partesDoSystem: { playbook: "PLAYBOOK", memoria_da_org: "" },
      ferramentas: { quantidade: 2, serializado: "TOOLS" },
      mensagens: [{ role: "user", content: "oi" } as never],
    });
    expect(composicao.system.chars).toBe(8);
    expect(composicao.system.partes.playbook?.chars).toBe(8);
    expect(composicao.system.partes.memoria_da_org?.chars).toBe(0);
    expect(composicao.ferramentas.quantidade).toBe(2);
    expect(composicao.ferramentas.chars).toBe(5);
    expect(composicao.total.chars).toBe(8 + 5 + 2);
    expect(composicao.total.tokens_est).toBeGreaterThan(0);
  });
});

describe("passos do laço (puro) — é aqui que o número agregado aparece", () => {
  it("devolve os tokens de entrada POR PASSO e a SOMA", () => {
    const resumo = medirPassos([
      { usage: { inputTokens: 15_000 }, toolResults: [] },
      { usage: { inputTokens: 23_000 }, toolResults: [{ output: "x".repeat(50) }] },
      { usage: { inputTokens: 69_128 }, toolResults: [{ output: "y".repeat(20) }] },
    ]);
    expect(resumo.passos).toBe(3);
    expect(resumo.input_tokens_por_passo).toEqual([15_000, 23_000, 69_128]);
    expect(resumo.input_tokens_soma).toBe(107_128);
    expect(resumo.resultados_de_ferramenta_chars_por_passo[0]).toBe(0);
    expect(resumo.resultados_de_ferramenta_chars_por_passo[1]).toBeGreaterThan(0);
  });
});

describe("o seam emite as duas linhas com os campos esperados", () => {
  async function chamar(promptComposition?: boolean) {
    const p = poolFalso();
    const l = loggerFalso();
    await runModelCall(
      p.pool,
      {
        anthropicApiKey: "sk-ant-x",
        cacheTtl: "1h",
        ...(promptComposition !== undefined ? { promptComposition } : {}),
      },
      {
        tenantId: ORG,
        purpose: "agent_turn",
        system: "PLAYBOOK",
        systemParts: { playbook: "PLAYBOOK", memoria_da_org: "" },
        messages: [{ role: "user", content: "oi" } as never],
      } as never,
      { registry: createFakeRegistry() as never, log: l.log },
    );
    return l;
  }

  it("emite 'llm: composição do prompt (request inicial)' com contagens e tamanhos", async () => {
    const l = await chamar();
    const linha = l.linhas.find((x) => x.msg === "llm: composição do prompt (request inicial)");
    expect(linha, "a linha da composição não saiu").toBeDefined();
    expect(linha!.campos.system_chars).toBe("PLAYBOOK".length);
    expect(linha!.campos.system_tokens_est).toBeGreaterThan(0);
    expect((linha!.campos.system_partes as Record<string, { chars: number }>).playbook?.chars).toBe(
      "PLAYBOOK".length,
    );
    expect(linha!.campos.mensagens_quantidade).toBe(1);
    expect(linha!.campos.mensagens_texto_chars).toBe(2);
    expect(linha!.campos.ferramentas_quantidade).toBe(0);
    expect(linha!.campos.total_chars).toBeGreaterThan(0);
    expect(linha!.campos.purpose).toBe("agent_turn");
  });

  it("emite 'llm: tokens de entrada por passo' com a soma (o número do llm_calls)", async () => {
    const l = await chamar();
    const linha = l.linhas.find((x) => x.msg === "llm: tokens de entrada por passo");
    expect(linha, "a linha por passo não saiu").toBeDefined();
    expect(linha!.campos.passos).toBeGreaterThanOrEqual(1);
    expect(linha!.campos.input_tokens_soma).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(linha!.campos.input_tokens_por_passo)).toBe(true);
    expect(linha!.campos.input_tokens_inicial_est).toBeGreaterThan(0);
  });

  it("NUNCA loga conteúdo de conversa — só números e nomes", async () => {
    const l = await chamar();
    const tudo = JSON.stringify(l.linhas.map((x) => x.campos));
    // O texto que foi para o prompt não pode aparecer em lugar nenhum do log.
    expect(tudo).toContain("system_chars");
    expect(tudo).not.toContain('"oi"');
  });

  it("desligável: promptComposition=false não emite a linha", async () => {
    const l = await chamar(false);
    expect(l.linhas.some((x) => x.msg.startsWith("llm: composição do prompt"))).toBe(false);
    expect(l.linhas.some((x) => x.msg === "llm: tokens de entrada por passo")).toBe(false);
  });
});
