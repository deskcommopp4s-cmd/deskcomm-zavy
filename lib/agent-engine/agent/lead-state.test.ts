import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../queue/queue";
import { applyLeadStateUpdate } from "./lead-state";

/**
 * O fake responde às duas perguntas de `applyLeadStateUpdate`: o estágio ATUAL
 * (`from lead_state`) e o upsert (o CTE com `insert into lead_state`).
 */
function dbFake(stage: string): Queryable {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("from lead_state where")) {
      return {
        rows: [
          {
            id: "state-1",
            organization_id: "org-1",
            contact_id: "contact-1",
            stage,
            qualification: {},
            next_action: null,
            next_action_seq: 0,
            updated_at: new Date(),
          },
        ],
      };
    }
    if (sql.includes("insert into lead_state")) {
      return { rows: [{ stage }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as Queryable;
}

const ids = { tenantId: "org-1", leadId: "contact-1" };

describe("applyLeadStateUpdate — regressão é opt-in", () => {
  it("SEM a flag, regressão continua recusada (o caminho do modelo não muda)", async () => {
    const r = await applyLeadStateUpdate(dbFake("negotiating"), ids, { stage: "qualifying" });
    expect(r.ok).toBe(false);
  });

  it("COM a flag, aceita UM passo para trás (a volta de um avanço válido)", async () => {
    const r = await applyLeadStateUpdate(
      dbFake("negotiating"),
      ids,
      { stage: "qualified", reason: "qualificação automática (JEV): negotiating → qualified" },
      { permitirRegressao: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transition).toMatchObject({ from: "negotiating", to: "qualified" });
    }
  });

  it("MESMO com a flag, um SALTO inválido é recusado", async () => {
    const r = await applyLeadStateUpdate(
      dbFake("negotiating"),
      ids,
      { stage: "contacted" },
      { permitirRegressao: true },
    );
    expect(r.ok).toBe(false);
  });

  it("avanço continua aceito sem a flag (comportamento de sempre)", async () => {
    const r = await applyLeadStateUpdate(dbFake("contacted"), ids, { stage: "qualifying" });
    expect(r.ok).toBe(true);
  });
});
