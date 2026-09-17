/**
 * O editor de CAMPOS do funil — o que ele oferece e o que ele deixa editar.
 *
 * O defeito que estes testes trancam: a lista de tipos desta tela era digitada
 * à mão e ficou menor que a de `customFieldSchema`. `multiselect` era aceito
 * pelo schema, gravado pela API e desenhado no dossiê do contato, mas não
 * existia aqui — então um campo desse tipo abria com o seletor EM BRANCO (nenhum
 * `SelectItem` casava com o `value`) e sem a linha de opções, que só aparecia
 * para `select`. Quem administrava via um campo aparentemente corrompido, sem
 * como editar, e o conserto intuitivo (escolher um tipo qualquer para tirar o
 * branco) rebaixava a escolha múltipla para escolha única.
 *
 * Por isso os testes medem o par: a tela OFERECE todo tipo que o schema aceita,
 * e mostra as opções para TODO tipo de lista fechada — não só para `select`.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { customFieldSchema } from "@/lib/schemas/settings";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As duas seções irmãs falam com a API; este arquivo é sobre os CAMPOS.
vi.mock("./_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { PipelinesClient, TIPOS_DE_CAMPO, tipoTemOpcoes, type PipelineRow } from "./_client";

/** Um funil de clínica: o campo que importa é a lista de procedimentos, e ela é múltipla. */
const FUNIL: PipelineRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tratamentos",
  slug: "tratamentos",
  vocabulary: { lead: "Paciente", deal: "Tratamento", won: "Fechado", lost: "Perdido" },
  settings: {
    fields: [
      {
        key: "procedimentos_de_interesse",
        label: "Procedimentos de interesse",
        type: "multiselect",
        options: [
          { value: "clareamento", label: "Clareamento Dental" },
          { value: "implantes", label: "Implantes" },
        ],
      },
    ],
  },
};

describe("tipos de campo que a tela do funil oferece", () => {
  it("oferece TODO tipo que o schema aceita — lista menor deixa campo salvo sem seletor", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    const daTela = [...TIPOS_DE_CAMPO].sort();
    expect(daTela).toEqual(doSchema);
  });

  it("mostra as opções para toda lista fechada, não só para `select`", () => {
    expect(tipoTemOpcoes("select")).toBe(true);
    expect(tipoTemOpcoes("multiselect")).toBe(true);
    // Um tipo de texto livre não tem lista para editar.
    expect(tipoTemOpcoes("text")).toBe(false);
    expect(tipoTemOpcoes("date")).toBe(false);
  });
});

describe("um campo multiselect já gravado", () => {
  it("abre com o tipo à mostra, e não com o seletor em branco", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const seletor = screen.getByLabelText(/Tipo do campo 1/i);
    // O texto do gatilho do Radix é o rótulo do item casado. Vazio = nenhum
    // `SelectItem` bateu com o `value`, que é exatamente o defeito.
    expect(seletor.textContent?.trim()).toBe("multiselect");
  });

  it("deixa editar as opções — sem isso o campo fica só de leitura", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    expect(opcoes).toHaveValue("Clareamento Dental, Implantes");
  });
});

/**
 * Escrever uma lista de opções do zero.
 *
 * O defeito que estes testes trancam: o input é CONTROLADO e o que ele exibe é
 * `options.join(", ")`. O `onChange` descartava a opção vazia a cada tecla. Como
 * digitar a vírgula cria justamente um item vazio no fim, o separador era
 * descartado antes de a pessoa escrever a palavra seguinte:
 *
 *   digita "Dor,"  → ["Dor", ""] → filter → ["Dor"] → a tela volta a mostrar "Dor"
 *   digita "O"     → o cursor está depois de "Dor"   → "DorO"   ✗
 *
 * O resultado era um campo que SÓ aceitava uma opção, e ninguém conseguia criar
 * um `select`/`multiselect` com duas — o sintoma que chegou do uso real.
 *
 * A opção vazia continua sendo jogada fora, mas no SALVAMENTO (handleSave), onde
 * o texto já está completo e descartá-la não apaga nada em andamento.
 */
describe("digitar uma lista de opções nova", () => {
  /**
   * Digita de verdade: cada tecla ACRESCENTA ao que a tela mostra AGORA.
   *
   * A diferença é o coração do teste. `fireEvent.change` com o texto crescente
   * finge que a pessoa digita o certo; ler `input.value` antes de acrescentar é
   * o que o teclado faz. Se o `onChange` reescrever o valor (comendo a vírgula
   * recém-digitada), a tecla seguinte parte de um texto diferente do que foi
   * digitado — e o defeito aparece.
   */
  function digitar(input: HTMLInputElement, texto: string): void {
    for (const tecla of texto) {
      fireEvent.change(input, { target: { value: input.value + tecla } });
    }
  }

  it("não come a vírgula que acabou de ser digitada", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;

    fireEvent.change(opcoes, { target: { value: "" } });
    fireEvent.change(opcoes, { target: { value: "Dor," } });

    // O separador precisa continuar na tela. Sem o conserto, aqui estava "Dor"
    // — e a palavra seguinte colava nela.
    expect(opcoes).toHaveValue("Dor, ");
  });

  it("monta uma lista de três opções do começo ao fim", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;

    fireEvent.change(opcoes, { target: { value: "" } });
    digitar(opcoes, "Dor, Orçamento, Prazo");

    expect(opcoes).toHaveValue("Dor, Orçamento, Prazo");
  });

  it("grava o texto digitado como as opções do campo", async () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;

    fireEvent.change(opcoes, { target: { value: "" } });
    digitar(opcoes, "Dor, Orçamento");

    fireEvent.click(screen.getByRole("button", { name: /Salvar|Guardar/i }));

    const { updatePipelineConfig } = await import("@/app/actions/settings/updatePipelineConfig");
    // `handleSave` roda dentro de `startTransition`, então o salvamento chega
    // depois do clique.
    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalled());

    // A assinatura é `updatePipelineConfig(pipelineId, patch)`.
    const patch = vi.mocked(updatePipelineConfig).mock.calls.at(-1)?.[1] as {
      fields?: Array<{ options?: Array<{ label: string }> }>;
    };
    // O campo 1 sai exatamente com as duas opções — nem uma a mais (o item vazio
    // do fim), nem uma a menos (a que a vírgula comida teria colado).
    expect(patch?.fields?.[0]?.options?.map((o) => o.label)).toEqual(["Dor", "Orçamento"]);
  });
});
