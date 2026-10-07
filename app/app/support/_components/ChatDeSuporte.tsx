"use client";

/**
 * O chat de suporte do lado do CLIENTE.
 *
 * ─── Por que uma lista de chamados, e não uma conversa contínua ──────────────
 *
 * A decisão do dono foi "1 thread = 1 chamado": fechou, abre outro. Uma conversa
 * contínua não teria "fim" — e sem fim não há NPS, não há fila de abertos e não
 * há como medir tempo de resolução. O histórico do usuário É a lista.
 *
 * ─── Por que o aviso do badge não aparece aqui ──────────────────────────────
 *
 * O sino do sistema conta os itens da Central. O suporte ainda não emite evento
 * (é a pendência do badge) — então esta tela não promete um aviso que não chega.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { toast } from "sonner";

interface Chamado {
  id: string;
  assunto: string | null;
  status: string;
  nps: number | null;
  created_at: string;
  updated_at: string;
}

interface Mensagem {
  id: string;
  author_kind: "usuario" | "ia" | "humano";
  body: string | null;
  created_at: string;
}

/** O rótulo do autor. `ia` e `humano` são a PLATAFORMA respondendo. */
const ROTULO_DO_AUTOR: Record<Mensagem["author_kind"], string> = {
  usuario: "Você",
  ia: "Assistente",
  humano: "Suporte",
};

export function ChatDeSuporte() {
  const t = useT();
  const [chamados, setChamados] = useState<Chamado[]>([]);
  const [aberto, setAberto] = useState<string | null>(null);
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [rascunho, setRascunho] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);

  const carregarChamados = useCallback(async () => {
    const res = await fetch("/api/v1/support/threads");
    if (!res.ok) {
      toast.error(t("Não consegui carregar seus chamados."));
      setCarregando(false);
      return;
    }
    const json = await res.json();
    setChamados(json?.data ?? []);
    setCarregando(false);
  }, [t]);

  const carregarMensagens = useCallback(async (id: string) => {
    const res = await fetch(`/api/v1/support/threads/${id}`);
    if (!res.ok) return;
    const json = await res.json();
    setMensagens(json?.data?.mensagens ?? []);
  }, []);

  useEffect(() => {
    void carregarChamados();
  }, [carregarChamados]);

  useEffect(() => {
    if (aberto) void carregarMensagens(aberto);
  }, [aberto, carregarMensagens]);

  /**
   * `?chamado=<id>` abre o chamado direto — é para onde o aviso da Central leva.
   * Sem isto, o sino notificaria e o clique cairia numa lista, obrigando a
   * pessoa a procurar o chamado que o aviso acabou de apontar.
   */
  const chamadoDaUrl = useSearchParams().get("chamado");
  useEffect(() => {
    if (chamadoDaUrl) setAberto(chamadoDaUrl);
  }, [chamadoDaUrl]);

  async function abrirChamado() {
    const texto = rascunho.trim();
    if (texto === "") return;
    setEnviando(true);
    try {
      const res = await fetch("/api/v1/support/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: texto }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui abrir o chamado."));
        return;
      }
      setRascunho("");
      await carregarChamados();
      setAberto(json?.data?.id ?? null);
      toast.success(t("Chamado aberto."));
    } finally {
      setEnviando(false);
    }
  }

  async function responder() {
    if (!aberto) return;
    const texto = rascunho.trim();
    if (texto === "") return;
    setEnviando(true);
    try {
      const res = await fetch(`/api/v1/support/threads/${aberto}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: texto }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui enviar."));
        return;
      }
      setRascunho("");
      await carregarMensagens(aberto);
      await carregarChamados();
    } finally {
      setEnviando(false);
    }
  }

  async function fechar(nota: number | null) {
    if (!aberto) return;
    const res = await fetch(`/api/v1/support/threads/${aberto}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nps: nota }),
    });
    if (!res.ok) {
      toast.error(t("Não consegui encerrar o chamado."));
      return;
    }
    setAberto(null);
    setMensagens([]);
    await carregarChamados();
    toast.success(t("Chamado encerrado."));
  }

  const chamadoAberto = chamados.find((c) => c.id === aberto) ?? null;
  const podeResponder =
    chamadoAberto !== null && chamadoAberto.status !== "fechado" && chamadoAberto.status !== "resolvido";

  return (
    <div className="mx-auto w-full max-w-3xl p-6" data-testid="chat-de-suporte">
      <h1 className="text-xl font-semibold">{t("Ajuda")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Fale com o suporte do sistema. A conversa fica aqui dentro — não sai para o WhatsApp.")}
      </p>

      {carregando ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="carregando">
          {t("Carregando…")}
        </p>
      ) : (
        <>
          {chamados.length > 0 && (
            <div className="mt-6 space-y-2" data-testid="lista-de-chamados">
              {chamados.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setAberto(c.id);
                    setRascunho("");
                  }}
                  data-testid={`chamado-${c.id}`}
                  className="flex w-full items-center justify-between rounded-md border p-3 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">
                    {c.assunto ?? t("Chamado")} ·{" "}
                    <span className="text-muted-foreground">{t(c.status)}</span>
                  </span>
                  {c.nps !== null && (
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {t("Nota")}: {c.nps}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {aberto && chamadoAberto && (
            <Card className="mt-6 p-4" data-testid="chamado-aberto">
              <div className="max-h-96 space-y-3 overflow-y-auto">
                {mensagens.map((m) => (
                  <div key={m.id} className="text-sm" data-testid={`mensagem-${m.id}`}>
                    <span className="font-medium">{t(ROTULO_DO_AUTOR[m.author_kind])}</span>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                ))}
              </div>

              {podeResponder ? (
                <div className="mt-4">
                  <Label className="text-xs" htmlFor="resposta">
                    {t("Sua mensagem")}
                  </Label>
                  <Textarea
                    id="resposta"
                    value={rascunho}
                    rows={3}
                    onChange={(e) => setRascunho(e.target.value)}
                    data-testid="campo-de-resposta"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" disabled={enviando} onClick={() => void responder()} data-testid="responder">
                      {t("Enviar")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void fechar(null)}
                      data-testid="fechar-sem-nota"
                    >
                      {t("Encerrar")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">{t("Este chamado foi encerrado.")}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs">{t("Como foi o atendimento?")}</span>
                    {[0, 2, 4, 6, 8, 10].map((nota) => (
                      <Button
                        key={nota}
                        size="sm"
                        variant="outline"
                        onClick={() => void fechar(nota)}
                        data-testid={`nps-${nota}`}
                      >
                        {nota}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}

          {!aberto && (
            <Card className="mt-6 p-4">
              <Label className="text-xs" htmlFor="novo-chamado">
                {t("Abrir um chamado")}
              </Label>
              <Textarea
                id="novo-chamado"
                value={rascunho}
                rows={4}
                onChange={(e) => setRascunho(e.target.value)}
                placeholder={t("Conte o que aconteceu, com o máximo de detalhe.")}
                data-testid="campo-de-novo-chamado"
              />
              <Button
                size="sm"
                className="mt-2"
                disabled={enviando}
                onClick={() => void abrirChamado()}
                data-testid="abrir-chamado"
              >
                {t("Abrir chamado")}
              </Button>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
