/**
 * "EDITADO E NÃO PUBLICADO" PRECISA SALTAR AOS OLHOS.
 *
 * O runtime responde com a versão PUBLICADA. Quem edita o agente e não publica
 * continua com o comportamento antigo no ar — e o sintoma é "editei e não
 * funcionou", que faz o autor procurar defeito no texto que ele acabou de
 * escrever.
 *
 * O produto já tinha o ESTADO certo na tela (o badge "Publicado vN + Rascunho
 * vM"), mas cinza, no mesmo tom de "Publicado vN" — informação certa, sinal
 * nenhum. Este teste guarda as duas coisas que faltavam:
 *
 *   1. o badge mudou de tom (deixou de ser o neutro);
 *   2. existe um AVISO em bloco, que nomeia as DUAS versões.
 *
 * E guarda também o silêncio: sem rascunho mais novo, nada acende — um aviso
 * que aparece sempre é um aviso que ninguém lê.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/a1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

const CREDENCIAIS = [
  { id: "11111111-1111-4111-8111-111111111111", provider: "anthropic", label: "chave", is_active: true },
];
const SESSOES = [
  { id: "22222222-2222-4222-8222-222222222222", label: "WhatsApp", status: "WORKING" },
];

const AGENTE = {
  id: "a1",
  organization_id: "org-1",
  name: "Vitoria",
  description: null,
  model: "claude-sonnet-5",
  system_prompt: "Você é a Vitória.",
  is_active: false,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: "v3",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function versao(n: number, status: string) {
  return {
    id: `v${n}`,
    organization_id: "org-1",
    agent_id: "a1",
    version_number: n,
    status,
    system_prompt: "Você é a Vitória.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    credential_id: CREDENCIAIS[0]!.id,
    tool_ids: [],
    channel_session_id: SESSOES[0]!.id,
    max_steps: 10,
    token_budget: 50000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    cases_enabled: true,
    split_messages: true,
    split_max_chars: 600,
    followup: { enabled: false, flow_pointer_ids: [] },
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    trigger_config: null,
    published_at: null,
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
  };
}

function renderizar(props: {
  draft: ReturnType<typeof versao> | null;
  published: ReturnType<typeof versao> | null;
  base: ReturnType<typeof versao> | null;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE as never}
        credentials={CREDENCIAIS as never}
        channelSessions={SESSOES as never}
        draft={props.draft as never}
        published={props.published as never}
        base={props.base as never}
        draftObsoleto={null as never}
      />
    </QueryClientProvider>,
  );
}

describe("o agente editado e não publicado avisa", () => {
  it("com rascunho mais novo que a publicada, o aviso aparece e nomeia as DUAS versões", () => {
    renderizar({ draft: versao(4, "draft"), published: versao(3, "published"), base: versao(3, "published") });

    const aviso = screen.getByTestId("aviso-nao-publicado");
    expect(aviso).toBeInTheDocument();
    // A frase inteira é o produto: um "há alterações não publicadas" genérico
    // não diz QUAL está no ar, que é a pergunta que o autor tem.
    expect(aviso.textContent).toContain("v3");
    expect(aviso.textContent).toContain("v4");
  });

  it("o aviso é ALERTA, não rótulo — tem papel de alerta para o leitor de tela", () => {
    renderizar({ draft: versao(4, "draft"), published: versao(3, "published"), base: versao(3, "published") });
    expect(screen.getByTestId("aviso-nao-publicado")).toHaveAttribute("role", "alert");
  });

  it("SEM rascunho (só publicado), nada acende — o que está no ar é o que se está vendo", () => {
    renderizar({ draft: null, published: versao(3, "published"), base: versao(3, "published") });
    expect(screen.queryByTestId("aviso-nao-publicado")).not.toBeInTheDocument();
  });

  it("agente NOVO (nunca publicado) não acende o aviso — ali publicar é o passo seguinte", () => {
    renderizar({ draft: versao(1, "draft"), published: null, base: null });
    expect(screen.queryByTestId("aviso-nao-publicado")).not.toBeInTheDocument();
  });
});
