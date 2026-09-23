/**
 * QUALIFICAÇÃO DO LEAD COM A TYPESAFE (JEV) — a decisão que move o funil na hora.
 *
 * ─── O que este módulo faz ────────────────────────────────────────────────────
 *
 * A cada turno, manda a conversa para um provedor de DECISÃO (o Jev, da TypeSafe)
 * e recebe um julgamento tipado sobre cinco dimensões: a etapa do funil, se o
 * lead decide a compra, a urgência, se há necessidade e o quão pronto para
 * comprar ele está. Com o resultado, MOVE a etapa do negócio na hora (decisão
 * explícita do dono: "se confiamos no modelo para responder ao lead, confiamos
 * para classificar"), grava a decisão como atividade auditável e nos campos do
 * lead.
 *
 * ─── Onde ele se pluga, e por que degrada em silêncio ────────────────────────
 *
 * O turno já roda o classificador de etapa (`stage-classifier.ts`). Este módulo
 * roda ANTES dele: quando a qualificação está ligada e o provedor responde, a
 * etapa já foi decidida e o classificador antigo não precisa rodar. Quando
 * QUALQUER coisa dá errado — o ponto está desligado (por organização ou pelo
 * kill switch global), não há credencial, o provedor devolve 429/529, estoura o
 * timeout ou a resposta é indefinida — este módulo devolve `usado: false` e o
 * classificador ATUAL assume. A funcionalidade não desaparece; o turno nunca
 * quebra por causa de um provedor de decisão.
 *
 * ─── Invariantes ─────────────────────────────────────────────────────────────
 *
 *   - Desligado (org ou global) ⇒ `usado:false` ⇒ comportamento idêntico ao de hoje.
 *   - Falha do provedor ⇒ `usado:false` ⇒ o turno segue pelo classificador atual.
 *   - Nunca loga conteúdo de conversa nem chave: só nomes de etapa, ids e
 *     contadores. A conversa (`state`) só cruza a fronteira no corpo do request.
 *   - A etapa só muda para etapas que o funil DAQUELA organização mapeia
 *     (`sincronizaEstagioDoAgente` + `crm_stages.agent_stage_hint`) — nunca uma
 *     etapa inventada.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "../obs/logger";
import type { LeadContext } from "../edge/crm/get-lead-context";
import { carregarBinding } from "../edge/llm/binding-do-ponto";
import {
  applyLeadStateUpdate,
  LEAD_STAGE_TRANSITIONS,
  LEAD_STAGES,
  type LeadStage,
} from "./lead-state";
import type { LinhaDeBinding } from "@/lib/ai/pontos/resolver";
import { PROVEDOR_DE_DECISAO_POR_ID } from "@/lib/ai/pontos/provedores-de-decisao";
import {
  classificarComTypeSafe,
  lerChoice,
  lerNoul,
  lerScore,
  type PerguntaTypeSafe,
  type RespostaTypeSafe,
} from "@/lib/ai/decisao/typesafe";
import { resolverChaveDoProvedorDeDecisao } from "@/lib/ai/decisao/credencial-de-plataforma";
import { regressaoDeFunilAtivada } from "@/lib/schemas/settings";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { sincronizaEstagioDoAgente, razaoDaMudancaPeloAgente } from "@/lib/leads/agent-stage-sync";

/** O `purpose` do ponto no registro de IA — a ponte com `ai_purpose_bindings`. */
export const PONTO_QUALIFICACAO = "qualificacao_do_lead";

/** Confiança mínima da Choice de etapa para agir — abaixo disso é indefinido. */
export const LIMIAR_CONFIANCA_ETAPA = 0.34;
/**
 * Regra quantitativa do dono (o caso medido: `pronto_pra_compra = 0,83`): quando o
 * modelo dá ≥ 0,8 de "pronto para comprar", a etapa sobe ao menos a `qualified`,
 * mesmo que a Choice de etapa tenha ficado antes.
 */
export const LIMIAR_PRONTO_PRA_COMPRA = 0.8;

