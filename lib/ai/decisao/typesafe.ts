/**
 * O CLIENTE HTTP DO SYSTEM ONE (TypeSafe / Jev) — a chamada do provedor de DECISÃO.
 *
 * ─── Por que isto NÃO mora junto dos provedores de conversa ───────────────────
 *
 * `lib/agent-engine/edge/llm/providers.ts` implementa `LanguageModel` do AI SDK:
 * recebe um prompt e devolve TEXTO. O Jev não é um LLM de conversa — ele não gera
 * texto nem usa ferramentas; ele devolve JULGAMENTO TIPADO (escolha +
 * probabilidade + confiança), que é consumido diretamente por código. Forçá-lo na
 * prateleira de conversa quebraria a interface (o SDK esperaria `LanguageModel` e
 * receberia um objeto sem `doGenerate`).
 *
 * Por isso a prateleira paralela (`lib/ai/pontos/provedores-de-decisao.ts`) e este
 * cliente: a mesma separação que o dono do produto pediu — "IAs como a JEV
 * começarão a surgir, tem que ter opção do usuário escolher o provedor".
 *
 * ─── Contrato (medido na doc oficial, https://docs.typesafe.ai/api) ───────────
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <chave>
 *   { state, model: "jev-latest", questions: { <id>: { type, instructions, criteria } } }
 *   → { model, answers: { <id>: { type, ... } }, usage: { input_tokens, output_tokens } }
 *
 * `state` é texto ou objeto (a conversa). Entrada é SÓ TEXTO: sem imagem nem
 * áudio, contexto de 64k tokens por request. Erros 429/529 pedem backoff
 * exponencial. A chave nunca é logada nem incluída em erro — só cruza a
 * fronteira no header.
 */
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** `jev-latest` resolve no provedor para a versão mais recente (ex.: `jev-1.13.0`). */
export const TYPESAFE_MODELO_PADRAO = "jev-latest";

const TIMEOUT_PADRAO_MS = 8_000;
const TENTATIVAS_PADRAO = 3;
const BACKOFF_BASE_MS = 500;

/** Uma instrução de pergunta. A API aceita string, objeto ou array. */
export type InstrucaoTypeSafe = string | Record<string, unknown> | unknown[];

export interface PerguntaNoul {
  type: "noul";
  instructions: InstrucaoTypeSafe;
  criteria?: { true?: InstrucaoTypeSafe; false?: InstrucaoTypeSafe };
}
export interface PerguntaChoice {
  type: "choice";
  instructions: InstrucaoTypeSafe;
  criteria: Record<string, InstrucaoTypeSafe | null>;
}
export interface PerguntaScore {
  type: "score";
  instructions: InstrucaoTypeSafe;
  criteria: InstrucaoTypeSafe[];
}
export type PerguntaTypeSafe = PerguntaNoul | PerguntaChoice | PerguntaScore;

