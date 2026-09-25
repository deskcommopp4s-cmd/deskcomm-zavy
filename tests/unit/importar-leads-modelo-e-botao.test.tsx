/**
 * O MODELO DE PLANILHA É UM BOTÃO, NÃO UM LINK PERDIDO.
 *
 * A tela de importação sempre teve o download do modelo — mas como um link
 * minúsculo sublinhado no fim do diálogo. O dono do sistema, olhando a tela,
 * viu "apenas um texto informativo": quem não sabia que o modelo existia não
 * via, e o usuário adivinhava o formato e mandava a planilha de volta com erro.
 *
 * A correção troca o link por um botão de verdade, logo abaixo da explicação —
 * o primeiro passo do fluxo (baixar → preencher → subir). O que este arquivo
 * tranca é a propriedade que a correção existe para garantir: o download é um
 * DOWNLOAD (atributo `download` + rota que responde `content-disposition:
 * attachment`), não uma navegação de página — e ele está visível sem nenhum
 * clique além de abrir o diálogo.
 *
 * Roda com: npx vitest run tests/unit/importar-leads-modelo-e-botao.test.tsx
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportarLeads } from "@/app/app/kanban/_components/ImportarLeads";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const FUNIS = [
  { id: "f1", name: "Vendas" },
  { id: "f2", name: "Pós-venda" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("o modelo de planilha na tela de importação", () => {
  it("é um botão visível ao abrir o diálogo — sem procurar em link perdido", () => {
    render(<ImportarLeads funis={FUNIS} />);
    fireEvent.click(screen.getByTestId("abrir-importar-leads"));

    const botao = screen.getByTestId("modelo-de-leads");
    expect(botao.tagName).toBe("A");
    // O download é um download: o atributo `download` + a rota que responde
    // `content-disposition: attachment`. Sem o atributo, o navegador abriria o
    // CSV na janela em vez de baixar — e o usuário veria texto cru.
    expect(botao.getAttribute("href")).toBe("/api/v1/leads/import");
    expect(botao.getAttribute("download")).toBe("modelo-leads.csv");
    expect(botao.textContent).toContain("Baixar planilha modelo");
  });

  it("vem ANTES do botão de escolher arquivo — é o primeiro passo do fluxo", () => {
    render(<ImportarLeads funis={FUNIS} />);
    fireEvent.click(screen.getByTestId("abrir-importar-leads"));

    const modelo = screen.getByTestId("modelo-de-leads");
    const escolher = screen.getByTestId("escolher-planilha");
    // Quem não sabe o formato precisa do modelo ANTES de escolher o arquivo.
    // Se a ordem inverter, o usuário escolhe o arquivo primeiro e só descobre o
    // modelo depois de errar.
    const posicaoModelo = modelo.compareDocumentPosition(escolher);
    expect(posicaoModelo & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});