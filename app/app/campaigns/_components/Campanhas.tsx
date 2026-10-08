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
  delivered_count: number;
  read_count: number;
  replied_count: number;
}

interface Conexao {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  status: string | null;
  daily_message_limit: number | null;
}

interface Passo {
  body: string;
  media_storage_path?: string;
  media_mime?: string;
  media_kind?: "image" | "document" | "voice";
  media_name?: string;
  delay_after_seconds: string;
}

const ROTULO_STATUS: Record<string, string> = {
  rascunho: "Rascunho",
  agendada: "Agendada",
  ativa: "Ativa",
  pausada: "Pausada",
  concluida: "Concluida",
  cancelada: "Cancelada",
};

const DIAS_DA_SEMANA: { valor: number; rotulo: string }[] = [
  { valor: 1, rotulo: "Seg" },
  { valor: 2, rotulo: "Ter" },
  { valor: 3, rotulo: "Qua" },
  { valor: 4, rotulo: "Qui" },
  { valor: 5, rotulo: "Sex" },
  { valor: 6, rotulo: "Sáb" },
  { valor: 0, rotulo: "Dom" },
];

type TipoRecorrencia = "semanal" | "mensal" | "dia_util" | "intervalo";

/**
 * A tela de campanhas (A1). Cria, agenda e acompanha um disparo em massa.
 *
 * Revisão de usabilidade (08/10/2026):
 *  - PÚBLICO por seletor de etiquetas existentes (não campo de texto);
 *  - anexo mostra o NOME do arquivo e permite REMOVER;
 *  - "Espera" com rótulo claro (espera até o PRÓXIMO passo);
 *  - estratégia de lead novo integrada ao bloco de conexões;
 *  - recorrência com as regras do desenho (semanal/mensal/dia_util/intervalo);
 *  - janela de envio nomeada (dias + horário juntos).
 */
