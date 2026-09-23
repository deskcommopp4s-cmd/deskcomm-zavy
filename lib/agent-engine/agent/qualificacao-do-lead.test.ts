import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import type * as agenteStageSync from "@/lib/leads/agent-stage-sync";
import type { LinhaDeBinding } from "@/lib/ai/pontos/resolver";
import {
  decidirEtapa,
  escolherPasso,
  montarDimensoes,
  passoRegressivoValido,
  proximoPassoValido,
  qualificarLeadComJev,
  type AplicacaoArgs,
  type EntradaDaQualificacao,
} from "@/lib/agent-engine/agent/qualificacao-do-lead";
import type { RespostaTypeSafe } from "@/lib/ai/decisao/typesafe";

const mocks = vi.hoisted(() => ({ sincronizaEstagioDoAgente: vi.fn() }));

vi.mock("@/lib/leads/agent-stage-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof agenteStageSync>();
  return { ...actual, sincronizaEstagioDoAgente: mocks.sincronizaEstagioDoAgente };
});

/* ───────────────────────── helpers ───────────────────────── */

function respostasJev(over?: {
  etapa?: string;
  confianca?: number;
  pronto?: number;
}): Record<string, RespostaTypeSafe> {
  return {
    etapa: {
      type: "choice",
      choice: over?.etapa ?? "contacted",
      probabilities: { [over?.etapa ?? "contacted"]: 1 },
      confidence: over?.confianca ?? 0.7,
    },
    decide_a_compra: { type: "noul", noul: 0.94 },
    urgencia: {
      type: "score",
      score: 3,
      legend: { "3": "esta semana" },
      probabilities: { "3": 1 },
      confidence: 0.9,
    },
    tem_necessidade: { type: "noul", noul: 0.9 },
    pronto_pra_compra: { type: "noul", noul: over?.pronto ?? 0.83 },
  };
}

