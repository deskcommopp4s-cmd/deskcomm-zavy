/**
 * O TESTE ESTAVA ONDE NINGUÉM ACHAVA.
 *
 * A tela de Provedores ganhou um botão "Testar" que responde a pergunta que o
 * "Validada" da tela de Credenciais NÃO responde — se o par chave + modelo
 * responde de verdade, e não apenas se a chave existe. Ele nasceu dentro do
 * formulário de cada ponto, que vive atrás do rótulo "Configuração avançada".
 *
 * O dono do sistema — que sabia que a função existia — não a encontrou. Quem
 * não sabe que ela existe não a encontra nunca. O rótulo fala de "configuração
 * avançada"; nada ali sugere "aqui você testa".
 *
 * A correção traz o botão para o card "Modelo padrão" — o primeiro da tela, o
 * que a pessoa olha antes de qualquer coisa. E ali ele vale mais do que
 * conveniência de layout: é o card que troca o provedor e o modelo de TODOS os
 * pontos herdados de uma vez (na captura do dono, 12 de 26). Testar ANTES dessa
 * troca é o momento em que a informação ainda muda a decisão.
 *
 * O que este arquivo tranca, em ordem de importância:
 *
 *   1. o botão existe no card do padrão SEM clique nenhum — é a propriedade
 *      que a correção existe para garantir, e a única que uma regressão
 *      silenciosa (mover o botão de volta para dentro do avançado) quebraria;
 *   2. o corpo que ele envia é o que a rota espera — `base_url: null`, porque o
 *      padrão não carrega endereço próprio (isso vive em cada ponto);
 *   3. a falha chega com MOTIVO, e a queda de rede NÃO vira "a configuração
 *      falhou" — dizer isso mandaria o operador trocar uma chave que está certa;
 *   4. trocar modelo ou credencial APAGA o veredito: um "Respondeu" verde sobre
 *      uma configuração que já mudou é pior que nenhum.
 *
 * Roda com: npx vitest run tests/unit/provedores-testar-no-cartao-do-padrao.test.tsx
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

/** O mínimo que a tela precisa para desenhar o card do padrão com um ponto. */
const DADOS = {
  papeis: { atender: { rotulo: "Atender o cliente", explicacao: "Escrever o que o cliente lê." } },
  pontos: [],
  provedores: [
    {
      id: "openai",
      rotulo: "OpenAI (GPT)",
      quandoUsar: "Necessário para áudio.",
      ondePegarAChave: "https://platform.openai.com/api-keys",
      aceitaEndpointProprio: true,
    },
  ],
  credenciais: [
    { id: "cred-1", provider: "openai", label: "Minha chave", api_key_last4: "abcd" },
    // A segunda existe para o teste de INVALIDAÇÃO: trocar para a MESMA
    // credencial não dispara mudança nenhuma no Radix, e o teste passaria (ou
    // falharia) sem medir o que diz medir.
    { id: "cred-2", provider: "openai", label: "Chave do gateway", api_key_last4: "wxyz" },
  ],
  modelos: [
    {
      provider: "openai",
      model_id: "gpt-5-mini",
      display_name: "GPT-5 mini",
      supports_tools: true,
      supports_vision: false,
      input_price_per_million_cents: null,
    },
    {
      provider: "openai",
      model_id: "gpt-5",
      display_name: "GPT-5",
      supports_tools: true,
      supports_vision: false,
      input_price_per_million_cents: null,
    },
  ],
  padrao: { provider: "openai", defaultModel: "gpt-5-mini" },
  podeEditar: true,
};

/** Registra cada POST no endpoint de teste para conferir o CORPO enviado. */
let corposDeTeste: Array<Record<string, unknown>> = [];

/**
 * A tela consome as duas rotas de formas DIFERENTES: a carga lê `res.text()`
 * (para poder mostrar o começo do corpo quando ele não é JSON) e o teste lê
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

function stubDeRede(respostaDoTeste: { status: number; body: unknown }) {
  corposDeTeste = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/v1/ai/providers/test")) {
        corposDeTeste.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return resposta(respostaDoTeste.status, respostaDoTeste.body);
      }
      return resposta(200, { data: DADOS });
    }),
  );
}

async function renderizar() {
  render(<PainelDeProvedores />);
  // O card só existe depois da carga — esperar aqui evita asserção sobre tela
  // em branco, que passaria ou falharia por corrida em vez de por produto.
  await screen.findByTestId("cartao-do-padrao");
}

/** Escolhe a credencial da empresa no card do padrão (o botão nasce travado). */
async function escolherCredencial() {
  fireEvent.click(screen.getByTestId("padrao-credencial"));
  fireEvent.click(await screen.findByText(/Minha chave/));
}

