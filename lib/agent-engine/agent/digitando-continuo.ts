/**
 * O "digitando…" que ATRAVESSA O TURNO — e por que ele precisa de batimento.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `atraso-humano.ts` acende o "digitando…" no instante em que a PRIMEIRA bolha
 * fica pronta — ou seja, depois de o modelo terminar. Só que o turno leva ~44s
 * até aí: `stage_classifier`, `jailbreak`, a chamada principal e o `checkpoint`
 * rodam em sequência ANTES de a bolha existir. Durante todo esse tempo o lead
 * não vê nada, conclui que foi ignorado e manda "alô?" — medido em produção real.
 *
 * ─── O que este módulo faz ──────────────────────────────────────────────────
 *
 * Acende o indicador assim que o turno decide que VAI responder, e o mantém
 * aceso enquanto ele processa. Um único sinal de presença expira em segundos, e
 * a espera é de dezenas deles — daí o batimento: re-sinaliza a cada
 * `INTERVALO_DIGITANDO_MS` até `parar()`.
 *
 * ─── As três garantias (todas com teste) ────────────────────────────────────
 *
 *  1. NUNCA ATRASA O TURNO. A primeira sinalização e o loop rodam destacados
 *     (`void bater()`); `parar()` é síncrono. Quem chama não espera rede.
 *  2. NUNCA DERRUBA O TURNO. Falha ao sinalizar vira `warn` e o batimento
 *     segue — "digitando…" é decoração, a mensagem é o produto.
 *  3. NUNCA SOBREPÕE. O próximo batimento só é agendado DEPOIS que o anterior
 *     resolve; um canal lento estica o intervalo em vez de acumular pedidos.
 *
 * ─── O que ele NÃO faz ──────────────────────────────────────────────────────
 *
 * Não decide SE deve sinalizar (canal sem presença simplesmente não chama isto),
 * não para sozinho (quem chama garante `parar()` num `finally`) e não conhece
 * provider nenhum — recebe uma closure `sinalizar`.
 */
import type { Logger } from '../obs/logger';

/**
 * De quanto em quanto tempo reacender. Abaixo de ~10s de propósito: a presença
 * do WhatsApp expira em segundos, e o intervalo precisa ser MENOR que a validade
 * dela para a luz não piscar. 5s mantém o indicador continuamente aceso durante
 * os ~44s de processamento sem virar enxurrada de requisições.
 */
export const INTERVALO_DIGITANDO_MS = 5_000;

export interface DigitandoContinuoArgs {
  /** Acende "digitando…" AGORA. Rejeição é engolida e logada. */
  sinalizar: () => Promise<void>;
  log: Logger;
  /** Injetável para teste; default `INTERVALO_DIGITANDO_MS`. */
  intervaloMs?: number;
}

export interface DigitandoContinuo {
  /**
   * Apaga. Síncrono e idempotente; depois dele NENHUM batimento novo é
   * agendado (um que já esteja em voo pode concluir, o que é inofensivo).
   */
  parar: () => void;
}

export function iniciarDigitandoContinuo(args: DigitandoContinuoArgs): DigitandoContinuo {
  const intervaloMs = args.intervaloMs ?? INTERVALO_DIGITANDO_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let parado = false;

  const bater = async (): Promise<void> => {
    if (parado) return;
    try {
      await args.sinalizar();
    } catch (err) {
      // Sem corpo de erro e sem texto de conversa: `lib/logger.ts` proíbe
      // conteúdo no log, e a resposta do canal pode carregá-lo.
      args.log.warn('batimento de "digitando" falhou (segue o turno)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
    // Re-checa DEPOIS do await: `parar()` pode ter chegado durante a chamada, e
    // reagendar ali deixaria um batimento vivo depois de o turno ter acabado.
    if (parado) return;
    timer = setTimeout(() => void bater(), intervaloMs);
  };

  // A primeira sinalização é imediata e destacada: o lead vê a luz antes de o
  // turno começar a pensar, e nada aqui bloqueia o processamento.
  void bater();

  return {
    parar: (): void => {
      parado = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
