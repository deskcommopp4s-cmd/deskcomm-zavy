/**
 * GET /api/v1/campaigns/tags — as etiquetas existentes na organização.
 * A tela de campanha mostra a LISTA para selecionar o público (não digitar).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadEnv } from "@/lib/agent-engine/env";

export const dynamic = "force-dynamic";

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: loadEnv().SUPABASE_DB_URL, max: 2 });
  return _pool;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  // O MESMO vocabulário que Configurações → Tags usa (`fn_vocabulario_de_tags`).
  // Antes esta rota lia só `contacts.tags` — e os dois eixos divergiam: uma
  // etiqueta criada/visível numa tela não aparecia na outra. Medido: a tela de
  // Tags lê a fn; a campanha lia os contatos.
  const { rows } = await pool().query<{ tag: string; uso_em_contatos: string }>(
    `select tag, uso_em_contatos::text
       from public.fn_vocabulario_de_tags($1)
      order by uso_em_contatos desc, tag
      limit 500`,
    [authz.org.orgId],
  );
  return ok(
    rows.map((r) => ({ tag: r.tag, uso_em_contatos: Number(r.uso_em_contatos) })),
    { requestId },
  );
}
