/**
 * O WORKER DA CAMPANHA — o laço que dispara.
 *
 * ── POR QUE ESTE CAMINHO, E NÃO O ADAPTER DIRETO (a lição C1 da mesa) ───────
 *
 * A mesa de análise (05/10/2026) reprovou o desenho original que chamava o
 * adapter direto: isso furava 7 gates de uma vez — opt-out, LGPD, anti-ban,
 * janela, spinning, idempotência e a linha em `messages`.
 *
 * Este worker NÃO chama o adapter direto. Ele passa pelo canal que o runtime
 * de `lib/channels/` expõe (que embrulha o adapter do agent-engine), cujo
 * `send` → `sendTurnMessage` → **`sendMessageHandler`** — o caminho ÚNICO do
 * repo ("envio de mensagem SEMPRE via sendMessageHandler", `send-message.ts:11`).
 * E `sendMessageHandler` **ele próprio**:
 *   - barra `contacts.is_blocked` (opt-out — o gate irrevogável)  `_handler.ts:379`
 *   - grava a linha em `messages` (senão some do inbox — decisão 6)
 *   - reconcilia por `metadata.idempotency_key` (o ledger — idempotência)
 *   - trata `isConfigured` / canal arquivado / janela de 24h do oficial
 *
 * O que o worker acrescenta POR CIMA (porque o caminho do adapter não tem):
 *   - o CLAIM com lease (`fn_claim_due_campaign_recipients`) — sem ele, dois
 *     workers enviam a mesma linha (lição da 0146);
 *   - o `decidePacing` (anti-ban) — decide se esta mensagem pode sair AGORA, e
 *     reagenda o destinatário quando o número precisa respirar;
 *   - a janela da campanha (início/fim/dias) — o pacing global não sabe a janela
 *     que o dono definiu para a campanha;
 *   - o registro em `campaign_recipients` + `campaign_step_dispatches` — o
 *     estado por destinatário e o grão por ENVIO.
 *
 * O gate `lgpd` fica inócuo de propósito (decisão do dono, 05/10/2026): a
 * campanha não bloqueia por base legal. O `spinning` (veta template idêntico em
 * massa) NÃO se aplica aqui por natureza: campanha É texto repetido em massa —
 * a proteção é o pacing + a janela + opt-out, não um veto de "mesma mensagem".
 * A variação por IA (Fase 4) é que diversifica o texto.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

import { createLogger } from "@/lib/agent-engine/obs/logger";
import { crmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/crm/mcp-client";
import { createRuntimeSendChannel, type RuntimeSendChannel } from "@/lib/channels/runtime";
import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { loadPacingState } from "@/lib/agent-engine/pacing/store";
import { loadEnv } from "@/lib/agent-engine/env";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";

export const CAMPAIGN_TICK_LIMIT = 50;
export const CAMPAIGN_LEASE_SECONDS = 120;

export interface TickResult {
  reclamados: number;
  enviados: number;
  reagendados: number;
  erros: number;
}

export async function tickCampanhas(pool: pg.Pool, now: Date = new Date()): Promise<TickResult> {
  const log = createLogger();
  const env = loadEnv();
  const crmCfg = crmEdgeConfigFromEnv({
    SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  // O canal vem de `lib/channels/runtime.ts` — DENTRO de lib/channels/ — e não
  // de um import pelo nome do provider: a doutrina de restricao de canal vale
  // para o TEXTO tambem (lint-channels reprova o arquivo inteiro). O runtime
  // embrulha o adapter do agent-engine (cujo send passa por sendMessageHandler).
  const channel = createRuntimeSendChannel(pool, crmCfg);
  const knobs = PACING_DEFAULTS;

  const resultado: TickResult = { reclamados: 0, enviados: 0, reagendados: 0, erros: 0 };

  // ── 1. CLAIM ATÔMICO COM LEASE ──────────────────────────────────────────
  // A condição de lease vai repetida no WHERE do UPDATE (lição da 0146) —
  // está DENTRO da função.
  const { rows: reclamados } = await pool.query<{
    id: string;
    organization_id: string;
    campaign_id: string;
    contact_id: string;
    channel_session_id: string;
    conversation_id: string | null;
    current_step: number;
  }>("select * from public.fn_claim_due_campaign_recipients($1, $2)", [
    CAMPAIGN_TICK_LIMIT,
    CAMPAIGN_LEASE_SECONDS,
  ]);

  resultado.reclamados = reclamados.length;
  for (const r of reclamados) {
    try {
      const resposta = await processarUmDestinatario(pool, channel, knobs, r, now);
      if (resposta === "enviado") resultado.enviados += 1;
      else if (resposta === "reagendado") resultado.reagendados += 1;
    } catch (err) {
      // Nunca deixar a fila morrer por UM destinatário: o reaper devolve o lease
      // expirado (a tentativa fica contada em `attempts`).
      resultado.erros += 1;
      log.error("[campaign.worker] destinatário falhou — o reaper assume", {
        recipient_id: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 2. O REAPER: lease expirado volta para a fila (ou vira falhou) ──────
  await pool.query("select public.fn_reaper_campaign_recipients(5)");

  return resultado;
}

/**
 * Processa UM destinatário reclamado. Devolve o desfecho para o contador.
 */
