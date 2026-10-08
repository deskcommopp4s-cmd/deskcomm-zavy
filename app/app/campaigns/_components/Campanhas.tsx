"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { toast } from "sonner";

interface Campanha {
  id: string;
  name: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
}

interface Conexao {
  id: string;
  waha_session_name: string | null;
  display_name: string | null;
  phone_number: string | null;
  status: string | null;
}

const ROTULO_STATUS: Record<string, string> = {
  rascunho: "Rascunho",
  agendada: "Agendada",
  ativa: "Ativa",
  pausada: "Pausada",
  concluida: "Concluida",
  cancelada: "Cancelada",
};

/**
 * A tela de campanhas (A1, Fase 1 — o mínimo que já dispara).
 *
 * ── O PASSO DE REVISÃO É OBRIGATÓRIO ────────────────────────────────────────
 *
 * A mesa de análise (a11y/ux, 🔴): "a tela não tem passo de revisão/confirmação
 * — `agora` dispara no mesmo gesto de salvar". Disparo em massa é irreversível;
 * aqui o botão "Criar e disparar" só ativa depois de mostrar um resumo (nome,
 * conexões, público, mensagem) para confirmação explícita.
 */
export function Campanhas() {
  const t = useT();
  const [campanhas, setCampanhas] = useState<Campanha[]>([]);
  const [conexoes, setConexoes] = useState<Conexao[]>([]);
  const [carregando, setCarregando] = useState(true);

  const [nome, setNome] = useState("");
  const [sessoes, setSessoes] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [tetoDiario, setTetoDiario] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [revisando, setRevisando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [rCamp, rConex] = await Promise.all([
        fetch("/api/v1/campaigns"),
        fetch("/api/v1/channel-sessions"),
      ]);
      const camp = await rCamp.json().catch(() => null);
      const conex = await rConex.json().catch(() => null);
      if (rCamp.ok) setCampanhas(Array.isArray(camp) ? camp : []);
      if (rConex.ok) {
        const lista = Array.isArray(conex) ? conex : [];
        setConexoes(lista.filter((c) => c.status !== "disconnected"));
      }
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const tagsArray = useMemo(
    () =>
      tags
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 50),
    [tags],
  );

  const podeRevisar =
    nome.trim().length > 0 &&
    sessoes.length > 0 &&
    mensagem.trim().length > 0;

  async function criarEDisparar() {
    if (!podeRevisar) return;
    setEnviando(true);
    try {
      const criada = await fetch("/api/v1/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: nome.trim(),
          channel_session_ids: sessoes,
          audience: tagsArray.length ? { tags: tagsArray } : {},
          steps: [{ body: mensagem.trim() }],
          daily_limit: tetoDiario ? Number(tetoDiario) : null,
          new_lead_strategy: "rotacionar",
        }),
      });
      const criadaJson = await criada.json().catch(() => null);
      if (!criada.ok) {
        toast.error(criadaJson?.error?.message ? t(criadaJson.error.message) : t("Não consegui criar a campanha."));
        return;
      }
      const id = criadaJson?.data?.id as string | undefined;
      if (!id) return;

      const ativada = await fetch(`/api/v1/campaigns/${id}/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: tagsArray.length ? { tags: tagsArray } : {} }),
      });
      const ativadaJson = await ativada.json().catch(() => null);
      if (!ativada.ok) {
        toast.error(ativadaJson?.error?.message ? t(ativadaJson.error.message) : t("Não consegui disparar a campanha."));
        return;
      }
      toast.success(t("Campanha disparada."));
      setNome("");
      setSessoes([]);
      setTags("");
      setMensagem("");
      setTetoDiario("");
      setRevisando(false);
      await carregar();
    } finally {
      setEnviando(false);
    }
  }

  function alternarSessao(id: string) {
    setSessoes((atual) =>
      atual.includes(id) ? atual.filter((v) => v !== id) : [...atual, id],
    );
  }

  const resumoPessoa = useMemo(() => {
    if (!podeRevisar) return null;
    return {
      nome: nome.trim(),
      conexoes: sessoes.length,
      publico: tagsArray.length ? tagsArray.join(", ") : t("Toda a base (sem filtro)"),
      mensagem: mensagem.trim(),
    };
  }, [podeRevisar, nome, sessoes, tagsArray, mensagem, t]);

  return (
    <div className="space-y-6" data-testid="campanhas">
      <h1 className="text-xl font-semibold">{t("Campanhas")}</h1>

      {/* ── LISTA (acompanhamento) ── */}
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium">{t("Suas campanhas")}</h2>
        {carregando ? (
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        ) : campanhas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhuma campanha ainda.")}</p>
        ) : (
          <ul className="divide-y">
            {campanhas.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium">{c.name}</span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{t(ROTULO_STATUS[c.status] ?? c.status)}</span>
                  <span>
                    {c.sent_count}/{c.total_recipients} {t("enviadas")}
                  </span>
                  {c.failed_count > 0 && <span className="text-destructive">⚠ {c.failed_count}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── FORMULÁRIO (criação) ── */}
      <Card className="p-4" data-testid="formulario-campanha">
        <h2 className="mb-3 text-sm font-medium">{t("Nova campanha")}</h2>
        <div className="space-y-4">
          <div>
            <Label htmlFor="nome">{t("Nome da campanha")}</Label>
            <Input
              id="nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex.: Black Friday")}
              data-testid="campo-nome"
            />
          </div>

          <div>
            <Label>{t("Conexões")}</Label>
            {conexoes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma conexão ativa.")}</p>
            ) : (
              <div className="mt-1 space-y-1">
                {conexoes.map((con) => (
                  <label key={con.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sessoes.includes(con.id)}
                      onChange={() => alternarSessao(con.id)}
                      data-testid={`conexao-${con.id}`}
                    />
                    <span>
                      {con.display_name ?? con.phone_number ?? con.id.slice(0, 8)}
                    </span>
                    {con.phone_number && (
                      <span className="text-xs text-muted-foreground">{con.phone_number}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="tags">{t("Público (etiquetas)")}</Label>
            <Input
              id="tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("Ex.: interessado, black-friday")}
              data-testid="campo-tags"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Vazio = toda a base (sem filtro). Separadas por vírgula.")}
            </p>
          </div>

          <div>
            <Label htmlFor="mensagem">{t("Mensagem")}</Label>
            <Textarea
              id="mensagem"
              value={mensagem}
              rows={3}
              onChange={(e) => setMensagem(e.target.value)}
              data-testid="campo-mensagem"
            />
          </div>

          <div>
            <Label htmlFor="teto">{t("Teto por dia (opcional)")}</Label>
            <Input
              id="teto"
              type="number"
              min={1}
              value={tetoDiario}
              onChange={(e) => setTetoDiario(e.target.value)}
              data-testid="campo-teto"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Este teto é COMPARTILHADO com o atendimento do número.")}
            </p>
          </div>

          {!revisando ? (
            <Button
              disabled={!podeRevisar || enviando}
              onClick={() => setRevisando(true)}
              data-testid="ir-para-revisao"
            >
              {t("Revisar")}
            </Button>
          ) : (
            <div className="rounded-md border p-3" data-testid="revisao">
              <h3 className="mb-2 text-sm font-semibold">{t("Confirme o disparo")}</h3>
              {resumoPessoa && (
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t("Nome")}</dt>
                    <dd className="text-right">{resumoPessoa.nome}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t("Conexões")}</dt>
                    <dd className="text-right">{resumoPessoa.conexoes}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t("Público")}</dt>
                    <dd className="text-right">{resumoPessoa.publico}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t("Mensagem")}</dt>
                    <dd className="max-w-[60%] text-right">{resumoPessoa.mensagem}</dd>
                  </div>
                </dl>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={enviando}
                  onClick={() => void criarEDisparar()}
                  data-testid="confirmar-disparo"
                >
                  {enviando ? t("Disparando…") : t("Criar e disparar")}
                </Button>
                <Button variant="outline" disabled={enviando} onClick={() => setRevisando(false)}>
                  {t("Voltar")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}