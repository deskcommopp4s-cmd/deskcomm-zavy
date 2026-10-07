/**
 * GET/POST /api/v1/cron/campaign-worker — o tick da campanha (A1).
 *
 * A cada minuto o scheduler chama esta rota; ela processa até
 * `CAMPAIGN_TICK_LIMIT` destinatários pendentes de campanhas ATIVAS:
 * claim com lease → passo atual → janela → anti-ban (`decidePacing`) →
 * envio via o caminho que passa por `sendMessageHandler` → registro
 * (recipient + dispatch) → reaper dos leases expirados.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (ou
 * `INTERNAL_SECRET` / `x-cron-secret`), mesmo padrão dos outros crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import pg from "pg";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { tickCampanhas } from "@/lib/campaign/worker";

export const dynamic = "force-dynamic";

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL, max: 4 });
  return _pool;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || req.headers.get("x-cron-secret")?.trim() || "";
  const cronSecret = env.INTERNAL_CRON_SECRET;
  const fallbackSecret = env.INTERNAL_SECRET;
  if (!provided || (cronSecret ? provided !== cronSecret : provided !== fallbackSecret)) {
    return fail("unauthorized", "invalid cron secret", 401, { requestId });
  }

  try {
    const resultado = await tickCampanhas(pool());
    return ok(resultado, { requestId });
  } catch (err) {
    // O erro loga e devolve 500: o cron do scheduler reporta falha em vez de
    // engolir (a lição do webhook que devolvia 200).
    console.error("[campaign-worker] tick falhou", err instanceof Error ? err.message : err);
    return fail("internal_error", "campaign tick failed", 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}