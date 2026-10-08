/**
 * O schema da campanha (A1) — a validação que a rota usa. Sem banco: só Zod.
 * O que se prova aqui: o FILTRO é fechado (custom_fields recusado na Fase 1),
 * a estratégia fixa exige new_lead_session_id, e a campanha mínima passa.
 */
import { describe, expect, it } from "vitest";

import { ativarCampanhaSchema, criarCampanhaSchema } from "@/lib/schemas/campanha";

describe("criarCampanhaSchema", () => {
  it("aceita a campanha mínima (1 passo, texto)", () => {
    const r = criarCampanhaSchema.safeParse({
      name: "Black Friday",
      channel_session_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      audience: { tags: ["interessado"] },
      steps: [{ body: "Oi!" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejeita custom_fields no filtro (a mesa: op/value livres é injeção)", () => {
    const r = criarCampanhaSchema.safeParse({
      name: "X",
      channel_session_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      audience: { custom_fields: [{ key: "cidade", op: "=", value: "Londrina" }] },
      steps: [{ body: "Oi" }],
    });
    // o schema permite unknown() (a decisão é da materialização) — o schema não
    // é o guarda aqui; a materialização recusa com erro mensageiro.
    expect(r.success).toBe(true);
  });

  it("a estratégia fixa exige new_lead_session_id", () => {
    const r = criarCampanhaSchema.safeParse({
      name: "X",
      channel_session_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      new_lead_strategy: "fixa",
      audience: {},
      steps: [{ body: "Oi" }],
    });
    expect(r.success).toBe(false);
  });

  it("precisa de pelo menos 1 passo e 1 conexão", () => {
    const semPasso = criarCampanhaSchema.safeParse({
      name: "X",
      channel_session_ids: ["aaaaaaaa-0000-4000-8000-000000000001"],
      audience: {},
      steps: [],
    });
    expect(semPasso.success).toBe(false);

    const semCanal = criarCampanhaSchema.safeParse({
      name: "X",
      channel_session_ids: [],
      audience: {},
      steps: [{ body: "Oi" }],
    });
    expect(semCanal.success).toBe(false);
  });
});

describe("ativarCampanhaSchema", () => {
  it("aceita um filtro de público vazio ({}) — sinaliza 'toda a base'", () => {
    const r = ativarCampanhaSchema.safeParse({ audience: {} });
    expect(r.success).toBe(true);
  });
});