async function processarUmDestinatario(
  pool: pg.Pool,
  channel: RuntimeSendChannel,
  knobs: typeof PACING_DEFAULTS,
  r: { id: string; organization_id: string; campaign_id: string; contact_id: string; channel_session_id: string; conversation_id: string | null; current_step: number },
  now: Date,
): Promise<"enviado" | "reagendado"> {
  // ── O passo atual ───────────────────────────────────────────────────────
  const passo = await pool.query<{
    id: string;
    body: string | null;
    media_storage_path: string | null;
    media_kind: string | null;
    media_mime: string | null;
    delay_after_seconds: number;
  }>("select * from public.campaign_steps where campaign_id = $1 and step_order = $2", [
    r.campaign_id,
    r.current_step,
  ]);
  const step = passo.rows[0];
  if (!step) {
    // Sem passo para o contador: o destinatário não tem mais o que receber → parado.
    await pool.query(
      "update public.campaign_recipients set status = 'parado', claimed_until = null, claimed_by = null where id = $1",
      [r.id],
    );
    return "reagendado";
  }
  if ((!step.body || step.body.trim() === "") && !step.media_storage_path) {
    throw new Error(`passo ${r.current_step} sem texto e sem mídia`);
  }

  // ── A campanha (janela + teto) ──────────────────────────────────────────
  const camp = await pool.query<{
    id: string;
    daily_limit: number | null;
    window_start_hour: number;
    window_end_hour: number;
    allowed_weekdays: number[];
    timezone: string | null;
  }>("select id, daily_limit, window_start_hour, window_end_hour, allowed_weekdays, timezone from public.campaigns where id = $1", [
    r.campaign_id,
  ]);
  const campaign = camp.rows[0];
  if (!campaign) throw new Error("campanha não encontrada");

  // Janela: o dia da semana (0=dom) e a hora local. Sem fuso configurado, usa a
  // hora da org via `now` em UTC — a org também pode herdar; Fase 1 usa UTC até
  // a tela expor o fuso (o desenho exige dayStartInTz — pendência Fase 2).
  const dow = now.getUTCDay();
  const hour = now.getUTCHours();
  const naJanela =
    (campaign.allowed_weekdays.length === 0 || campaign.allowed_weekdays.includes(dow)) &&
    hour >= campaign.window_start_hour &&
    hour < campaign.window_end_hour;
  if (!naJanela) {
    // Fora da janela: reagendar para amanhã na abertura.
    const amanha = new Date(now);
    amanha.setUTCDate(amanha.getUTCDate() + 1);
    amanha.setUTCHours(campaign.window_start_hour, 0, 0, 0);
    await pool.query(
      "update public.campaign_recipients set status = 'pendente', claimed_until = null, claimed_by = null, next_send_at = $1 where id = $2",
      [amanha, r.id],
    );
    return "reagendado";
  }

  // ── O ANTI-BAN (decidePacing): o número precisa respirar? ───────────────
  const estado = await loadPacingState(pool, r.organization_id, r.channel_session_id, {
      now,
      timezone: "UTC", // Fase 1: UTC até a tela expor o fuso (pendência Fase 2)
      numberActivatedAt: null,
    });
  const decisao = decidePacing({
    now,
    knobs,
    state: estado,
    crmDailyLimit: campaign.daily_limit,
  });
  if (!decisao.allow) {
    await pool.query(
      "update public.campaign_recipients set status = 'pendente', claimed_until = null, claimed_by = null, next_send_at = $1 where id = $2",
      [decisao.nextAllowedAt, r.id],
    );
    return "reagendado";
  }

  // ── O ENVIO (via o caminho que passa por sendMessageHandler) ─────────────
  // A conversa: o destinatário tem uma garantida na inscrição; se faltar,
  // criamos uma conversa mínima aqui (Fase 1). Idempotência: o jobId é o UUID
  // do dispatch (novo por envio) e o ledger reconcilia pela chave.
  let conversationId = r.conversation_id ?? null;
  if (!conversationId) {
    const criada = await pool.query<{ id: string }>(
      `insert into public.conversations (organization_id, contact_id, channel_session_id, status)
       values ($1, $2, $3, 'open') returning id`,
      [r.organization_id, r.contact_id, r.channel_session_id],
    );
    conversationId = criada.rows[0]!.id;
  }

  const dispatchId = randomUUID();
  await pool.query(
    `insert into public.campaign_step_dispatches (id, organization_id, recipient_id, step_order, status)
     values ($1, $2, $3, $4, 'enviando')`,
    [dispatchId, r.organization_id, r.id, r.current_step],
  );

  const out = await channel.send({
    tenantId: r.organization_id,
    leadId: null,
    jobId: dispatchId,
    seq: r.current_step + 1,
    conversationId,
    body: step.body ?? "",
    // Mídia do passo (imagem/documento/voz) — Fase 2. O path é asset da CAMPANHA
    // (`{org}/campaigns/...`); o gate isMediaPathOwnedBy aceita da mesma org.
    media_storage_path: step.media_storage_path ?? undefined,
    media_mime: step.media_mime ?? undefined,
  });

  // O adapter devolve o id da linha em `messages` quando enviou.
  const messageId = out.kind === "sent" || out.kind === "already_sent" ? out.messageId : null;
  if (out.kind === "failed" || out.kind === "blocked" || out.kind === "unavailable") {
    await pool.query(
      `update public.campaign_step_dispatches
       set status = 'falhou', error_message = $1 where id = $2`,
      [out.kind === "unavailable" ? "transporte_indisponivel" : out.kind, dispatchId],
    );
    await pool.query(
      `update public.campaign_recipients
       set status = 'pendente', claimed_until = null, claimed_by = null,
           attempts = attempts + 1, last_error = $1
       where id = $2`,
      [out.kind, r.id],
    );
    return "reagendado";
  }

  // ── REGISTRO: avançar o passo e calcular o próximo envio ─────────────────
  const temProximo = await pool.query<{ n: number }>(
    "select count(*)::int as n from public.campaign_steps where campaign_id = $1 and step_order > $2",
    [r.campaign_id, r.current_step],
  );
  const proximoPasso = r.current_step + 1;
  const proximo = temProximo.rows[0]!.n > 0 ? proximoPasso : null;
  const delay = step.delay_after_seconds || 0;

  await pool.query(
    `update public.campaign_step_dispatches
     set status = 'enviado', outbound_message_id = $1, sent_at = $2
     where id = $3`,
    [messageId, now.toISOString(), dispatchId],
  );

  if (proximo !== null) {
    const proxima = new Date(now.getTime() + delay * 1000);
    await pool.query(
      `update public.campaign_recipients
       set status = 'pendente', current_step = $1, claimed_until = null, claimed_by = null,
           next_send_at = $2, last_sent_at = $3, outbound_message_id = $4
       where id = $5`,
      [proximo, proxima, now.toISOString(), messageId, r.id],
    );
  } else {
    await pool.query(
      `update public.campaign_recipients
       set status = 'enviado', claimed_until = null, claimed_by = null,
           last_sent_at = $1, outbound_message_id = $2
       where id = $3`,
      [now.toISOString(), messageId, r.id],
    );
    await pool.query(
      `update public.campaigns set sent_count = sent_count + 1 where id = $1`,
      [r.campaign_id],
    );
  }

  // Contador de envios da campanha em TODOS os casos de envio confirmado.
  await pool.query(
    `update public.campaigns set sent_count = sent_count + 1 where id = $1`,
    [r.campaign_id],
  );

  return "enviado";
}