/** As cinco dimensões qualificadas, como ficam gravadas no campo do lead. */
export interface DimensoesDaQualificacao {
  etapa: string | null;
  etapa_confianca: number | null;
  decide_a_compra: number | null;
  urgencia: number | null;
  tem_necessidade: number | null;
  pronto_pra_compra: number | null;
}

/** As perguntas enviadas ao provedor de decisão — uma rodada, cinco dimensões. */
export function perguntasDaQualificacao(): Record<string, PerguntaTypeSafe> {
  return {
    etapa: {
      type: "choice",
      instructions:
        "Em que etapa do funil de vendas esta conversa está AGORA, considerando o que o cliente já revelou?",
      criteria: {
        new: "Lead recém-chegado, ainda sem diálogo real (só um primeiro oi ou pergunta genérica).",
        contacted:
          "Já houve troca inicial e rapport, mas o cliente ainda não revelou necessidade ou dor concreta.",
        qualifying:
          "O cliente está revelando necessidade, contexto, dores ou tamanho da operação (descoberta em curso).",
        qualified:
          "Orçamento, poder de decisão, necessidade e prazo já confirmados — pronto para proposta.",
        negotiating:
          "Há proposta, preço ou condições na mesa e o cliente discute valor, desconto ou parcelamento.",
        won: "O cliente fechou ou aceitou explicitamente (vai assinar, pagar ou emitir nota).",
        lost: "O cliente recusou, desistiu ou pediu para parar de ser contatado.",
      },
    },
    decide_a_compra: {
      type: "noul",
      instructions: "Esta pessoa é quem decide a compra?",
      criteria: {
        true: "É o decisor, ou disse que a decisão é dele/dela.",
        false: "Depende de outra pessoa, ou não há sinal de que decide.",
      },
    },
    urgencia: {
      type: "score",
      instructions: "Qual é a urgência do cliente em resolver isso?",
      criteria: [
        "Sem urgência declarada.",
        "Algum dia, quando fizer sentido.",
        "Nos próximos meses.",
        "Nas próximas semanas.",
        "Esta semana ou imediatamente.",
      ],
    },
    tem_necessidade: {
      type: "noul",
      instructions: "O cliente já expressou uma necessidade ou dor concreta que o produto resolve?",
      criteria: {
        true: "Descreveu um problema ou objetivo concreto.",
        false: "Só perguntou de forma genérica, sem necessidade revelada.",
      },
    },
    pronto_pra_compra: {
      type: "noul",
      instructions: "O cliente está pronto para comprar agora, faltando apenas o fechamento?",
      criteria: {
        true: "Pediu preço/condições, escolheu plano, ou sinaliza decisão iminente.",
        false: "Ainda avalia, compara ou não demonstra intenção de fechar.",
      },
    },
  };
}

/** Extrai as cinco dimensões tipadas das respostas. Pura. */
export function montarDimensoes(
  respostas: Record<string, RespostaTypeSafe>,
): DimensoesDaQualificacao {
  const etapa = lerChoice(respostas.etapa);
  return {
    etapa: etapa?.choice ?? null,
    etapa_confianca: etapa?.confidence ?? null,
    decide_a_compra: lerNoul(respostas.decide_a_compra),
    urgencia: lerScore(respostas.urgencia)?.score ?? null,
    tem_necessidade: lerNoul(respostas.tem_necessidade),
    pronto_pra_compra: lerNoul(respostas.pronto_pra_compra),
  };
}

function ehEtapa(valor: string): valor is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(valor);
}

function indiceDeEtapa(etapa: LeadStage): number {
  return LEAD_STAGES.indexOf(etapa);
}

export type DecisaoDeEtapa = { etapa: LeadStage } | { indefinido: true; porque: string };

/**
 * A REGRA probabilidade → etapa. Pura e testável.
 *
 * 1. A Choice `etapa` é o julgamento holístico do modelo; precisa ser uma das 7
 *    etapas conhecidas e ter confiança ≥ `LIMIAR_CONFIANCA_ETAPA`.
 * 2. Regra quantitativa: `pronto_pra_compra ≥ 0,8` eleva o alvo ao menos a
 *    `qualified` (o caso medido com o dono do produto).
 * 3. Regressão NÃO é decidida aqui — `proximoPassoValido` só anda para frente, e
 *    a máquina de estados (F2-10) recusa saltos. Uma etapa atrás do atual vira
 *    `proximoPassoValido = null` e nada é movido.
 */
