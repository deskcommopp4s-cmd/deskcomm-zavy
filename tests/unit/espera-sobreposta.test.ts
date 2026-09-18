import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { calcularAtrasoHumano } from "@/lib/agent-engine/agent/atraso-humano";
import { iniciarEsperaSobreposta } from "@/lib/agent-engine/agent/espera-sobreposta";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { runBeforeSend, type Gate } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Logger de teste — guarda os warns em vez de escrever em stdout. */
function logDeTeste(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    info: () => undefined,
    warn: (msg) => warns.push(msg),
    error: () => undefined,
  };
}

/**
 * Cronômetro real dos fake timers: `Date.now()` anda JUNTO com
 * `vi.advanceTimersByTimeAsync`, então o intervalo medido é o que os
 * `setTimeout` prometeram — não uma soma de chamadas de `sleep`.
 */
const dormeDeVerdade = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A PERGUNTA QUE ESTE MÓDULO RESPONDE: sobrepor a pausa humana à cadeia de gates
 * remove a SOMA e deixa só o MAIOR? O turno é difícil de montar em teste (pool,
 * modelo, canal), então o contrato é medido na unidade que o turno chama, com o
 * mesmo `sleep` injetável — e a fiação no arquivo do turno é presa por fonte.
 */
describe("iniciarEsperaSobreposta — o bloco é max(pausa, gates), não a soma", () => {
  // Pausa entre piso e teto (clamp [1200, 7500]) para o max ser observável.
  const TEXTO = "Claro! Vou conferir a agenda do sítio para essa data e já te respondo.";
  const PAUSA = calcularAtrasoHumano(TEXTO, 1);
  const GATES = 2000;

  it("a pausa corre junto com os gates: termina em max(pausa, gates)", async () => {
    vi.useFakeTimers();
    // Garante que o max é a PAUSA (senão o teste provaria o caso banal).
    expect(PAUSA).toBeGreaterThan(GATES);

    const t0 = Date.now();
    const espera = iniciarEsperaSobreposta({
      textoCandidato: TEXTO,
      sleep: dormeDeVerdade,
      log: logDeTeste(),
      fatorAleatorio: () => 1,
    });

    // Os gates rodam EM PARALELO à pausa — é o contrato que o turno implementa
    // (a pausa dispara antes do `runBeforeSend`, que corre aqui ao lado).
    const gates = dormeDeVerdade(GATES);
    await vi.advanceTimersByTimeAsync(GATES);
    await gates;

    const aguardando = espera.aguardar(TEXTO);
    await vi.advanceTimersByTimeAsync(PAUSA - GATES);
    await aguardando;

    const bloco = Date.now() - t0;
    expect(bloco).toBe(PAUSA); // max(PAUSA, GATES)
    // O contrapositivo é o defeito: serializado, o bloco seria a soma.
    expect(bloco).toBeLessThan(PAUSA + GATES);
  });

  it("não ENCURTA: se o texto final exigir mais, completa a diferença", async () => {
    vi.useFakeTimers();
    const CURTO = "Oi, tudo bem?";
    const LONGO =
      "Claro! Vou conferir a agenda do sítio para essa data e já te respondo com o pacote completo e os valores.";
    const pausaCurta = calcularAtrasoHumano(CURTO, 1);
    const pausaLonga = calcularAtrasoHumano(LONGO, 1);
    expect(pausaLonga).toBeGreaterThan(pausaCurta);

    const dormidos: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      dormidos.push(ms);
      return dormeDeVerdade(ms);
    };
    const espera = iniciarEsperaSobreposta({
      textoCandidato: CURTO,
      sleep,
      log: logDeTeste(),
      fatorAleatorio: () => 1,
    });
    const aguardando = espera.aguardar(LONGO);
    await vi.advanceTimersByTimeAsync(pausaLonga);
    const ms = await aguardando;

    // A pausa TOTAL é a que o texto FINAL exige (o disclosureGate pode
    // prependar o corpo), não a do candidato: inicial + top-up somam o exigido.
    expect(ms).toBe(pausaLonga);
    expect(dormidos.reduce((a, b) => a + b, 0)).toBe(pausaLonga);
  });

  it("UMA pausa por turno: o re-run do fail-safe reusa a pausa já iniciada", async () => {
    vi.useFakeTimers();
    const chamadasDeSleep: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      chamadasDeSleep.push(ms);
      return dormeDeVerdade(ms);
    };

    const espera = iniciarEsperaSobreposta({
      textoCandidato: TEXTO,
      sleep,
      log: logDeTeste(),
      fatorAleatorio: () => 1,
    });
    // Duas passagens da cadeia (o fail-safe de promessa/vocabulário re-roda) —
    // as duas chegam ao `antesDaPrimeira`, que chama `aguardar`.
    const primeiraPassagem = espera.aguardar(TEXTO);
    const segundaPassagem = espera.aguardar(TEXTO);
    await vi.advanceTimersByTimeAsync(PAUSA + 100);
    const [m1, m2] = await Promise.all([primeiraPassagem, segundaPassagem]);

    expect(m1).toBe(PAUSA);
    expect(m2).toBe(PAUSA);
    // Só UM `sleep` da pausa: uma segunda cobrança seria o defeito simétrico.
    expect(chamadasDeSleep).toEqual([PAUSA]);
  });

  it("acende 'digitando' ANTES de dormir — a ordem é o produto", async () => {
    const ordem: string[] = [];
    const espera = iniciarEsperaSobreposta({
      textoCandidato: TEXTO,
      sleep: async () => {
        ordem.push("espera");
      },
      log: logDeTeste(),
      fatorAleatorio: () => 1,
      sinalizarDigitando: async () => {
        ordem.push("digitando");
      },
    });
    await espera.aguardar(TEXTO);
    expect(ordem).toEqual(["digitando", "espera"]);
  });

  it("presença que FALHA não derruba nem encurta a pausa", async () => {
    const log = logDeTeste();
    const espera = iniciarEsperaSobreposta({
      textoCandidato: TEXTO,
      sleep: async () => undefined,
      log,
      fatorAleatorio: () => 1,
      sinalizarDigitando: async () => {
        throw new Error("waha_500");
      },
    });
    await expect(espera.aguardar(TEXTO)).resolves.toBe(PAUSA);
    expect(log.warns.length).toBe(1);
  });

  it("se a cadeia VETA, a pausa termina sozinha — sem pendurar nem vazar", async () => {
    vi.useFakeTimers();
    const espera = iniciarEsperaSobreposta({
      textoCandidato: TEXTO,
      sleep: dormeDeVerdade,
      log: logDeTeste(),
      fatorAleatorio: () => 1,
    });
    // Cadeia vetou: `antesDaPrimeira` nunca roda, ninguém aguarda a pausa.
    await vi.advanceTimersByTimeAsync(PAUSA + 100);
    expect(vi.getTimerCount()).toBe(0); // esvaziou sozinha
    // E a promessa permanece aguardável (não virou rejeição pendurada).
    await expect(espera.aguardar(TEXTO)).resolves.toBe(PAUSA);
  });

  it("erro no `sleep` não vaza quando ninguém aguarda; quem aguarda vê o erro", async () => {
    const sleep = vi.fn(async () => {
      throw new Error("sleep explodiu");
    });
    const espera = iniciarEsperaSobreposta({
      textoCandidato: TEXTO,
      sleep,
      log: logDeTeste(),
      fatorAleatorio: () => 1,
    });
    // Deixa a rejeição da pausa correr solta: sem o catch interno, o vitest
    // acusaria unhandled rejection e este teste falharia aqui.
    await Promise.resolve();
    await Promise.resolve();
    await expect(espera.aguardar(TEXTO)).rejects.toThrow("sleep explodiu");
  });
});

