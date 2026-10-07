/**
 * A GUARDA DA LEITURA DA IA DO SUPORTE (migration 0268 §"read-only").
 *
 * ── O DEFEITO QUE ELA IMPEDE ────────────────────────────────────────────────
 *
 * A IA de suporte lê a conta do cliente com `service_role` — e
 * `service_role.rolbypassrls = true` (medido): as policies RESTRICTIVE que
 * barram o humano NÃO a alcançam. Se ela ler pela conexão de ESCRITA, ela
 * altera a conta do cliente e nenhum teste de RLS acusa.
 *
 * A trava é a CONEXÃO em `default_transaction_read_only=on`, e o próprio
 * servidor recusa a escrita. Esta guarda prova TRÊS coisas, e as duas últimas
 * são as que importam:
 *
 *   1. o modo está ATIVO na conexão que o módulo entrega (senão a trava não
 *      existe — foi o que aconteceu quando o modo vinha por `options`: o pooler
 *      do Supabase descarta o parâmetro e a sessão nascia `off`);
 *   2. a conexão RECUSA escrita;
 *   3. a conexão NORMAL ACEITA a mesma escrita (controle positivo — sem ele,
 *      "recusou" é indistinguível de "o instrumento está morto").
 *
 * ── POR QUE PELA VIA DE PRODUÇÃO ────────────────────────────────────────────
 *
 * O pool vem de `poolDeLeituraDoSuporte`, não de um `new Pool` montado aqui.
 * Um teste que montasse o próprio pool provaria a ideia, não o código — e a
 * ideia já estava errada uma vez (o `options`).
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  fecharPoolDeLeituraDoSuporte,
  poolDeLeituraDoSuporte,
} from "@/lib/support/leitura-readonly";

const DSN = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;

/** O pool REAL do módulo — a via de produção. */
const leitura = poolDeLeituraDoSuporte(DSN);
/** O controle: conexão normal, sem o modo. */
const normal = new pg.Pool({ connectionString: DSN, max: 2 });

afterAll(async () => {
  await fecharPoolDeLeituraDoSuporte();
  await normal.end();
});

describe("a IA do suporte só LÊ — a trava é a conexão, não a policy", () => {
  it("o modo está ATIVO na conexão que o módulo entrega", async () => {
    // A medição que teria pegado o `options` morto: `off` significa trava ausente.
    const { rows } = await leitura.query<{ v: string }>("show default_transaction_read_only");
    expect(rows[0]?.v).toBe("on");
  });

  it("a conexão de leitura RECUSA escrita (a trava existe)", async () => {
    // `where false` não altera linha nenhuma: o que se mede é a RECUSA do
    // servidor, não o efeito. Um UPDATE que casasse linhas mediria duas coisas.
    await expect(
      leitura.query("update organizations set display_name = display_name where false"),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it("CONTROLE POSITIVO: a conexão normal ACEITA a mesma escrita", async () => {
    // Se ISTO falhar, a recusa de cima não prova nada — seria um banco quebrado.
    const r = await normal.query("update organizations set display_name = display_name where false");
    expect(r.rowCount).toBe(0);
  });
});
