/**
 * O FREIO DA CAMPANHA (circuit breaker — A1, Fase 3).
 *
 * As TRÊS camadas da mesa (requisitos §5.7) — configuradas para calibração:
 *
 * | Camada | Sinal | Régua | Ação |
 * |---|---|---|---|
 * | 1. Conexão caiu | `channel_sessions.status != 'WORKING'` | imediato | pausa |
 * | 2. Erro em série | falhas nos últimos 30 min na SESSÃO | >= 5 | pausa |
 * | 3. Ban silencioso | enviadas nos últimos 5 min SEM `ack_at` | >= 5 | pausa |
 *
 * ── POR QUE POR SESSÃO, E NÃO POR CAMPANHA ─────────────────────────────────
 *
 * O ban é do NÚMERO (a mesa: "o índice do freio é por SESSÃO"). Duas campanhas
 * na mesma conexão sofrem o mesmo destino de ban — pausar só uma deixaria a
 * outra queimando o número. O freio pausa TODAS as campanhas ativas da sessão.
 *
 * ── A PAUSA NÃO VOLTA SOZINHA ───────────────────────────────────────────────
 *
 * O desenho (mesa): "voltar sozinho depois de um ban é o pior comportamento
 * possível". A pausa é `auto_paused=true` + `paused_reason` + `breaker_layer` —
 * uma pessoa revê e retoma manualmente.
 *
 * ── O `ack_at` ─────────────────────────────────────────────────────────────
 *
 * A camada 3 depende do `ack_at`, que o webhook agora alimenta (handleAck →
 * messages.ack_at + espelho no dispatch) — sem ele a régua "sem ack" não mede.
 */
import type pg from "pg";

export const FALHAS_PARA_PAUSAR = 5;
export const JANELA_FALHAS_MIN = 30;
export const SEM_ACK_QTD = 5;
export const SEM_ACK_JANELA_MIN = 5;

/** Camadas do freio (1..3) + sem gatilho (0). */
export type CamadaDoFreio = 0 | 1 | 2 | 3;

export interface FreioResultado {
  pausadas: number;
  camada: CamadaDoFreio;
  motivo: string | null;
}

/**
 * Avalia as campanhas ATIVAS e pausa as que estiverem sob um gatilho de ban.
 * Devolve quantas pausou e por qual camada (para o log do tick).
 */
export async function avaliarFreioDasCampanhasAtivas(
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<FreioResultado> {
  // Sessões das campanhas ativas (uma vez por campanha/sessão).
  const { rows: ativas } = await pool.query<{
    session_id: string;
    status: string | null;
    campaign_id: string;
  }>(
    `select cc.channel_session_id::text as session_id, s.status,
            c.id::text as campaign_id
       from public.campaigns c
       join public.campaign_channels cc on cc.organization_id = c.organization_id and cc.campaign_id = c.id
       join public.channel_sessions s on s.id = cc.channel_session_id
      where c.status = 'ativa'`,
  );
  if (ativas.length === 0) return { pausadas: 0, camada: 0, motivo: null };

  // Agrupa as campanhas por sessão.
  const campanhasPorSessao = new Map<string, string[]>();
  for (const a of ativas) {
    const lista = campanhasPorSessao.get(a.session_id) ?? [];
    lista.push(a.campaign_id);
    campanhasPorSessao.set(a.session_id, lista);
  }

  const agoraIso = now.toISOString();
  const limiteFalhas = new Date(now.getTime() - JANELA_FALHAS_MIN * 60_000).toISOString();
  const limiteSemAck = new Date(now.getTime() - SEM_ACK_JANELA_MIN * 60_000).toISOString();

  let totalPausadas = 0;
  let ultimaCamada: CamadaDoFreio = 0;
  let ultimoMotivo: string | null = null;

  for (const [sessaoId, campanhas] of campanhasPorSessao) {
    const sessao = ativas.find((a) => a.session_id === sessaoId);
    let camada: CamadaDoFreio = 0;
    let motivo: string | null = null;

    // ── Camada 1: a conexão caiu (imediato) ──
    if (sessao && sessao.status !== "WORKING") {
      camada = 1;
      motivo = `conexão da sessão não está WORKING (${sessao.status ?? "?"})`;
    } else {
      // ── Camada 2: erro em série (30 min) ──
      const falhas = await pool.query<{ n: string }>(
        `select count(*)::text as n
           from public.campaign_step_dispatches d
           join public.campaign_recipients r on r.id = d.recipient_id
          where r.channel_session_id = $1
            and d.status = 'falhou'
            and d.created_at >= $2`,
        [sessaoId, limiteFalhas],
      );
      if (Number(falhas.rows[0]?.n ?? 0) >= FALHAS_PARA_PAUSAR) {
        camada = 2;
        motivo = `${falhas.rows[0]?.n} falhas em ${JANELA_FALHAS_MIN} min na sessão`;
      }
    }

    // ── Camada 3: ban silencioso — 5+ enviadas em 5 min sem nenhum ack ──
    if (camada === 0) {
      const semAck = await pool.query<{ n: string }>(
        `select count(*)::text as n
           from public.campaign_step_dispatches d
           join public.campaign_recipients r on r.id = d.recipient_id
          where r.channel_session_id = $1
            and d.status = 'enviado'
            and d.sent_at >= $2
            and d.ack_at is null`,
        [sessaoId, limiteSemAck],
      );
      if (Number(semAck.rows[0]?.n ?? 0) >= SEM_ACK_QTD) {
        camada = 3;
        motivo = `${semAck.rows[0]?.n} enviadas em ${SEM_ACK_JANELA_MIN} min sem ack (ban silencioso)`;
      }
    }

    if (camada > 0 && motivo) {
      const pausadas = await pool.query(
        `update public.campaigns
            set status = 'pausada', auto_paused = true,
                paused_reason = $2, breaker_layer = $3, paused_at = $4, updated_at = now()
          where id = any($1::uuid[]) and status = 'ativa'`,
        [campanhas, motivo, camada, agoraIso],
      );
      totalPausadas += pausadas.rowCount ?? 0;
      ultimaCamada = camada;
      ultimoMotivo = motivo;
    }
  }

  return { pausadas: totalPausadas, camada: ultimaCamada, motivo: ultimoMotivo };
}