/**
 * O TEMPO QUE UMA PESSOA LEVA PARA RESPONDER — e por que ele é feature.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O agente responde no instante em que o modelo termina de gerar. Do lado do
 * cliente, no WhatsApp, isso é inconfundível: a resposta chega junto com o "✓✓"
 * da mensagem que ele acabou de mandar. Nenhum atendente humano lê, pensa e
 * digita um parágrafo em 200ms — e o cliente sabe disso. Reportado pelo dono de
 * um tenant real (sítio de eventos): "responde rápido demais, parece robô".
 *
 * O produto é um agente que ATENDE junto com humanos. Ser identificável como
 * máquina na primeira troca é perda de conversão, não detalhe estético.
 *
 * ─── A fórmula, e por que estes números ─────────────────────────────────────
 *
 *   atraso = clamp(NOTAR + POR_CARACTERE × comprimento, MINIMO, MAXIMO)
 *
 * `NOTAR` (900ms) é a parcela que NÃO depende do texto: ver a notificação,
 * abrir a conversa, ler o que o cliente escreveu. Ela existe separada do termo
 * proporcional porque mesmo um "Sim!" tem esse custo — sem ela, respostas
 * curtas voltariam a sair instantâneas, que é exatamente o defeito.
 *
 * `POR_CARACTERE` (22ms ≈ 45 caracteres/s) é digitação DELIBERADAMENTE mais
 * rápida que a real (um bom digitador faz ~8 c/s no celular). Não é erro de
 * calibração: em velocidade real, um parágrafo de 400 caracteres pediria 50
 * segundos, e um cliente esperando 50s conclui que ninguém vai responder.
 * O objetivo é "não é instantâneo", não "é indistinguível de humano" — a
 * segunda meta custa o atendimento.
 *
 * `MINIMO` (1200ms) é o piso do throttle anti-ban do canal (CLAUDE.md: 1 msg /
 * 1.2s). Um atraso "humano" menor que o piso que o anti-ban já impõe seria
 * decoração que não muda nada. `MAXIMO` (7500ms) é o teto: acima disso o
 * silêncio deixa de ler como "está digitando" e passa a ler como "caiu".
 *
 * ─── A variação (±25%), e por que ela é do ATRASO INTEIRO ───────────────────
 *
 * A fórmula crua é determinística: dois turnos com o mesmo tamanho de texto
 * esperam os MESMOS milissegundos, e tempo idêntico é a assinatura de máquina
 * mais óbvia que existe — mais que o valor em si. `FATOR_ALEATORIO_*` multiplica
 * o atraso bruto ANTES do clamp, então nos extremos (piso/teto) a variação
 * desaparece: repetição no extremo é justamente onde ela não incomoda.
 *
 * O fator é INJETÁVEL de propósito (`EsperaHumanaArgs.fatorAleatorio`). Teste que
 * chama a produção com `Math.random` escondido é teste que pisca; quem testa
 * passa um fator fixo e o atraso volta a ser o número puro que a fórmula promete.
 *
 * ─── Onde ele NÃO entra ─────────────────────────────────────────────────────
 *
 * Este atraso é do TURNO, antes da PRIMEIRA bolha. O intervalo ENTRE bolhas
 * continua sendo o jitter anti-ban (1.2s + ≤800ms) que já existia — são coisas
 * diferentes com donos diferentes, e somá-las numa só apagaria o throttle que
 * protege o número de banimento.
 */
import type { Logger } from '../obs/logger';

/** Ver o cabeçalho: a parcela que não depende do tamanho do texto. */
export const ATRASO_NOTAR_MS = 900;

/** ≈45 caracteres/s — rápido de propósito; ver o cabeçalho. */
export const MS_POR_CARACTERE = 22;

/** Piso do throttle anti-ban do canal (CLAUDE.md). Abaixo dele o atraso não significa nada. */
export const ATRASO_MINIMO_MS = 1200;

/** Acima disto o silêncio lê como queda, não como digitação. */
export const ATRASO_MAXIMO_MS = 7500;

/** Piso do fator de variação — 25% mais rápido que a fórmula crua. */
export const FATOR_ALEATORIO_MIN = 0.75;

/** Teto do fator de variação — 25% mais lento que a fórmula crua. */
export const FATOR_ALEATORIO_MAX = 1.25;

/** Sorteia o fator de ±25%. Só existe para o chamador de produção; puro de relógio. */
export function sortearFator(): number {
  return FATOR_ALEATORIO_MIN + Math.random() * (FATOR_ALEATORIO_MAX - FATOR_ALEATORIO_MIN);
}

/**
 * Quanto esperar antes de mandar `texto`, em ms. Pura — é o que a torna
 * testável sem relógio e sem canal. `fator` é o multiplicador de aleatoriedade
 * (padrão `1` = determinístico); a produção o passa via `esperarComoHumano`,
 * que injeta `sortearFator()`.
 */
export function calcularAtrasoHumano(texto: string, fator: number = 1): number {
  const comprimento = (texto ?? '').trim().length;
  const bruto = (ATRASO_NOTAR_MS + MS_POR_CARACTERE * comprimento) * fator;
  return Math.min(ATRASO_MAXIMO_MS, Math.max(ATRASO_MINIMO_MS, Math.round(bruto)));
}

export interface EsperaHumanaArgs {
  /** O corpo que vai sair — é o tamanho DELE que dita a espera. */
  texto: string;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  /**
   * Acende o "digitando…" no aparelho do cliente. OPCIONAL: canal que não sabe
   * sinalizar presença simplesmente espera, e o ganho principal (não responder
   * instantaneamente) continua valendo.
   */
  sinalizarDigitando?: () => Promise<void>;
  /**
   * De onde sai o fator de aleatoriedade do atraso (±25% em produção). OPCIONAL
   * e INJETÁVEL: o teste passa `() => 1` e o atraso fica determinístico — sem
   * `Math.random` escondido, sem relógio.
   */
  fatorAleatorio?: () => number;
}

/**
 * Acende o "digitando…" e espera. Devolve os ms esperados.
 *
 * ⚠️ A PRESENÇA FALHA MACIO, E ISSO NÃO É NEGOCIÁVEL. "digitando…" é decoração;
 * a mensagem é o produto. Transporte fora do ar, sessão que não está saudável ou
 * canal que não implementa presença viram uma linha de log e o envio segue — deixar
 * uma chamada decorativa derrubar entrega seria trocar o produto pelo enfeite.
 *
 * A ordem também é o produto: sinalizar DEPOIS de esperar entregaria ao cliente
 * os segundos de silêncio sem a explicação visual que os torna naturais.
 */
export async function esperarComoHumano(args: EsperaHumanaArgs): Promise<number> {
  const ms = calcularAtrasoHumano(args.texto, (args.fatorAleatorio ?? sortearFator)());

  if (args.sinalizarDigitando !== undefined) {
    try {
      await args.sinalizarDigitando();
    } catch (err) {
      // Sem corpo de erro e sem texto da mensagem: `lib/logger.ts` proíbe
      // conteúdo de conversa no log, e a resposta do canal pode carregá-lo.
      args.log.warn('não consegui sinalizar "digitando" (segue o envio)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  await args.sleep(ms);
  return ms;
}