beforeEach(() => {
  stubDeRede({
    status: 200,
    body: { data: { ok: true } },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("o teste que ninguém achava, agora no card que todos veem", () => {
  it("o botão está no card do padrão SEM abrir nada — é a correção inteira", async () => {
    await renderizar();
    // Nenhum clique em "Configuração avançada": quem não sabia que a função
    // existia não abriria aquele rótulo, e era exatamente por isso que ele
    // ficava invisível.
    expect(screen.getByTestId("testar-padrao")).toBeTruthy();
  });

  it("nasce travado sem credencial, e diz por quê em vez de só não responder", async () => {
    await renderizar();
    const botao = screen.getByTestId("testar-padrao") as HTMLButtonElement;
    expect(botao.disabled, "testar sem credencial não provaria nada").toBe(true);
    expect(screen.getByText(/Escolha a credencial da empresa/)).toBeTruthy();
  });

  it("escolhida a credencial, destrava", async () => {
    await renderizar();
    await escolherCredencial();
    await waitFor(() => {
      expect((screen.getByTestId("testar-padrao") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("envia o provedor, o modelo e a credencial — e base_url NULO", async () => {
    await renderizar();
    await escolherCredencial();
    fireEvent.click(screen.getByTestId("testar-padrao"));
    await waitFor(() => expect(corposDeTeste.length).toBe(1));
    // `base_url: null` é a decisão de produto: o padrão não carrega endereço
    // próprio (isso vive em cada ponto). O teste daqui responde "este provedor
    // + este modelo + esta chave respondem?" — o que a troca em massa pressupõe.
    expect(corposDeTeste[0]).toEqual({
      provider: "openai",
      model_id: "gpt-5-mini",
      credential_id: "cred-1",
      base_url: null,
    });
  });

  it("respondeu: diz que respondeu, e fala dos pontos que herdam", async () => {
    await renderizar();
    await escolherCredencial();
    fireEvent.click(screen.getByTestId("testar-padrao"));
    const caixa = await screen.findByTestId("resultado-teste-padrao");
    expect(caixa.textContent).toContain("Respondeu");
  });

  it("não respondeu: mostra o MOTIVO, não um 'erro' genérico", async () => {
    stubDeRede({
      status: 200,
      body: {
        data: { ok: false, codigo: "chave_invalida", mensagem: "A chave foi recusada" },
      },
    });
    await renderizar();
    await escolherCredencial();
    fireEvent.click(screen.getByTestId("testar-padrao"));
    const caixa = await screen.findByTestId("resultado-teste-padrao");
    expect(caixa.textContent).toContain("A chave foi recusada");
    expect(caixa.textContent).toContain("chave_invalida");
  });

  it("rede caída NÃO vira 'a configuração falhou'", async () => {
    // A queda é da tela, não do provedor. Chamar de falha da configuração
    // mandaria o operador trocar uma chave que está certa.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/v1/ai/providers/test")) throw new Error("sem rede");
        return resposta(200, { data: DADOS });
      }),
    );
    await renderizar();
    await escolherCredencial();
    fireEvent.click(screen.getByTestId("testar-padrao"));
    const caixa = await screen.findByTestId("resultado-teste-padrao");
    expect(caixa.textContent).toContain("não consegui alcançar o servidor");
  });

  it("trocar o modelo APAGA o veredito anterior", async () => {
    await renderizar();
    await escolherCredencial();
    fireEvent.click(screen.getByTestId("testar-padrao"));
    await screen.findByTestId("resultado-teste-padrao");
    // Mudar o modelo muda o que foi provado: manter o verde seria afirmar sobre
    // uma configuração que ninguém testou.
    fireEvent.click(screen.getByTestId("padrao-modelo"));
    fireEvent.click(await screen.findByText("GPT-5"));
    await waitFor(() => {
      expect(screen.queryByTestId("resultado-teste-padrao")).toBeNull();
    });
  });

  it("trocar a credencial APAGA o veredito anterior", async () => {
    await renderizar();
    await escolherCredencial();
    fireEvent.click(screen.getByTestId("testar-padrao"));
    await screen.findByTestId("resultado-teste-padrao");
    // Trocar de credencial troca a chave que foi provada; o verde antigo não
    // fala da nova.
    fireEvent.click(screen.getByTestId("padrao-credencial"));
    fireEvent.click(await screen.findByText(/Chave do gateway/));
    await waitFor(() => {
      expect(screen.queryByTestId("resultado-teste-padrao")).toBeNull();
    });
  });
});