export function decidirEtapa(
  respostas: Record<string, RespostaTypeSafe>,
  _atual: LeadStage,
): DecisaoDeEtapa {
  const choice = lerChoice(respostas.etapa);
  if (choice === null) return { indefinido: true, porque: "sem_choice_de_etapa" };
  if (!ehEtapa(choice.choice)) return { indefinido: true, porque: "etapa_desconhecida" };
  if (choice.confidence < LIMIAR_CONFIANCA_ETAPA) {
    return { indefinido: true, porque: "confianca_baixa" };
  }

  let alvo: LeadStage = choice.choice;
  const pronto = lerNoul(respostas.pronto_pra_compra);
  if (pronto !== null && pronto >= LIMIAR_PRONTO_PRA_COMPRA) {
    if (indiceDeEtapa(alvo) < indiceDeEtapa("qualified")) alvo = "qualified";
  }
  return { etapa: alvo };
}

/**
 * O próximo passo VÁLIDO de `atual` em direção a `alvo`, andando só para frente
 * pelo grafo de `LEAD_STAGE_TRANSITIONS` (BFS). Devolve o PRIMEIRO passo do
 * caminho — nunca um salto. `null` quando não há caminho (regressão, terminal,
 * ou alvo igual ao atual).
 */
export function proximoPassoValido(atual: LeadStage, alvo: LeadStage): LeadStage | null {
  if (atual === alvo) return null;
  const visitados = new Set<LeadStage>([atual]);
  const fila: Array<{ no: LeadStage; primeiro: LeadStage | null }> = [{ no: atual, primeiro: null }];
  while (fila.length > 0) {
    const { no, primeiro } = fila.shift()!;
    for (const prox of LEAD_STAGE_TRANSITIONS[no]) {
      if (visitados.has(prox)) continue;
      const passoInicial = primeiro ?? prox;
      if (prox === alvo) return passoInicial;
      visitados.add(prox);
      fila.push({ no: prox, primeiro: passoInicial });
    }
  }
  return null;
}

/**
 * O passo VÁLIDO para TRÁS, um por vez (BFS no grafo INVERSO). Devolve o
 * PRIMEIRO passo do caminho de volta — nunca um salto, exatamente como
 * `proximoPassoValido` faz para frente.
 *
 * ── Quando isto roda ────────────────────────────────────────────────────────
 *
 * Só quando o admin da organização LIGOU a regressão de funil
 * (`organizations.settings.crm.regressao_de_funil_ativada`, default false). Com
 * a regressão desligada este caminho nem é chamado e o comportamento é idêntico
 * ao de hoje: o classificador de etapa assume e o card não anda para trás.
 *
 * ── O que "válido" quer dizer ───────────────────────────────────────────────
 *
 * Um passo para trás é válido quando a ida correspondente é válida em
 * `LEAD_STAGE_TRANSITIONS` — andar de `qualified` para `qualifying` vale porque
 * `qualifying → qualified` é uma transição de avanço. Não é "pular para
 * qualquer lugar": um alvo que não é ancestral de `atual` devolve `null` e nada
 * é movido.
 */
export function passoRegressivoValido(atual: LeadStage, alvo: LeadStage): LeadStage | null {
  if (atual === alvo) return null;
  // Predecessores de um estágio: quem tem esse estágio como avanço válido.
  const predecessores = (no: LeadStage): readonly LeadStage[] =>
    LEAD_STAGES.filter((p) => LEAD_STAGE_TRANSITIONS[p].includes(no));
  const visitados = new Set<LeadStage>([atual]);
  const fila: Array<{ no: LeadStage; primeiro: LeadStage | null }> = [{ no: atual, primeiro: null }];
  while (fila.length > 0) {
    const { no, primeiro } = fila.shift()!;
    for (const anterior of predecessores(no)) {
      if (visitados.has(anterior)) continue;
      const passoInicial = primeiro ?? anterior;
      if (anterior === alvo) return passoInicial;
      visitados.add(anterior);
      fila.push({ no: anterior, primeiro: passoInicial });
    }
  }
  return null;
}

