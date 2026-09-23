/**
 * A CREDENCIAL DE PLATAFORMA DO PROVEDOR DE DECISÃO — o cofre do superadmin.
 *
 * ─── Por que a chave é da INSTALAÇÃO, e não BYOK ─────────────────────────────
 *
 * Até aqui a chave do Jev (TypeSafe) era cadastrada por organização
 * (`ai_provider_credentials`, que tem `organization_id NOT NULL`). O dono do
 * produto decidiu o contrário: a chave é DA PLATAFORMA — o superadmin cadastra
 * UMA vez e todas as organizações usam. Uma chave por tenant para um provedor de
 * decisão é custo de operação sem ganho: o julgamento não muda com quem paga.
 *
 * ─── A ESCADA DE CHAVE: banco → ambiente ─────────────────────────────────────
 *
 * A ordem é a mesma que o resto do produto pratica (`chaveDePlataforma` em
 * `lib/ai/runtime/agent.ts` é o ÚLTIMO degrau, o piso de rollback):
 *
 *   1. O cofre da INSTALAÇÃO (`platform_decision_credentials`, migration 0267),
 *      decifrado com `decryptKey` (AES-256-GCM, `AI_CRED_AES_KEY`).
 *   2. O AMBIENTE — `chaveDePlataforma(provider)`, preservado como último
 *      degrau. O `.env` continua valendo quando não há linha no cofre.
 *
 * O banco VENCE o ambiente. O que NÃO se mistura: uma linha meio-preenchida no
 * cofre (sem par completo de colunas) é lida como ausente e a escada desce — não
 * se junta byte de um lado com chave do outro.
 *
 * ─── NUNCA em claro ─────────────────────────────────────────────────────────
 *
 * A única leitura que devolve a chave é esta função interna; nenhuma rota a
 * expõe. O que a tela mostra é `api_key_last4`, gravado pela action no momento
 * do cadastro. Quando `AI_CRED_AES_KEY` não está configurada, `encryptKey`
 * lança e o cadastro RECUSA — nunca cai para texto puro.
 */
import type pg from "pg";

import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

/** O cofre da INSTALAÇÃO (migration 0267). */
export const TABELA_DA_CREDENCIAL_DE_PLATAFORMA = "platform_decision_credentials";

interface LinhaCifrada {
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
}

/**
 * Lê e decifra a chave de um provedor de decisão do cofre da instalação.
 *
 * `null` cobre os quatro casos em que a escada deve descer para o ambiente:
 * tabela ainda não migrada, provedor sem linha, linha inativa, ou pacote
 * cifrado que não decifra. Nenhum deles é erro para o chamador — todos são
 * "não há credencial de plataforma aqui".
 */
export async function lerChaveDaPlataformaDoBanco(
  db: pg.Pool,
  provider: string,
): Promise<string | null> {
  let row: LinhaCifrada | undefined;
  try {
    const { rows } = await db.query<LinhaCifrada>(
      `select api_key_encrypted, api_key_iv, api_key_tag
         from ${TABELA_DA_CREDENCIAL_DE_PLATAFORMA}
        where provider = $1 and is_active
        limit 1`,
      [provider],
    );
    row = rows[0];
  } catch {
    // Clone que ainda não aplicou a 0267 (42P01): sem cofre, vale o ambiente.
    return null;
  }
  if (row === undefined) return null;
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(row.api_key_encrypted),
      iv: byteaToBuffer(row.api_key_iv),
      tag: byteaToBuffer(row.api_key_tag),
    });
  } catch {
    // Cifra que não abre (chave mestra trocada) é misconfiguração silenciosa
    // daqui; quem decide é a escada. Não lança: um cofre quebrado não pode
    // derrubar o turno — cai para o ambiente, e no limite para o classificador.
    return null;
  }
}

/**
 * A ESCADA COMPLETA do provedor de decisão: cofre da instalação → ambiente.
 *
 * Usada pela orquestração da qualificação (`qualificacao-do-lead.ts`). Não lança
 * em nenhum caminho: sem chave nenhuma devolve `null`, e o chamador degrada
 * para o classificador de etapa atual.
 */
export async function resolverChaveDoProvedorDeDecisao(
  db: pg.Pool,
  provider: string,
): Promise<string | null> {
  const doBanco = await lerChaveDaPlataformaDoBanco(db, provider);
  if (doBanco !== null) return doBanco;
  // Último degrau: o ambiente. É o piso de rollback de quem instalou colando a
  // chave no `.env` e nunca abriu a tela nova.
  return chaveDePlataforma(provider);
}
