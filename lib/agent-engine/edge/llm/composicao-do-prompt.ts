/**
 * A COMPOSIÇÃO DO PROMPT — o que cada bloco da chamada custa, e por que isto existe.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Medido em produção: a chamada principal do agente (`purpose='agent_turn'`)
 * registrou 107.128 tokens de entrada em `llm_calls`. A soma dos blocos
 * conhecidos — playbook (~180), skills (~3.300), memória (0), conhecimento (0),
 * ferramentas (~4.000) e o histórico (≤ `history_token_window` = 8.000) —
 * fechava em ~15.500. Os ~90 mil restantes não tinham explicação em lugar
 * nenhum, e otimizar sem medir é chute: já se otimizou o lugar errado uma vez
 * neste fork.
 *
 * ─── O que este módulo é ────────────────────────────────────────────────────
 *
 * Uma MEDIÇÃO de contagens e tamanhos. Antes da chamada: system (e suas partes —
 * playbook / memória / índice de skills / blocos residentes), definições de
 * ferramentas e mensagens (total, separando TEXTO × RESULTADO de ferramenta ×
 * CHAMADA de ferramenta). Depois da chamada: os tokens de entrada POR PASSO.
 *
 * POR QUE O "POR PASSO" É O PONTO: `result.usage.inputTokens` do AI SDK é
 * **AGREGADO entre os passos** do laço de tool-calls (`GenerateTextResult.usage`
 * — "Aggregated token usage across all steps", node_modules/ai/dist/index.d.ts,
 * tipo `GenerateTextResult`). Cada passo REENVIA o system + as tools + a fita
 * inteira de mensagens, acrescida dos resultados de ferramenta do passo
 * anterior. O número que o `llm_calls` guarda é a SOMA desses reenvios — não o
 * tamanho de um request. Medir o request inicial e a soma por passo é o que
 * separa "o prompt é gigante" de "o laço reenviou um prompt normal N vezes".
 *
 * ─── As três garantias (as mesmas da medição de tempo) ──────────────────────
 *
 *  1. NUNCA DERRUBA A CHAMADA. As funções são puras; o log passa por
 *     `logarComposicao`, que engole erro.
 *  2. NUNCA VAZA DADO. Saem só NÚMEROS (chars e tokens estimados) e nomes de
 *     bloco — nenhum conteúdo de conversa, nenhum segredo (ver `lib/logger.ts`).
 *  3. NUNCA ATRASA. Tudo é `length`/`JSON.stringify` de blocos que já existem;
 *     nenhum I/O novo.
 *
 * ─── Desligar ───────────────────────────────────────────────────────────────
 *
 * `LLM_PROMPT_COMPOSITION=false` desliga (via `LlmEdgeConfig.promptComposition`).
 * O padrão é LIGADO, pela mesma razão de `AGENT_TURN_TIMING`: uma medição opt-in
 * nasceria desligada exatamente no dia em que se precisa dela.
 */
import type { ModelMessage } from 'ai';

import type { Logger } from '../../obs/logger';

/**
 * Heurística conservadora de contagem, a MESMA de `get-lead-context.ts`:
 * ~3,5 chars/token para pt-br. Não é o tokenizer real — é uma régua única para
 * comparar blocos entre si, que é o que este diagnóstico pede.
 */
export const CHARS_POR_TOKEN = 3.5;

export interface BlocoMedido {
  chars: number;
  tokens_est: number;
}

export interface ComposicaoDeMensagens extends BlocoMedido {
  quantidade: number;
  texto_chars: number;
  resultado_de_ferramenta_chars: number;
  chamada_de_ferramenta_chars: number;
  outras_chars: number;
}

export interface ComposicaoDoPrompt {
  system: BlocoMedido & { partes: Record<string, BlocoMedido> };
  ferramentas: BlocoMedido & { quantidade: number };
  mensagens: ComposicaoDeMensagens;
  total: BlocoMedido;
}

export function estimarTokens(chars: number): number {
  return Math.ceil(chars / CHARS_POR_TOKEN);
}

export function medirTexto(texto: string): BlocoMedido {
  return { chars: texto.length, tokens_est: estimarTokens(texto.length) };
}

