/**
 * O BOTÃO DO MODELO ESTÁ NA TELA, E ELE BAIXA O ARQUIVO CERTO.
 *
 * A tela de importação dizia em prosa quais colunas ela reconhece. Quem nunca
 * importou nada lê isso e adivinha o resto — separador, data, campo vazio — e
 * descobre o erro depois de subir a planilha inteira.
 *
 * O conteúdo do modelo é testado contra o importador de verdade em
 * `modelo-de-planilha-e-aceito-pelo-importador.test.ts`. O que este arquivo
 * prende é o que aquele não alcança: que o botão EXISTE na tela, que ele
 * entrega um CSV com o nome certo, e que a URL temporária é devolvida — um
 * `createObjectURL` sem `revoke` vaza memória a cada clique.
 *
 * Por que na TELA e não só na função: uma correção que existe no código e não
 * aparece para quem usa é o defeito que este diálogo tinha antes — o "Testar"
 * do painel de IA estava lá, atrás de um rótulo que ninguém abre.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useImportContacts", () => ({
  useImportContacts: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { ImportContactsDialog } = await import("@/components/contacts/ImportContactsDialog");

let criadas: string[] = [];
let revogadas: string[] = [];
let cliquesDeDownload: string[] = [];

beforeEach(() => {
  criadas = [];
  revogadas = [];
  cliquesDeDownload = [];
  // jsdom não implementa as duas — sem o dublê o clique estoura.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      criadas.push(blob.type);
      return "blob:modelo";
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revogadas.push(url);
    }),
  });
  // O download é um `<a download>` clicado por código. Espionar o clique é o
  // que prova que o arquivo foi entregue, sem baixar nada.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(
    this: HTMLAnchorElement,
  ) {
    cliquesDeDownload.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a planilha modelo está na tela de importação", () => {
  it("o botão existe ANTES de escolher arquivo — é para quem chegou sem planilha", () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    expect(screen.getByTestId("baixar-modelo-planilha")).toBeTruthy();
  });

  it("clicar baixa um CSV com o nome que diz a que serve", () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("baixar-modelo-planilha"));
    expect(cliquesDeDownload).toEqual(["modelo-contatos.csv"]);
  });

  it("o arquivo entregue é CSV com charset declarado", () => {
    // O tipo importa: sem `charset=utf-8` o Excel em português pode abrir o
    // arquivo em Latin-1 e estragar os acentos do próprio cabeçalho.
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("baixar-modelo-planilha"));
    expect(criadas).toHaveLength(1);
    expect(criadas[0]).toContain("text/csv");
    expect(criadas[0]).toContain("utf-8");
  });

  it("a URL temporária é DEVOLVIDA — senão cada clique vaza memória", async () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("baixar-modelo-planilha"));
    // O revoke é adiado num tique para o download começar antes. `toContain` e
    // não `toEqual`: o revoke adiado de um teste anterior pode cair neste, e a
    // pergunta aqui é "esta URL foi devolvida?", não "quantas vezes".
    await waitFor(() => {
      expect(revogadas).toContain("blob:modelo");
    });
  });

  it("a tela explica para que serve o botão, e não só o nomeia", () => {
    render(<ImportContactsDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/Baixe o modelo e preencha por cima dos exemplos/)).toBeTruthy();
  });
});