export interface RespostaNoul {
  type: "noul";
  noul: number;
}
export interface RespostaChoice {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface RespostaScore {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type RespostaTypeSafe = RespostaNoul | RespostaChoice | RespostaScore;

export interface ResultadoSystemOne {
  model: string;
  answers: Record<string, RespostaTypeSafe>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Provedor recusou por indisponibilidade (429/529/timeout) — o chamador degrada. */
export class TypeSafeIndisponivelError extends Error {
  override readonly name = "typesafe_indisponivel";
}
/** Resposta fora do contrato (status 4xx/5xx não-retentável, ou corpo inválido). */
export class TypeSafeRespostaInvalidaError extends Error {
  override readonly name = "typesafe_resposta_invalida";
}

export interface EntradaDaClassificacao {
  apiKey: string;
  /** A conversa (texto ou objeto). NUNCA é logado. */
  state: unknown;
  questions: Record<string, PerguntaTypeSafe>;
  model?: string;
  /** Seam de rede — os testes injetam um `fetch` fake; produção usa o global. */
  fetchImpl?: typeof fetch;
  /** Seam de espera — os testes injetam para não dormir de verdade. */
  sleep?: (ms: number) => Promise<void>;
  maxTentativas?: number;
  timeoutMs?: number;
}

function dormirPadrao(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Roda UMA rodada de perguntas contra o System One e devolve as respostas tipadas.
 *
 * Retenta SÓ 429/529 (e falhas de rede/timeout), com backoff exponencial — é o
 * que a doc manda. Erro de credencial (401/403) ou de corpo (422) NÃO é
 * retentado: repetir não conserta configuração. `sleep`/`fetchImpl` são seams
 * para teste; produção usa setTimeout e o fetch global.
 */
export async function classificarComTypeSafe(
  input: EntradaDaClassificacao,
): Promise<ResultadoSystemOne> {
  const doFetch = input.fetchImpl ?? fetch;
  const dormir = input.sleep ?? dormirPadrao;
  const tentativas = input.maxTentativas ?? TENTATIVAS_PADRAO;
  const timeoutMs = input.timeoutMs ?? TIMEOUT_PADRAO_MS;
  const corpo = JSON.stringify({
    state: input.state,
    model: input.model ?? TYPESAFE_MODELO_PADRAO,
    questions: input.questions,
  });

  let ultimoErro: Error | null = null;
  for (let tentativa = 0; tentativa < tentativas; tentativa += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(TYPESAFE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`,
        },
        body: corpo,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status === 529) {
        ultimoErro = new TypeSafeIndisponivelError(`typesafe_${res.status}`);
      } else if (!res.ok) {
        throw new TypeSafeRespostaInvalidaError(`typesafe_status_${res.status}`);
      } else {
        return validarResultado(await res.json());
      }
    } catch (err) {
      // Erro de contrato não se resolve tentando de novo.
      if (err instanceof TypeSafeRespostaInvalidaError) throw err;
      ultimoErro = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
    if (tentativa < tentativas - 1) await dormir(BACKOFF_BASE_MS * 2 ** tentativa);
  }
  throw ultimoErro ?? new TypeSafeIndisponivelError("typesafe_indisponivel");
}

/** Valida o contorno mínimo do corpo e devolve o resultado tipado. */
export function validarResultado(json: unknown): ResultadoSystemOne {
  if (json === null || typeof json !== "object") {
    throw new TypeSafeRespostaInvalidaError("typesafe_corpo_nao_objeto");
  }
  const obj = json as Record<string, unknown>;
  const answers = obj.answers;
  if (answers === null || typeof answers !== "object") {
    throw new TypeSafeRespostaInvalidaError("typesafe_sem_answers");
  }
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  return {
    model: typeof obj.model === "string" ? obj.model : "",
    answers: answers as Record<string, RespostaTypeSafe>,
    usage: {
      input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  };
}

/* ─────────────── interpretação tipada (pura, sem rede) ─────────────── */

/** Probabilidade de "sim" de uma resposta Noul — `null` se não for Noul. */
export function lerNoul(resposta: RespostaTypeSafe | undefined): number | null {
  if (resposta === undefined || resposta.type !== "noul") return null;
  return typeof resposta.noul === "number" ? resposta.noul : null;
}

/** Escolha + confiança de uma resposta Choice — `null` se não for Choice. */
export function lerChoice(
  resposta: RespostaTypeSafe | undefined,
): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  if (resposta === undefined || resposta.type !== "choice") return null;
  if (typeof resposta.choice !== "string") return null;
  return {
    choice: resposta.choice,
    confidence: typeof resposta.confidence === "number" ? resposta.confidence : 0,
    probabilities: resposta.probabilities ?? {},
  };
}

/** Nota + confiança de uma resposta Score — `null` se não for Score. */
export function lerScore(
  resposta: RespostaTypeSafe | undefined,
): { score: number; confidence: number } | null {
  if (resposta === undefined || resposta.type !== "score") return null;
  return {
    score: typeof resposta.score === "number" ? resposta.score : 0,
    confidence: typeof resposta.confidence === "number" ? resposta.confidence : 0,
  };
}

/**
 * Valida a chave de um provedor de decisão. Espelha o contrato de
 * `lib/ai/provider-validators.ts`: 401/403 vira `auth_failed_401`, o resto vira
 * `provider_status_<n>` ou `network_error`. Não há `/models` no provedor, então a
 * prova é uma chamada de verdade com uma pergunta trivial (`noul`).
 */
export async function validarChaveTypeSafe(
  apiKey: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        state: "ok",
        model: TYPESAFE_MODELO_PADRAO,
        questions: {
          valida: { type: "noul", instructions: "Is this a valid request?" },
        },
      }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "auth_failed_401" };
    if (!res.ok) return { ok: false, error: `provider_status_${res.status}` };
    return { ok: true, models: [TYPESAFE_MODELO_PADRAO] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
