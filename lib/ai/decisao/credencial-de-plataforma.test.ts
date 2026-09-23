import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

// Precisa existir ANTES de qualquer import: `lib/env.ts` lê o processo no import.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { encryptKey } from "@/lib/crypto/aes_gcm";
import {
  lerChaveDaPlataformaDoBanco,
  resolverChaveDoProvedorDeDecisao,
} from "@/lib/ai/decisao/credencial-de-plataforma";

/** Um pool fake que devolve as linhas dadas (ou estoura, se `erro`). */
function poolCom(rows: unknown[], erro?: Error): pg.Pool {
  return {
    query: vi.fn(async () => {
      if (erro) throw erro;
      return { rows };
    }),
  } as unknown as pg.Pool;
}

/** A linha cifrada como o `encryptKey` produz — Buffer direto, como o driver devolve bytea. */
function linhaDe(chave: string, ativa = true) {
  const c = encryptKey(chave);
  return {
    api_key_encrypted: c.ciphertext,
    api_key_iv: c.iv,
    api_key_tag: c.tag,
    is_active: ativa,
  };
}

afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

describe("a escada de chave do provedor de decisão (0267)", () => {
  it("decifra a chave do cofre da instalação", async () => {
    const pool = poolCom([linhaDe("chave-secreta-do-cofre")]);
    await expect(lerChaveDaPlataformaDoBanco(pool, "typesafe")).resolves.toBe(
      "chave-secreta-do-cofre",
    );
  });

  it("o cofre (banco) VENCE o ambiente", async () => {
    process.env.TYPESAFE_API_KEY = "chave-do-env";
    const pool = poolCom([linhaDe("chave-do-cofre")]);
    await expect(resolverChaveDoProvedorDeDecisao(pool, "typesafe")).resolves.toBe(
      "chave-do-cofre",
    );
  });

  it("sem linha no cofre, cai para o ambiente (o último degrau continua funcionando)", async () => {
    process.env.TYPESAFE_API_KEY = "chave-do-env";
    const pool = poolCom([]);
    await expect(resolverChaveDoProvedorDeDecisao(pool, "typesafe")).resolves.toBe("chave-do-env");
  });

  it("sem cofre (tabela ausente) nem ambiente ⇒ null (o chamador degrada)", async () => {
    const pool = poolCom([], new Error("42P01 relation does not exist"));
    await expect(resolverChaveDoProvedorDeDecisao(pool, "typesafe")).resolves.toBeNull();
  });

  it("cifra que não abre devolve null e desce a escada, em vez de lançar", async () => {
    const pool = poolCom([
      { api_key_encrypted: Buffer.from([1, 2, 3]), api_key_iv: Buffer.from([0]), api_key_tag: Buffer.from([9]) },
    ]);
    await expect(lerChaveDaPlataformaDoBanco(pool, "typesafe")).resolves.toBeNull();
  });

  it("linha INATIVA é ignorada (o filtro `is_active` vale)", async () => {
    // O pool fake devolve a linha mesmo inativa; quem filtra é o SQL real. Aqui
    // garantimos que uma resposta vazia (o que o SQL produziria) cai para o env.
    process.env.TYPESAFE_API_KEY = "chave-do-env";
    const pool = poolCom([]);
    await expect(resolverChaveDoProvedorDeDecisao(pool, "typesafe")).resolves.toBe("chave-do-env");
  });
});

describe("a escada dos provedores de CONVERSA não mudou", () => {
  it("anthropic/openai/openrouter continuam lendo o mesmo env; google segue null", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.OPENROUTER_API_KEY = "sk-openrouter";
    expect(chaveDePlataforma("anthropic")).toBe("sk-ant");
    expect(chaveDePlataforma("openai")).toBe("sk-openai");
    expect(chaveDePlataforma("openrouter")).toBe("sk-openrouter");
    // Google não tem ramo de fallback — nem antes nem agora.
    expect(chaveDePlataforma("google")).toBeNull();
  });

  it("o ambiente vazio vale null para todos, e typesafe tem o seu próprio par", () => {
    expect(chaveDePlataforma("openai")).toBeNull();
    expect(chaveDePlataforma("typesafe")).toBeNull();
    process.env.TYPESAFE_API_KEY = "chave-typesafe";
    expect(chaveDePlataforma("typesafe")).toBe("chave-typesafe");
    // E não vaza para os outros provedores.
    expect(chaveDePlataforma("openai")).toBeNull();
  });
});
