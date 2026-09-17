import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INTERVALO_DIGITANDO_MS,
  iniciarDigitandoContinuo,
} from "@/lib/agent-engine/agent/digitando-continuo";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Logger de teste — guarda os warns em vez de escrever em stdout. */
function logDeTeste(): Logger & { avisos: string[] } {
  const avisos: string[] = [];
  return {
    avisos,
    info: () => undefined,
    warn: (msg) => avisos.push(msg),
    error: () => undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("iniciarDigitandoContinuo", () => {
  it("acende NA HORA e reacende a cada intervalo — a espera é de dezenas de segundos", async () => {
    vi.useFakeTimers();
    const sinalizar = vi.fn(async () => undefined);

    iniciarDigitandoContinuo({ sinalizar, log: logDeTeste(), intervaloMs: 5_000 });

    // O lead vê a luz antes de o turno começar a pensar: a primeira sinalização
    // não espera o primeiro intervalo.
    expect(sinalizar).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinalizar).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinalizar).toHaveBeenCalledTimes(3);
  });

  it("usa o intervalo default quando nenhum é injetado", () => {
    vi.useFakeTimers();
    const sinalizar = vi.fn(async () => undefined);
    iniciarDigitandoContinuo({ sinalizar, log: logDeTeste() });
    expect(INTERVALO_DIGITANDO_MS).toBeGreaterThan(0);
    expect(sinalizar).toHaveBeenCalledTimes(1);
  });

  it("parar() apaga e NENHUM batimento novo é agendado — 'digitando' eterno é pior que nenhum", async () => {
    vi.useFakeTimers();
    const sinalizar = vi.fn(async () => undefined);
    const batimento = iniciarDigitandoContinuo({
      sinalizar,
      log: logDeTeste(),
      intervaloMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinalizar).toHaveBeenCalledTimes(2);

    batimento.parar();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sinalizar).toHaveBeenCalledTimes(2);
  });

  it("parar() é idempotente", () => {
    const batimento = iniciarDigitandoContinuo({
      sinalizar: async () => undefined,
      log: logDeTeste(),
    });
    batimento.parar();
    expect(() => batimento.parar()).not.toThrow();
  });

  it("parar() DURANTE um batimento em voo não deixa agendamento vivo", async () => {
    vi.useFakeTimers();
    let liberar: (() => void) | null = null;
    const sinalizar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          liberar = resolve;
        }),
    );
    const batimento = iniciarDigitandoContinuo({
      sinalizar,
      log: logDeTeste(),
      intervaloMs: 5_000,
    });

    batimento.parar();
    // O canal finalmente responde — mas o turno já acabou: não re-agenda.
    liberar!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sinalizar).toHaveBeenCalledTimes(1);
  });

  it("canal LENTO não acumula batimentos sobrepostos", async () => {
    vi.useFakeTimers();
    let liberar: (() => void) | null = null;
    const sinalizar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          liberar = resolve;
        }),
    );
    iniciarDigitandoContinuo({ sinalizar, log: logDeTeste(), intervaloMs: 5_000 });

    expect(sinalizar).toHaveBeenCalledTimes(1);
    // Enquanto o primeiro não resolveu, o próximo NÃO foi agendado — nada de
    // enxurrada de presença num canal travado.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sinalizar).toHaveBeenCalledTimes(1);

    liberar!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinalizar).toHaveBeenCalledTimes(2);
  });

  it("falha ao sinalizar vira warn e o batimento SEGUE — decoração não derruba o turno", async () => {
    vi.useFakeTimers();
    const log = logDeTeste();
    let chamadas = 0;
    const sinalizar = vi.fn(async () => {
      chamadas += 1;
      if (chamadas === 1) throw new Error("waha_500");
    });

    iniciarDigitandoContinuo({ sinalizar, log, intervaloMs: 5_000 });

    // A 1ª falhou e depois dela o turno continuou a processar por 5s: o 2º
    // batimento TEM de ter saído, senão uma oscilação apagaria o indicador.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sinalizar).toHaveBeenCalledTimes(2);
    expect(log.avisos.length).toBe(1);
  });
});

/**
 * FIAÇÃO — o batimento mora no meio de um arquivo de ~4.300 linhas e não é
 * alcançável por teste de unidade do turno (precisaria de pool, modelo e canal).
 * A perda seria silenciosa e cara: um batimento sem `finally` fica aceso depois
 * de o turno morrer; um sem parada em `antesDaPrimeira` duplica presença com o
 * `esperarComoHumano`. Prender a fiação na fonte é a rede mais barata.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);

describe("fiação — o 'digitando' do turno sempre apaga", () => {
  it("começa DEPOIS das barreiras que descartam e ANTES das chamadas de IA caras", () => {
    const inicio = FONTE_INBOUND.indexOf("iniciarDigitandoContinuo({");
    expect(inicio).toBeGreaterThan(-1);

    // Depois do adiamento por horário de funcionamento (a última barreira que
    // descarta sem responder).
    const barreiraHorario = FONTE_INBOUND.indexOf(
      "fora do horário de funcionamento — job reagendado",
    );
    expect(barreiraHorario).toBeGreaterThan(-1);
    expect(inicio).toBeGreaterThan(barreiraHorario);

    // Antes do primeiro classificador auxiliar — começo dos ~44s que ele cobre.
    const primeiroClassificador = FONTE_INBOUND.indexOf("await classifyStage(");
    expect(primeiroClassificador).toBeGreaterThan(-1);
    expect(inicio).toBeLessThan(primeiroClassificador);
  });

  it("para no `finally` que também limpa o MCP — parar independe do desfecho", () => {
    const limpeza = FONTE_INBOUND.indexOf("await mcpCleanup?.();");
    expect(limpeza).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(Math.max(0, limpeza - 400), limpeza);
    expect(janela).toContain("digitando?.parar();");
  });

  it("para em `antesDaPrimeira` ANTES de o `esperarComoHumano` sinalizar", () => {
    const i = FONTE_INBOUND.indexOf("antesDaPrimeira: async (primeiraBolha: string)");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 1200);
    const parada = janela.indexOf("digitando?.parar();");
    const reacende = janela.indexOf("esperarComoHumano({");
    expect(parada).toBeGreaterThan(-1);
    expect(reacende).toBeGreaterThan(-1);
    // Ordem importa: parar DEPOIS de o `esperarComoHumano` já ter acendido
    // deixaria dois pedidos de presença no ar ao mesmo tempo.
    expect(parada).toBeLessThan(reacende);
  });

  it("para também antes do `checkpoint` — o modelo não fala mais com o lead", () => {
    const chamadaPrincipal = FONTE_INBOUND.indexOf(
      "purpose: preview ? 'agent_preview' : 'agent_turn'",
    );
    const checkpoint = FONTE_INBOUND.indexOf("purpose: 'checkpoint'");
    expect(chamadaPrincipal).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(chamadaPrincipal);

    // Há um `parar()` entre a resposta ao lead e o checkpoint: o indicador não
    // sobrevive à própria resposta.
    const parada = FONTE_INBOUND.indexOf("digitando?.parar();", chamadaPrincipal);
    expect(parada).toBeGreaterThan(chamadaPrincipal);
    expect(parada).toBeLessThan(checkpoint);
  });
});
