import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { provarSaldo } from "@/lib/instalacao/prova-de-credito";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * "ESSA CONFIGURAÇÃO FUNCIONA?" — a prova de que o par CHAVE + ENDEREÇO
 * responde, antes de o agente descobrir isso conversando com o cliente.
 *
 * ─── Por que esta rota existe, e por que ela NÃO é o `revalidate` ───────────
 *
 * O produto já validava a chave (o `GET /v1/models` do `provider-validators`),
 * e isso prova que ela EXISTE e é aceita pelo endpoint CANÔNICO do provedor.
 * Só que existem dois pares em jogo, não um:
 *
 *   • chave ↔ provedor canônico   → provado pelo `revalidate` (o "Validada")
 *   • chave ↔ ENDEREÇO PRÓPRIO    → provado por NADA na tela
 *
 * O segundo par é o que este arquivo resolve. A tela de Provedores oferece um
 * campo de endereço próprio para openai/openrouter/deepseek; quem aponta para
 * um gateway (proxy corporativo, LiteLLM, vLLM na máquina do cliente) configura
 * e **não tem como testar**. O erro só aparece na primeira conversa real — com
 * o cliente do outro lado.
 *
 * ─── Por que a prova é uma GERAÇÃO, e não a listagem ────────────────────────
 *
 * Está escrito em `lib/instalacao/prova-de-credito.ts`, e vale repetir aqui
 * porque é a decisão central: `GET /v1/models` responde 200 com a conta
 * zerada, e um gateway próprio frequentemente NÃO implementa a listagem. A
 * única coisa que prova o par inteiro é a coisa que o provedor cobra — uma
 * geração mínima (`max_tokens: 1`, ou o equivalente de cada provedor).
 *
 * Por isso ela é EXPLÍCITA: custa um token de verdade. Não roda sozinha num
 * GET que a tela chama ao abrir.
 *
 * ─── O que ela NÃO faz ──────────────────────────────────────────────────────
 *
 * Não grava em `llm_calls` (é diagnóstico, não uso — `provarSaldo` já cuida
 * disso), não muda o binding e não altera `validated_at` da credencial. Ela
 * RESPONDE e sai.
 */
const entradaSchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  credential_id: z.string().uuid().nullable(),
  base_url: z.string().url().nullable(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = entradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Configuração inválida para o teste."), 422, { requestId });
  }
  const { provider, model_id, credential_id, base_url } = parsed.data;

  if (credential_id === null) {
    // Sem chave não há o que provar. A mensagem diz o PRÓXIMO PASSO em vez de
    // só recusar: a escolha "chave da instalação" é legítima para publicar, mas
    // não dá para testá-la por aqui — esta rota fala em nome da ORGANIZAÇÃO.
    return fail(
      "credential_required",
      t(
        "Escolha a credencial desta empresa para testar — a chave da instalação é do arquivo .env e o teste não a alcança.",
      ),
      409,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data: row, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select("id, organization_id, provider, api_key_encrypted, api_key_iv, api_key_tag, is_active")
    .eq("id", credential_id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", t("Não foi possível consultar a credencial."), 500, { requestId });
  }
  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
  // obrigatório (CLAUDE.md, anti-pattern 10).
  if (!row || row.organization_id !== authz.org.orgId) {
    return fail("not_found", t("Credencial não encontrada."), 404, { requestId });
  }
  if (!row.is_active) {
    return fail("credential_inactive", t("Esta credencial está desativada."), 409, { requestId });
  }
  // A credencial tem de ser do MESMO provedor que o ponto — testar a chave da
  // Anthropic contra o endereço da DeepSeek devolveria "funciona" ou "falha"
  // por um motivo que não é o que o operador perguntou.
  if (row.provider !== provider) {
    return fail(
      "credential_provider_mismatch",
      t("A credencial escolhida não é do provedor deste ponto."),
      409,
      { requestId },
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(row.api_key_encrypted),
      iv: byteaToBuffer(row.api_key_iv),
      tag: byteaToBuffer(row.api_key_tag),
    });
  } catch {
    // Sem corpo de erro e sem a chave: `lib/logger.ts` proíbe conteúdo, e o
    // material da credencial é exatamente o que não pode vazar para o log.
    return fail("decrypt_failed", t("Falha ao decifrar a credencial."), 500, { requestId });
  }

  const resultado = await provarSaldo(provider, apiKey, model_id, {
    baseUrl: base_url ?? undefined,
  });

  return ok(resultado, { requestId });
}
