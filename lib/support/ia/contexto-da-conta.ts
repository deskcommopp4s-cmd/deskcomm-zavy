/**
 * O RETRATO DA CONTA que a IA de suporte recebe antes de responder.
 *
 * ── POR QUE UM RETRATO, E NÃO SQL GERADO PELO MODELO ────────────────────────
 *
 * A alternativa era dar ao modelo uma ferramenta que executa SQL. A conexão
 * read-only impediria a ESCRITA, mas não impediria a LEITURA CRUZADA: uma query
 * gerada pelo modelo poderia ler a conta de OUTRO cliente, e a conexão não tem
 * como saber de quem é a pergunta.
 *
 * O retrato fecha isso por construção: as queries são NOSSAS, todas com
 * `where organization_id = $1`, e o modelo nunca escreve SQL. Ele recebe o
 * estado da conta e responde sobre ele.
 *
 * ── A LEITURA PASSA PELA CONEXÃO READ-ONLY ──────────────────────────────────
 *
 * `poolDeLeituraDoSuporte` — a mesma trava do §read-only da 0268. Aqui é onde
 * ela ganha sentido prático: se alguém, um dia, acrescentar uma query que
 * escreve neste arquivo, o BANCO recusa (medido, com controle positivo).
 *
 * ── O QUE ENTRA ─────────────────────────────────────────────────────────────
 *
 * O que um cliente pergunta no suporte: a conexão do WhatsApp caiu? quantos
 * leads tenho? o bot está respondendo? qual o plano/limite? O retrato é curto de
 * propósito — é o que caber no prompt sem competir com a conversa do chamado.
 */
import type pg from 'pg';

export interface ContaDoSuporte {
  display_name: string | null;
  status: string | null;
  timezone: string | null;
  canais: { provider: string | null; status: string | null; phone: string | null }[];
  leads: { total: number; abertos: number };
  conversas: { total: number; abertas: number; ultima: string | null };
  agentes: { nome: string; ativo: boolean; kind: string | null }[];
  mensagens_7d: number;
}

/**
 * Lê o retrato. TODA query filtra `organization_id` — é o contrato desta função.
 * Uma query nova aqui sem o filtro lê a conta de outro cliente.
 */
export async function lerContaDoSuporte(
  pool: pg.Pool,
  organizationId: string,
): Promise<ContaDoSuporte> {
  const [org, canais, leads, conversas, agentes, mensagens] = await Promise.all([
    pool.query<{ display_name: string | null; status: string | null; timezone: string | null }>(
      `select display_name, status, timezone from organizations where id = $1`,
      [organizationId],
    ),
    pool.query<{ provider: string | null; status: string | null; phone_number: string | null }>(
      `select provider, status, phone_number from channel_sessions
        where organization_id = $1 and archived_at is null
        order by created_at desc limit 5`,
      [organizationId],
    ),
    pool.query<{ total: string; abertos: string }>(
      `select count(*)::text as total,
              count(*) filter (where status = 'open')::text as abertos
         from crm_leads where organization_id = $1`,
      [organizationId],
    ),
    pool.query<{ total: string; abertas: string; ultima: string | null }>(
      `select count(*)::text as total,
              count(*) filter (where status = 'open')::text as abertas,
              max(last_message_at)::text as ultima
         from conversations where organization_id = $1`,
      [organizationId],
    ),
    pool.query<{ name: string; is_active: boolean; kind: string | null }>(
      `select name, is_active, kind from ai_agents
        where organization_id = $1 and archived_at is null
        order by is_default desc, created_at asc limit 5`,
      [organizationId],
    ),
    pool.query<{ n: string }>(
      `select count(*)::text as n from messages
        where organization_id = $1 and created_at > now() - interval '7 days'`,
      [organizationId],
    ),
  ]);

  return {
    display_name: org.rows[0]?.display_name ?? null,
    status: org.rows[0]?.status ?? null,
    timezone: org.rows[0]?.timezone ?? null,
    canais: canais.rows.map((c) => ({
      provider: c.provider,
      status: c.status,
      phone: c.phone_number,
    })),
    leads: {
      total: Number(leads.rows[0]?.total ?? 0),
      abertos: Number(leads.rows[0]?.abertos ?? 0),
    },
    conversas: {
      total: Number(conversas.rows[0]?.total ?? 0),
      abertas: Number(conversas.rows[0]?.abertas ?? 0),
      ultima: conversas.rows[0]?.ultima ?? null,
    },
    agentes: agentes.rows.map((a) => ({ nome: a.name, ativo: a.is_active, kind: a.kind })),
    mensagens_7d: Number(mensagens.rows[0]?.n ?? 0),
  };
}

/** O retrato em texto — é isto que entra no prompt. */
export function retratoEmTexto(c: ContaDoSuporte): string {
  const canais = c.canais.length
    ? c.canais
        .map((x) => `  - ${x.provider ?? "canal"} · status=${x.status ?? "?"} · ${x.phone ?? "sem número"}`)
        .join("\n")
    : "  - (nenhum canal conectado)";
  const agentes = c.agentes.length
    ? c.agentes.map((a) => `  - ${a.nome} · ${a.ativo ? "ativo" : "inativo"}${a.kind ? ` · ${a.kind}` : ""}`).join("\n")
    : "  - (nenhum assistente criado)";
  return [
    `Conta: ${c.display_name ?? "(sem nome)"} · status=${c.status ?? "?"} · fuso=${c.timezone ?? "?"}`,
    `Canais:`,
    canais,
    `Leads: ${c.leads.total} no total, ${c.leads.abertos} abertos`,
    `Conversas: ${c.conversas.total} no total, ${c.conversas.abertas} abertas; última atividade: ${c.conversas.ultima ?? "nunca"}`,
    `Assistentes de IA:`,
    agentes,
    `Mensagens nos últimos 7 dias: ${c.mensagens_7d}`,
  ].join("\n");
}
