/**
 * GET /api/v1/admin/support/threads — a fila de chamados da PLATAFORMA.
 *
 * Cross-tenant de propósito: quem atende suporte precisa ver os chamados de
 * todas as contas. É por isso que usa o admin client — e é por isso que o
 * perfil (`full` | `suporte`) é conferido ANTES, e a leitura é só de suporte:
 * um admin de suporte NÃO enxerga dado de tenant (a função do banco o exclui
 * das policies de dado — migration 0268).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { podeAtenderSuporte } from "@/lib/support/escopo";

export const dynamic = "force-dynamic";

const COLS =
  "id, organization_id, opened_by, assunto, status, assigned_to, escalated_at, closed_at, nps, created_at, updated_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const ctx = await requirePlatformAdmin();
  if (!podeAtenderSuporte(ctx)) {
    return fail("forbidden", "Seu perfil não atende suporte.", 403, { requestId });
  }

  const status = req.nextUrl.searchParams.get("status");
  const admin = createAdminClient();

  let query = admin
    .from("support_threads")
    // O join traz o nome da conta: sem ele a fila é uma lista de uuids, e quem
    // atende não sabe de quem é o chamado antes de abrir.
    .select(`${COLS}, organizations!inner(display_name)`)
    .order("created_at", { ascending: false })
    .limit(100);

  // `fechado`/`resolvido` ficam FORA do default: a fila é o que ainda espera.
  if (status) query = query.eq("status", status);
  else query = query.in("status", ["aberto", "com_ia", "com_humano", "ia_falhou"]);

  const { data, error } = await query;
  if (error) return fail("internal_error", "Erro ao listar chamados.", 500, { requestId });
  return ok(data ?? [], { requestId });
}