/** Uma parte de conteúdo (`ContentPart`) medida e classificada pela categoria. */
interface MedidaDeParte {
  texto: number;
  resultado: number;
  chamada: number;
  outras: number;
}

function medirParte(parte: unknown): MedidaDeParte {
  const vazio: MedidaDeParte = { texto: 0, resultado: 0, chamada: 0, outras: 0 };
  if (parte === null || typeof parte !== 'object') {
    // String solta dentro de um array de conteúdo — conta como texto.
    return { ...vazio, texto: typeof parte === 'string' ? parte.length : 0 };
  }
  const tipo = (parte as { type?: unknown }).type;
  if (tipo === 'text') {
    const texto = (parte as { text?: unknown }).text;
    return { ...vazio, texto: typeof texto === 'string' ? texto.length : 0 };
  }
  if (tipo === 'tool-result') {
    const output = (parte as { output?: unknown }).output;
    // O payload É o que infla o prompt; medir o envelope dá o mesmo número dele.
    return { ...vazio, resultado: JSON.stringify(output ?? parte).length };
  }
  if (tipo === 'tool-call') {
    const input = (parte as { input?: unknown }).input ?? (parte as { args?: unknown }).args;
    return { ...vazio, chamada: JSON.stringify(input ?? parte).length };
  }
  // reasoning, file/imagem, source, data… tudo o mais é "outras": não é texto
  // de conversa nem resultado de ferramenta, mas ocupa contexto.
  return { ...vazio, outras: JSON.stringify(parte).length };
}

/** Mede a fita de mensagens separando texto × resultado × chamada de ferramenta. */
export function medirMensagens(mensagens: readonly ModelMessage[]): ComposicaoDeMensagens {
  let texto = 0;
  let resultado = 0;
  let chamada = 0;
  let outras = 0;
  for (const mensagem of mensagens) {
    const conteudo = (mensagem as { content?: unknown }).content;
    if (typeof conteudo === 'string') {
      texto += conteudo.length;
      continue;
    }
    if (!Array.isArray(conteudo)) continue;
    for (const parte of conteudo) {
      const m = medirParte(parte);
      texto += m.texto;
      resultado += m.resultado;
      chamada += m.chamada;
      outras += m.outras;
    }
  }
  const chars = texto + resultado + chamada + outras;
  return {
    quantidade: mensagens.length,
    chars,
    tokens_est: estimarTokens(chars),
    texto_chars: texto,
    resultado_de_ferramenta_chars: resultado,
    chamada_de_ferramenta_chars: chamada,
    outras_chars: outras,
  };
}

/**
 * Composição completa do request inicial. PURA — recebe o system já montado, as
 * partes do system (opcionais; cada uma medida pelo nome), as ferramentas já
 * serializadas (`serializeStablePrefix`, a MESMA visão que o provider recebe) e
 * a fita de mensagens. Não toca em banco, rede nem relógio.
 */
export function medirComposicaoDoPrompt(input: {
  system: string | undefined;
  partesDoSystem?: Record<string, string>;
  ferramentas: { quantidade: number; serializado: string };
  mensagens: readonly ModelMessage[];
}): ComposicaoDoPrompt {
  const system = medirTexto(input.system ?? '');
  const partes: Record<string, BlocoMedido> = {};
  for (const [nome, texto] of Object.entries(input.partesDoSystem ?? {})) {
    partes[nome] = medirTexto(texto);
  }
  const ferramentas = {
    quantidade: input.ferramentas.quantidade,
    ...medirTexto(input.ferramentas.serializado),
  };
  const mensagens = medirMensagens(input.mensagens);
  const totalChars = system.chars + ferramentas.chars + mensagens.chars;
  return {
    system: { ...system, partes },
    ferramentas,
    mensagens,
    total: { chars: totalChars, tokens_est: estimarTokens(totalChars) },
  };
}

/** Um passo do laço — o subconjunto de `StepResult` de que a medição precisa. */
export interface PassoMedivel {
  usage?: { inputTokens?: number } | undefined;
  toolResults?: readonly unknown[] | undefined;
  toolCalls?: readonly unknown[] | undefined;
}

