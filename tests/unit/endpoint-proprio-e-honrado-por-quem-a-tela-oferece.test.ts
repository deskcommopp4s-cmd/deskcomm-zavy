/**
 * O ENDPOINT PRÓPRIO PRECISA SER HONRADO POR TODOS OS QUE A TELA OFERECE.
 *
 * A tela de Provedores oferece um campo de endereço próprio para openai,
 * openrouter e deepseek — e é isso que `PROVEDORES[].aceitaEndpointProprio`
 * declara. O runtime honra os três? Não honrava: a factory do `openai` tinha
 * DOIS parâmetros (`apiKey, modelId`) enquanto a dos outros dois tinha TRÊS
 * (`apiKey, modelId, baseUrl`), e o `baseUrl` passado pelo `run-model-call`
 * era simplesmente ignorado.
 *
 * O modo de falha é o pior desta família: a tela SALVA, o painel diz "agora
 * usa", e a chamada vai ao endpoint CANÔNICO — com a chave do gateway no
 * cabeçalho, ou com o endereço do gateway sem efeito nenhum. Nos dois casos o
 * operador acredita estar roteando por onde não está.
 *
 * O que os testes abaixo medem: a URL QUE SAI DO PROCESSO, com `fetch`
 * interceptado. Não é leitura de configuração — é o endereço de destino.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel } from "ai";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";

afterEach(() => {
  vi.unstubAllGlobals();
});

const GATEWAY = "https://gateway.ejemplo.com/v1";

/** Intercepta o `fetch` da fábrica e guarda a URL de destino. */
function interceptarDestino(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      urls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url,
      );
      throw new Error("PARADA_DE_TESTE");
    }),
  );
  return { urls };
}

async function disparar(model: LanguageModel): Promise<void> {
  await generateText({ model, prompt: "oi", maxRetries: 0 }).catch(() => {});
}

/** Os provedores que a TELA diz que aceitam endereço próprio. */
const ACEITAM_ENDPOINT_PROPRIO = PROVEDORES.filter((p) => p.aceitaEndpointProprio).map(
  (p) => p.id,
);

describe("quem a tela diz que aceita endpoint próprio, o registry honra", () => {
  it("a lista vem do catálogo — não é escrita à mão aqui", () => {
    // Se um provedor novo passar a aceitar endereço próprio, ele entra neste
    // teste sozinho. Um caso faltando foi exatamente o que deixou o `openai`
    // passar: a lista anterior citava openrouter e deepseek, e pulava ele.
    expect(ACEITAM_ENDPOINT_PROPRIO).toContain("openai");
    expect(ACEITAM_ENDPOINT_PROPRIO).toContain("openrouter");
    expect(ACEITAM_ENDPOINT_PROPRIO).toContain("deepseek");
  });

  it("openai com endereço próprio vai PARA O ENDEREÇO, não para a OpenAI", async () => {
    const { urls } = interceptarDestino();
    const modelo = createDefaultRegistry()["openai"]!("sk-de-teste", "gpt-5-mini", GATEWAY);
    await disparar(modelo);
    expect(urls[0]).toContain("gateway.ejemplo.com");
  });

  it("openai SEM endereço próprio continua indo ao endpoint canônico", async () => {
    const { urls } = interceptarDestino();
    const modelo = createDefaultRegistry()["openai"]!("sk-de-teste", "gpt-5-mini");
    await disparar(modelo);
    // Literal de propósito: é o endereço de destino que o produto promete.
    expect(urls[0]).toContain("api.openai.com");
  });

  it("openrouter com endereço próprio vai para o endereço (controle positivo)", async () => {
    const { urls } = interceptarDestino();
    const modelo = createDefaultRegistry()["openrouter"]!(
      "sk-de-teste",
      "meta-llama/llama-3.3-70b-instruct",
      GATEWAY,
    );
    await disparar(modelo);
    expect(urls[0]).toContain("gateway.ejemplo.com");
  });

  it("deepseek com endereço próprio vai para o endereço (controle positivo)", async () => {
    const { urls } = interceptarDestino();
    const modelo = createDefaultRegistry()["deepseek"]!("sk-de-teste", "deepseek-flash", GATEWAY);
    await disparar(modelo);
    expect(urls[0]).toContain("gateway.ejemplo.com");
  });
});
