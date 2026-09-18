/**
 * A ESPERA HUMANA SOBREPOSTA À CADEIA `before_send` — e por que as duas correm juntas.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Responder ao lead passa por duas etapas de naturezas opostas, e no turno elas
 * vivem em SÉRIE dentro do mesmo `send_message`:
 *
 *   1. a pausa humana (`esperarComoHumano`, 1,2–7,5 s) — DELIBERADA; existe para
 *      a resposta não sair colada no "✓✓" do lead (ver `atraso-humano.ts`);
 *   2. a cadeia de gates (`runBeforeSend`) — ~10 queries + o classificador
 *      semântico de promessa (~0,9 s). Trabalho de verdade, e independente da
 *      pausa: nenhum gate decide QUANTO esperar.
 *
 * Seriais, o bloco custa `pausa + gates`. Sobrepostas, custa `max(pausa, gates)`
 * — o mesmo que o lead percebe, menos o tempo em que os gates ocuparam a linha
 * enquanto a pausa já podia estar correndo.
 *
 * ─── A ORDEM: por que a pausa começa ANTES da cadeia ────────────────────────
 *
 * A pausa é dimensionada pelo TEXTO. No instante em que o modelo chama
 * `send_message` o corpo candidato já existe (`body`), então a pausa pode começar
 * no prelúdio do envio, em paralelo com os gates. Só a cadeia pode EMENDAR esse
 * corpo — hoje, um único gate o faz (`disclosureGate`, modo `inject`, e só
 * PREPENDANDO o disclosure; nenhum gate encurta). Por isso `aguardar` recebe o
 * texto FINAL e completa a diferença quando ele exige mais: a pausa nunca é
 * menor que a que o texto enviado pediria. No pior caso (texto final menor) ela
 * é a mesma de hoje; nunca encurta.
 *
 * ─── As três garantias ──────────────────────────────────────────────────────
 *
 *  1. UMA pausa por turno. `aguardar` é idempotente: o fail-safe de
 *     promessa/vocabulário re-roda a cadeia, e a 2ª passagem reusa a pausa já
 *     iniciada em vez de cobrar do lead uma segunda espera.
 *  2. NÃO pendura nem vaza. A pausa é uma promessa com `catch` próprio: se a
 *     cadeia VETAR, ninguém a aguarda e ela termina sozinha — sem unhandled
 *     rejection. Se o `sleep` lançar, quem aguarda vê o erro; quem não aguarda
 *     (o veto) não é afetado.
 *  3. O veto segue igual. Quem fala com o canal é o `runBeforeSend`, e só no ramo
 *     não-vetado — este módulo NUNCA chama o canal. A pausa "desperdiçada" de um
 *     veto é aceita: gate que veta é raro e nem chegou a falar com o lead.
 *
 * O `sleep` é o MESMO injetável do turno (`deps.sleep`), o que torna a
 * sobreposição testável com tempos falsos.
 */
import type { Logger } from '../obs/logger';
import { calcularAtrasoHumano, esperarComoHumano, sortearFator } from './atraso-humano';

export interface EsperaSobreposta {
  /**
   * Aguarda a pausa já iniciada e completa o que faltar para o texto FINAL.
   * Devolve os ms TOTAIS da pausa (a soma do que já correu com o top-up).
   * Idempotente: chamadas repetidas (re-run do fail-safe) devolvem a MESMA
   * promessa — nenhuma segunda espera é cobrada.
   */
  aguardar: (textoFinal: string) => Promise<number>;
}

export interface IniciarEsperaSobrepostaArgs {
  /** O corpo candidato (pré-cadeia) — dimensiona a pausa enquanto os gates rodam. */
  textoCandidato: string;
  /** O mesmo relógio injetável do turno — teste passa tempos falsos. */
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  sinalizarDigitando?: () => Promise<void>;
  /** Sorteado UMA vez; injetável para determinismo. */
  fatorAleatorio?: () => number;
}

/**
 * Inicia a pausa JÁ — antes da cadeia de gates. Quem chama é o dono do turno, no
 * prelúdio do `send_message`; a cadeia roda em paralelo e o envio só sai depois
 * que AMBAS terminam (a cadeia chama `aguardar` pelo `antesDaPrimeira`).
 */
export function iniciarEsperaSobreposta(args: IniciarEsperaSobrepostaArgs): EsperaSobreposta {
  // Um único fator para as duas pontas: o top-up precisa do MESMO número que
  // dimensionou a pausa inicial, senão o fim não corresponderia ao início.
  const fator = (args.fatorAleatorio ?? sortearFator)();
  let esperadoMs = calcularAtrasoHumano(args.textoCandidato, fator);

  // `esperarComoHumano` mantém a doutrina da presença: acende "digitando" ANTES
  // de dormir e falha MACIO se o canal não responder (decoração não derruba o
  // produto). O `catch` logo abaixo é o que impede uma rejeição de `sleep` de
  // virar unhandled rejection quando a cadeia veta e ninguém aguarda a pausa.
  const dormindo = esperarComoHumano({
    texto: args.textoCandidato,
    sleep: args.sleep,
    log: args.log,
    fatorAleatorio: () => fator,
    ...(args.sinalizarDigitando !== undefined
      ? { sinalizarDigitando: args.sinalizarDigitando }
      : {}),
  });
  dormindo.catch(() => undefined);

  let pendente: Promise<number> | null = null;

  return {
    aguardar: (textoFinal: string): Promise<number> => {
      if (pendente === null) {
        pendente = dormindo.then(async () => {
          const exigido = calcularAtrasoHumano(textoFinal, fator);
          // Só COMPLETA. Se o texto final exigir menos, a pausa já paga permanece:
          // encurtá-la seria mentir sobre o que o lead esperou.
          if (exigido > esperadoMs) {
            await args.sleep(exigido - esperadoMs);
            esperadoMs = exigido;
          }
          return esperadoMs;
        });
      }
      return pendente;
    },
  };
}