/**
 * FIAÇÃO — o turno mora num arquivo de ~4.400 linhas e não é alcançável por teste
 * de unidade (precisa de pool, modelo e canal). A sobreposição só existe se a
 * pausa for iniciada ANTES do `runBeforeSend`; iniciada depois, seria a mesma
 * serialização de antes com um nome novo. Prender a ordem na fonte é a rede mais
 * barata que alcança isso.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);

describe("fiação — a pausa sobreposta no turno", () => {
  it("a pausa é iniciada ANTES do `runBeforeSend` — é isso que a sobrepõe", () => {
    const inicioDaPausa = FONTE_INBOUND.indexOf("esperaSobreposta = iniciarEsperaSobreposta({");
    const cadeia = FONTE_INBOUND.indexOf("let chain = await runBeforeSend(beforeSendArgs)");
    expect(inicioDaPausa).toBeGreaterThan(-1);
    expect(cadeia).toBeGreaterThan(-1);
    expect(inicioDaPausa).toBeLessThan(cadeia);
  });

  it("UMA pausa por turno — a condição exige o flag e o holder vazios", () => {
    expect(FONTE_INBOUND).toContain(
      "if (!preview && !jaEsperouComoHumano && esperaSobreposta === null) {",
    );
  });

  it("`antesDaPrimeira` aguarda a pausa e mantém o guard do re-run", () => {
    const i = FONTE_INBOUND.indexOf("antesDaPrimeira: async (primeiraBolha: string)");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 900);
    // O guard continua ANTES de qualquer espera (ordem é o que impede a 2ª).
    expect(janela).toMatch(/if \(jaEsperouComoHumano\) return;\s*\n\s*jaEsperouComoHumano = true;/);
    expect(janela).toContain("esperaSobreposta.aguardar(primeiraBolha)");
  });

  it("a fase `envio` abre no PRELÚDIO do envio, não no fim da pausa", () => {
    const marca = FONTE_INBOUND.indexOf("if (!preview) medicaoDoTurno?.marcar('envio');");
    const cadeia = FONTE_INBOUND.indexOf("let chain = await runBeforeSend(beforeSendArgs)");
    expect(marca).toBeGreaterThan(-1);
    expect(marca).toBeLessThan(cadeia);
    // E o callback da pausa NÃO marca mais a fase — a marcação mudou de lugar.
    const callback = FONTE_INBOUND.slice(
      FONTE_INBOUND.indexOf("onEsperaHumana:"),
      FONTE_INBOUND.indexOf("antesDaPrimeira: async"),
    );
    expect(callback).not.toContain("marcar('envio')");
  });
});

/**
 * O VETO NÃO MUDOU. Quem fala com o canal é o `runBeforeSend`, e só no ramo
 * não-vetado; a sobreposição acrescenta uma pausa em paralelo, nunca um caminho
 * alternativo de envio. Este teste prende a garantia no runner real (o mesmo
 * harness de `gate-pacing-capability.test.ts`), com `send` espionado.
 */
describe("veto — nada é enviado (garantia do runBeforeSend, preservada)", () => {
  it("gate que veta: o `send` do canal não é chamado", async () => {
    const gateQueVeta: Gate = {
      name: "stop",
      evaluate: () => ({
        pass: false,
        code: "contato_bloqueado",
        reason: "opt-out irrevogável",
      }),
    };
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] }),
    } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn(
      async (_body: string): Promise<ChannelSendResult> => ({
        kind: "sent",
        idempotencyKey: "k",
        messageId: "m",
      }),
    );

    const resultado = await runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: "oi",
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: new Date("2026-09-18T12:00:00Z"),
      gates: [gateQueVeta],
      send,
    });

    expect(resultado.status).toBe("vetoed");
    expect(send).not.toHaveBeenCalled();
  });
});
