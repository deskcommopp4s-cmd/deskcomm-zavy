import { describe, expect, it, vi } from "vitest";

import {
  ATRASO_MAXIMO_MS,
  ATRASO_MINIMO_MS,
  FATOR_ALEATORIO_MAX,
  FATOR_ALEATORIO_MIN,
  calcularAtrasoHumano,
  esperarComoHumano,
  sortearFator,
} from "@/lib/agent-engine/agent/atraso-humano";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Logger de teste — guarda as linhas em vez de escrever em stdout. */
function logDeTeste(): Logger & { linhas: Array<{ nivel: string; msg: string }> } {
  const linhas: Array<{ nivel: string; msg: string }> = [];
  return {
    linhas,
    info: (msg) => linhas.push({ nivel: "info", msg }),
    warn: (msg) => linhas.push({ nivel: "warn", msg }),
    error: (msg) => linhas.push({ nivel: "error", msg }),
  };
}

describe("calcularAtrasoHumano", () => {
  it("resposta de duas palavras espera o PISO, não uma eternidade", () => {
    // O defeito que este módulo conserta é o oposto (resposta instantânea), mas
    // a correção não pode criar o defeito simétrico: "Oi, tudo bem?" com 8s de
    // espera lê como travamento, não como humano.
    expect(calcularAtrasoHumano("Oi, tudo bem?")).toBe(ATRASO_MINIMO_MS);
  });

  it("parágrafo longo é limitado pelo TETO", () => {
    const paragrafo = "a".repeat(4000);
    expect(calcularAtrasoHumano(paragrafo)).toBe(ATRASO_MAXIMO_MS);
  });

  it("entre piso e teto, o atraso CRESCE com o tamanho do texto", () => {
    const curta = calcularAtrasoHumano("Temos sim, o sítio está livre nessa data.");
    const media = calcularAtrasoHumano(
      "Temos sim, o sítio está livre nessa data. O pacote de casamento inclui " +
        "a cerimônia no jardim, o salão climatizado e a suíte dos noivos.",
    );
    expect(media).toBeGreaterThan(curta);
    expect(media).toBeLessThanOrEqual(ATRASO_MAXIMO_MS);
  });

  it("o piso não fica abaixo do piso anti-ban de 1,2s", () => {
    // Doutrina WAHA (CLAUDE.md): throttle 1 msg/1.2s. Um atraso "humano" menor
    // que o piso do anti-ban seria decoração que não protege nada.
    expect(ATRASO_MINIMO_MS).toBeGreaterThanOrEqual(1200);
    expect(calcularAtrasoHumano("")).toBeGreaterThanOrEqual(1200);
  });

  it("devolve inteiro de milissegundos (é argumento de setTimeout)", () => {
    expect(Number.isInteger(calcularAtrasoHumano("um texto de tamanho médio aqui"))).toBe(true);
  });
});

