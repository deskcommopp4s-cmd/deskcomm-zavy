import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classificarComTypeSafe,
  lerChoice,
  lerNoul,
  lerScore,
  TYPESAFE_ENDPOINT,
  TypeSafeIndisponivelError,
  TypeSafeRespostaInvalidaError,
  validarChaveTypeSafe,
  type RespostaTypeSafe,
} from "@/lib/ai/decisao/typesafe";

/** Resposta 200 com as cinco dimensões tipadas (o formato medido no provedor). */
function respostaCompleta(): string {
  return JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      etapa: {
        type: "choice",
        choice: "qualified",
        probabilities: { qualified: 0.78, negotiating: 0.22 },
        confidence: 0.78,
      },
      decide_a_compra: { type: "noul", noul: 0.94 },
      urgencia: {
        type: "score",
        score: 3.0,
        legend: { "0": "Sem urgência", "4": "Esta semana ou imediatamente." },
        probabilities: { "3": 1 },
        confidence: 0.9,
      },
      tem_necessidade: { type: "noul", noul: 0.9 },
      pronto_pra_compra: { type: "noul", noul: 0.83 },
    },
    usage: { input_tokens: 542, output_tokens: 128 },
  });
}

function res(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

describe("interpretação tipada (pura)", () => {
  it("lê Noul, Choice e Score; devolve null no tipo errado", () => {
    const respostas: Record<string, RespostaTypeSafe> = {
      etapa: {
        type: "choice",
        choice: "qualified",
        probabilities: { qualified: 1 },
        confidence: 0.78,
      },
      pronto: { type: "noul", noul: 0.83 },
      urgencia: { type: "score", score: 3, legend: { "3": "esta semana" }, probabilities: { "3": 1 }, confidence: 0.9 },
    };

    expect(lerNoul(respostas.pronto)).toBe(0.83);
    expect(lerChoice(respostas.etapa)).toEqual({
      choice: "qualified",
      confidence: 0.78,
      probabilities: { qualified: 1 },
    });
    expect(lerScore(respostas.urgencia)?.score).toBe(3);

    // Tipo errado não vira 0 nem estoura: vira null (o chamador decide).
    expect(lerNoul(respostas.etapa)).toBeNull();
    expect(lerChoice(respostas.pronto)).toBeNull();
    expect(lerScore(undefined)).toBeNull();
  });
});

describe("classificarComTypeSafe", () => {
  it("manda state/model/questions no endpoint certo, com Bearer, e devolve respostas tipadas", async () => {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      chamadas.push({ url: String(url), init: init ?? {} });
      return res(200, respostaCompleta());
    }) as unknown as typeof fetch;

    const resultado = await classificarComTypeSafe({
      apiKey: "chave-secreta",
      state: { conversation: "..." },
      questions: { etapa: { type: "choice", instructions: "?", criteria: { qualified: null } } },
      fetchImpl,
      sleep: async () => {},
    });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(TYPESAFE_ENDPOINT);
    expect((chamadas[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer chave-secreta",
    );
    const corpo = JSON.parse(String(chamadas[0]!.init.body)) as {
      model: string;
      state: unknown;
      questions: Record<string, unknown>;
    };
    expect(corpo.model).toBe("jev-latest");
    expect(corpo.questions.etapa).toBeDefined();
    expect(lerChoice(resultado.answers.etapa)?.choice).toBe("qualified");
    expect(lerNoul(resultado.answers.pronto_pra_compra)).toBe(0.83);
    expect(resultado.usage).toEqual({ input_tokens: 542, output_tokens: 128 });
  });

  it("retenta 429/529 com backoff e vence na terceira", async () => {
    const esperas: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n < 3) return res(429, "{}");
      return res(200, respostaCompleta());
    }) as unknown as typeof fetch;

    const resultado = await classificarComTypeSafe({
      apiKey: "k",
      state: "x",
      questions: { etapa: { type: "choice", instructions: "?", criteria: {} } },
      fetchImpl,
      sleep: async (ms) => {
        esperas.push(ms);
      },
    });

    expect(n).toBe(3);
    expect(esperas).toEqual([500, 1000]);
    expect(resultado.model).toBe("jev-1.13.0");
  });

  it("esgota as tentativas em 529 e lança indisponível", async () => {
    const fetchImpl = (async () => res(529, "{}")) as unknown as typeof fetch;
    await expect(
      classificarComTypeSafe({
        apiKey: "k",
        state: "x",
        questions: { etapa: { type: "choice", instructions: "?", criteria: {} } },
        fetchImpl,
        sleep: async () => {},
        maxTentativas: 3,
      }),
    ).rejects.toBeInstanceOf(TypeSafeIndisponivelError);
  });

  it("401 não retenta e vira resposta inválida", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return res(401, "{}");
    }) as unknown as typeof fetch;
    await expect(
      classificarComTypeSafe({
        apiKey: "k",
        state: "x",
        questions: { etapa: { type: "choice", instructions: "?", criteria: {} } },
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(TypeSafeRespostaInvalidaError);
    expect(n).toBe(1);
  });

  it("falha de rede vira erro (e o chamador degrada)", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      classificarComTypeSafe({
        apiKey: "k",
        state: "x",
        questions: { etapa: { type: "choice", instructions: "?", criteria: {} } },
        fetchImpl,
        sleep: async () => {},
        maxTentativas: 2,
      }),
    ).rejects.toThrow("fetch failed");
  });
});

describe("validarChaveTypeSafe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("chave recusada → auth_failed_401", async () => {
    vi.stubGlobal("fetch", (async () => res(401, "{}")) as unknown as typeof fetch);
    expect(await validarChaveTypeSafe("ruim")).toEqual({ ok: false, error: "auth_failed_401" });
  });

  it("chave aceita → ok com o modelo padrão: o catálogo não existe no provedor", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => res(200, JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: {} }))) as unknown as typeof fetch,
    );
    expect(await validarChaveTypeSafe("boa")).toEqual({ ok: true, models: ["jev-latest"] });
  });
});
