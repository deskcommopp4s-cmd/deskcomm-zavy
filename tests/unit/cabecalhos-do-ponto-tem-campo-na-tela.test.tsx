/**
 * OS CABEÇALHOS DO PONTO PRECISAM TER ONDE SER ESCRITOS — E MOSTRAR O QUE JÁ ESTÁ GRAVADO.
 *
 * A coluna existe no banco, o runtime a honra e a API a aceita. Faltava a
 * SUPERFÍCIE: sem campo na tela, o recurso só existiria por chamada direta à
 * API — que é exatamente o defeito que o campo de endereço próprio teve por
 * meses (a coluna existia, o PUT a aceitava, o registry a honrava, e nada na
 * tela a enviava).
 *
 * Este arquivo tranca quatro propriedades, em ordem de importância:
 *
 *   1. o campo MOSTRA o cabeçalho já gravado. Campo que não recebe o valor
 *      atual faz o operador reconfigurar às cegas e, sem querer, apagar o que
 *      já estava lá;
 *   2. o "Testar" prova o par INTEIRO — endereço + cabeçalho —, porque há
 *      gateway que só responde com o cabeçalho de roteamento dele. Um botão que
 *      ignorasse o cabeçalho reprovaria uma configuração que funciona, e o
 *      operador iria procurar o defeito no gateway;
 *   3. o "Salvar" envia o mesmo objeto que o "Testar" prova — o veredito verde
 *      só vale se a configuração que ele aprovou for a que fica gravada;
 *   4. linha sem formato `Nome: valor` RECUSA a operação. Ignorá-la calada
 *      deixaria a configuração salva sem o cabeçalho que o provedor exige — e o
 *      erro só apareceria na chamada, longe do painel que prometeu tê-lo
 *      gravado.
 *
 * Roda com: npx vitest run tests/unit/cabecalhos-do-ponto-tem-campo-na-tela.test.tsx
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PainelDeProvedores } from "@/app/app/ai/providers/_components/PainelDeProvedores";

// O tradutor devolve a própria chave: o teste é sobre o MECANISMO, e prender
// frase traduzida aqui faria o arquivo quebrar a cada ajuste de texto.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const { toastFalso } = vi.hoisted(() => ({
  toastFalso: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: toastFalso }));

const CABECALHO_GRAVADO = { "x-opencode-session": "abc123" };

/** O ponto com o cabeçalho já gravado — é o estado que o campo precisa mostrar. */
function dados(): Record<string, unknown> {
  return {
    papeis: {
      atender: { rotulo: "Atender o cliente", explicacao: "Escrever o que o cliente lê." },
    },
    pontos: [
      {
        id: "p1",
        rotulo: "Responder o cliente",
        oQueFaz: "Escreve a resposta que o cliente lê.",
        papel: "atender",
        exige: {},
        sintomaDeFalha: "O cliente fica sem resposta.",
        fixo: null,
        mandadoPeloAgente: false,
        efetivo: {
          provider: "openai",
          modelId: "gpt-5-mini",
          credentialId: "cred-1",
          baseUrl: "https://gateway.ejemplo.com/v1",
          headers: CABECALHO_GRAVADO,
          origem: "binding",
          porQue: "Você escolheu para este ponto.",
        },
        avisos: [],
      },
    ],
    provedores: [
      {
        id: "openai",
        rotulo: "OpenAI (GPT)",
        quandoUsar: "Necessário para áudio.",
        ondePegarAChave: "https://platform.openai.com/api-keys",
        aceitaEndpointProprio: true,
      },
    ],
    credenciais: [{ id: "cred-1", provider: "openai", label: "Minha chave", api_key_last4: "abcd" }],
    modelos: [
      {
        provider: "openai",
        model_id: "gpt-5-mini",
        display_name: "GPT-5 mini",
        supports_tools: true,
        supports_vision: false,
        input_price_per_million_cents: 10,
      },
    ],
    padrao: { provider: "openai", defaultModel: "gpt-5-mini" },
    podeEditar: true,
  };
}