export function Campanhas() {
  const t = useT();
  const [campanhas, setCampanhas] = useState<Campanha[]>([]);
  const [conexoes, setConexoes] = useState<Conexao[]>([]);
  const [etiquetas, setEtiquetas] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);

  const [nome, setNome] = useState("");
  const [sessoes, setSessoes] = useState<string[]>([]);
  const [etiquetasSelecionadas, setEtiquetasSelecionadas] = useState<string[]>([]);
  const [passos, setPassos] = useState<Passo[]>([{ body: "", delay_after_seconds: "" }]);
  const [tetoDiario, setTetoDiario] = useState("");
  const [horaInicio, setHoraInicio] = useState("8");
  const [horaFim, setHoraFim] = useState("20");
  const [dias, setDias] = useState<number[]>([1, 2, 3, 4, 5]);
  const [agendadoPara, setAgendadoPara] = useState("");
  const [novaEstrategia, setNovaEstrategia] = useState<"rotacionar" | "fixa">("rotacionar");
  const [sessaoFixa, setSessaoFixa] = useState("");
  const [variacaoIa, setVariacaoIa] = useState(false);
  const [recorrente, setRecorrente] = useState(false);
  const [recorrenciaTipo, setRecorrenciaTipo] = useState<TipoRecorrencia>("semanal");
  const [recorrenciaDias, setRecorrenciaDias] = useState<number[]>([1]);
  const [recorrenciaDiaMes, setRecorrenciaDiaMes] = useState("1");
  const [recorrenciaUltimoDia, setRecorrenciaUltimoDia] = useState(false);
  const [recorrenciaDiaUtil, setRecorrenciaDiaUtil] = useState<"primeiro" | "ultimo">("primeiro");
  const [recorrenciaDiaUtilN, setRecorrenciaDiaUtilN] = useState("1");
  const [recorrenciaHora, setRecorrenciaHora] = useState("9");
  const [recorrenciaIntervalo, setRecorrenciaIntervalo] = useState("7");
  const [enviando, setEnviando] = useState(false);
  const [revisando, setRevisando] = useState(false);
  const [subindo, setSubindo] = useState<number | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [rCamp, rConex, rTags] = await Promise.all([
        fetch("/api/v1/campaigns"),
        fetch("/api/v1/channel-sessions"),
        fetch("/api/v1/campaigns/tags"),
      ]);
      const camp = await rCamp.json().catch(() => null);
      const conex = await rConex.json().catch(() => null);
      const tags = await rTags.json().catch(() => null);
      if (rCamp.ok) setCampanhas(Array.isArray(camp) ? camp : []);
      if (rConex.ok) {
        const lista = Array.isArray(conex) ? conex : [];
        setConexoes(lista.filter((c) => c.status !== "disconnected"));
      }
      if (rTags.ok) setEtiquetas(Array.isArray(tags) ? tags : []);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const temCorpoOuMidia = (p: Passo) => p.body.trim().length > 0 || Boolean(p.media_storage_path);
  const podeRevisar =
    nome.trim().length > 0 &&
    sessoes.length > 0 &&
    passos.some(temCorpoOuMidia) &&
    passos.every(temCorpoOuMidia) &&
    (novaEstrategia !== "fixa" || sessaoFixa !== "");

  async function subirArquivo(index: number, arquivo: File) {
    setSubindo(index);
    try {
      const form = new FormData();
      form.append("file", arquivo);
      const res = await fetch("/api/v1/campaigns/media", { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui subir o arquivo."));
        return;
      }
      setPassos((atual) =>
        atual.map((p, i) => (i === index ? { ...p, ...json.data, media_name: arquivo.name } : p)),
      );
    } finally {
      setSubindo(null);
    }
  }

  function removerAnexo(index: number) {
    setPassos((atual) =>
      atual.map((p, i) =>
        i === index
          ? {
              ...p,
              media_storage_path: undefined,
              media_mime: undefined,
              media_kind: undefined,
              media_name: undefined,
            }
          : p,
      ),
    );
  }

  function atualizarPasso(index: number, campo: Partial<Passo>) {
    setPassos((atual) => atual.map((p, i) => (i === index ? { ...p, ...campo } : p)));
  }

  function adicionarPasso() {
    setPassos((atual) => [...atual, { body: "", delay_after_seconds: "" }]);
  }

  function removerPasso(index: number) {
    setPassos((atual) => atual.filter((_, i) => i !== index));
  }

  function alternarSessao(id: string) {
    setSessoes((atual) => (atual.includes(id) ? atual.filter((v) => v !== id) : [...atual, id]));
  }

  function alternarEtiqueta(tag: string) {
    setEtiquetasSelecionadas((atual) =>
      atual.includes(tag) ? atual.filter((v) => v !== tag) : [...atual, tag],
    );
  }

  function alternarDia(valor: number) {
    setDias((atual) => (atual.includes(valor) ? atual.filter((d) => d !== valor) : [...atual, valor]));
  }

  function alternarDiaRecorrencia(valor: number) {
    setRecorrenciaDias((atual) =>
      atual.includes(valor) ? atual.filter((d) => d !== valor) : [...atual, valor],
    );
  }

  const limiteEfetivoPorConexao = useMemo(() => {
    return conexoes
      .filter((c) => sessoes.includes(c.id))
      .map((c) => ({
        rotulo: c.display_name ?? c.phone_number ?? c.id.slice(0, 8),
        teto: c.daily_message_limit ?? null,
      }))
      .filter((c) => c.teto !== null);
  }, [conexoes, sessoes]);

  async function criarEDisparar() {
    if (!podeRevisar) return;
    setEnviando(true);
    try {
      const steps = passos.map((p) => ({
        body: p.body.trim() || null,
        media_storage_path: p.media_storage_path ?? null,
        media_kind: p.media_kind ?? null,
        media_mime: p.media_mime ?? null,
        delay_after_seconds: Number(p.delay_after_seconds || 0),
      }));
      let recurrence: unknown = null;
      if (recorrente) {
        if (recorrenciaTipo === "semanal") {
          recurrence = { kind: "semanal", weekdays: recorrenciaDias, hour: Number(recorrenciaHora), minute: 0 };
        } else if (recorrenciaTipo === "mensal") {
          recurrence = {
            kind: "mensal",
            ...(recorrenciaUltimoDia ? { last_month_day: true } : { month_days: [Number(recorrenciaDiaMes) || 1] }),
            hour: Number(recorrenciaHora),
            minute: 0,
          };
        } else if (recorrenciaTipo === "dia_util") {
          recurrence = {
            kind: "dia_util",
            business_day: recorrenciaDiaUtil,
            ...(recorrenciaDiaUtil === "primeiro" ? { business_day_nth: Number(recorrenciaDiaUtilN) || 1 } : {}),
            hour: Number(recorrenciaHora),
            minute: 0,
          };
        } else {
          recurrence = {
            kind: "intervalo",
            interval_n: Number(recorrenciaIntervalo) || 1,
            interval_unit: "dia",
            hour: Number(recorrenciaHora),
            minute: 0,
          };
        }
      }
      const corpo = {
        name: nome.trim(),
        channel_session_ids: sessoes,
        audience: etiquetasSelecionadas.length ? { tags: etiquetasSelecionadas } : {},
        steps,
        daily_limit: tetoDiario ? Number(tetoDiario) : null,
        new_lead_strategy: novaEstrategia,
        new_lead_session_id: novaEstrategia === "fixa" ? sessaoFixa : null,
        ai_variation: variacaoIa,
        window_start_hour: Number(horaInicio),
        window_end_hour: Number(horaFim),
        allowed_weekdays: dias,
        ...(recorrente
          ? { schedule_kind: "recorrente", recurrence }
          : agendadoPara
            ? { schedule_kind: "agendado", scheduled_at: new Date(agendadoPara).toISOString() }
            : {}),
      };

      const criada = await fetch("/api/v1/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
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
        body: JSON.stringify({
          audience: etiquetasSelecionadas.length ? { tags: etiquetasSelecionadas } : {},
        }),
      });
      const ativadaJson = await ativada.json().catch(() => null);
      if (!ativada.ok) {
        toast.error(ativadaJson?.error?.message ? t(ativadaJson.error.message) : t("Não consegui disparar a campanha."));
        return;
      }
      toast.success(recorrente ? t("Campanha recorrente programada.") : agendadoPara ? t("Campanha agendada.") : t("Campanha disparada."));
      setNome("");
      setSessoes([]);
      setEtiquetasSelecionadas([]);
      setPassos([{ body: "", delay_after_seconds: "" }]);
      setTetoDiario("");
      setAgendadoPara("");
      setNovaEstrategia("rotacionar");
      setSessaoFixa("");
      setVariacaoIa(false);
      setRecorrente(false);
      setRevisando(false);
      await carregar();
    } finally {
      setEnviando(false);
    }
  }

  async function pausar(campanha: Campanha) {
    const resposta = window.confirm(t("Pausar a campanha não volta sozinha. Continuar?"));
    if (!resposta) return;
    try {
      const res = await fetch(`/api/v1/campaigns/${campanha.id}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ motivo: t("Pausa manual") }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui pausar a campanha."));
        return;
      }
      toast.success(t("Campanha pausada."));
      await carregar();
    } catch {
      toast.error(t("Não consegui pausar a campanha."));
    }
  }

  const resumoPessoa = useMemo(() => {
    if (!podeRevisar) return null;
    return {
      nome: nome.trim(),
      conexoes: sessoes.length,
      publico: etiquetasSelecionadas.length
        ? etiquetasSelecionadas.join(", ")
        : t("Toda a base (sem filtro)"),
      passos: passos.map((p, i) => ({
        indice: i + 1,
        rotulo: p.media_kind
          ? p.media_name ?? (p.media_kind === "voice" ? t("Nota de voz") : p.media_kind === "image" ? t("Imagem") : t("Documento"))
          : p.body.trim(),
      })),
      agendado: recorrente
        ? t("Recorrente")
        : agendadoPara
          ? new Date(agendadoPara).toLocaleString()
          : t("Agora"),
    };
  }, [podeRevisar, nome, sessoes, etiquetasSelecionadas, passos, agendadoPara, recorrente, t]);

  return (
    <div className="space-y-6" data-testid="campanhas">
      <h1 className="text-xl font-semibold">{t("Campanhas")}</h1>

      <Card className="p-4" data-testid="lista-campanhas">
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
                  <span>{c.sent_count}/{c.total_recipients} {t("enviadas")}</span>
                  <span title={t("Entregues")}>{c.delivered_count} {t("entregues")}</span>
                  <span title={t("Lidas")}>{c.read_count} {t("lidas")}</span>
                  <span title={t("Respostas")}>{c.replied_count} {t("respostas")}</span>
                  {c.failed_count > 0 && <span className="text-destructive">⚠ {c.failed_count}</span>}
                  {(c.status === "ativa" || c.status === "agendada") && (
                    <button type="button" className="text-xs underline" onClick={() => void pausar(c)} data-testid={`pausar-${c.id}`}>
                      {t("Pausar")}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4" data-testid="formulario-campanha">
        <h2 className="mb-3 text-sm font-medium">{t("Nova campanha")}</h2>
        <div className="space-y-4">
          {/* NOME */}
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

          {/* CONEXÕES + ESTRATÉGIA DE LEAD NOVO */}
          <div className="rounded-md border p-3">
            <Label className="mb-2 block">{t("Conexões que enviam")}</Label>
            {conexoes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma conexão ativa.")}</p>
            ) : (
              <div className="space-y-1">
                {conexoes.map((con) => (
                  <label key={con.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sessoes.includes(con.id)}
                      onChange={() => alternarSessao(con.id)}
                      data-testid={`conexao-${con.id}`}
                    />
                    <span>{con.display_name ?? con.phone_number ?? con.id.slice(0, 8)}</span>
                    {con.daily_message_limit !== null && (
                      <span className="text-xs text-muted-foreground">· {t("teto")} {con.daily_message_limit}</span>
                    )}
                  </label>
                ))}
              </div>
            )}

            <div className="mt-3 border-t pt-3">
              <Label className="mb-1 block">{t("Lead novo (sem conversa)")}</Label>
              <p className="mb-2 text-xs text-muted-foreground">
                {t("Quem não tem conversa ainda não tem conexão de afinidade — escolha como tratar.")}
              </p>
              <select
                value={novaEstrategia}
                onChange={(e) => setNovaEstrategia(e.target.value as "rotacionar" | "fixa")}
                className="w-full rounded-md border px-2 py-1 text-sm"
                data-testid="estrategia-novo"
              >
                <option value="rotacionar">{t("Rotacionar entre as conexões marcadas acima")}</option>
                <option value="fixa">{t("Sempre por uma conexão fixa")}</option>
              </select>
              {novaEstrategia === "fixa" && (
                <select
                  value={sessaoFixa}
                  onChange={(e) => setSessaoFixa(e.target.value)}
                  className="mt-1 w-full rounded-md border px-2 py-1 text-sm"
                  data-testid="sessao-fixa"
                >
                  <option value="">{t("Escolha a conexão…")}</option>
                  {conexoes.map((con) => (
                    <option key={con.id} value={con.id}>
                      {con.display_name ?? con.phone_number ?? con.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* PÚBLICO POR ETIQUETAS */}
          <div>
            <Label className="mb-1 block">{t("Público (etiquetas)")}</Label>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("Selecione as etiquetas dos contatos que recebem. Vazio = toda a base.")}
            </p>
            {etiquetas.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma etiqueta na conta ainda.")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {etiquetas.map((tag) => (
                  <label key={tag} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
                    <input
                      type="checkbox"
                      checked={etiquetasSelecionadas.includes(tag)}
                      onChange={() => alternarEtiqueta(tag)}
                      data-testid={`etiqueta-${tag}`}
                    />
                    <span>{tag}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* MENSAGENS (PASSOS) */}
          <div>
            <Label className="mb-2 block">{t("Mensagens (passos)")}</Label>
            <div className="space-y-3">
              {passos.map((passo, i) => (
                <div key={i} className="rounded-md border p-3" data-testid={`passo-${i}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium">{t("Passo")} {i + 1}</span>
                    {passos.length > 1 && (
                      <button type="button" className="text-xs text-destructive" onClick={() => removerPasso(i)}>
                        {t("Remover")}
                      </button>
                    )}
                  </div>
                  <Textarea
                    rows={2}
                    value={passo.body}
                    onChange={(e) => atualizarPasso(i, { body: e.target.value })}
                    placeholder={t("Texto da mensagem")}
                    data-testid={`campo-passo-${i}`}
                  />
                  <div className="mt-2 flex items-center gap-3">
                    {passo.media_storage_path ? (
                      <span className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">
                          {passo.media_kind === "voice" ? t("Nota de voz") : passo.media_kind === "image" ? t("Imagem") : t("Documento")}
                          {passo.media_name ? ` — ${passo.media_name}` : ""}
                        </span>
                        <button type="button" className="text-xs text-destructive underline" onClick={() => removerAnexo(i)} data-testid={`remover-anexo-${i}`}>
                          {t("Remover arquivo")}
                        </button>
                      </span>
                    ) : (
                      <input
                        type="file"
                        disabled={subindo === i}
                        aria-label={t("Anexar arquivo")}
                        data-testid={`arquivo-${i}`}
                        className="text-xs"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void subirArquivo(i, f);
                          e.target.value = "";
                        }}
                      />
                    )}
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">{t("Espera até o próximo passo (s)")}</Label>
                      <Input
                        className="w-24"
                        type="number"
                        min={0}
                        value={passo.delay_after_seconds}
                        onChange={(e) => atualizarPasso(i, { delay_after_seconds: e.target.value })}
                        data-testid={`espera-${i}`}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={adicionarPasso} data-testid="adicionar-passo">
                {t("Adicionar passo")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t("A espera é o tempo até o próximo passo sair, em segundos.")}
              </p>
            </div>
          </div>

          {/* JANELA DE ENVIO */}
          <div className="rounded-md border p-3">
            <Label className="mb-1 block">{t("Janela de envio")}</Label>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("Fora desta janela a campanha fica agendada para a próxima abertura.")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="hora-inicio">{t("Horário início")}</Label>
                <Input id="hora-inicio" type="number" min={0} max={23} value={horaInicio} onChange={(e) => setHoraInicio(e.target.value)} data-testid="hora-inicio" />
              </div>
              <div>
                <Label htmlFor="hora-fim">{t("Horário fim")}</Label>
                <Input id="hora-fim" type="number" min={0} max={23} value={horaFim} onChange={(e) => setHoraFim(e.target.value)} data-testid="hora-fim" />
              </div>
            </div>
            <div className="mt-2">
              <Label>{t("Dias da semana da janela")}</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {DIAS_DA_SEMANA.map((d) => (
                  <label key={d.valor} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={dias.includes(d.valor)} onChange={() => alternarDia(d.valor)} data-testid={`dia-${d.valor}`} />
                    <span>{d.rotulo}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* AGENDAMENTO + RECORRÊNCIA + LIMITE */}
          <div>
            <Label htmlFor="agendado">{t("Agendar para (opcional)")}</Label>
            <Input
              id="agendado"
              type="datetime-local"
              value={agendadoPara}
              onChange={(e) => setAgendadoPara(e.target.value)}
              data-testid="campo-agendado"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("Vazio = dispara agora (dentro da janela).")}</p>

            <div className="mt-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={recorrente} onChange={(e) => setRecorrente(e.target.checked)} data-testid="recorrente" />
                {t("Campanha recorrente")}
              </label>
              {recorrente && (
                <div className="mt-2 space-y-2 rounded-md border p-3" data-testid="recorrencia-bloco">
                  <select
                    value={recorrenciaTipo}
                    onChange={(e) => setRecorrenciaTipo(e.target.value as TipoRecorrencia)}
                    className="w-full rounded-md border px-2 py-1 text-sm"
                    data-testid="recorrencia-tipo"
                  >
                    <option value="semanal">{t("Toda semana, nos dias")}</option>
                    <option value="mensal">{t("Todo mês, no dia")}</option>
                    <option value="dia_util">{t("Todo dia útil")}</option>
                    <option value="intervalo">{t("A cada N dias")}</option>
                  </select>
                  {recorrenciaTipo === "semanal" && (
                    <div className="flex flex-wrap gap-2">
                      {DIAS_DA_SEMANA.map((d) => (
                        <label key={d.valor} className="flex items-center gap-1 text-sm">
                          <input type="checkbox" checked={recorrenciaDias.includes(d.valor)} onChange={() => alternarDiaRecorrencia(d.valor)} data-testid={`recorrencia-dia-${d.valor}`} />
                          <span>{d.rotulo}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {recorrenciaTipo === "mensal" && (
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={recorrenciaUltimoDia} onChange={(e) => setRecorrenciaUltimoDia(e.target.checked)} data-testid="recorrencia-ultimo" />
                        <span>{t("Último dia do mês")}</span>
                      </label>
                      {!recorrenciaUltimoDia && (
                        <div className="flex items-center gap-1">
                          <Label className="text-xs">{t("Dia")}</Label>
                          <Input className="w-16" type="number" min={1} max={31} value={recorrenciaDiaMes} onChange={(e) => setRecorrenciaDiaMes(e.target.value)} data-testid="recorrencia-dia-mes" />
                        </div>
                      )}
                    </div>
                  )}
                  {recorrenciaTipo === "dia_util" && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">{t("Quando")}</Label>
                      <select value={recorrenciaDiaUtil} onChange={(e) => setRecorrenciaDiaUtil(e.target.value as "primeiro" | "ultimo")} className="rounded-md border px-2 py-1 text-sm" data-testid="recorrencia-dia-util">
                        <option value="primeiro">{t("Primeiro dia útil")}</option>
                        <option value="ultimo">{t("Último dia útil")}</option>
                      </select>
                      {recorrenciaDiaUtil === "primeiro" && (
                        <div className="flex items-center gap-1">
                          <Label className="text-xs">{t("N-ésimo")}</Label>
                          <Input className="w-16" type="number" min={1} max={5} value={recorrenciaDiaUtilN} onChange={(e) => setRecorrenciaDiaUtilN(e.target.value)} data-testid="recorrencia-dia-util-n" />
                        </div>
                      )}
                    </div>
                  )}
                  {recorrenciaTipo === "intervalo" && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">{t("A cada N dias")}</Label>
                      <Input className="w-20" type="number" min={1} value={recorrenciaIntervalo} onChange={(e) => setRecorrenciaIntervalo(e.target.value)} data-testid="recorrencia-intervalo" />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">{t("Hora")}</Label>
                    <Input className="w-24" type="number" min={0} max={23} value={recorrenciaHora} onChange={(e) => setRecorrenciaHora(e.target.value)} data-testid="recorrencia-hora" />
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3">
              <Label htmlFor="teto">{t("Teto por dia (opcional)")}</Label>
              <Input id="teto" type="number" min={1} value={tetoDiario} onChange={(e) => setTetoDiario(e.target.value)} data-testid="campo-teto" />
              {limiteEfetivoPorConexao.length > 0 && (
                <p className="mt-1 text-xs text-amber-600" role="alert">
                  {t("Este teto é COMPARTILHADO com o atendimento dos números selecionados.")}{" "}
                  {limiteEfetivoPorConexao.map((c) => `${c.rotulo}: ${c.teto}`).join(" · ")}
                </p>
              )}
            </div>

            <div className="mt-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={variacaoIa} onChange={(e) => setVariacaoIa(e.target.checked)} data-testid="variacao-ia" />
                {t("Variação por IA (só no canal não oficial)")}
              </label>
            </div>
          </div>

          {/* REVISÃO */}
          {!revisando ? (
            <Button disabled={!podeRevisar || enviando} onClick={() => setRevisando(true)} data-testid="ir-para-revisao">
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
                    <dt className="text-muted-foreground">{t("Quando")}</dt>
                    <dd className="text-right">{resumoPessoa.agendado}</dd>
                  </div>
                  {resumoPessoa.passos.map((p) => (
                    <div key={p.indice} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{t("Passo")} {p.indice}</dt>
                      <dd className="max-w-[60%] text-right">{p.rotulo}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-3 flex gap-2">
                <Button disabled={enviando} onClick={() => void criarEDisparar()} data-testid="confirmar-disparo">
                  {enviando ? t("Disparando…") : recorrente ? t("Criar recorrente") : agendadoPara ? t("Criar e agendar") : t("Criar e disparar")}
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