/**
 * A TRANSCRIÇÃO DO ÁUDIO NA TELA — para quem atende sem áudio.
 *
 * Nem todo mundo que atende tem como ouvir: fone quebrado, ambiente
 * compartilhado, surdez, ou a preferência de ler. Sem o texto, a única saída
 * era pedir ao cliente que escrevesse de novo — passando a bola para quem não
 * tem culpa de nada.
 *
 * O derivado textual JÁ existia (o worker `media-derive-worker` grava
 * `messages.media_derived_text` desde a Onda 3), mas só alimentava o AGENTE.
 * Esta entrega o leva para o OPERADOR.
 *
 * O que estes casos trancam, em ordem de importância:
 *
 *   1. **O texto aparece mesmo quando o áudio FALHA.** É o caso que mais
 *      importa: quem não tem áudio é quem mais depende do texto, e devolver
 *      `MediaUnavailable` sozinho deixaria essa pessoa sem a mensagem.
 *   2. O texto fica RECOLHIDO atrás de um botão que diz o que faz — numa
 *      conversa com muitos áudios, parágrafos abertos afogam a leitura de quem
 *      ouve normalmente.
 *   3. Sem transcrição, o botão NÃO aparece (nada de promessa vazia).
 *   4. O desfecho negativo (`failed`) se anuncia; o nulo não — `null` é "ainda
 *      não derivou", e áudios antigos podem nunca receber texto.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então o texto
 * esperado é o português — o espanhol é coberto por i18n-espanhol-cobre-a-tela.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AudioPlayer } from "./AudioPlayer";

const TRANSCRICAO = "Oi, tudo bem? Queria saber sobre o prazo de entrega.";

afterEach(cleanup);

/** O `<audio>` do player — é nele que o erro de carregamento é disparado. */
function elementoDeAudio(container: HTMLElement): HTMLAudioElement {
  const el = container.querySelector("audio");
  if (!el) throw new Error("o player não renderizou o elemento <audio>");
  return el;
}

describe("a transcrição do áudio, para quem atende sem áudio", () => {
  it("Começa RECOLHIDA: o texto não ocupa a conversa de quem ouve", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedText={TRANSCRICAO} />);
    expect(screen.getByTestId("transcricao-toggle-m1")).toBeTruthy();
    expect(screen.queryByTestId("transcricao-m1")).toBeNull();
  });

  it("o botão diz o que faz — e o estado é anunciado (aria-expanded)", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedText={TRANSCRICAO} />);
    const botao = screen.getByTestId("transcricao-toggle-m1");
    expect(botao.textContent).toContain("Ver transcrição");
    expect(botao.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicar ABRE o texto", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedText={TRANSCRICAO} />);
    fireEvent.click(screen.getByTestId("transcricao-toggle-m1"));
    expect(screen.getByTestId("transcricao-m1").textContent).toContain(
      "prazo de entrega",
    );
    expect(screen.getByTestId("transcricao-toggle-m1").getAttribute("aria-expanded")).toBe("true");
  });

  it("clicar de novo FECHA — o rótulo acompanha", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedText={TRANSCRICAO} />);
    const botao = screen.getByTestId("transcricao-toggle-m1");
    fireEvent.click(botao);
    expect(botao.textContent).toContain("Ocultar transcrição");
    fireEvent.click(botao);
    expect(screen.queryByTestId("transcricao-m1")).toBeNull();
  });

  it("⭐ áudio que FALHA ainda mostra o texto — é o caso que mais importa", () => {
    // Quem não tem áudio depende do texto; devolver só "áudio indisponível"
    // deixaria essa pessoa sem a mensagem do cliente.
    const { container } = render(
      <AudioPlayer messageId="m1" isOutbound={false} derivedText={TRANSCRICAO} />,
    );
    fireEvent.error(elementoDeAudio(container));
    // O player fica inerte (não é possível reproduzir)...
    expect((screen.getByLabelText("Reproduzir áudio") as HTMLButtonElement).disabled).toBe(true);
    // ...mas a transcrição continua alcançável.
    fireEvent.click(screen.getByTestId("transcricao-toggle-m1"));
    expect(screen.getByTestId("transcricao-m1").textContent).toContain("prazo de entrega");
  });

  it("áudio que falha e SEM transcrição: mostra o indisponível, não um botão vazio", () => {
    const { container } = render(<AudioPlayer messageId="m1" isOutbound={false} />);
    fireEvent.error(elementoDeAudio(container));
    expect(screen.queryByTestId("transcricao-toggle-m1")).toBeNull();
    expect(screen.queryByTestId("transcricao-m1")).toBeNull();
  });

  it("sem transcrição, o botão NÃO aparece — nada de promessa vazia", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} />);
    expect(screen.queryByTestId("transcricao-toggle-m1")).toBeNull();
  });

  it("texto em branco é tratado como ausente (não abre um balão vazio)", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedText="   " />);
    expect(screen.queryByTestId("transcricao-toggle-m1")).toBeNull();
  });

  it("desfecho NEGATIVO se anuncia — quem lê sabe que não virá texto", () => {
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedStatus="failed" />);
    expect(screen.getByTestId("transcricao-falhou-m1").textContent).toContain(
      "Não conseguimos transcrever",
    );
  });

  it("⚠️ `null` NÃO vira 'transcrevendo…' — áudios antigos podem nunca receber texto", () => {
    // Afirmar "transcrevendo" prometeria algo que pode não chegar. O silêncio é
    // honesto: se o worker derivar, o realtime traz e o botão aparece.
    render(<AudioPlayer messageId="m1" isOutbound={false} derivedStatus={null} />);
    expect(screen.queryByTestId("transcricao-falhou-m1")).toBeNull();
    expect(screen.queryByTestId("transcricao-toggle-m1")).toBeNull();
  });

  it("vale também para o áudio ENVIADO (o operador relê o que disse)", () => {
    render(<AudioPlayer messageId="m1" isOutbound={true} derivedText={TRANSCRICAO} />);
    fireEvent.click(screen.getByTestId("transcricao-toggle-m1"));
    expect(screen.getByTestId("transcricao-m1").textContent).toContain("prazo de entrega");
  });

  it("com transcrição pronta, o aviso de falha não aparece junto", () => {
    render(
      <AudioPlayer
        messageId="m1"
        isOutbound={false}
        derivedText={TRANSCRICAO}
        derivedStatus="failed"
      />,
    );
    expect(screen.queryByTestId("transcricao-falhou-m1")).toBeNull();
  });
});
