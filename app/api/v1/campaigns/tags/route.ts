/**
 * GET /api/v1/campaigns/tags — as etiquetas existentes na organização.
 *
 * A tela de campanha precisa mostrar a LISTA de etiquetas para o usuário
 * selecionar o público (em vez de digitar). São as tags distintas dos contatos
 * da org (contacts.tags). A query é crua e o filtro é por organization_id —
 * explícito (service_role), além da RLS do app.
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

  const { rows } = await pool().query<{ tag: string }>(
    `select distinct unnest(tags) as tag
       from public.contacts
      where organization_id = $1 and tags is not null
      order by 1`,
    [authz.org.orgId],
  );
  return ok(rows.map((r) => r.tag), { requestId });
}
