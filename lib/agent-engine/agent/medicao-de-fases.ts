/**
 * A MEDIÇÃO DE TEMPO DO TURNO — por fase, e por que ela existe.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O turno leva ~44,5s entre a mensagem do lead e a resposta, e as cinco chamadas
 * de IA somam apenas ~21,6s (`agent_preview` 9,3s + `stage_classifier` 6,5s +
 * `jailbreak_detect` 2,5s + `promise_semantic` 1,6s + `checkpoint` 1,7s). Os
 * outros ~23s NÃO estavam medidos em lugar nenhum: nenhum ponto do turno tinha
 * relógio, e otimização sem medição é chute — já se otimizou o lugar errado uma
 * vez neste fork.
 *
 * ─── O que este módulo é ────────────────────────────────────────────────────
 *
 * Um relógio de FASES: `marcar('preparo')` fecha a fase anterior e abre a
 * seguinte; `resumo()` devolve o tempo de cada uma e o total. O nome da fase é
 * carimbado ANTES do I/O que ela mede (é por isso que a API é "marcar o início
 * da próxima", e não "fechar esta"), de modo que o preparo caiba inteiro na
 * primeira fase.
 *
 * ─── As três garantias ──────────────────────────────────────────────────────
 *
 *  1. NUNCA DERRUBA O TURNO. Toda medição passa por `comMedicao`, que engole o
 *     erro e loga `warn`. Relógio que falta vira fase ausente, nunca exceção.
 *  2. NUNCA ATRASA O TURNO. Uma chamada de relógio por fase; o log sai UMA vez,
 *     no fim, e nada aqui espera I/O.
 *  3. NUNCA VAZA DADO. Saem só NÚMEROS (ms) e nomes de fase — nenhum id, nenhum
 *     texto de conversa (ver `lib/logger.ts`: conteúdo de lead nunca é logável).
 *
 * ─── Desligar ───────────────────────────────────────────────────────────────
 *
 * `AGENT_TURN_TIMING=false` desliga. O padrão é LIGADO: o diagnóstico é o
 * motivo de o módulo existir, e uma medição opt-in chegaria desligada
 * exatamente no dia em que se precisa dela. Desligado, `marcar` e `resumo`
 * continuam seguros (viram no-op) — o turno não ganha `if` de guarda.
 */
import type { Logger } from '../obs/logger';

/** Fase do turno. Ordem aqui é a ordem documental; a REAL vem do código. */
export const FASES_DO_TURNO = [
  'preparo',
  'compactacao',
  'ferramentas',
  'etapa',
  'jailbreak',
  'contexto',
  'chamada_principal',
  'envio',
  'checkpoint',
] as const;

export type FaseDoTurno = (typeof FASES_DO_TURNO)[number];

export interface MedicaoDeFases {
  /**
   * Fecha a fase corrente e abre `fase`. O carimbo do rótulo acontece AGORA —
   * o I/O que a fase mede vem DEPOIS desta chamada, não antes.
   */
  marcar: (fase: FaseDoTurno) => void;
  /**
   * Instante em que a fase `fase` começou, ou `null` se ela não foi marcada.
   * Existe para medir um trecho DENTRO de uma fase (o envio já traz o instante
   * em que a espera humana começou, medido pelo próprio `sendInBubbles`) sem
   * que o dono do trecho precise de uma segunda implementação de relógio.
   */
  inicioDaFase: (fase: FaseDoTurno) => number | null;
  /**
   * Fecha a última fase e devolve os ms por fase + o total desde a criação.
   * Marcar tudo o que se quer medir, e chamar isto UMA vez, no fim.
   */
  resumo: () => { fases_ms: Partial<Record<FaseDoTurno, number>>; total_ms: number } | null;
}

export interface MedicaoDeFasesArgs {
  /** Logger já carimbado com o contexto do run (`withFields`) — correlaciona por job_id. */
  log: Logger;
  /** Injetável para teste; default `Date.now`. */
  agora?: () => number;
}

/**
 * Cria o relógio de fases. NUNCA lança: um relógio quebrado degrada a medição a
 * `null`, e o turno segue — medir é observabilidade, responder é o produto.
 */
export function criarMedicaoDeFases(args: MedicaoDeFasesArgs): MedicaoDeFases {
  const agora = args.agora ?? Date.now;
  const inicioDoTurno = agora();
  const inicioDaFase = new Map<FaseDoTurno, number>();
  const encerrada: Partial<Record<FaseDoTurno, number>> = Object.create(null);
  let faseCorrente: FaseDoTurno | null = null;
  let fechada = false;

  return {
    marcar: (fase: FaseDoTurno): void => {
      if (fechada) return;
      const t = agora();
      if (faseCorrente !== null) encerrada[faseCorrente] = t - (inicioDaFase.get(faseCorrente) ?? t);
      faseCorrente = fase;
      inicioDaFase.set(fase, t);
    },
    inicioDaFase: (fase: FaseDoTurno): number | null =>
      inicioDaFase.has(fase) ? (inicioDaFase.get(fase) as number) : null,
    resumo: (): { fases_ms: Partial<Record<FaseDoTurno, number>>; total_ms: number } | null => {
      if (fechada) return null;
      fechada = true;
      const t = agora();
      if (faseCorrente !== null) {
        encerrada[faseCorrente] = t - (inicioDaFase.get(faseCorrente) ?? t);
        faseCorrente = null;
      }
      return { fases_ms: encerrada, total_ms: t - inicioDoTurno };
    },
  };
}

/**
 * Fecha a medição e emite a linha. Engole qualquer falha do relógio/log — a
 * única coisa que este envoltório NÃO pode fazer é derrubar o turno que ele
 * existe para diagnosticar.
 */
export function fecharMedicaoDeFases(medicao: MedicaoDeFases | null, log: Logger): void {
  if (medicao === null) return;
  try {
    const resumo = medicao.resumo();
    if (resumo === null) return;
    log.info('tempo por fase do turno', { ...resumo.fases_ms, total_ms: resumo.total_ms });
  } catch (err) {
    try {
      log.warn('medição de tempo do turno falhou ao fechar (o turno segue)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    } catch {
      // Log que lança é o fim da linha: engolir aqui é a diferença entre perder
      // uma linha de diagnóstico e perder o turno.
    }
  }
}

/**
 * Executa `fn` sob a medição — abre a fase `fase`, roda, fecha e emite, sempre.
 * É o atalho para um trecho autocontido (o preparo do turno, por exemplo) que
 * não tem como reaproveitar o relógio do turno inteiro. Falha no `finally` não
 * mascara o erro de `fn`.
 */
export async function comMedicao<T>(
  log: Logger,
  fase: FaseDoTurno,
  fn: (medicao: MedicaoDeFases) => Promise<T>,
  deps: { agora?: () => number } = {},
): Promise<T> {
  const medicao = criarMedicaoDeFases(deps.agora !== undefined ? { log, agora: deps.agora } : { log });
  try {
    medicao.marcar(fase);
    return await fn(medicao);
  } finally {
    fecharMedicaoDeFases(medicao, log);
  }
}