function bodyJev(respostas: Record<string, RespostaTypeSafe>): Response {
  return new Response(
    JSON.stringify({ model: "jev-1.13.0", answers: respostas, usage: { input_tokens: 10, output_tokens: 4 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

interface QueryFake {
  pool: pg.Pool;
  queries: { sql: string; params: unknown[] }[];
}

function poolFake(): QueryFake {
  const queries: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ");
    queries.push({ sql: s, params: params ?? [] });
    if (s.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    if (s.includes("insert into crm_lead_activities")) return { rows: [] };
    if (s.includes("insert into lead_state")) {
      return { rows: [leadState("qualified")] };
    }
    if (s.includes("from lead_state")) return { rows: [leadState("qualifying")] };
    if (s.includes("from crm_leads l")) {
      return {
        rows: [
          {
            id: "lead-1",
            organization_id: "org-1",
            pipeline_id: "pipe-1",
            status: "open",
            last_activity_at: null,
            created_at: "2026-09-01T00:00:00Z",
          },
        ],
      };
    }
    if (s.includes("from crm_pipelines")) return { rows: [{ id: "pipe-1" }] };
    if (s.includes("update crm_leads")) return { rows: [] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, queries };
}

function leadState(stage: string) {
  return {
    id: "state-1",
    organization_id: "org-1",
    contact_id: "contact-1",
    stage,
    qualification: {},
    next_action: null,
    next_action_seq: 0,
    updated_at: new Date(),
  };
}

const BINDING: LinhaDeBinding = {
  purpose: "qualificacao_do_lead",
  provider: "typesafe",
  credential_id: "cred-1",
  model_id: "jev-latest",
  base_url: null,
  is_enabled: true,
};

function entrada(pool: pg.Pool): EntradaDaQualificacao {
  return {
    pool,
    admin: {} as SupabaseClient,
    organizationId: "org-1",
    contactId: "contact-1",
    jobId: "job-1",
    agentId: "agent-1",
    context: { messages: [] } as unknown as LeadContext,
    currentStage: "contacted",
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/* ───────────────────────── regras puras ───────────────────────── */

describe("decidirEtapa — probabilidade → etapa (pura)", () => {
  it("usa a Choice quando a confiança basta", () => {
    expect(decidirEtapa(respostasJev({ etapa: "negotiating", pronto: 0.2 }), "contacted")).toEqual({
      etapa: "negotiating",
    });
  });

  it("pronto_pra_compra ≥ 0,8 eleva ao menos a qualified (o caso medido)", () => {
    expect(decidirEtapa(respostasJev({ etapa: "contacted", pronto: 0.83 }), "contacted")).toEqual({
      etapa: "qualified",
    });
    // Já em negotiating: não regride para qualified.
    expect(decidirEtapa(respostasJev({ etapa: "negotiating", pronto: 0.9 }), "contacted")).toEqual({
      etapa: "negotiating",
    });
  });

  it("confiança baixa / escolha desconhecida / ausência vira indefinido", () => {
    expect(decidirEtapa(respostasJev({ confianca: 0.1 }), "contacted")).toMatchObject({
      indefinido: true,
      porque: "confianca_baixa",
    });
    expect(decidirEtapa(respostasJev({ etapa: "foobar" }), "contacted")).toMatchObject({
      indefinido: true,
      porque: "etapa_desconhecida",
    });
    expect(decidirEtapa({}, "contacted")).toMatchObject({
      indefinido: true,
      porque: "sem_choice_de_etapa",
    });
  });
});

describe("proximoPassoValido — só anda para frente, um passo por vez", () => {
  it("devolve o PRIMEIRO passo do caminho, nunca o salto", () => {
    expect(proximoPassoValido("new", "qualified")).toBe("contacted");
    expect(proximoPassoValido("contacted", "qualified")).toBe("qualifying");
    expect(proximoPassoValido("qualified", "qualified")).toBeNull();
  });

  it("não regride e não sai de terminal", () => {
    expect(proximoPassoValido("negotiating", "qualifying")).toBeNull();
    expect(proximoPassoValido("won", "negotiating")).toBeNull();
  });
});

describe("passoRegressivoValido + escolherPasso — a regressão de funil", () => {
  it("devolve o PRIMEIRO passo de volta (BFS inverso), nunca o salto", () => {
    expect(passoRegressivoValido("negotiating", "qualifying")).toBe("qualified");
    expect(passoRegressivoValido("qualified", "contacted")).toBe("qualifying");
    // `lost` tem vários predecessores válidos; ir para `qualified` é um passo
    // direto porque `qualified → lost` é transição de avanço.
    expect(passoRegressivoValido("lost", "qualified")).toBe("qualified");
    expect(passoRegressivoValido("won", "negotiating")).toBe("negotiating");
  });

  it("recusa alvo que não é ancestral (salto inválido) e o no-op", () => {
    expect(passoRegressivoValido("qualifying", "lost")).toBeNull();
    expect(passoRegressivoValido("new", "negotiating")).toBeNull();
    expect(passoRegressivoValido("contacted", "contacted")).toBeNull();
  });

  it("(c) regressão DESLIGADA (default) ⇒ não regride", () => {
    expect(escolherPasso("negotiating", "qualifying", false)).toEqual({
      passo: null,
      regressao: false,
    });
  });

  it("(d) regressão LIGADA ⇒ regride por UM passo válido, e recusa o salto inválido", () => {
    expect(escolherPasso("negotiating", "qualifying", true)).toEqual({
      passo: "qualified",
      regressao: true,
    });
    // Alvo inalcançável em qualquer direção (`won` é terminal e `lost` não é seu
    // ancestral): nada é movido mesmo com a regressão ligada.
    expect(escolherPasso("won", "lost", true)).toEqual({
      passo: null,
      regressao: true,
    });
    // O caminho de IDA continua tendo prioridade — não vira regressão.
    expect(escolherPasso("contacted", "qualified", true)).toEqual({
      passo: "qualifying",
      regressao: false,
    });
  });
});

describe("montarDimensoes", () => {
  it("extrai as cinco dimensões tipadas", () => {
    expect(montarDimensoes(respostasJev())).toEqual({
      etapa: "contacted",
      etapa_confianca: 0.7,
      decide_a_compra: 0.94,
      urgencia: 3,
      tem_necessidade: 0.9,
      pronto_pra_compra: 0.83,
    });
  });
});

/* ───────────────────────── orquestração ───────────────────────── */

describe("qualificarLeadComJev", () => {
  beforeEach(() => mocks.sincronizaEstagioDoAgente.mockReset());

  it("(a) desligado GLOBAL ⇒ usado:false e o classificador antigo assume; nada é chamado", async () => {
    const { pool } = poolFake();
    const fetchImpl = vi.fn();
    const aplicar = vi.fn();

    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      aplicar,
    });

    expect(r).toEqual({ usado: false, motivo: "desligado_global" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(aplicar).not.toHaveBeenCalled();
  });

  it("(a) desligado por ORGANIZAÇÃO (sem binding, ou binding desabilitado) ⇒ usado:false", async () => {
    const { pool } = poolFake();
    const fetchImpl = vi.fn();

    const semBinding = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(semBinding).toEqual({ usado: false, motivo: "desligado_org" });

    const desabilitado = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => ({ ...BINDING, is_enabled: false }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(desabilitado).toEqual({ usado: false, motivo: "desligado_org" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(b) ligado + resposta da TypeSafe ⇒ a etapa muda e a atividade é gravada", async () => {
    const { pool, queries } = poolFake();
    const aplicar = vi.fn(async (args: AplicacaoArgs) => {
      return {
        movido: true,
        motivo: "movido" as const,
        leadId: "lead-1",
        passo: proximoPassoValido(args.currentStage, args.alvo) ?? undefined,
      };
    });

    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      fetchImpl: (async () => bodyJev(respostasJev({ etapa: "contacted", pronto: 0.83 }))) as unknown as typeof fetch,
      sleep: async () => {},
      aplicar,
    });

    // A Choice disse "contacted", mas pronto_pra_compra 0,83 eleva a qualified;
    // de "contacted" o primeiro passo válido é "qualifying".
    expect(aplicar).toHaveBeenCalledTimes(1);
    const args = aplicar.mock.calls[0]![0];
    expect(args.alvo).toBe("qualified");
    expect(args.dimensoes.pronto_pra_compra).toBe(0.83);
    expect(args.dimensoes.decide_a_compra).toBe(0.94);

    expect(r).toMatchObject({
      usado: true,
      movido: true,
      motivo: "movido",
      etapa: "qualified",
      passo: "qualifying",
    });
    // A telemetria do provedor de decisão vai para `llm_calls`.
    expect(queries.some((q) => q.sql.includes("insert into llm_calls"))).toBe(true);
  });

  it("(c) erro/timeout da TypeSafe ⇒ usado:false, o turno segue e nada é aplicado", async () => {
    const { pool } = poolFake();
    const aplicar = vi.fn();

    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
      sleep: async () => {},
      aplicar,
    });

    expect(r).toMatchObject({ usado: false, motivo: "falha_provedor" });
    expect(aplicar).not.toHaveBeenCalled();
  });

  it("sem credencial / provedor desconhecido / resposta indefinida ⇒ usado:false", async () => {
    const { pool } = poolFake();

    const semCred = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(semCred).toEqual({ usado: false, motivo: "sem_credencial" });

    const outroProvedor = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => ({ ...BINDING, provider: "openai" }),
    });
    expect(outroProvedor).toMatchObject({ usado: false, motivo: "provedor_desconhecido" });

    const indefinida = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      fetchImpl: (async () => bodyJev(respostasJev({ confianca: 0.05 }))) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(indefinida).toMatchObject({ usado: false, motivo: "resposta_indefinida" });
  });

  it("(b) aplicação PADRÃO: grava lead_state, atividade e o campo do lead", async () => {
    mocks.sincronizaEstagioDoAgente.mockResolvedValue({
      moveu: true,
      motivo: "movido",
      leadId: "lead-1",
      stageName: "Proposta",
    });
    const { pool, queries } = poolFake();

    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      // NÍVEL 2: a mudança acrescentou esta porta ao contrato de deps; os testes
      // que medem os níveis 1 e 3 a deixam ABERTA para isolar o que medem.
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      // etapa "qualified" e pronto 0,83: de "qualifying" o passo é "qualified".
      fetchImpl: (async () => bodyJev(respostasJev({ etapa: "qualified", pronto: 0.83 }))) as unknown as typeof fetch,
      sleep: async () => {},
    });

    // currentStage da entrada é "contacted": primeiro passo para "qualified" é
    // "qualifying".
    expect(r).toMatchObject({ usado: true, movido: true, passo: "qualifying" });

    const atividade = queries.find((q) => q.sql.includes("insert into crm_lead_activities"));
    expect(atividade, "a atividade da decisão não foi gravada").toBeDefined();
    expect(atividade!.params).toContain("stage_changed");
    expect(atividade!.params).toContain("agent_qualification");

    const campoDoLead = queries.find((q) => q.sql.includes("update crm_leads"));
    expect(campoDoLead, "o campo do lead não foi gravado").toBeDefined();
    expect(JSON.stringify(campoDoLead!.params)).toContain("qualificacao_jev");

    const espelho = mocks.sincronizaEstagioDoAgente.mock.calls[0]![1] as { passo: string };
    expect(espelho.passo).toBe("qualifying");
  });

  it("(a) NÍVEL 2 desligado (superadmin não liberou) ⇒ usado:false e o JEV nem é chamado", async () => {
    const { pool } = poolFake();
    const fetchImpl = vi.fn();
    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      lerHabOrg: async () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ usado: false, motivo: "desligado_pelo_superadmin" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(b) os TRÊS níveis ligados ⇒ usa o JEV", async () => {
    const { pool } = poolFake();
    const fetchImpl = vi.fn(async () => bodyJev(respostasJev({ etapa: "contacted", pronto: 0.83 })));
    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ usado: true, etapa: "qualified", passo: "qualifying" });
  });

  it("(c) regressão DESLIGADA (default) ⇒ o alvo atrás do atual NÃO move o card", async () => {
    const { pool } = poolFake();
    // `BINDING` + credencial OK; a resposta manda `qualifying`, atrás do atual
    // `negotiating`. Sem a regressão ligada, `movido:false` e nada é aplicado.
    const r = await qualificarLeadComJev({ ...entrada(pool), currentStage: "negotiating" }, {
      lerGlobal: async () => true,
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      lerRegressao: async () => false,
      fetchImpl: (async () => bodyJev(respostasJev({ etapa: "qualifying", pronto: 0.1 }))) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(r).toMatchObject({ usado: true, movido: false, motivo: "transicao_invalida" });
  });

  it("(d) regressão LIGADA ⇒ regride UM passo válido", async () => {
    const { pool } = poolFake();
    const r = await qualificarLeadComJev({ ...entrada(pool), currentStage: "negotiating" }, {
      lerGlobal: async () => true,
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial: async () => "chave",
      lerRegressao: async () => true,
      fetchImpl: (async () => bodyJev(respostasJev({ etapa: "qualifying", pronto: 0.1 }))) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(r).toMatchObject({ usado: true, movido: true, etapa: "qualifying", passo: "qualified" });
  });

  it("(e) a chave vem do cofre da plataforma (banco) ANTES do ambiente", async () => {
    const { pool } = poolFake();
    const lerCredencial = vi.fn(async () => "chave-do-cofre");
    const r = await qualificarLeadComJev(entrada(pool), {
      lerGlobal: async () => true,
      lerHabOrg: async () => true,
      lerBindingDoPonto: async () => BINDING,
      lerCredencial,
      fetchImpl: (async () => bodyJev(respostasJev({ etapa: "contacted" }))) as unknown as typeof fetch,
      sleep: async () => {},
    });
    // A dep é chamada por PROVIDER (não mais por credentialId): a chave deixou
    // de ser BYOK. O default (`lerCredencialDaPlataforma`) resolve cofre → env.
    expect(lerCredencial).toHaveBeenCalledWith(pool, "typesafe");
    expect(r).toMatchObject({ usado: true });
  });
});