describe("esperarComoHumano", () => {
  it("sinaliza 'digitando' ANTES de esperar — a ordem é o produto", async () => {
    const ordem: string[] = [];
    const sinalizarDigitando = vi.fn(async () => {
      ordem.push("digitando");
    });
    const sleep = vi.fn(async () => {
      ordem.push("espera");
    });

    await esperarComoHumano({
      texto: "Claro! Vou conferir a agenda do sítio para essa data.",
      sleep,
      log: logDeTeste(),
      sinalizarDigitando,
    });

    // Esperar primeiro e só depois mostrar "digitando" entregaria os três
    // segundos de silêncio que o dono do produto reclamou.
    expect(ordem).toEqual(["digitando", "espera"]);
  });

  it("espera exatamente o que a fórmula calculou", async () => {
    const texto = "Claro! Vou conferir a agenda do sítio para essa data.";
    const sleep = vi.fn(async () => undefined);

    // Fator fixo: sem ele o atraso de produção é aleatório e este teste piscaria.
    await esperarComoHumano({ texto, sleep, log: logDeTeste(), fatorAleatorio: () => 1 });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(calcularAtrasoHumano(texto));
  });

  it("presença que FALHA não derruba o envio nem encurta a espera", async () => {
    // "digitando" é decoração; a mensagem é o produto. Um WAHA fora do ar, uma
    // sessão que não está WORKING ou um engine que não implementa presença não
    // podem virar mensagem não entregue.
    const texto = "Claro! Vou conferir a agenda do sítio para essa data.";
    const sleep = vi.fn(async () => undefined);
    const log = logDeTeste();

    await expect(
      esperarComoHumano({
        texto,
        sleep,
        log,
        fatorAleatorio: () => 1,
        sinalizarDigitando: async () => {
          throw new Error("waha_500");
        },
      }),
    ).resolves.toBeDefined();

    expect(sleep).toHaveBeenCalledWith(calcularAtrasoHumano(texto));
    expect(log.linhas.some((l) => l.nivel === "warn")).toBe(true);
  });

  it("canal que não sabe sinalizar presença apenas espera", async () => {
    const sleep = vi.fn(async () => undefined);
    await esperarComoHumano({ texto: "Bom dia!", sleep, log: logDeTeste() });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("devolve os ms esperados, para o log do turno poder afirmá-los", async () => {
    const texto = "Uma resposta de tamanho médio para o cliente do sítio.";
    const ms = await esperarComoHumano({
      texto,
      sleep: async () => undefined,
      log: logDeTeste(),
      fatorAleatorio: () => 1,
    });
    expect(ms).toBe(calcularAtrasoHumano(texto));
  });
});

/**
 * A VARIAÇÃO DO ATRASO — antes, todo turno com o mesmo tamanho de texto esperava
 * o mesmo número de milissegundos, e tempo idêntico é a assinatura de máquina
 * mais óbvia que existe. O fator é injetável justamente para estes testes serem
 * determinísticos: o `Math.random` só vive no default de produção.
 */
describe("aleatoriedade do atraso (±25%)", () => {
  // Tamanho médio: o bruto fica ENTRE piso e teto, onde a variação é visível.
  const TEXTO_MEDIO = "Claro! Vou conferir a agenda do sítio para essa data.";

  it("o fator multiplica o atraso — e o teste o controla", () => {
    const devagar = calcularAtrasoHumano(TEXTO_MEDIO, 1.25);
    const base = calcularAtrasoHumano(TEXTO_MEDIO, 1);
    const rapido = calcularAtrasoHumano(TEXTO_MEDIO, 0.75);

    expect(rapido).toBeLessThan(base);
    expect(base).toBeLessThan(devagar);
    // Determinístico de ponta a ponta: sem fator, o valor puro da fórmula.
    expect(base).toBe(calcularAtrasoHumano(TEXTO_MEDIO));
  });

  it("a variação é aplicada ANTES do clamp — nos extremos ela desaparece", () => {
    // Piso: mesmo 25% mais devagar, uma resposta curta continua no mínimo.
    expect(calcularAtrasoHumano("Oi", 1.25)).toBe(ATRASO_MINIMO_MS);
    // Teto: mesmo 25% mais rápido, um parágrafo longo continua no máximo.
    expect(calcularAtrasoHumano("a".repeat(4000), 0.75)).toBe(ATRASO_MAXIMO_MS);
    // E um fator absurdo continua preso à faixa.
    expect(calcularAtrasoHumano("a".repeat(4000), 50)).toBe(ATRASO_MAXIMO_MS);
    expect(calcularAtrasoHumano("Oi", 0.01)).toBe(ATRASO_MINIMO_MS);
  });

  it("sortearFator() fica na faixa e VARIA — nunca o mesmo número duas vezes", () => {
    const amostras = Array.from({ length: 40 }, () => sortearFator());
    for (const f of amostras) {
      expect(f).toBeGreaterThanOrEqual(FATOR_ALEATORIO_MIN);
      expect(f).toBeLessThanOrEqual(FATOR_ALEATORIO_MAX);
    }
    // 40 amostras contínuas: todas iguais teria probabilidade zero. A asserção
    // existe para pegar uma "aleatoriedade" que na verdade é constante.
    expect(new Set(amostras).size).toBeGreaterThan(1);
  });

  it("a produção usa o fator sorteado — o injetado é o que manda", async () => {
    const sleep = vi.fn(async () => undefined);
    await esperarComoHumano({
      texto: TEXTO_MEDIO,
      sleep,
      log: logDeTeste(),
      fatorAleatorio: () => 0.8,
    });
    expect(sleep).toHaveBeenCalledWith(calcularAtrasoHumano(TEXTO_MEDIO, 0.8));
  });

  it("sem injeção, o caminho de produção continua preso à faixa [piso, teto]", async () => {
    const ms = await esperarComoHumano({
      texto: TEXTO_MEDIO,
      sleep: async () => undefined,
      log: logDeTeste(),
    });
    expect(ms).toBeGreaterThanOrEqual(ATRASO_MINIMO_MS);
    expect(ms).toBeLessThanOrEqual(ATRASO_MAXIMO_MS);
  });
});
