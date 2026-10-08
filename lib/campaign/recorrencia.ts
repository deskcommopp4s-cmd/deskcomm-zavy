/**
 * A RECORRÊNCIA DA CAMPANHA (A1, Fase 4) — todas as regras do desenho §6.
 *
 * O `campaigns.recurrence` (jsonb) define quando a campanha volta a disparar
 * depois de concluir. Puro por construção (sem banco): testável sozinho, e a
 * tela expõe as MESMAS regras.
 *
 * Regras (o desenho manda expor TODAS):
 *  - semanal  : `weekdays` [1..6, 0=dom] + hora
 *  - mensal   : `month_days` (dia do mês) OU `last_month_day` + hora
 *  - dia_util : `business_day` primeiro/ultimo (ou N-ésimo) + hora
 *  - intervalo: a cada `interval_n` dias/semanas/meses
 *
 * O fuso: o desenho exige `dayStartInTz` (não assumir UTC). Aqui o cálculo é em
 * UTC e a REGRA DOMÉSTICA de "que dia é" fica com o chamador (a tela/worker
 * pode passar um `now` já no fuso da campanha). Anotado: Fase 4 usa UTC e
 * documenta — o fuso por campanha (`campaigns.timezone`) fica explícito.
 */
export interface Recorrencia {
  kind: "semanal" | "mensal" | "dia_util" | "intervalo";
  weekdays?: number[];
  month_days?: number[];
  last_month_day?: boolean;
  business_day?: "primeiro" | "ultimo";
  business_day_nth?: number;
  interval_n?: number;
  interval_unit?: "dia" | "semana" | "mes";
  hour?: number;
  minute?: number;
}

const MS_DIA = 86_400_000;
const MS_SEMANA = 7 * MS_DIA;

/** `2026-10-08T03:00Z` → `2026-10-08T00:00Z`. */
function inicioDoDia(d: Date): Date {
  const copia = new Date(d.getTime());
  copia.setUTCHours(0, 0, 0, 0);
  return copia;
}

function proximaHoraDoDia(dia: Date, hora = 0, minuto = 0): Date {
  const d = new Date(dia.getTime());
  d.setUTCHours(hora, minuto, 0, 0);
  return d;
}

function ehDiaUtil(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6;
}

function ultimoDiaDoMes(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/** O N-ésimo dia útil do mês (1-based). */
function enesimoDiaUtilDoMes(mesDe: Date, n: number): Date | null {
  let d = new Date(Date.UTC(mesDe.getUTCFullYear(), mesDe.getUTCMonth(), 1));
  let vistos = 0;
  while (d.getUTCMonth() === mesDe.getUTCMonth()) {
    if (ehDiaUtil(d)) {
      vistos += 1;
      if (vistos === n) return d;
    }
    d = new Date(d.getTime() + MS_DIA);
  }
  return null;
}

/**
 * O próximo instante de disparo ESTRITAMENTE DEPOIS de `de`.
 * Devolve null quando a régua não tem próximo (ex.: semanal sem weekdays).
 */
export function proximoDisparo(
  recursao: Recorrencia,
  de: Date,
  hora = recursao.hour ?? 0,
  minuto = recursao.minute ?? 0,
): Date | null {
  switch (recursao.kind) {
    case "semanal": {
      const dias = (recursao.weekdays ?? []).filter((d) => d >= 0 && d <= 6);
      if (dias.length === 0) return null;
      // varre até 8 dias à frente (sempre acha um dia da semana no círculo)
      for (let i = 1; i <= 8; i += 1) {
        const candidato = proximaHoraDoDia(inicioDoDia(new Date(de.getTime() + i * MS_DIA)), hora, minuto);
        if (candidato.getTime() > de.getTime() && dias.includes(candidato.getUTCDay())) {
          return candidato;
        }
      }
      return null;
    }

    case "mensal": {
      let mes = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1));
      for (let m = 0; m < 3; m += 1) {
        if (recursao.last_month_day) {
          const ultimo = proximaHoraDoDia(ultimoDiaDoMes(mes), hora, minuto);
          if (ultimo.getTime() > de.getTime()) return ultimo;
        } else {
          const dias = (recursao.month_days ?? []).filter((d) => d >= 1 && d <= 31);
          for (const dia of dias.sort((a, b) => a - b)) {
            const candidato = proximaHoraDoDia(new Date(Date.UTC(mes.getUTCFullYear(), mes.getUTCMonth(), dia)), hora, minuto);
            if (candidato.getTime() > de.getTime() && candidato.getUTCMonth() === mes.getUTCMonth()) {
              return candidato;
            }
          }
        }
        mes = new Date(Date.UTC(mes.getUTCFullYear(), mes.getUTCMonth() + 1, 1));
      }
      return null;
    }

    case "dia_util": {
      let mes = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1));
      for (let m = 0; m < 3; m += 1) {
        const diaUtil =
          recursao.business_day === "ultimo"
            ? (() => {
                const ultimo = ultimoDiaDoMes(mes);
                let d = ultimo;
                while (!ehDiaUtil(d)) d = new Date(d.getTime() - MS_DIA);
                return d;
              })()
            : enesimoDiaUtilDoMes(mes, recursao.business_day_nth ?? 1);
        if (diaUtil) {
          const candidato = proximaHoraDoDia(diaUtil, hora, minuto);
          if (candidato.getTime() > de.getTime()) return candidato;
        }
        mes = new Date(Date.UTC(mes.getUTCFullYear(), mes.getUTCMonth() + 1, 1));
      }
      return null;
    }

    case "intervalo": {
      const n = recursao.interval_n ?? 1;
      const unidade = recursao.interval_unit ?? "dia";
      const base = inicioDoDia(de);
      let incrementoMs = n * MS_DIA;
      if (unidade === "semana") incrementoMs = n * MS_SEMANA;
      if (unidade === "mes") {
        let m = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + n, 1));
        return proximaHoraDoDia(m, hora, minuto);
      }
      const candidato = proximaHoraDoDia(new Date(base.getTime() + incrementoMs), hora, minuto);
      return candidato.getTime() > de.getTime() ? candidato : null;
    }

    default:
      return null;
  }
}