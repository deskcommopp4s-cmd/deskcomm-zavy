/**
 * A MATERIALIZAÇÃO DO PÚBLICO — o filtro vira destinatários (A1, Fase 1).
 *
 * ── O QUE É ─────────────────────────────────────────────────────────────────
 *
 * O `campaigns.audience` é um jsonb de filtro; aqui ele vira linhas em
 * `campaign_recipients`, UMA por contato, com a CONEXÃO resolvida NA INSCRIÇÃO
 * (decisão do dono): quem já tem conversa usa a sessão da conversa (afinidade);
 * quem não tem aplica `new_lead_strategy` ('rotacionar' round-robin | 'fixa').
 *
 * ── O FILTRO É FECHADO (a lição da mesa) ────────────────────────────────────
 *
 * A mesa (05/10/2026) flagrou: "Injeção no filtro de público (jsonb com
 * op/value livres)". Por isso este filtro NÃO monta SQL dinâmico com operador
 * do usuário. Os operadores são NOSSOS e fechados: `tags` (&&), `tags_exclude`
 * (não &&), `import_tags` (&& — a etiqueta `import:*`), `pipeline_ids` (exists
 * em crm_leads). `custom_fields` fica FORA da Fase 1 de propósito: exigiria o
 * repositório fechado de operadores, e isso é Fase 2 do desenho — aqui ele é
 * recusado com erro MENSAGEIRO em vez de SQL dinâmico.
 *
 * ── O OPT-OUT É IRREVOGÁVEL ────────────────────────────────────────────────
 *
 * Não existe `include_opted_out`: a materialização exclui `is_blocked` E
 * `force_human` (a mesma dupla do `before_send`). Um toggle para ignorar
 * criaria falsa expectativa — e a campanha não fala com quem pediu para não.
 *
 * ── IDEMPOTENTE ────────────────────────────────────────────────────────────
 *
 * `unique (campaign_id, contact_id)` + `on conflict do nothing`: materializar
 * de novo não duplica destinatário. O total retornado é só o que ENTROU agora.
 */
import type pg from "pg";

export interface FiltroDePublico {
  pipeline_ids?: string[];
  tags?: string[];
  tags_exclude?: string[];
  import_tags?: string[];
  /** Fase 2: recusado com erro — ver o cabeçalho (mesa: injeção via op/value). */
  custom_fields?: unknown;
}

export interface MaterializarResultado {
  /** Quantos entraram NESTA materialização (0 se já estavam). */
  entrados: number;
  /** Quantos contatos elegíveis existiam no total (para o aviso da tela). */
  elegiveis: number;
}

interface Candidato {
  id: string;
  conversation_id: string | null;
  session_da_conversa: string | null;
}

export async function materializarPublico(
  pool: pg.Pool,
  organizationId: string,
  campaignId: string,
  audience: FiltroDePublico,
  channelSessionIds: string[],
  newLeadStrategy: "rotacionar" | "fixa",
  newLeadSessionId: string | null,
): Promise<MaterializarResultado> {
  if (audience.custom_fields !== undefined && audience.custom_fields !== null) {
    throw new Error(
      "custom_fields no filtro é Fase 2: exigiria o repositório fechado de operadores (a mesa reprovou op/value livres).",
    );
  }

  const canalFixo =
    newLeadStrategy === "fixa"
      ? newLeadSessionId ?? null
      : null;
  if (newLeadStrategy === "fixa" && canalFixo === null) {
    throw new Error("estratégia fixa exige new_lead_session_id");
  }
  if (channelSessionIds.length === 0) {
    throw new Error("campanha sem conexões");
  }

  const tags = audience.tags?.length ? audience.tags : null;
  const tagsExclu = audience.tags_exclude?.length ? audience.tags_exclude : null;
  const importTags = audience.import_tags?.length ? audience.import_tags : null;
  const pipes = audience.pipeline_ids?.length ? audience.pipeline_ids : null;

  const candidatos = await pool.query<Candidato>(
    `select
       c.id,
       conv.id::text as conversation_id,
       conv.channel_session_id::text as session_da_conversa
     from public.contacts c
     left join lateral (
       select id, channel_session_id
         from public.conversations
        where organization_id = $1 and contact_id = c.id
        order by last_message_at desc nulls last
        limit 1
     ) conv on true
     where c.organization_id = $1
       and coalesce(c.is_blocked, false) = false
       and coalesce(c.force_human, false) = false
       and ($2::text[] is null or c.tags && $2)
       and ($3::text[] is null or not (c.tags && $3))
       and ($4::text[] is null or c.tags && $4)
       and ($5::uuid[] is null or exists (
         select 1 from public.crm_leads l
          where l.organization_id = $1
            and l.contact_id = c.id
            and l.pipeline_id = any($5)
       ))
     order by c.id`,
    [organizationId, tags, tagsExclu, importTags, pipes],
  );

  const elegiveis = candidatos.rowCount ?? 0;

  // A conexão de cada candidato: afinidade da conversa OU estratégia p/ novo.
  // Round-robin: `idx % n` sobre a lista de canais da campanha.
  const listaDeCanais = channelSessionIds;
  let rotador = 0;
  const linhas = candidatos.rows.map((cand) => {
    const sessionId = cand.session_da_conversa ?? (canalFixo ?? listaDeCanais[rotador++ % listaDeCanais.length]!);
    return {
      contact_id: cand.id,
      channel_session_id: sessionId,
      conversation_id: cand.conversation_id,
    };
  });

  if (linhas.length === 0) {
    return { entrados: 0, elegiveis };
  }

  // INSERT BULK com on conflict do nothing — idempotente e sem duplicar.
  // 7 colunas, 7 expressões por tupla. $1 (org) e $2 (campanha) são fixos;
  // cada linha consome 5 parâmetros (contact_id, session, conversa, status,
  // next_send_at) — o `base` anda de 5 em 5. O erro anterior ("INSERT has more
  // target columns than expressions") era exatamente este desalinhamento: 7
  // colunas contra 6 placeholders.
  const values: unknown[] = [];
  const placeholders: string[] = [];
  const agoraIso = new Date().toISOString();
  linhas.forEach((linha, i) => {
    const b = i * 5;
    placeholders.push(`($1, $2, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
    values.push(
      linha.contact_id,
      linha.channel_session_id,
      linha.conversation_id,
      "pendente",
      agoraIso,
    );
  });

  // FIXME: para muitos contatos isso vira um VALUES gigante; a Fase 2 usa lote
  // de 500/1000. Aqui segue simples e correto.
  const resultado = await pool.query(
    `insert into public.campaign_recipients
       (organization_id, campaign_id, contact_id, channel_session_id, conversation_id, status, next_send_at)
     values ${placeholders.join(", ")}
     on conflict (campaign_id, contact_id) do nothing`,
    [organizationId, campaignId, ...values],
  );

  const entrados = resultado.rowCount ?? 0;
  if (entrados > 0) {
    await pool.query(
      `update public.campaigns
          set total_recipients = total_recipients + $2, status = 'ativa', updated_at = now()
        where id = $1`,
      [campaignId, entrados],
    );
  }

  return { entrados, elegiveis };
}