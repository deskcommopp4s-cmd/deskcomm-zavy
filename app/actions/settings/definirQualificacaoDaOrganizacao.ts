"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export type DefinirQualificacaoDaOrganizacaoResult =
  | { ok: true; ativa: boolean }
  | { ok: false; error: string; details?: unknown };

/**
 * NÍVEL 2 DA QUALIFICAÇÃO DO LEAD — o superadmin libera a feature para UMA
 * organização.
 *
 * `organizations.qualificacao_jev_ativa` (migration 0267). Default `false`:
 * ninguém ganha a funcionalidade sem liberação. Os outros dois níveis são o kill
 * switch global (`platform_settings.qualificacao_jev_ativa`) e o binding da
 * conta (`ai_purpose_bindings.is_enabled`); efetivo = os três ligados.
 *
 * ── Por que o gate é `is_platform_admin` ────────────────────────────────────
 *
 * É a instalação decidindo por um tenant: mesmo argumento de `updateMetaApp.ts`.
 * O admin da organização LIGA a feature para si no nível 3 (binding); QUEM a
 * torna disponível é o superadmin, aqui.
 *
 * ── Por que o admin client ──────────────────────────────────────────────────
 *
 * A única policy de escrita de `organizations` é `orgs_write_platform_admin`;
 * pelo client de sessão o UPDATE de quem não é super-admin casa ZERO linhas e o
 * PostgREST devolve sucesso — a tela diria "salvo" e nada mudaria.
 */
const entradaSchema = z.object({
  organization_id: z.string().uuid(),
  ativa: z.boolean(),
});

export async function definirQualificacaoDaOrganizacao(
  input: z.infer<typeof entradaSchema>,
): Promise<DefinirQualificacaoDaOrganizacaoResult> {
  const { user } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .update({ qualificacao_jev_ativa: parsed.data.ativa })
    .eq("id", parsed.data.organization_id)
    .select("id, qualificacao_jev_ativa")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  // Zero linhas = tenant inexistente. Sem esta checagem a tela diria "salvo".
  if (!data) return { ok: false, error: "tenant_nao_encontrado" };

  const hdrs = await headers();
  await audit({
    action: "tenant.qualificacao_jev_alterada",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organization_id,
    resourceType: "organization",
    resourceId: parsed.data.organization_id,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: { ativa: parsed.data.ativa },
  });

  revalidatePath(`/admin/tenants/${parsed.data.organization_id}`);
  return { ok: true, ativa: (data.qualificacao_jev_ativa as boolean) === true };
}