export interface ResumoDePassos {
  passos: number;
  input_tokens_por_passo: number[];
  input_tokens_soma: number;
  resultados_de_ferramenta_chars_por_passo: number[];
}

function charsDeLista(lista: readonly unknown[] | undefined): number {
  if (lista === undefined) return 0;
  let total = 0;
  for (const item of lista) total += JSON.stringify(item ?? null).length;
  return total;
}

/**
 * Resume os passos do `generateText`. `input_tokens_soma` é o número que o
 * `llm_calls` grava como `input_tokens`; `input_tokens_por_passo` é o que
 * revela que ele é a soma dos reenvios, e não um request só.
 */
export function medirPassos(passos: readonly PassoMedivel[]): ResumoDePassos {
  const inputPorPasso: number[] = [];
  const toolsPorPasso: number[] = [];
  for (const passo of passos) {
    inputPorPasso.push(passo.usage?.inputTokens ?? 0);
    toolsPorPasso.push(charsDeLista(passo.toolResults));
  }
  return {
    passos: passos.length,
    input_tokens_por_passo: inputPorPasso,
    input_tokens_soma: inputPorPasso.reduce((soma, n) => soma + n, 0),
    resultados_de_ferramenta_chars_por_passo: toolsPorPasso,
  };
}

/** Contexto de correlação do log — nunca conteúdo. */
export interface ContextoDaComposicao {
  organization_id: string;
  purpose: string;
}

/** Emite a linha da composição inicial. Engole erro: medir não derruba nada. */
export function logarComposicaoInicial(
  log: Logger,
  composicao: ComposicaoDoPrompt,
  contexto: ContextoDaComposicao,
): void {
  try {
    log.info('llm: composição do prompt (request inicial)', {
      ...contexto,
      system_chars: composicao.system.chars,
      system_tokens_est: composicao.system.tokens_est,
      system_partes: composicao.system.partes,
      ferramentas_quantidade: composicao.ferramentas.quantidade,
      ferramentas_chars: composicao.ferramentas.chars,
      ferramentas_tokens_est: composicao.ferramentas.tokens_est,
      mensagens_quantidade: composicao.mensagens.quantidade,
      mensagens_chars: composicao.mensagens.chars,
      mensagens_tokens_est: composicao.mensagens.tokens_est,
      mensagens_texto_chars: composicao.mensagens.texto_chars,
      mensagens_resultado_de_ferramenta_chars: composicao.mensagens.resultado_de_ferramenta_chars,
      mensagens_chamada_de_ferramenta_chars: composicao.mensagens.chamada_de_ferramenta_chars,
      mensagens_outras_chars: composicao.mensagens.outras_chars,
      total_chars: composicao.total.chars,
      total_tokens_est: composicao.total.tokens_est,
    });
  } catch {
    // Log que lança é o fim da linha — engolir aqui é a diferença entre perder
    // uma linha de diagnóstico e perder a chamada que ela veio medir.
  }
}

/**
 * Emite a linha dos passos. O campo `fator_reenvio` (soma ÷ estimativa do
 * request inicial) é o veredito: ~1 significa "o prompt é o tamanho que se
 * mediu"; ≫ 1 significa "o laço reenviou o prompt N vezes, com os resultados de
 * ferramenta engordando a fita a cada passo".
 */
export function logarPassos(
  log: Logger,
  resumo: ResumoDePassos,
  contexto: ContextoDaComposicao & { input_tokens_inicial_est: number },
): void {
  try {
    const fator =
      contexto.input_tokens_inicial_est > 0
        ? Number((resumo.input_tokens_soma / contexto.input_tokens_inicial_est).toFixed(2))
        : null;
    log.info('llm: tokens de entrada por passo', {
      organization_id: contexto.organization_id,
      purpose: contexto.purpose,
      passos: resumo.passos,
      input_tokens_por_passo: resumo.input_tokens_por_passo,
      input_tokens_soma: resumo.input_tokens_soma,
      input_tokens_inicial_est: contexto.input_tokens_inicial_est,
      fator_reenvio: fator,
      resultados_de_ferramenta_chars_por_passo: resumo.resultados_de_ferramenta_chars_por_passo,
    });
  } catch {
    // idem: diagnóstico nunca derruba a chamada.
  }
}