/**
 * A escolha do passo, com a regressão no lugar certo. Pura e testável.
 *
 * 1. Anda para FRENTE sempre que houver caminho (`proximoPassoValido`).
 * 2. Sem caminho e com a regressão DESLIGADA (default) ⇒ `null`: nada é movido,
 *    idêntico ao comportamento de hoje.
 * 3. Sem caminho e com a regressão LIGADA ⇒ o primeiro passo válido para trás
 *    (`passoRegressivoValido`), ou `null` se o alvo não é ancestral.
 *
 * `regressao` sai junto porque a máquina de estados só aceita a volta quando ela
 * é pedida EXPLICITAMENTE — o avanço continua passando sem flag.
 */
export function escolherPasso(
  atual: LeadStage,
  alvo: LeadStage,
  permitirRegressao: boolean,
): { passo: LeadStage | null; regressao: boolean } {
  const paraFrente = proximoPassoValido(atual, alvo);
  if (paraFrente !== null) return { passo: paraFrente, regressao: false };
  if (!permitirRegressao) return { passo: null, regressao: false };
  return { passo: passoRegressivoValido(atual, alvo), regressao: true };
}

/**
 * O kill switch GLOBAL do superadmin vive em `platform_settings.qualificacao_jev_ativa`
 * (singleton id=1, server-side only — o mesmo mecanismo de `signup_mode`). A
 * ausência da linha ou da coluna vale o DEFAULT do produto (ligado): desligar é
 * ato explícito. O interruptor POR ORGANIZAÇÃO é o binding habilitado
 * (`ai_purpose_bindings` com `purpose='qualificacao_do_lead'` e `is_enabled`).
 */
export async function lerInterruptorGlobal(db: pg.Pool): Promise<boolean> {
  try {
    const { rows } = await db.query<{ ativa: boolean | null }>(
      "select coalesce((select qualificacao_jev_ativa from platform_settings where id = 1), true) as ativa",
    );
    return rows[0]?.ativa !== false;
  } catch {
    // Clone que ainda não aplicou a migration: sem coluna, vale o default.
    return true;
  }
}

/* ────────────────────────── interruptores ────────────────────────── */

/**
 * NÍVEL 2 (o superadmin libera a feature por organização). Lê
 * `organizations.qualificacao_jev_ativa` (migration 0267).
 *
 * Default `false` e ausência da coluna valem DESLIGADO: ninguém ganha a
 * funcionalidade sem que o superadmin a libere. É o oposto do kill switch global
 * (que nasce ligado) de propósito — lá o default protege a operação, aqui
 * protege quem nunca pediu a feature de a ver aparecendo sozinha.
 */
export async function lerHabilitacaoDaOrganizacao(
  db: pg.Pool,
  organizationId: string,
): Promise<boolean> {
  try {
    const { rows } = await db.query<{ ativa: boolean | null }>(
      "select qualificacao_jev_ativa from organizations where id = $1",
      [organizationId],
    );
    return rows[0]?.ativa === true;
  } catch {
    // Clone que ainda não aplicou a 0267: sem coluna, desligado.
    return false;
  }
}

/**
 * A regressão de funil está ligada nesta organização?
 * `organizations.settings.crm.regressao_de_funil_ativada` — default false.
 * Nunca lança: leitura que falha vale desligado (não regride).
 */
export async function lerRegressaoDeFunilDaOrganizacao(
  db: pg.Pool,
  organizationId: string,
): Promise<boolean> {
  try {
    const { rows } = await db.query<{ settings: unknown }>(
      "select settings from organizations where id = $1",
      [organizationId],
    );
    return regressaoDeFunilAtivada(rows[0]?.settings);
  } catch {
    return false;
  }
}

