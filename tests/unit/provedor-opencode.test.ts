/**
 * O OPENCODE GO COMO PROVEDOR DE PRIMEIRA CLASSE.
 *
 * O gateway dele é OpenAI-compatível, mas tem uma exigência própria: **toda
 * geração precisa do cabeçalho `x-opencode-session`**. Medido em 28/09/2026:
 * `POST /chat/completions` sem ele devolve
 * `400 {"type":"error","error":{"type":"MissingSessionID"}}`; com ele, 200. A
 * listagem (`GET /models`) NÃO exige — responde 200 só com a chave.
 *
 * A primeira tentativa de resolver isso foi um campo de "cabeçalhos extras" na
 * tela, por ponto. Estava errado por dois motivos, e os dois estão travados
 * aqui:
 *
 *   1. **O operador não tem esse dado.** A doc do provedor diz que o cabeçalho é
 *      um id de sessão ESTÁVEL por conversa, "so we can optimize routing and
 *      prompt caching" — é roteamento interno do gateway, não configuração do
 *      cliente. Pedir que ele digite isso é transferir ao usuário um dado que o
 *      sistema tem (ou deriva).
 *   2. **O provedor não é um endereço só.** A doc oficial serve cada modelo por
 *      um protocolo diferente: os Grok e os GPT Luna em `/v1/responses`, o
 *      MiniMax M2.7 em `/v1/messages` (protocolo Anthropic). Um campo de
 *      endereço único não descreve esse provedor.
 *
 * O que este arquivo tranca:
 *
 *   1. o cabeçalho SAI do processo, e é ESTÁVEL (mesma chave → mesmo valor);
 *   2. a prova de crédito também o manda — sem isso o botão "Testar" diria "não
 *      respondeu" sobre uma chave perfeita;
 *   3. o catálogo de modelos NÃO oferece os que recusam o endpoint compatível
 *      (medido: 7 dos 30 devolvem 400);
 *   4. o provedor aparece na tela e o registry o registra (o par é vigiado por
 *      `provedores-x-registry.test.ts`).
 *
 * Roda com: npx vitest run tests/unit/provedor-opencode.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel } from "ai";

import {
  cabecalhosDoOpenCode,
  createDefaultRegistry,
  OPENCODE_ENDPOINT,
} from "@/lib/agent-engine/edge/llm/providers";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import {
  MODELOS_OPENCODE_FORA_DO_ENDPOINT_COMPATIVEL,
  validateOpenCodeKey,
} from "@/lib/ai/provider-validators";
import { montarRequisicaoDeProva } from "@/lib/instalacao/prova-de-credito";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHAVE = "oc_sk_de_teste_1234567890";

/** Intercepta o `fetch` e guarda URL e cabeçalhos de destino. */
function interceptar(): { chamadas: { url: string; headers: Record<string, string> }[] } {
  const chamadas: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { headers?: unknown }) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      const origem =
        typeof Request !== "undefined" && input instanceof Request
          ? input.headers
          : (init?.headers as HeadersInit | undefined);
      chamadas.push({ url, headers: Object.fromEntries(new Headers(origem).entries()) });
      throw new Error("PARADA_DE_TESTE");
    }),
  );
  return { chamadas };
}

async function disparar(model: LanguageModel): Promise<void> {
  await generateText({ model, prompt: "oi", maxRetries: 0 }).catch(() => {});
}

