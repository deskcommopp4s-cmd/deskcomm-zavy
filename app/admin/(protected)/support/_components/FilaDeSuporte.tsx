"use client";

/**
 * A fila de suporte do lado da PLATAFORMA.
 *
 * ─── Por que esta tela é NOVA (e não o `admin/inbox`) ───────────────────────
 *
 * O `admin/inbox` existe, mas é **somente leitura por desenho** — o composer
 * está desabilitado com a frase "Use 'Impersonate' para responder" — e ele lê
 * `conversations`, não chamados. A refutação pegou isso: eu tinha escrito que
 * aquela era "a tela de quem responde", e não é.
 *
 * O que se reusa é o PADRÃO (lista à esquerda, conversa à direita) e os
 * componentes — não a tela.
 *
 * ─── O perfil decide quem entra ─────────────────────────────────────────────
 *
 * A rota confere `scope` (`full` | `suporte`) e o BANCO acompanha: um admin de
 * suporte não satisfaz as policies de dado de tenant (migration 0268). Sem os
 * dois lados, contratar suporte seria dar admin total.
 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { toast } from "sonner";

interface NaFila {
  id: string;
  organization_id: string;
  assunto: string | null;
  status: string;
  assigned_to: string | null;
  escalated_summary: string | null;
  created_at: string;
  organizations?: { display_name: string } | null;
}

interface Mensagem {
  id: string;
  author_kind: "usuario" | "ia" | "humano";
  body: string | null;
  created_at: string;
}

const ROTULO_DO_AUTOR: Record<Mensagem["author_kind"], string> = {
  usuario: "Cliente",
  ia: "Assistente",
  humano: "Suporte",
};

export function FilaDeSuporte() {
  const t = useT();
  const [fila, setFila] = useState<NaFila[]>([]);
  const [aberto, setAberto] = useState<string | null>(null);
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [resumo, setResumo] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);

  const carregarFila = useCallback(async () => {
    const res = await fetch("/api/v1/admin/support/threads");
    if (!res.ok) {
      toast.error(t("Não consegui carregar a fila."));
      setCarregando(false);
      return;
    }
    const json = await res.json();
    setFila(json?.data ?? []);
    setCarregando(false);
  }, [t]);

  const abrir = useCallback(async (id: string) => {
    const res = await fetch(`/api/v1/admin/support/threads/${id}`);
    if (!res.ok) return;
    const json = await res.json();
    setMensagens(json?.data?.mensagens ?? []);
    setResumo(json?.data?.thread?.escalated_summary ?? null);
  }, []);

  useEffect(() => {
    void carregarFila();
  }, [carregarFila]);

  useEffect(() => {
    if (aberto) void abrir(aberto);
  }, [aberto, abrir]);

  async function responder() {
    if (!aberto) return;
    const texto = rascunho.trim();
    if (texto === "") return;
    setEnviando(true);
    try {
      const res = await fetch(`/api/v1/admin/support/threads/${aberto}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: texto }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui responder."));
        return;
      }
      setRascunho("");
      await abrir(aberto);
      await carregarFila();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="fila-de-suporte">
      <h1 className="text-xl font-semibold">{t("Suporte")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Chamados abertos pelas contas. Responder aqui não altera nada no sistema do cliente.")}
      </p>

      {carregando ? (
        <p className="mt-6 text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : fila.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="fila-vazia">
          {t("Nenhum chamado esperando.")}
        </p>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-[260px_1fr]">
          <div className="space-y-2" data-testid="lista-da-fila">
            {fila.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setAberto(c.id)}
                data-testid={`fila-${c.id}`}
                className="w-full rounded-md border p-3 text-left text-sm hover:bg-accent"
              >
                <div className="truncate font-medium">
                  {c.organizations?.display_name ?? t("Conta")}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {c.assunto ?? t("Chamado")} · {t(c.status)}
                </div>
              </button>
            ))}
          </div>

          {aberto && (
            <Card className="p-4" data-testid="chamado-da-fila">
              {resumo && (
                <div className="mb-3 rounded-md bg-muted p-2 text-xs" data-testid="resumo-da-escalada">
                  {resumo}
                </div>
              )}
              <div className="max-h-96 space-y-3 overflow-y-auto">
                {mensagens.map((m) => (
                  <div key={m.id} className="text-sm" data-testid={`fila-mensagem-${m.id}`}>
                    <span className="font-medium">{t(ROTULO_DO_AUTOR[m.author_kind])}</span>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                <Label className="text-xs" htmlFor="resposta-suporte">
                  {t("Sua resposta")}
                </Label>
                <Textarea
                  id="resposta-suporte"
                  value={rascunho}
                  rows={3}
                  onChange={(e) => setRascunho(e.target.value)}
                  data-testid="campo-de-resposta-suporte"
                />
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={enviando}
                  onClick={() => void responder()}
                  data-testid="responder-suporte"
                >
                  {t("Responder")}
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
