import { z } from "zod";

/**
 * Cabeçalhos HTTP extras de um ponto (coluna `headers` de `ai_purpose_bindings`,
 * migration 0268).
 *
 * Existem para provedores OpenAI-compatíveis que exigem cabeçalho de ROTEAMENTO
 * próprio. O caso medido: o OpenCode Go devolve `400 MissingSessionID` sem
 * `x-opencode-session`, e 200 com ele. Sem esta coluna, o painel só conseguia
 * configurar metade do que o gateway exige.
 *
 * Duas regras, e cada uma responde a um defeito concreto:
 *
 * 1. `Authorization` é RECUSADO. É o único cabeçalho que carrega a chave, e é o
 *    cofre cifrado (`ai_provider_credentials`) que a guarda — permitir
 *    sobrescrevê-lo aqui deixaria a chave em texto no banco e faria do cofre
 *    decoração. A recusa é por nome, sem diferenciar maiúsculas, e vive AQUI
 *    para valer nas duas rotas que aceitam cabeçalho (gravar e testar): duas
 *    cópias da mesma regra de segurança divergem com o tempo.
 *
 * 2. Teto de 20. Cabeçalho de roteamento é um ou dois; um objeto sem limite é um
 *    blob que ninguém revisa e que trafega em toda chamada.
 */
export const MAX_CABECALHOS_DO_PONTO = 20;

export const MOTIVO_DO_LIMITE_DE_CABECALHOS =
  "cabeçalhos: no máximo 20, e o Authorization não se define aqui — a chave fica em Credenciais";

export const cabecalhosDoPontoSchema = z
  .record(z.string(), z.string())
  .nullable()
  .optional()
  .refine(
    (cabecalhos) =>
      !cabecalhos ||
      (Object.keys(cabecalhos).length <= MAX_CABECALHOS_DO_PONTO &&
        Object.keys(cabecalhos).every((nome) => nome.toLowerCase() !== "authorization")),
    { message: MOTIVO_DO_LIMITE_DE_CABECALHOS },
  );