describe("o x-opencode-session sai do processo", () => {
  it("a geração leva o cabeçalho — sem ele o gateway recusa com 400", async () => {
    const { chamadas } = interceptar();
    const modelo = createDefaultRegistry()["opencode"]!(CHAVE, "glm-5.3-flash");
    await disparar(modelo);
    expect(chamadas[0]?.headers["x-opencode-session"]).toBeTruthy();
  });

  it("vai para o endpoint do gateway, não para a OpenAI", async () => {
    const { chamadas } = interceptar();
    const modelo = createDefaultRegistry()["opencode"]!(CHAVE, "glm-5.3-flash");
    await disparar(modelo);
    expect(chamadas[0]?.url).toContain("opencode.ai");
    expect(chamadas[0]?.url).not.toContain("api.openai.com");
  });

  it("CONTROLE POSITIVO: a chave continua autenticando", async () => {
    // Sem esta asserção, "achei o cabeçalho" seria indistinguível de um
    // capturador que lê qualquer coisa.
    const { chamadas } = interceptar();
    const modelo = createDefaultRegistry()["opencode"]!(CHAVE, "glm-5.3-flash");
    await disparar(modelo);
    expect(chamadas[0]?.headers.authorization).toContain(CHAVE);
  });

  it("o id de sessão é ESTÁVEL: a mesma chave dá o mesmo valor", () => {
    // É o que a doc do provedor pede ("a stable session ID"). Um valor novo a
    // cada chamada jogaria cada turno numa rota diferente e o cache de prefixo
    // nunca acertaria — o oposto do que o cabeçalho existe para fazer.
    expect(cabecalhosDoOpenCode(CHAVE)).toEqual(cabecalhosDoOpenCode(CHAVE));
  });

  it("chaves diferentes dão sessões diferentes", () => {
    expect(cabecalhosDoOpenCode(CHAVE)["x-opencode-session"]).not.toBe(
      cabecalhosDoOpenCode("oc_sk_outra_chave")["x-opencode-session"],
    );
  });

  it("o cabeçalho NÃO carrega a chave em claro", () => {
    // Ele viaja para o log de um terceiro; não é lugar para fragmento de chave.
    const valor = cabecalhosDoOpenCode(CHAVE)["x-opencode-session"]!;
    expect(valor).not.toContain(CHAVE);
    expect(valor).not.toContain("oc_sk_");
  });
});

describe("o botão Testar prova o que o ponto usa", () => {
  it("a prova de crédito manda o mesmo cabeçalho da geração", () => {
    const req = montarRequisicaoDeProva("opencode", CHAVE, "glm-5.3-flash");
    expect(req?.headers["x-opencode-session"]).toBe(
      cabecalhosDoOpenCode(CHAVE)["x-opencode-session"],
    );
    expect(req?.url).toBe(`${OPENCODE_ENDPOINT}/chat/completions`);
  });

  it("CONTROLE: a prova continua autenticando com a chave", () => {
    const req = montarRequisicaoDeProva("opencode", CHAVE, "glm-5.3-flash");
    expect(req?.headers.authorization).toBe(`Bearer ${CHAVE}`);
  });
});

describe("o catálogo não oferece modelo que o endpoint compatível recusa", () => {
  it("a lista de exclusão é a MEDIDA, não a suposta", () => {
    // Medido em 28/09/2026, um POST /chat/completions por modelo: dos 30 que o
    // GET /models lista, 23 respondem 200 e estes 7 respondem 400. Bate com a
    // tabela de endpoints da doc (Grok e GPT Luna em /v1/responses, MiniMax
    // M2.7 em /v1/messages).
    expect([...MODELOS_OPENCODE_FORA_DO_ENDPOINT_COMPATIVEL].sort()).toEqual([
      "gpt-5.6-luna",
      "gpt-6-luna",
      "grok-4.6",
      "grok-4.7",
      "minimax-m2.7",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
    ]);
  });

  it("a validação da chave FILTRA os que não atendem no endpoint compatível", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "glm-5.3-flash" },
            { id: "grok-4.7" },
            { id: "kimi-k3" },
            { id: "minimax-m2.7" },
          ],
        }),
      })),
    );
    const r = await validateOpenCodeKey(CHAVE);
    expect(r.ok).toBe(true);
    // O que funciona fica; o que recusaria a chamada sai — senão o seletor da
    // tela ofereceria um modelo que estoura, e o operador procuraria o defeito
    // na chave dele.
    expect(r.ok && r.models).toEqual(["glm-5.3-flash", "kimi-k3"]);
  });
});

describe("o provedor está na tela e no registry", () => {
  it("aparece no catálogo com o rótulo e o prefixo da chave", () => {
    const p = PROVEDORES.find((x) => x.id === "opencode");
    expect(p?.rotulo).toBe("OpenCode Go");
    expect(p?.prefixoDaChave).toBe("oc_sk_…");
    expect(p?.catalogoSincronizavel).toBe(true);
  });

  it("NÃO oferece endereço próprio — o endereço é o do gateway dele", () => {
    // O provedor serve cada modelo por um protocolo diferente; um campo de
    // endereço único não o descreve, e oferecê-lo prometeria o que não existe.
    expect(PROVEDORES.find((x) => x.id === "opencode")?.aceitaEndpointProprio).toBe(false);
  });

  it("o registry o registra", () => {
    expect(Object.keys(createDefaultRegistry())).toContain("opencode");
  });
});
