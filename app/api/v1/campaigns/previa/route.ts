/**
 * GET /api/v1/campaigns/previa?tags=a,b — quantos contatos recebem.
 * A mesa: "o público precisa de prévia da contagem" — sem número, o usuário
 * não sabe o tamanho do disparo. Exclui is_blocked e force_human (o mesmo que a
 * materialização fará), para a prévia NÃO mentir.
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

  const tags = (req.nextUrl.searchParams.get("tags") ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const { rows } = await pool().query<{ n: string }>(
    `select count(*)::text as n
       from public.contacts c
      where c.organization_id = $1
        and coalesce(c.is_blocked, false) = false
        and coalesce(c.force_human, false) = false
        and (cardinality($2::text[]) = 0 or c.tags && $2::text[])`,
    [authz.org.orgId, tags],
  );
  return ok({ total: Number(rows[0]?.n ?? 0) }, { requestId });
}
