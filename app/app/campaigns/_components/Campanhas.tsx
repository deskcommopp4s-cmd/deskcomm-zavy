"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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

interface DetalheDaCampanha {
  campanha: {
    id: string; name: string; status: string; auto_paused: boolean;
    paused_reason: string | null; breaker_layer: number | null;
    total_recipients: number; sent_count: number; failed_count: number;
    // Configuração — o MESMO GET alimenta o modo edição (o formulário reabre
    // preenchido com estes campos).
    channel_session_ids: string[] | null;
    new_lead_strategy: string | null;
    new_lead_session_id: string | null;
    daily_limit: number | null;
    window_start_hour: number | null;
    window_end_hour: number | null;
    allowed_weekdays: number[] | null;
    audience: { tags?: string[] } | null;
    ai_variation: boolean | null;
    schedule_kind: string | null;
    scheduled_at: string | null;
    recurrence: unknown;
  };
  passos: { step_order: number; body: string | null; media_kind: string | null; media_storage_path?: string | null; media_mime?: string | null; media_name?: string | null; delay_after_seconds: number }[];
  destinatarios: { id: string; status: string; nome: string; current_step: number; attempts: number; last_error: string | null }[];
  contadores: { entregues: number; lidas: number; respondidos: number };
}

interface Etiqueta {
  tag: string;
  uso_em_contatos: number;
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

/** Converte um ISO para o valor do input `datetime-local` (no fuso do navegador). */
function paraInputLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Lê o corpo de uma resposta que pode vir crua ou em `{ data: [...] }`. */
function lerLista<T>(j: unknown): T[] {
  if (Array.isArray(j)) return j as T[];
  if (j && typeof j === "object" && Array.isArray((j as { data?: unknown }).data)) {
    return (j as { data: T[] }).data;
  }
  return [];
}

/**
 * Disparos em massa (A1). Ordem da tela = desenho §7:
 * 1 Nome · 2 Conexões (+ lead novo) · 3 Público · 4 Mensagens · 5 Agendamento ·
 * 6 Limites (janela + teto) · 7 Acompanhamento. A revisão separa criar de disparar.
 */
export function Campanhas() {
  const t = useT();
  const [campanhas, setCampanhas] = useState<Campanha[]>([]);
  const [conexoes, setConexoes] = useState<Conexao[]>([]);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [buscaEtiqueta, setBuscaEtiqueta] = useState("");
  const [previa, setPrevia] = useState<number | null>(null);
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
  const [detalhe, setDetalhe] = useState<DetalheDaCampanha | null>(null);
  const [abrindoDetalhe, setAbrindoDetalhe] = useState(false);
  // Quando setado, o formulário do topo está em MODO EDIÇÃO (rascunho reaberto):
  // o botão de revisão vira "Salvar alterações" e grava via PUT.
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [rCamp, rConex, rTags] = await Promise.all([
        fetch("/api/v1/campaigns"),
        fetch("/api/v1/channel-sessions"),
        fetch("/api/v1/campaigns/tags"),
      ]);
      const [camp, conex, tags] = await Promise.all([
        rCamp.json().catch(() => null),
        rConex.json().catch(() => null),
        rTags.json().catch(() => null),
      ]);
      if (rCamp.ok) setCampanhas(lerLista<Campanha>(camp));
      if (rConex.ok) setConexoes(lerLista<Conexao>(conex).filter((c) => c.status !== "disconnected"));
      if (rTags.ok) setEtiquetas(lerLista<Etiqueta>(tags));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Prévia da contagem — muda quando as etiquetas mudam.
  useEffect(() => {
    const qs = etiquetasSelecionadas.join(",");
    let vivo = true;
    fetch(`/api/v1/campaigns/previa?tags=${encodeURIComponent(qs)}`)
      .then((r) => r.json())
      .then((j) => {
        if (vivo) setPrevia(typeof j?.data?.total === "number" ? j.data.total : null);
      })
      .catch(() => {
        if (vivo) setPrevia(null);
      });
    return () => {
      vivo = false;
    };
  }, [etiquetasSelecionadas]);

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
      const dados = json?.data ?? json;
      setPassos((atual) =>
        atual.map((p, i) => (i === index ? { ...p, ...dados, media_name: arquivo.name } : p)),
      );
    } finally {
      setSubindo(null);
    }
  }

  function removerAnexo(index: number) {
    setPassos((atual) =>
      atual.map((p, i) =>
        i === index
          ? { ...p, media_storage_path: undefined, media_mime: undefined, media_kind: undefined, media_name: undefined }
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

  const etiquetasFiltradas = useMemo(
    () =>
      etiquetas
        .filter((e) => e.tag.toLowerCase().includes(buscaEtiqueta.trim().toLowerCase()))
        .slice(0, 100),
    [etiquetas, buscaEtiqueta],
  );

  const limiteEfetivoPorConexao = useMemo(
    () =>
      conexoes
        .filter((c) => sessoes.includes(c.id))
        .map((c) => ({
          rotulo: c.display_name ?? c.phone_number ?? c.id.slice(0, 8),
          teto: c.daily_message_limit ?? null,
        }))
        .filter((c) => c.teto !== null),
    [conexoes, sessoes],
  );

  function montarRecorrencia(): unknown {
    if (!recorrente) return null;
    if (recorrenciaTipo === "semanal") {
      return { kind: "semanal", weekdays: recorrenciaDias, hour: Number(recorrenciaHora), minute: 0 };
    }
    if (recorrenciaTipo === "mensal") {
      return {
        kind: "mensal",
        ...(recorrenciaUltimoDia ? { last_month_day: true } : { month_days: [Number(recorrenciaDiaMes) || 1] }),
        hour: Number(recorrenciaHora),
        minute: 0,
      };
    }
    if (recorrenciaTipo === "dia_util") {
      return {
        kind: "dia_util",
        business_day: recorrenciaDiaUtil,
        ...(recorrenciaDiaUtil === "primeiro" ? { business_day_nth: Number(recorrenciaDiaUtilN) || 1 } : {}),
        hour: Number(recorrenciaHora),
        minute: 0,
      };
    }
    return {
      kind: "intervalo",
      interval_n: Number(recorrenciaIntervalo) || 1,
      interval_unit: "dia",
      hour: Number(recorrenciaHora),
      minute: 0,
    };
  }

  // O corpo do formulário — o MESMO para criar (POST) e para salvar a edição
  // (PUT). O formulário inteiro é a fonte de verdade da campanha.
  function montarCorpo() {
    const steps = passos.map((p) => ({
      body: p.body.trim() || null,
      media_storage_path: p.media_storage_path ?? null,
      media_kind: p.media_kind ?? null,
      media_mime: p.media_mime ?? null,
      delay_after_seconds: Number(p.delay_after_seconds || 0),
    }));
    return {
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
        ? { schedule_kind: "recorrente", recurrence: montarRecorrencia() }
        : agendadoPara
          ? { schedule_kind: "agendado", scheduled_at: new Date(agendadoPara).toISOString() }
          : {}),
    };
  }

  function limparForm() {
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
    setEditandoId(null);
    setRevisando(false);
  }

  async function criarEDisparar() {
    if (!podeRevisar) return;
    setEnviando(true);
    try {
      const criada = await fetch("/api/v1/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(montarCorpo()),
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
        body: JSON.stringify({ audience: etiquetasSelecionadas.length ? { tags: etiquetasSelecionadas } : {} }),
      });
      const ativadaJson = await ativada.json().catch(() => null);
      if (!ativada.ok) {
        toast.error(ativadaJson?.error?.message ? t(ativadaJson.error.message) : t("Não consegui disparar a campanha."));
        return;
      }
      toast.success(recorrente ? t("Campanha recorrente programada.") : agendadoPara ? t("Campanha agendada.") : t("Campanha disparada."));
      limparForm();
      await carregar();
    } finally {
      setEnviando(false);
    }
  }

  async function abrirDetalhe(campanha: Campanha) {
    setAbrindoDetalhe(true);
    try {
      const res = await fetch(`/api/v1/campaigns/${campanha.id}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui abrir a campanha."));
        return;
      }
      setDetalhe((json?.data ?? null) as DetalheDaCampanha | null);
    } finally {
      setAbrindoDetalhe(false);
    }
  }

  async function pausar(campanha: { id: string }) {
    if (!window.confirm(t("Pausar a campanha não volta sozinha. Continuar?"))) return;
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
      setDetalhe((d) => (d && d.campanha.id === campanha.id ? { ...d, campanha: { ...d.campanha, status: "pausada" } } : d));
      await carregar();
    } catch {
      toast.error(t("Não consegui pausar a campanha."));
    }
  }

  // Retomar só existe para quem foi pausada (pausa não volta sozinha). Retomada a
  // campanha, o worker segue do ponto em que parou — os pendentes continuam pendentes.
  async function retomar(campanha: { id: string }) {
    try {
      const res = await fetch(`/api/v1/campaigns/${campanha.id}/resume`, { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui retomar a campanha."));
        return;
      }
      toast.success(t("Campanha retomada."));
      setDetalhe((d) => (d && d.campanha.id === campanha.id ? { ...d, campanha: { ...d.campanha, status: "ativa" } } : d));
      await carregar();
    } catch {
      toast.error(t("Não consegui retomar a campanha."));
    }
  }

  // Reabre a campanha EM RASCUNHO no formulário com TODOS os campos — o usuário
  // muda o que quiser e salva de volta (PUT). Rascunho: nada foi enviado ainda.
  async function editar(campanha: { id: string }) {
    setAbrindoDetalhe(true);
    try {
      const res = await fetch(`/api/v1/campaigns/${campanha.id}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui abrir a campanha."));
        return;
      }
      const d = (json?.data ?? null) as DetalheDaCampanha | null;
      if (!d) return;
      const c = d.campanha;
      setNome(c.name ?? "");
      setSessoes(c.channel_session_ids ?? []);
      setEtiquetasSelecionadas(c.audience?.tags ?? []);
      setPassos(
        d.passos.length
          ? d.passos.map((p) => ({
              body: p.body ?? "",
              delay_after_seconds: p.delay_after_seconds ? String(p.delay_after_seconds) : "",
              media_kind: (p.media_kind as Passo["media_kind"]) ?? undefined,
              media_storage_path: p.media_storage_path ?? undefined,
              media_mime: p.media_mime ?? undefined,
              media_name: p.media_name ?? undefined,
            }))
          : [{ body: "", delay_after_seconds: "" }],
      );
      setTetoDiario(c.daily_limit ? String(c.daily_limit) : "");
      setHoraInicio(String(c.window_start_hour ?? 8));
      setHoraFim(String(c.window_end_hour ?? 20));
      setDias(c.allowed_weekdays ?? [1, 2, 3, 4, 5]);
      setNovaEstrategia(c.new_lead_strategy === "fixa" ? "fixa" : "rotacionar");
      setSessaoFixa(c.new_lead_session_id ?? "");
      setVariacaoIa(Boolean(c.ai_variation));
      setRecorrente(c.schedule_kind === "recorrente");
      setAgendadoPara(
        c.schedule_kind === "agendado" && c.scheduled_at ? paraInputLocal(c.scheduled_at) : "",
      );
      setEditandoId(campanha.id);
      setRevisando(false);
      setDetalhe(null);
      toast.success(t("Campanha aberta para edição."));
    } finally {
      setAbrindoDetalhe(false);
    }
  }

  // Salva o rascunho reaberto. NÃO dispara — o disparo é outro gesto (Ativar).
  async function salvarEdicao() {
    if (!podeRevisar || !editandoId) return;
    setEnviando(true);
    try {
      const res = await fetch(`/api/v1/campaigns/${editandoId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(montarCorpo()),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("Não consegui salvar a campanha."));
        return;
      }
      toast.success(t("Alterações salvas."));
      limparForm();
      await carregar();
    } finally {
      setEnviando(false);
    }
  }

  const resumoPessoa = useMemo(() => {
    if (!podeRevisar) return null;
    return {
      nome: nome.trim(),
      conexoes: sessoes.length,
      publico: etiquetasSelecionadas.length ? etiquetasSelecionadas.join(", ") : t("Toda a base (sem filtro)"),
      passos: passos.map((p, i) => ({
        indice: i + 1,
        rotulo: p.media_kind
          ? p.media_name ?? (p.media_kind === "voice" ? t("Nota de voz") : p.media_kind === "image" ? t("Imagem") : t("Documento"))
          : p.body.trim(),
      })),
      agendado: recorrente ? t("Recorrente") : agendadoPara ? new Date(agendadoPara).toLocaleString() : t("Agora"),
    };
  }, [podeRevisar, nome, sessoes, etiquetasSelecionadas, passos, agendadoPara, recorrente, t]);

  return (
    <div className="space-y-6" data-testid="campanhas">
      <h1 className="text-xl font-semibold">{t("Campanhas")}</h1>

      <Card className="p-4" data-testid="formulario-campanha">
        <h2 className="mb-3 text-sm font-medium">{editandoId ? t("Editando campanha") : t("Nova campanha")}</h2>
        {editandoId && (
          <div
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500 p-2 text-sm"
            data-testid="modo-edicao"
          >
            <span className="text-amber-600">
              {t("Você está editando um rascunho. Salvar não dispara — o disparo é o botão Ativar.")}
            </span>
            <Button variant="outline" size="sm" onClick={limparForm}>
              {t("Cancelar edição")}
            </Button>
          </div>
        )}
        <div className="space-y-5">
          {/* 1 · NOME */}
          <div>
            <Label htmlFor="nome">{t("Nome da campanha")}</Label>
            <Input id="nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t("Ex.: Black Friday")} data-testid="campo-nome" />
          </div>

          {/* 2 · CONEXÕES + LEAD NOVO */}
          <div className="rounded-md border p-3">
            <Label className="mb-2 block">{t("Conexões que enviam")}</Label>
            {conexoes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma conexão ativa.")}</p>
            ) : (
              <div className="space-y-2">
                {conexoes.map((con) => (
                  <div key={con.id} className="flex items-center justify-between gap-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={sessoes.includes(con.id)} onChange={() => alternarSessao(con.id)} data-testid={`conexao-${con.id}`} />
                      <span>{con.display_name ?? con.phone_number ?? con.id.slice(0, 8)}</span>
                    </label>
                    {con.daily_message_limit !== null && (
                      <Badge variant="secondary">{t("teto")} {con.daily_message_limit}</Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 border-t pt-3">
              <Label className="mb-1 block">{t("Lead novo (sem conversa)")}</Label>
              <Select value={novaEstrategia} onValueChange={(v) => setNovaEstrategia(v as "rotacionar" | "fixa")}>
                <SelectTrigger data-testid="estrategia-novo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rotacionar">{t("Rotacionar entre as conexões marcadas acima")}</SelectItem>
                  <SelectItem value="fixa">{t("Sempre por uma conexão fixa")}</SelectItem>
                </SelectContent>
              </Select>
              {novaEstrategia === "fixa" && (
                <Select value={sessaoFixa} onValueChange={setSessaoFixa}>
                  <SelectTrigger className="mt-2" data-testid="sessao-fixa">
                    <SelectValue placeholder={t("Escolha a conexão…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {conexoes.map((con) => (
                      <SelectItem key={con.id} value={con.id}>
                        {con.display_name ?? con.phone_number ?? con.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {t("Quem não tem conversa não tem conexão de afinidade — a escolha cria a conversa.")}
              </p>
            </div>
          </div>

          {/* 3 · PÚBLICO */}
          <div>
            <Label className="mb-1 block">{t("Público (etiquetas)")}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" data-testid="abrir-etiquetas">
                  {t("Selecionar etiquetas")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72">
                <Input
                  placeholder={t("Buscar etiqueta…")}
                  value={buscaEtiqueta}
                  onChange={(e) => setBuscaEtiqueta(e.target.value)}
                  data-testid="busca-etiqueta"
                />
                <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {etiquetasFiltradas.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("Nenhuma etiqueta encontrada.")}</p>
                  ) : (
                    etiquetasFiltradas.map((e) => (
                      <label key={e.tag} className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2">
                          <input type="checkbox" checked={etiquetasSelecionadas.includes(e.tag)} onChange={() => alternarEtiqueta(e.tag)} data-testid={`etiqueta-${e.tag}`} />
                          <span>{e.tag}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{e.uso_em_contatos}</span>
                      </label>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {etiquetasSelecionadas.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {etiquetasSelecionadas.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-muted-foreground" data-testid="previa-publico">
              {previa === null
                ? t("Vazio = toda a base (sem filtro).")
                : `${previa} ${t("contatos recebem")}`}
            </p>
          </div>

          {/* 4 · MENSAGENS */}
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
                  <Textarea rows={2} value={passo.body} onChange={(e) => atualizarPasso(i, { body: e.target.value })} placeholder={t("Texto da mensagem")} data-testid={`campo-passo-${i}`} />
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {passo.media_storage_path ? (
                      <span className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                        <span>{passo.media_name ?? t("Arquivo")}</span>
                        <button type="button" className="text-destructive underline" onClick={() => removerAnexo(i)} data-testid={`remover-anexo-${i}`}>
                          {t("Remover arquivo")}
                        </button>
                      </span>
                    ) : (
                      <input type="file" disabled={subindo === i} aria-label={t("Anexar arquivo")} data-testid={`arquivo-${i}`} className="text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (f) void subirArquivo(i, f); e.target.value = ""; }} />
                    )}
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">{t("Espera até o próximo passo (s)")}</Label>
                      <Input className="w-24" type="number" min={0} value={passo.delay_after_seconds} onChange={(e) => atualizarPasso(i, { delay_after_seconds: e.target.value })} data-testid={`espera-${i}`} />
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={adicionarPasso} data-testid="adicionar-passo">
                {t("Adicionar passo")}
              </Button>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>{t("Variação por IA")}</Label>
                <p className="text-xs text-muted-foreground">{t("Reescreve cada mensagem mantendo a estrutura. Só no canal não oficial.")}</p>
              </div>
              <Switch checked={variacaoIa} onCheckedChange={setVariacaoIa} data-testid="variacao-ia" />
            </div>
          </div>

          {/* 5 · AGENDAMENTO */}
          <div className="rounded-md border p-3">
            <Label className="mb-2 block">{t("Agendamento")}</Label>
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t("Campanha recorrente")}</Label>
              <Switch checked={recorrente} onCheckedChange={setRecorrente} data-testid="recorrente" />
            </div>
            {!recorrente && (
              <div className="mt-2">
                <Label htmlFor="agendado" className="text-xs">{t("Agendar para (opcional)")}</Label>
                <Input id="agendado" type="datetime-local" value={agendadoPara} onChange={(e) => setAgendadoPara(e.target.value)} data-testid="campo-agendado" />
                <p className="mt-1 text-xs text-muted-foreground">{t("Vazio = dispara agora (dentro da janela).")}</p>
              </div>
            )}
            {recorrente && (
              <div className="mt-2 space-y-2" data-testid="recorrencia-bloco">
                <Select value={recorrenciaTipo} onValueChange={(v) => setRecorrenciaTipo(v as TipoRecorrencia)}>
                  <SelectTrigger data-testid="recorrencia-tipo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="semanal">{t("Toda semana, nos dias")}</SelectItem>
                    <SelectItem value="mensal">{t("Todo mês, no dia")}</SelectItem>
                    <SelectItem value="dia_util">{t("Todo dia útil")}</SelectItem>
                    <SelectItem value="intervalo">{t("A cada N dias")}</SelectItem>
                  </SelectContent>
                </Select>
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
                  <div className="flex items-center gap-3">
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
                  <div className="flex items-center gap-3">
                    <Select value={recorrenciaDiaUtil} onValueChange={(v) => setRecorrenciaDiaUtil(v as "primeiro" | "ultimo")}>
                      <SelectTrigger className="w-48" data-testid="recorrencia-dia-util">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="primeiro">{t("Primeiro dia útil")}</SelectItem>
                        <SelectItem value="ultimo">{t("Último dia útil")}</SelectItem>
                      </SelectContent>
                    </Select>
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

          {/* 6 · LIMITES (janela + teto) */}
          <div className="rounded-md border p-3">
            <Label className="mb-1 block">{t("Limites de envio")}</Label>
            <p className="mb-2 text-xs text-muted-foreground">{t("Fora da janela a campanha fica agendada para a próxima abertura.")}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="hora-inicio" className="text-xs">{t("Horário início")}</Label>
                <Input id="hora-inicio" type="number" min={0} max={23} value={horaInicio} onChange={(e) => setHoraInicio(e.target.value)} data-testid="hora-inicio" />
              </div>
              <div>
                <Label htmlFor="hora-fim" className="text-xs">{t("Horário fim")}</Label>
                <Input id="hora-fim" type="number" min={0} max={23} value={horaFim} onChange={(e) => setHoraFim(e.target.value)} data-testid="hora-fim" />
              </div>
            </div>
            <div className="mt-2">
              <Label className="text-xs">{t("Dias da semana da janela")}</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {DIAS_DA_SEMANA.map((d) => (
                  <label key={d.valor} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={dias.includes(d.valor)} onChange={() => alternarDia(d.valor)} data-testid={`dia-${d.valor}`} />
                    <span>{d.rotulo}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-3">
              <Label htmlFor="teto" className="text-xs">{t("Teto por dia (opcional)")}</Label>
              <Input id="teto" type="number" min={1} value={tetoDiario} onChange={(e) => setTetoDiario(e.target.value)} data-testid="campo-teto" />
              {limiteEfetivoPorConexao.length > 0 && (
                <p className="mt-1 text-xs text-amber-600" role="alert">
                  {t("Este teto é COMPARTILHADO com o atendimento dos números selecionados.")}{" "}
                  {limiteEfetivoPorConexao.map((c) => `${c.rotulo}: ${c.teto}`).join(" · ")}
                </p>
              )}
            </div>
          </div>

          {/* REVISÃO */}
          {!revisando ? (
            <Button
              disabled={!podeRevisar || enviando}
              onClick={() => (editandoId ? void salvarEdicao() : setRevisando(true))}
              data-testid={editandoId ? "salvar-edicao" : "ir-para-revisao"}
            >
              {editandoId ? (enviando ? t("Salvando…") : t("Salvar alterações")) : t("Revisar")}
            </Button>
          ) : (
            <div className="rounded-md border p-3" data-testid="revisao">
              <h3 className="mb-2 text-sm font-semibold">{t("Confirme o disparo")}</h3>
              {resumoPessoa && (
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("Nome")}</dt><dd className="text-right">{resumoPessoa.nome}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("Conexões")}</dt><dd className="text-right">{resumoPessoa.conexoes}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("Público")}</dt><dd className="text-right">{resumoPessoa.publico}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("Quando")}</dt><dd className="text-right">{resumoPessoa.agendado}</dd></div>
                  {resumoPessoa.passos.map((p) => (
                    <div key={p.indice} className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("Passo")} {p.indice}</dt><dd className="max-w-[60%] text-right">{p.rotulo}</dd></div>
                  ))}
                </dl>
              )}
              <div className="mt-3 flex gap-2">
                <Button disabled={enviando} onClick={() => void criarEDisparar()} data-testid="confirmar-disparo">
                  {enviando ? t("Disparando…") : recorrente ? t("Criar recorrente") : agendadoPara ? t("Criar e agendar") : t("Criar e disparar")}
                </Button>
                <Button variant="outline" disabled={enviando} onClick={() => setRevisando(false)}>{t("Voltar")}</Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* 7 · ACOMPANHAMENTO (no fim, como o desenho manda) */}
      <Card className="p-4" data-testid="lista-campanhas">
        <h2 className="mb-2 text-sm font-medium">{t("Acompanhamento")}</h2>
        {carregando ? (
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        ) : campanhas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhuma campanha ainda.")}</p>
        ) : (
          <ul className="divide-y">
            {campanhas.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <button
                  type="button"
                  className="font-medium text-left hover:underline"
                  onClick={() => void abrirDetalhe(c)}
                  data-testid={`abrir-campanha-${c.id}`}
                >
                  {c.name}
                </button>
                <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <Badge variant="secondary">{t(ROTULO_STATUS[c.status] ?? c.status)}</Badge>
                  <span>{c.sent_count}/{c.total_recipients} {t("enviadas")}</span>
                  <span title={t("Entregues")}>{c.delivered_count} {t("entregues")}</span>
                  <span title={t("Lidas")}>{c.read_count} {t("lidas")}</span>
                  <span title={t("Respostas")}>{c.replied_count} {t("respostas")}</span>
                  {c.failed_count > 0 && <span className="text-destructive">⚠ {c.failed_count}</span>}
                  {(c.status === "ativa" || c.status === "agendada") && (
                    <button type="button" className="underline" onClick={() => void pausar(c)} data-testid={`pausar-${c.id}`}>
                      {t("Pausar")}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* O DETALHE — abre no clique do Acompanhamento. Havia contadores e o botão
          PAUSAR, mas clicar na campanha não fazia NADA. */}
      <Dialog open={detalhe !== null} onOpenChange={(aberto) => { if (!aberto) setDetalhe(null); }}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detalhe?.campanha.name ?? t("Campanha")}</DialogTitle>
          </DialogHeader>
          {detalhe && (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="secondary">{t(ROTULO_STATUS[detalhe.campanha.status] ?? detalhe.campanha.status)}</Badge>
                {detalhe.campanha.auto_paused && detalhe.campanha.paused_reason && (
                  <span className="flex items-center gap-2 rounded-md border border-amber-500 p-2 text-amber-600" role="alert">
                    ⚠ {t("Pausada automaticamente")}: {detalhe.campanha.paused_reason}
                    {detalhe.campanha.breaker_layer ? ` (${t("camada")} ${detalhe.campanha.breaker_layer})` : ""}
                  </span>
                )}
                {/* Ações da campanha no próprio detalhe: sem isto, clicar na campanha
                    só mostrava números — não dava para pausar nem retomar. */}
                {detalhe.campanha.status === "ativa" && (
                  <Button variant="outline" size="sm" onClick={() => pausar(detalhe.campanha)}>
                    {t("Pausar")}
                  </Button>
                )}
                {detalhe.campanha.status === "pausada" && (
                  <Button variant="outline" size="sm" onClick={() => retomar(detalhe.campanha)}>
                    {t("Retomar")}
                  </Button>
                )}
                {detalhe.campanha.status === "rascunho" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void editar(detalhe.campanha)}
                    disabled={abrindoDetalhe}
                    data-testid="editar-campanha"
                  >
                    {t("Editar")}
                  </Button>
                )}
              </div>

              <dl className="grid grid-cols-3 gap-2">
                <div><dt className="text-xs text-muted-foreground">{t("Enviadas")}</dt><dd className="text-lg">{detalhe.campanha.sent_count}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Entregues")}</dt><dd className="text-lg">{detalhe.contadores.entregues}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Lidas")}</dt><dd className="text-lg">{detalhe.contadores.lidas}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Respostas")}</dt><dd className="text-lg">{detalhe.contadores.respondidos}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Falhas")}</dt><dd className="text-lg">{detalhe.campanha.failed_count}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Total")}</dt><dd className="text-lg">{detalhe.campanha.total_recipients}</dd></div>
              </dl>

              <div>
                <h4 className="mb-1 font-medium">{t("Passos")}</h4>
                {detalhe.passos.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("Sem passos.")}</p>
                ) : (
                  <ul className="space-y-1">
                    {detalhe.passos.map((p) => (
                      <li key={p.step_order} className="rounded-md border p-2 text-xs">
                        <strong>{t("Passo")} {p.step_order}</strong>
                        {p.media_kind ? ` · ${p.media_kind}` : ""}
                        {p.delay_after_seconds ? ` · ${t("espera")} ${p.delay_after_seconds}s` : ""}
                        {p.body ? <div className="text-muted-foreground">{p.body}</div> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="mb-1 font-medium">{t("Destinatários")} ({detalhe.destinatarios.length})</h4>
                {detalhe.destinatarios.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("Nenhum destinatário ainda.")}</p>
                ) : (
                  <ul className="max-h-64 space-y-1 overflow-y-auto">
                    {detalhe.destinatarios.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
                        <span>{d.nome}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <Badge variant="outline">{d.status}</Badge>
                          {d.attempts > 0 && <span>{t("tentativas")} {d.attempts}</span>}
                          {d.last_error && <span className="text-destructive">{d.last_error.slice(0, 40)}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}