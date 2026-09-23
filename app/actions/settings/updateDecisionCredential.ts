"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { TABELA_DA_CREDENCIAL_DE_PLATAFORMA } from "@/lib/ai/decisao/credencial-de-plataforma";
import { IDS_DE_PROVEDOR_DE_DECISAO } from "@/lib/ai/pontos/provedores-de-decisao";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateDecisionCredentialResult =
  | { ok: true; last4: string }
  | { ok: false; error: string; details?: unknown };

/**
 * A CHAVE DO PROVEDOR DE DECISÃO DESTA INSTALAÇÃO — cadastro e troca pelo
 * superadmin.
 *
 * ── Por que a chave é da INSTALAÇÃO, e não do tenant ────────────────────────
 *
 * A qualificação do lead (Jev/TypeSafe) julga a conversa para mover o funil. O
 * julgamento não muda com quem paga a conta, então a chave deixou de ser BYOK
 * (`ai_provider_credentials`, uma por organização) e passou a ser uma só, da
 * plataforma (migration 0267). Deixar o admin de um tenant trocá-la mudaria o
 * julgamento de TODOS — mesmo argumento de `updateMetaApp.ts` e
 * `updateGoogleOAuth.ts`.
 *
 * ── Por que a escrita vai pelo admin client ─────────────────────────────────
 *
 * `platform_decision_credentials` tem RLS LIGADA e ZERO policies, com os
 * privilégios de `anon`/`authenticated` revogados. Pelo client de sessão nada
 * acontece — nem leitura. E a chave nunca deve ser servida ao browser.
 *
 * ── NUNCA em claro ──────────────────────────────────────────────────────────
 *
 * A cifra é a MESMA das chaves de LLM (`encryptKey`, AES-256-GCM com
 * `AI_CRED_AES_KEY`) e as colunas são as mesmas de `ai_provider_credentials`.
 * Sem a chave mestra `encryptKey` LANÇA e o save RECUSA — nunca cai para texto
 * puro. Se isso acontecesse, trocaríamos "não dá para configurar" por "está
 * configurado e desprotegido", e o segundo não tem sintoma.
 *
 * O `upsert` (e não `update`) é deliberado: a linha não existe na primeira
 * configuração, e um `update` casaria zero linhas devolvendo SUCESSO.
 */
const entradaSchema = z.object({
  provider: z.enum(
    IDS_DE_PROVEDOR_DE_DECISAO as unknown as [string, ...string[]],
  ),
  /**
   * A chave em claro. Nunca persistida nem logada — cruza a fronteira uma vez e
   * vive só no escopo desta função. Piso de 8 é folga: a validação de verdade é
   * a chamada ao provedor, e barrar por tamanho no cadastro só atrapalharia quem
   * tem uma chave mais curta.
   */
  api_key: z.string().trim().min(8).max(400),
});

export type DecisionCredentialInput = z.infer<typeof entradaSchema>;

export async function updateDecisionCredential(
  input: DecisionCredentialInput,
): Promise<UpdateDecisionCredentialResult> {
  const { user } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  let cifrada: ReturnType<typeof encryptKey>;
  try {
    cifrada = encryptKey(parsed.data.api_key);
  } catch (err) {
    // Sem o log da chave por perto: o que importa é que falhou.
    return {
      ok: false,
      error:
        "cifra indisponível nesta instalação (AI_CRED_AES_KEY ausente ou inválida) — a chave não foi gravada",
      details: err instanceof Error ? err.message : undefined,
    };
  }

  const admin = createAdminClient();
  const { error } = await admin.from(TABELA_DA_CREDENCIAL_DE_PLATAFORMA).upsert(
    {
      provider: parsed.data.provider,
      api_key_encrypted: bufToBytea(cifrada.ciphertext),
      api_key_iv: bufToBytea(cifrada.iv),
      api_key_tag: bufToBytea(cifrada.tag),
      api_key_last4: cifrada.last4,
      is_active: true,
      updated_by: user.id,
    },
    { onConflict: "provider" },
  );
  if (error) return { ok: false, error: error.message };

  const hdrs = await headers();
  await audit({
    action: "platform_decision_credential.updated",
    actorUserId: user.id,
    // Sem `organizationId`: a chave é da instalação, não pertence a tenant.
    resourceType: TABELA_DA_CREDENCIAL_DE_PLATAFORMA,
    actingAsPlatformAdmin: true,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? undefined,
    // O QUE mudou, jamais a chave — só o `last4` e o provedor.
    metadata: { provider: parsed.data.provider, last4: cifrada.last4 },
  });

  return { ok: true, last4: cifrada.last4 };
}