/**
 * A tela consome as duas rotas de formas DIFERENTES: a carga lê `res.text()`
 * (para mostrar o começo do corpo quando ele não é JSON) e o teste lê
 * `res.json()`. Um dublê que só oferece `json()` faz a carga estourar em
 * `res.text is not a function` e a tela desenha "Não consegui carregar" — que
 * pareceria defeito de produto em vez de dublê incompleto.
 */
function resposta(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let corposDeTeste: Record<string, unknown>[] = [];
let corposDeSalvar: Record<string, unknown>[] = [];

function stubDeRede() {
  corposDeTeste = [];
  corposDeSalvar = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      if (alvo.endsWith("/api/v1/ai/providers/test")) {
        corposDeTeste.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return resposta(200, { data: { ok: true } });
      }
      if (alvo.endsWith("/api/v1/ai/providers") && init?.method === "PUT") {
        corposDeSalvar.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return resposta(200, { data: { avisos: [] } });
      }
      return resposta(200, { data: dados() });
    }),
  );
}

/** Abre a tela e o grupo "Configuração avançada" — o ponto só existe ali dentro. */
async function renderizar() {
  render(<PainelDeProvedores />);
  // O card só existe depois da carga — esperar aqui evita asserção sobre tela
  // em branco, que passaria ou falharia por corrida em vez de por produto.
  await screen.findByTestId("cartao-do-padrao");
  fireEvent.click(screen.getByTestId("avancado-atender"));
  await screen.findByTestId("ponto-p1");
}

beforeEach(() => {
  stubDeRede();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("o campo de cabeçalhos do ponto", () => {
  it("MOSTRA o cabeçalho já gravado, em linhas `Nome: valor`", async () => {
    await renderizar();
    expect(screen.getByTestId("headers-p1")).toHaveValue("x-opencode-session: abc123");
  });

  it("o Testar envia os cabeçalhos da tela", async () => {
    await renderizar();
    const campo = screen.getByTestId("headers-p1");
    fireEvent.change(campo, {
      target: { value: "x-opencode-session: abc123\nx-outro: valor" },
    });
    fireEvent.click(screen.getByTestId("testar-p1"));

    await waitFor(() => expect(corposDeTeste).toHaveLength(1));
    expect(corposDeTeste[0]?.headers).toEqual({
      "x-opencode-session": "abc123",
      "x-outro": "valor",
    });
    // O endereço vai no MESMO corpo: o teste é sobre o par, não sobre a metade.
    expect(corposDeTeste[0]?.base_url).toBe("https://gateway.ejemplo.com/v1");
  });

  it("o Salvar manda o MESMO objeto que o Testar prova", async () => {
    await renderizar();
    fireEvent.change(screen.getByTestId("headers-p1"), {
      target: { value: "x-opencode-session: abc123\nx-outro: valor" },
    });
    fireEvent.click(screen.getByTestId("salvar-p1"));

    await waitFor(() => expect(corposDeSalvar).toHaveLength(1));
    expect(corposDeSalvar[0]?.headers).toEqual({
      "x-opencode-session": "abc123",
      "x-outro": "valor",
    });
    expect(corposDeSalvar[0]?.base_url).toBe("https://gateway.ejemplo.com/v1");
  });

  it("campo vazio salva null — desligar o cabeçalho é possível", async () => {
    await renderizar();
    fireEvent.change(screen.getByTestId("headers-p1"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("salvar-p1"));

    await waitFor(() => expect(corposDeSalvar).toHaveLength(1));
    expect(corposDeSalvar[0]?.headers).toBeNull();
  });

  it("linha sem formato `Nome: valor` RECUSA — e não chama a API", async () => {
    await renderizar();
    fireEvent.change(screen.getByTestId("headers-p1"), {
      target: { value: "isto-nao-tem-dois-pontos" },
    });
    fireEvent.click(screen.getByTestId("testar-p1"));

    await waitFor(() => expect(toastFalso.error).toHaveBeenCalled());
    // A recusa é ANTES da rede: nada saiu, e a tela não ficou com um veredito
    // sobre uma configuração que o salvamento não aceitaria.
    expect(corposDeTeste).toHaveLength(0);
  });
});
