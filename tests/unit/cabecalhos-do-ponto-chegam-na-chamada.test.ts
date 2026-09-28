/**
 * O CABEÇALHO DO PONTO PRECISA SAIR DO PROCESSO.
 *
 * Há provedor OpenAI-compatível que só responde com o cabeçalho de ROTEAMENTO
 * dele. O caso medido: o OpenCode Go devolve
 * `400 {"type":"MissingSessionID","message":"Request is missing x-opencode-session..."}`
 * sem `x-opencode-session`, e 200 com ele (com qualquer valor) — o User-Agent
 * próprio NÃO é exigido. Sem esta coluna, o painel conseguia configurar o
 * endereço do gateway e não a metade que o gateway exige.
 *
 * A coluna `headers` foi acrescentada em `ai_purpose_bindings` (migration 0268)
 * e o caminho é longo: banco → `carregarBinding` → `decidirBinding` →
 * `run-model-call` → fábrica do provedor → `fetch`. Um elo esquecido em
 * qualquer ponto dá o pior desfecho desta família: a tela SALVA, o painel diz
 * "agora usa", e a chamada sai sem o cabeçalho — o operador vai procurar o
 * defeito no gateway dele.
 *
 * O que os testes abaixo medem, com `fetch` interceptado:
 *
 *   1. o cabeçalho do ponto CHEGA no `fetch` (o elo mais fácil de esquecer);
 *   2. SEM cabeçalho configurado, nenhum é inventado — e o `Authorization` da
 *      chave continua indo, que é o CONTROLE POSITIVO do instrumento: sem ele,
 *      "não achei o cabeçalho" seria indistinguível de "não li cabeçalho
 *      nenhum";
 *   3. configurar cabeçalho NÃO derruba a autenticação da credencial;
 *   4. o botão "Testar" prova o que está na tela — o mesmo merge vale para
 *      `montarRequisicaoDeProva`, senão o botão reprovaria (ou aprovaria) uma
 *      configuração diferente da que o ponto usa;
 *   5. a regra que RECUSA `Authorization` (o único cabeçalho que carrega a
 *      chave) é a mesma nas duas rotas que o aceitam.
 *
 * Roda com: npx vitest run tests/unit/cabecalhos-do-ponto-chegam-na-chamada.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel } from "ai";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import {
  MAX_CABECALHOS_DO_PONTO,
  cabecalhosDoPontoSchema,
} from "@/lib/ai/cabecalhos-do-ponto";
import { montarRequisicaoDeProva } from "@/lib/instalacao/prova-de-credito";

afterEach(() => {
  vi.unstubAllGlobals();
});

const GATEWAY = "https://gateway.ejemplo.com/v1";
const SESSAO = { "x-opencode-session": "abc123def456" };

/** Intercepta o `fetch` da fábrica e guarda a URL E OS CABEÇALHOS de destino. */
function interceptarChamada(): {
  chamadas: { url: string; headers: Record<string, string> }[];
} {
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
      // O SDK pode entregar os cabeçalhos num `Request` já montado ou no
      // segundo argumento — ler só um dos dois faria o teste medir a si mesmo.
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

describe("o cabeçalho do ponto chega no fetch", () => {
  it("deepseek com cabeçalho do ponto ENVIA o cabeçalho", async () => {
    const { chamadas } = interceptarChamada();
    const modelo = createDefaultRegistry()["deepseek"]!(
      "sk-de-teste",
      "deepseek-chat",
      GATEWAY,
      SESSAO,
    );
    await disparar(modelo);
    expect(chamadas[0]?.headers["x-opencode-session"]).toBe("abc123def456");
  });

  it("openai com cabeçalho do ponto ENVIA o cabeçalho", async () => {
    const { chamadas } = interceptarChamada();
    const modelo = createDefaultRegistry()["openai"]!(
      "sk-de-teste",
      "gpt-5-mini",
      GATEWAY,
      SESSAO,
    );
    await disparar(modelo);
    expect(chamadas[0]?.headers["x-opencode-session"]).toBe("abc123def456");
  });

  it("CONTROLE POSITIVO: sem cabeçalho configurado, o Authorization da chave sai", async () => {
    // Prova que o instrumento LÊ cabeçalhos: se esta asserção passasse a falhar,
    // as de cima não valeriam nada (um capturador morto reporta "ausente" em
    // tudo). O `Authorization` vem da chave, não do ponto.
    const { chamadas } = interceptarChamada();
    const modelo = createDefaultRegistry()["deepseek"]!("sk-de-teste", "deepseek-chat", GATEWAY);
    await disparar(modelo);
    expect(chamadas[0]?.headers.authorization).toContain("sk-de-teste");
  });

  it("configurar cabeçalho NÃO derruba a autenticação da credencial", async () => {
    const { chamadas } = interceptarChamada();
    const modelo = createDefaultRegistry()["deepseek"]!(
      "sk-de-teste",
      "deepseek-chat",
      GATEWAY,
      SESSAO,
    );
    await disparar(modelo);
    // Os dois convivem: o cabeçalho do ponto ROTEIA, o Authorization AUTENTICA.
    expect(chamadas[0]?.headers["x-opencode-session"]).toBe("abc123def456");
    expect(chamadas[0]?.headers.authorization).toContain("sk-de-teste");
  });

  it("sem cabeçalho do ponto, nenhum é inventado", async () => {
    const { chamadas } = interceptarChamada();
    const modelo = createDefaultRegistry()["openai"]!(
      "sk-de-teste",
      "gpt-5-mini",
      GATEWAY,
      null,
    );
    await disparar(modelo);
    expect(chamadas[0]?.headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("o botão Testar prova o que está na tela", () => {
  it("montarRequisicaoDeProva leva os cabeçalhos do ponto", () => {
    const req = montarRequisicaoDeProva(
      "deepseek",
      "sk-de-teste",
      "deepseek-chat",
      GATEWAY,
      SESSAO,
    );
    expect(req?.headers["x-opencode-session"]).toBe("abc123def456");
    // O corpo da prova continua sendo a geração mínima, e o endereço próprio
    // continua valendo: é o MESMO par que o ponto usa em produção.
    expect(req?.url).toBe(`${GATEWAY}/chat/completions`);
  });

  it("CONTROLE: sem cabeçalho, a prova é a de sempre", () => {
    const req = montarRequisicaoDeProva("deepseek", "sk-de-teste", "deepseek-chat", GATEWAY);
    expect(req?.headers["x-opencode-session"]).toBeUndefined();
    expect(req?.headers.authorization).toBe("Bearer sk-de-teste");
  });

  it("provedor desconhecido continua fail-closed", () => {
    expect(montarRequisicaoDeProva("provedor-que-nao-existe", "sk", "m")).toBeNull();
  });
});

describe("a regra que recusa Authorization (a chave vive no cofre cifrado)", () => {
  it("recusa `authorization`, sem diferenciar maiúsculas", () => {
    expect(
      cabecalhosDoPontoSchema.safeParse({ authorization: "Bearer minha-chave" }).success,
    ).toBe(false);
    expect(
      cabecalhosDoPontoSchema.safeParse({ Authorization: "Bearer minha-chave" }).success,
    ).toBe(false);
    expect(
      cabecalhosDoPontoSchema.safeParse({ AUTHORIZATION: "Bearer minha-chave" }).success,
    ).toBe(false);
  });

  it("aceita o cabeçalho de roteamento — que é a razão da coluna existir", () => {
    expect(cabecalhosDoPontoSchema.safeParse(SESSAO).success).toBe(true);
  });

  it("aceita null e ausente (ponto sem cabeçalho é o caso comum)", () => {
    expect(cabecalhosDoPontoSchema.safeParse(null).success).toBe(true);
    expect(cabecalhosDoPontoSchema.safeParse(undefined).success).toBe(true);
  });

  it(`recusa acima de ${MAX_CABECALHOS_DO_PONTO} cabeçalhos`, () => {
    const demais: Record<string, string> = {};
    for (let i = 0; i <= MAX_CABECALHOS_DO_PONTO; i += 1) demais[`x-c${i}`] = "v";
    expect(cabecalhosDoPontoSchema.safeParse(demais).success).toBe(false);
  });
});
