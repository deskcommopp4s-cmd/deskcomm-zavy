/**
 * A PRATELEIRA DOS PROVEDORES DE DECISÃO — paralela à de conversa, de propósito.
 *
 * ─── Por que ela existe, e por que separada ──────────────────────────────────
 *
 * `lib/ai/pontos/provedores.ts` lista os provedores de CONVERSA: entram no
 * `createDefaultRegistry` e a fábrica devolve um `LanguageModel` do AI SDK. Um
 * provedor de DECISÃO não devolve texto — devolve julgamento tipado (escolha,
 * probabilidade, confiança) que o código consome. Colocá-lo naquela lista
 * quebraria a prateleira: a tela o ofereceria para `agent_turn` e a chamada
 * morreria no `generateText`.
 *
 * A TypeSafe (modelo Jev) é o primeiro desta prateleira. O dono do produto
 * deixou a porta escrita: "IAs como a JEV começarão a surgir, tem que ter opção
 * do usuário escolher o provedor". Por isso a estrutura é a mesma da lista de
 * conversa — id, rótulo, quando usar, onde pegar a chave — e um provedor novo
 * entra AQUI sem tocar em nada que já roda.
 *
 * ─── O que um SEGUNDO provedor de decisão precisa fazer para entrar ──────────
 *
 *   1. Acrescentar uma entrada nesta lista (id, rótulo, quandoUsar, link da
 *      chave, `modeloPadrao`, `modelos`, `validarChave`).
 *   2. Implementar `validarChave` no mesmo contrato de `provider-validators.ts`
 *      (`{ ok:true, models }` | `{ ok:false, error }`).
 *   3. Nada mais. O ponto `qualificacao_do_lead` resolve o provedor pelo id do
 *      binding (`ai_purpose_bindings.provider`), e a rota de credenciais aceita
 *      qualquer id desta lista (ver `IDS_DE_PROVEDOR_DE_DECISAO`).
 *
 * O que NÃO precisa: mexer no registry de conversa, no resolvedor de pontos, no
 * seam `runModelCall`, ou na tela. É o par que este repo já viu divergir em
 * silêncio (catálogo × preço); por isso há teste casando a lista com o ponto.
 */
import { TYPESAFE_MODELO_PADRAO, validarChaveTypeSafe } from "@/lib/ai/decisao/typesafe";

/** Um modelo que o provedor de decisão sabe executar. */
export interface ModeloDeDecisao {
  id: string;
  rotulo: string;
}

export interface ProvedorDeDecisao {
  id: string;
  /** Nome como o operador conhece. */
  rotulo: string;
  /** Uma frase sobre quando escolher este, para quem não acompanha o mercado. */
  quandoUsar: string;
  /** Onde o operador pega a chave — a tela mostra o link. */
  ondePegarAChave: string;
  /** Como a chave começa — vira placeholder do campo. */
  prefixoDaChave: string;
  /** O modelo usado quando o binding não escolher um explicitamente. */
  modeloPadrao: string;
  /** Os modelos que este provedor de decisão sabe executar. */
  modelos: readonly ModeloDeDecisao[];
  /** Valida a chave contra o provedor. Mesmo contrato de `provider-validators.ts`. */
  validarChave: (
    apiKey: string,
  ) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
}

export const PROVEDORES_DE_DECISAO = [
  {
    id: "typesafe",
    rotulo: "TypeSafe (Jev)",
    quandoUsar:
      "Não conversa com o cliente: lê a conversa e devolve um julgamento pronto sobre ela — em que etapa o lead está, se decide a compra, qual a urgência — que o sistema usa para mover o funil na hora.",
    ondePegarAChave: "https://console.typesafe.ai/keys",
    prefixoDaChave: "apikey_…",
    modeloPadrao: TYPESAFE_MODELO_PADRAO,
    modelos: [{ id: TYPESAFE_MODELO_PADRAO, rotulo: "Jev (última versão)" }],
    validarChave: validarChaveTypeSafe,
  },
] as const satisfies readonly ProvedorDeDecisao[];

/**
 * Só os ids, na forma que o `z.enum` exige (tupla não-vazia de literais).
 *
 * Existe para os pontos de ESCRITA derivarem daqui em vez de repetir a lista —
 * a rota de credenciais precisava aceitar a chave da TypeSafe sem uma segunda
 * cópia da lista que envelhece sozinha.
 */
export const IDS_DE_PROVEDOR_DE_DECISAO = PROVEDORES_DE_DECISAO.map((p) => p.id) as unknown as readonly [
  (typeof PROVEDORES_DE_DECISAO)[number]["id"],
  ...(typeof PROVEDORES_DE_DECISAO)[number]["id"][],
];

/** O id de um provedor de decisão — para as portas de escrita tiparem a união. */
export type ProvedorDeDecisaoId = (typeof PROVEDORES_DE_DECISAO)[number]["id"];

export const PROVEDOR_DE_DECISAO_POR_ID: ReadonlyMap<string, ProvedorDeDecisao> = new Map(
  PROVEDORES_DE_DECISAO.map((p) => [p.id, p]),
);

/** O provedor que o produto assume quando nada foi configurado. */
export const PROVEDOR_DE_DECISAO_PADRAO = PROVEDORES_DE_DECISAO[0];

export function ehProvedorDeDecisao(id: string): boolean {
  return PROVEDOR_DE_DECISAO_POR_ID.has(id);
}
