import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { provarSaldo } from "@/lib/instalacao/prova-de-credito";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

/**
 * "ESSA CONFIGURAÇÃO FUNCIONA?" — o teste que faltava na tela de Provedores.
 *
 * A tela de Credenciais já tinha o "Validada", que bate no `GET /v1/models` e
 * por isso prova só que a chave EXISTE. O que ninguém provava era o par que o
 * runtime realmente usa: a chave contra o ENDEREÇO PRÓPRIO que o operador
 * configurou. Sem esta rota, o erro do gateway aparecia na primeira conversa
 * real — com o cliente do outro lado.
 *
 * O que este teste guarda, além do caminho feliz:
 *   • admin, e só admin;
 *   • a credencial é da ORGANIZAÇÃO de quem pediu (service role bypassa RLS);
 *   • a credencial é do MESMO provedor do ponto — testar a chave da Anthropic
 *     contra o endereço da DeepSeek responderia outra pergunta;
 *   • a falha do provedor chega ao operador com MOTIVO, não como "erro";
 *   • a chave NUNCA vaza para a resposta.
 */
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
// `requireSupportWrite` sem o mock devolve 503 (falta o segredo de impersonate
// no ambiente de teste), e aí TODO caso mediria 503 em vez do que ele pergunta.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/instalacao/prova-de-credito", () => ({ provarSaldo: vi.fn() }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: vi.fn(() => "sk-da-org-que-nao-pode-vazar"),
  byteaToBuffer: vi.fn(() => Buffer.from("")),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CRED_ID = "44444444-4444-4444-8444-444444444444";

let credencial: Record<string, unknown> | null = null;

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/providers/test", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const corpo = (over: Record<string, unknown> = {}) => ({
  provider: "openai",
  model_id: "gpt-5-mini",
  credential_id: CRED_ID,
  base_url: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  credencial = {
    id: CRED_ID,
    organization_id: ORG_ID,
    provider: "openai",
    api_key_encrypted: "\\x00",
    api_key_iv: "\\x00",
    api_key_tag: "\\x00",
    is_active: true,
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID, name: "Org", role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);

  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: credencial, error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => query,
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(provarSaldo).mockResolvedValue({ ok: true });
});

describe("testar a configuração de um ponto de IA", () => {
  it("exige ADMIN — é diagnóstico com credencial, não leitura", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await POST(req(corpo()));
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(provarSaldo).not.toHaveBeenCalled();
  });

  it("credencial de OUTRA organização não é testada — service role bypassa RLS", async () => {
    credencial = { ...credencial, organization_id: OUTRA_ORG };
    const res = await POST(req(corpo()));
    expect(res.status).toBe(404);
    expect(provarSaldo).not.toHaveBeenCalled();
  });

  it("credencial de OUTRO provedor é recusada — responderia outra pergunta", async () => {
    credencial = { ...credencial, provider: "deepseek" };
    const res = await POST(req(corpo({ provider: "openai" })));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("credential_provider_mismatch");
    expect(provarSaldo).not.toHaveBeenCalled();
  });

  it("sem credencial da empresa, diz o próximo passo em vez de só recusar", async () => {
    const res = await POST(req(corpo({ credential_id: null })));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("credential_required");
    expect(provarSaldo).not.toHaveBeenCalled();
  });

  it("repassa o ENDEREÇO PRÓPRIO para a prova — é o par que se quer verificar", async () => {
    await POST(req(corpo({ base_url: "https://gateway.ejemplo.com/v1" })));
    expect(provarSaldo).toHaveBeenCalledWith(
      "openai",
      "sk-da-org-que-nao-pode-vazar",
      "gpt-5-mini",
      { baseUrl: "https://gateway.ejemplo.com/v1" },
    );
    expect(decryptKey).toHaveBeenCalled();
    expect(byteaToBuffer).toHaveBeenCalled();
  });

  it("sem endereço próprio, a prova usa o padrão do provedor (undefined, não string vazia)", async () => {
    await POST(req(corpo({ base_url: null })));
    expect(provarSaldo).toHaveBeenCalledWith("openai", expect.any(String), "gpt-5-mini", {
      baseUrl: undefined,
    });
  });

  it("a falha do provedor chega com MOTIVO — não vira um 'erro' genérico", async () => {
    vi.mocked(provarSaldo).mockResolvedValue({
      ok: false,
      codigo: "saldo_insuficiente",
      mensagem: "A conta está sem crédito.",
      httpStatus: 402,
    });
    const res = await POST(req(corpo()));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ ok: false, codigo: "saldo_insuficiente" });
  });

  it("a chave decifrada NUNCA aparece na resposta", async () => {
    await POST(req(corpo()));
    const res = await POST(req(corpo()));
    expect(JSON.stringify(await res.json())).not.toContain("sk-da-org-que-nao-pode-vazar");
  });

  it("corpo fora do contrato morre em 422, sem tocar o banco", async () => {
    const res = await POST(req({ provider: "openai" }));
    expect(res.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
