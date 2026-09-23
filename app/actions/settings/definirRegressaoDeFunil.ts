"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { regressaoDeFunilAtivada } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export type ErroRegressaoDeFunil =
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "falha";

export type RespostaRegressaoDeFunil =
  | { ok: true; ativa: boolean }
  | { ok: false; erro: ErroRegressaoDeFunil };

/**
 * REGRESSÃO DE FUNIL — o admin da CONTA liga ou desliga.
 *
 * `organizations.settings.crm.regressao_de_funil_ativada` (migration 0267). Por
 * default é `false`: o agente só AVANÇA a etapa, como sempre. Ligada, o Jev pode
 * trazer o card UM passo para trás quando julgar que o lead retrocedeu —
 * respeitando as transições válidas do funil (não é pular para qualquer lugar).
 *
 * ── Por que o admin client, e merge ─────────────────────────────────────────
 *
 * Mesma razão de `updateTenant.ts`: a única policy de escrita de `organizations`
 * é do super-admin, então o client de sessão casaria zero linhas devolvendo
 * sucesso. Aqui é uma chave dentro de `settings.crm`, e a leitura-merge-escrita
 * PRESERVA as irmãs (`cliente_pela_agenda` e o que mais morar em `crm`) — um
 * `settings = '{"crm": {...}}'` cru apagaria o resto.
 *
 * O gate de papel é resolvido de fonte confiável (`resolveActiveOrg`), nunca do
 * corpo do request.
 */
export async function definirRegressaoDeFunil(
  ativa: boolean,
): Promise<RespostaRegressaoDeFunil> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ativa);
  if (!entrada.success) return { ok: false, erro: "falha" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return { ok: false, erro: "sem_permissao" };
  }

  const admin = createAdminClient();
  const { data: orgRow, error: readErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (readErr) {
    logger.error("[regressao-de-funil] não deu para ler as configurações", {
      organization_id: org.orgId,
      code: readErr.code,
    });
    return { ok: false, erro: "falha" };
  }

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const crmAtual =
    settings.crm && typeof settings.crm === "object" && !Array.isArray(settings.crm)
      ? (settings.crm as Record<string, unknown>)
      : {};
  const nextSettings = {
    ...settings,
    crm: { ...crmAtual, regressao_de_funil_ativada: entrada.data },
  };

  const { data, error } = await admin
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", org.orgId)
    .select("settings")
    .maybeSingle();
  if (error || !data) {
    logger.error("[regressao-de-funil] a gravação falhou", {
      organization_id: org.orgId,
      code: error?.code,
    });
    return { ok: false, erro: "falha" };
  }

  const hdrs = await headers();
  await audit({
    action: "crm.regressao_de_funil_alterada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: { ativa: entrada.data },
  });

  revalidatePath("/app/settings/tenant/pipelines");
  return { ok: true, ativa: regressaoDeFunilAtivada(data.settings) };
}