/**
 * A chave do provedor de decisão pela ESCADA da plataforma: cofre da instalação
 * (`platform_decision_credentials`, 0267) → ambiente (`TYPESAFE_API_KEY`).
 *
 * Substitui a leitura BYOK de `ai_provider_credentials`: por decisão do dono, a
 * chave agora é da INSTALAÇÃO e é cadastrada UMA vez pelo superadmin.
 */
export async function lerCredencialDaPlataforma(
  db: pg.Pool,
  provider: string,
): Promise<string | null> {
  return resolverChaveDoProvedorDeDecisao(db, provider);
}

/** Grava a execução do provedor de decisão em `llm_calls` (o `registraEm` do ponto). */
async function registrarChamada(d: {
  db: pg.Pool;
  organizationId: string;
  contactId: string;
  jobId?: string | null;
  agentId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}): Promise<string | null> {
  try {
    const { rows } = await d.db.query<{ id: string }>(
      `insert into llm_calls
         (organization_id, contact_id, job_id, purpose, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents,
          latency_ms, status, origem_da_escolha, agent_id)
       values ($1, $2, $3, 'qualificacao_do_lead', $4, $5, $6, $7, 0, 0, null,
               $8, 'ok', 'binding', $9)
       returning id`,
      [
        d.organizationId,
        d.contactId,
        d.jobId ?? null,
        d.provider,
        d.model,
        d.inputTokens,
        d.outputTokens,
        d.latencyMs,
        d.agentId ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch {
    // Telemetria não pode derrubar a decisão que ela descreve.
    return null;
  }
}

/* ────────────────────────── aplicação ────────────────────────── */

export interface AplicacaoArgs {
  pool: pg.Pool;
  admin: SupabaseClient;
  organizationId: string;
  contactId: string;
  jobId?: string | null;
  agentId?: string | null;
  currentStage: LeadStage;
  alvo: LeadStage;
  dimensoes: DimensoesDaQualificacao;
  llmCallId: string | null;
  log: Logger;
  /**
   * O admin da organização ligou a regressão de funil? Default `false` — o
   * comportamento de hoje (só avança). Ligado, o alvo atrás do atual vira UM
   * passo para trás válido.
   */
  permitirRegressao?: boolean;
}

export type ResultadoDaAplicacao = {
  movido: boolean;
  motivo: "movido" | "sem_mudanca" | "sem_negocio" | "transicao_invalida";
  leadId?: string;
  passo?: LeadStage;
  detalhe?: string;
};

/** Grava as dimensões no campo do lead (`crm_leads.custom_fields.qualificacao_jev`). */
async function gravarDimensoes(
  pool: pg.Pool,
  organizationId: string,
  leadId: string,
  dimensoes: DimensoesDaQualificacao,
): Promise<void> {
  await pool.query(
    `update crm_leads
        set custom_fields = coalesce(custom_fields, '{}'::jsonb) || $3::jsonb
      where organization_id = $1 and id = $2`,
    [organizationId, leadId, JSON.stringify({ qualificacao_jev: dimensoes })],
  );
}

/** A linha da timeline: a decisão virou atividade auditável, com lastro em `llm_calls`. */
async function gravarAtividade(d: {
  pool: pg.Pool;
  organizationId: string;
  contactId: string;
  leadId: string;
  agentId?: string | null;
  llmCallId: string | null;
  etapa: LeadStage;
  dimensoes: DimensoesDaQualificacao;
  razão: string;
}): Promise<void> {
  const row = buildLeadActivityRow({
    organizationId: d.organizationId,
    leadId: d.leadId,
    contactId: d.contactId,
    type: "stage_changed",
    sourceModule: "agent_qualification",
    sourceId: d.llmCallId,
    actor: {
      type: "ai_agent",
      id: d.agentId ?? "agent-engine",
      role: "agent",
      ...(d.agentId ? { agent_id: d.agentId } : {}),
    },
    reason: d.razão,
    evidence: d.llmCallId ? { llm_call_ids: [d.llmCallId] } : null,
    payload: {
      origem: "qualificacao_jev",
      etapa: d.etapa,
      dimensoes: d.dimensoes,
    },
  });
  await d.pool.query(
    `insert into crm_lead_activities
       (organization_id, lead_id, contact_id, type, source_module, source_id,
        actor_kind, actor_agent_id, performed_by_user_id, reason, evidence, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.organization_id,
      row.lead_id,
      row.contact_id,
      row.type,
      row.source_module,
      row.source_id,
      row.actor_kind,
      row.actor_agent_id,
      row.performed_by_user_id,
      row.reason,
      row.evidence ? JSON.stringify(row.evidence) : null,
      JSON.stringify(row.payload),
    ],
  );
}

/**
 * A aplicação PADRÃO: resolve o negócio do contato, grava a dimensão nos campos,
 * avança `lead_state` pela máquina (F2-10) um passo por vez, espelha a etapa no
 * funil do tenant e registra a atividade. Injetável para teste.
 */
export async function aplicarQualificacaoPadrao(
  args: AplicacaoArgs,
): Promise<ResultadoDaAplicacao> {
  const { pool, organizationId, contactId, jobId, currentStage, alvo, dimensoes, log } = args;

  const { rows } = await pool.query<LeadCandidate>(
    `select l.id, l.organization_id, l.pipeline_id, l.status,
            l.last_activity_at, l.created_at
       from crm_leads l
      where l.organization_id = $1 and l.contact_id = $2`,
    [organizationId, contactId],
  );
  const { rows: defaults } = await pool.query<{ id: string }>(
    `select id from crm_pipelines
      where organization_id = $1 and is_default = true and is_archived = false
      limit 1`,
    [organizationId],
  );
  const rota = resolveActiveLeadForContact(rows, {
    defaultPipelineId: defaults[0]?.id ?? null,
  });
  if (!rota.routed) return { movido: false, motivo: "sem_negocio" };
  const leadId = rota.leadId;

  // A dimensão é gravada SEMPRE que a decisão foi usada — é o registro que
  // sobrevive mesmo quando não há avanço de etapa.
  try {
    await gravarDimensoes(pool, organizationId, leadId, dimensoes);
  } catch (err) {
    log.warn("qualificação JEV: não gravei as dimensões no lead", {
      lead_id: leadId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }

  // O caminho de ida tem prioridade. Sem ele, e com a regressão LIGADA, o alvo
  // atrás do atual vira UM passo válido para trás (BFS no grafo inverso). Com a
  // regressão desligada (default), `passo` continua `null` e nada é movido —
  // exatamente o comportamento de hoje.
  const { passo, regressao } = escolherPasso(currentStage, alvo, args.permitirRegressao === true);
  if (passo === null) return { movido: false, motivo: "transicao_invalida", leadId };

  const transicao = await applyLeadStateUpdate(
    pool,
    { tenantId: organizationId, leadId: contactId, jobId },
    { stage: passo, reason: `qualificação automática (JEV): ${currentStage} → ${passo}` },
    // A máquina de estados só aceita regressão quando ela foi pedida EXPLICITAMENTE
    // aqui. O avanço continua sendo aceito sem flag — o caminho do modelo
    // (`update_lead_state`) não passa por este parâmetro e segue inalterado.
    regressao ? { permitirRegressao: true } : {},
  );
  if (!transicao.ok) {
    log.warn("qualificação JEV: a máquina de estados recusou o avanço", {
      lead_id: leadId,
      de: currentStage,
      para: passo,
      code: transicao.error.code,
    });
    return { movido: false, motivo: "transicao_invalida", leadId, detalhe: transicao.error.code };
  }

  // O espelho no funil do tenant é o passo que valida a etapa contra o banco
  // (`crm_stages.agent_stage_hint`). Ele não precisar ter para onde ir NÃO
  // desfaz o avanço de `lead_state`, que é a fonte da verdade do harness.
  let stageName: string | undefined;
  try {
    const card = await sincronizaEstagioDoAgente(args.admin, {
      organizationId,
      contactId,
      passo,
    });
    stageName = card.stageName;
  } catch (err) {
    log.warn("qualificação JEV: o espelho no funil do tenant falhou", {
      lead_id: leadId,
      de: currentStage,
      para: passo,
      error: err instanceof Error ? err.name : "unknown",
    });
  }

  try {
    await gravarAtividade({
      pool,
      organizationId,
      contactId,
      leadId,
      agentId: args.agentId,
      llmCallId: args.llmCallId,
      etapa: passo,
      dimensoes,
      razão: razaoDaMudancaPeloAgente(stageName ?? passo, passo),
    });
  } catch (err) {
    log.warn("qualificação JEV: não gravei a atividade da decisão", {
      lead_id: leadId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }

  return { movido: true, motivo: "movido", leadId, passo };
}

/* ────────────────────────── orquestração ────────────────────────── */

export interface EntradaDaQualificacao {
  pool: pg.Pool;
  admin: SupabaseClient;
  organizationId: string;
  /** No harness, "lead" é o CONTATO (inbound-turn: leadId = job.contact_id). */
  contactId: string | null;
  jobId?: string | null;
  agentId?: string | null;
  /** A conversa — vira o `state` do System One. NUNCA é logada. */
  context: LeadContext;
  currentStage: LeadStage;
  log: Logger;
}

export type MotivoNaoUsado =
  | "sem_contato"
  | "desligado_global"
  /** NÍVEL 2: o superadmin não liberou a feature para esta organização. */
  | "desligado_pelo_superadmin"
  | "desligado_org"
  | "provedor_desconhecido"
  | "sem_credencial"
  | "falha_provedor"
  | "resposta_indefinida";

export type ResultadoDaQualificacao =
  | { usado: false; motivo: MotivoNaoUsado; detalhe?: string }
  | {
      usado: true;
      movido: boolean;
      motivo: ResultadoDaAplicacao["motivo"];
      etapa?: LeadStage;
      passo?: LeadStage;
    };

export interface DepsDaQualificacao {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  lerGlobal?: (db: pg.Pool) => Promise<boolean>;
  /** NÍVEL 2 — o superadmin liberou a feature para esta organização? */
  lerHabOrg?: (db: pg.Pool, organizationId: string) => Promise<boolean>;
  lerBindingDoPonto?: (db: pg.Pool, organizationId: string) => Promise<LinhaDeBinding | null>;
  /**
   * A chave do provedor de decisão, por PROVIDER (cofre da instalação → env).
   * Não recebe mais `credentialId`: a chave deixou de ser BYOK.
   */
  lerCredencial?: (db: pg.Pool, provider: string) => Promise<string | null>;
  /** A regressão de funil está ligada nesta organização? Default false. */
  lerRegressao?: (db: pg.Pool, organizationId: string) => Promise<boolean>;
  aplicar?: (args: AplicacaoArgs) => Promise<ResultadoDaAplicacao>;
}

/**
 * Qualifica o lead com o provedor de decisão. NUNCA lança: qualquer falha vira
 * `{ usado:false }` e o classificador atual assume. Devolve `usado:true` apenas
 * quando a decisão foi de fato tomada (mesmo que não haja movimento).
 */
export async function qualificarLeadComJev(
  entrada: EntradaDaQualificacao,
  deps: DepsDaQualificacao = {},
): Promise<ResultadoDaQualificacao> {
  const log = entrada.log;

  if (entrada.contactId === null || entrada.contactId === "") {
    return { usado: false, motivo: "sem_contato" };
  }

  const lerGlobal = deps.lerGlobal ?? lerInterruptorGlobal;
  const lerHabOrg = deps.lerHabOrg ?? lerHabilitacaoDaOrganizacao;
  const lerBinding =
    deps.lerBindingDoPonto ??
    ((db, organizationId) => carregarBinding(db, organizationId, PONTO_QUALIFICACAO));
  const lerCredencial = deps.lerCredencial ?? lerCredencialDaPlataforma;
  const lerRegressao = deps.lerRegressao ?? lerRegressaoDeFunilDaOrganizacao;
  const aplicar = deps.aplicar ?? aplicarQualificacaoPadrao;

  try {
    // NÍVEL 1 — o kill switch GLOBAL do superadmin.
    if (!(await lerGlobal(entrada.pool))) return { usado: false, motivo: "desligado_global" };

    // NÍVEL 2 — o superadmin liberou a feature para ESTA organização?
    if (!(await lerHabOrg(entrada.pool, entrada.organizationId))) {
      return { usado: false, motivo: "desligado_pelo_superadmin" };
    }

    // NÍVEL 3 — a conta ligou o binding do ponto (e escolheu o provedor).
    const binding = await lerBinding(entrada.pool, entrada.organizationId);
    if (binding === null || !binding.is_enabled) return { usado: false, motivo: "desligado_org" };

    const provedor = PROVEDOR_DE_DECISAO_POR_ID.get(binding.provider);
    if (provedor === undefined) {
      return { usado: false, motivo: "provedor_desconhecido", detalhe: binding.provider };
    }

    // A chave é da INSTALAÇÃO: vem do cofre de plataforma (ou do ambiente). O
    // `credential_id` do binding deixou de ser a fonte — não é mais BYOK.
    const apiKey = await lerCredencial(entrada.pool, binding.provider);
    if (apiKey === null) return { usado: false, motivo: "sem_credencial" };

    const inicio = Date.now();
    let resultado;
    try {
      resultado = await classificarComTypeSafe({
        apiKey,
        state: entrada.context,
        questions: perguntasDaQualificacao(),
        model: binding.model_id,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
    } catch (err) {
      // Falha de provedor NÃO é incidente do turno: cai para o classificador atual.
      log.warn("qualificação JEV: provedor de decisão falhou — o classificador atual assume", {
        organization_id: entrada.organizationId,
        motivo: err instanceof Error ? err.name : "unknown",
      });
      return {
        usado: false,
        motivo: "falha_provedor",
        detalhe: err instanceof Error ? err.name : undefined,
      };
    }

    const decisao = decidirEtapa(resultado.answers, entrada.currentStage);
    if ("indefinido" in decisao) {
      return { usado: false, motivo: "resposta_indefinida", detalhe: decisao.porque };
    }

    const dimensoes = montarDimensoes(resultado.answers);
    const llmCallId = await registrarChamada({
      db: entrada.pool,
      organizationId: entrada.organizationId,
      contactId: entrada.contactId,
      jobId: entrada.jobId ?? null,
      agentId: entrada.agentId ?? null,
      provider: binding.provider,
      model: binding.model_id,
      inputTokens: resultado.usage.input_tokens,
      outputTokens: resultado.usage.output_tokens,
      latencyMs: Date.now() - inicio,
    });

    // A regressão é decisão do admin da CONTA (default false). Ela só afeta a
    // APLICAÇÃO (andar para trás); não interfere em quando o Jev é usado.
    const permitirRegressao = await lerRegressao(entrada.pool, entrada.organizationId);

    const aplicado = await aplicar({
      pool: entrada.pool,
      admin: entrada.admin,
      organizationId: entrada.organizationId,
      contactId: entrada.contactId,
      jobId: entrada.jobId ?? null,
      agentId: entrada.agentId ?? null,
      currentStage: entrada.currentStage,
      alvo: decisao.etapa,
      dimensoes,
      llmCallId,
      log,
      permitirRegressao,
    });

    return {
      usado: true,
      movido: aplicado.movido,
      motivo: aplicado.motivo,
      etapa: decisao.etapa,
      ...(aplicado.passo ? { passo: aplicado.passo } : {}),
    };
  } catch (err) {
    // Rede de segurança: nenhuma exceção deste módulo pode derrubar o turno.
    log.warn("qualificação JEV: falha inesperada — o turno segue", {
      organization_id: entrada.organizationId,
      motivo: err instanceof Error ? err.name : "unknown",
    });
    return {
      usado: false,
      motivo: "falha_provedor",
      detalhe: err instanceof Error ? err.name : undefined,
    };
  }
}
