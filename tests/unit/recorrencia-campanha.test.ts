/**
 * A recorrência da campanha (A1, Fase 4) — o cálculo puro, sem banco.
 */
import { describe, expect, it } from "vitest";

import { proximoDisparo, type Recorrencia } from "@/lib/campaign/recorrencia";

const SEG = new Date(Date.UTC(2026, 9, 5, 12, 0, 0)); // 2026-10-05 é SEGUNDA

describe("proximoDisparo", () => {
  it("semanal: volta na próxima terça depois de uma segunda", () => {
    const r: Recorrencia = { kind: "semanal", weekdays: [2], hour: 9, minute: 0 };
    const next = proximoDisparo(r, SEG)!;
    expect(next.toISOString()).toBe("2026-10-06T09:00:00.000Z");
  });

  it("semanal: composta (seg e qui) escolhe a mais próxima", () => {
    const r: Recorrencia = { kind: "semanal", weekdays: [2, 4], hour: 10, minute: 30 };
    const next = proximoDisparo(r, SEG)!;
    // SEG 05 -> TER 06 10:30 é a próxima
    expect(next.toISOString()).toBe("2026-10-06T10:30:00.000Z");
  });

  it("mensal: no dia 15 do mês seguinte", () => {
    const r: Recorrencia = { kind: "mensal", month_days: [15], hour: 8, minute: 0 };
    const next = proximoDisparo(r, SEG)!;
    expect(next.toISOString()).toBe("2026-10-15T08:00:00.000Z");
  });

  it("mensal: último dia do mês", () => {
    const r: Recorrencia = { kind: "mensal", last_month_day: true, hour: 9, minute: 0 };
    const next = proximoDisparo(r, SEG)!;
    expect(next.toISOString()).toBe("2026-10-31T09:00:00.000Z");
  });

  it("dia_util: primeiro dia útil do mês seguinte", () => {
    const r: Recorrencia = { kind: "dia_util", business_day: "primeiro", hour: 7, minute: 0 };
    const next = proximoDisparo(r, SEG)!;
    // outubro/2026: 01 é quinta (dia útil) -> já passou? SEG é 05; o primeiro de
    // outubro (01) já passou -> próximo é 01/11 (domingo) -> 02/11 (segunda) é o 1º útil
    expect(next.getUTCDate()).toBe(2);
    expect(next.getUTCMonth()).toBe(10); // novembro
  });

  it("intervalo: a cada 3 dias", () => {
    const r: Recorrencia = { kind: "intervalo", interval_n: 3, interval_unit: "dia", hour: 9, minute: 0 };
    const next = proximoDisparo(r, SEG)!;
    expect(next.toISOString()).toBe("2026-10-08T09:00:00.000Z");
  });

  it("semanal sem weekdays devolve null (régua inválida)", () => {
    const r: Recorrencia = { kind: "semanal", weekdays: [] };
    expect(proximoDisparo(r, SEG)).toBeNull();
  });
});