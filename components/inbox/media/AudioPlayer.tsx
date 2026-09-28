"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Pause, Play } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

const RATES = [1, 1.5, 2] as const;

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Props {
  messageId: string;
  isOutbound: boolean;
  /**
   * O derivado textual do áudio (transcrição), gravado pelo
   * `media-derive-worker` DEPOIS que a mensagem existe. Chega em segundo
   * momento pelo realtime — por isso é prop, e não algo buscado aqui.
   */
  derivedText?: string | null;
  /** `ready` | `failed` | nulo (ainda não derivou). */
  derivedStatus?: string | null;
}

/**
 * Player de voz estilo WhatsApp: play/pause, progresso seekável, tempo, 1x/1.5x/2x.
 *
 * ─── A TRANSCRIÇÃO, E POR QUE ELA FICA ATRÁS DE UM BOTÃO ────────────────────
 *
 * Nem todo mundo que atende tem áudio: fone quebrado, ambiente barulhento, surdez,
 * ou simplesmente a preferência de ler. Sem o texto, a única saída era pedir ao
 * cliente para escrever de novo — o que passa a bola para quem não tem culpa.
 *
 * O botão (em vez do texto sempre aberto) é escolha de quem OUVE: numa conversa
 * com muitos áudios, parágrafos abertos embaixo de cada player afogam a leitura.
 * Quem precisa lê, abre; quem não precisa, não vê. O botão fica VISÍVEL e diz o
 * que faz — esconder atrás de um ícone repetiria o defeito do "Testar" de
 * provedores, que ninguém achava.
 *
 * ⚠️ O texto aparece MESMO SE O ÁUDIO FALHAR. É o caso mais importante desta
 * funcionalidade: quem não tem áudio é justamente quem mais depende do texto, e
 * o `MediaUnavailable` sozinho deixaria essa pessoa sem a mensagem.
 */
export function AudioPlayer({ messageId, isOutbound, derivedText, derivedStatus }: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const [verTranscricao, setVerTranscricao] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    const onError = () => setFailed(true);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, []);

  // ponytail: OGG streams report Infinity at loadedmetadata; self-heal when refined
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      void el.play();
      setPlaying(true);
    }
  };

  const cycleRate = () => {
    const next = (rateIdx + 1) % RATES.length;
    setRateIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next]!;
  };

  const seek = (value: number) => {
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrent(value);
  };

  const temTranscricao = Boolean(derivedText && derivedText.trim() !== "");
  // `failed` sozinho NÃO esconde: com transcrição na mão, o texto é o que salva
  // a mensagem para quem não tem áudio.
  if (failed && !temTranscricao) return <MediaUnavailable kind="Áudio" className="h-12 w-60" />;

  return (
    <div className="flex w-60 flex-col gap-1 py-1">
      <div className="flex items-center gap-2">
        <audio ref={audioRef} src={mediaSrc(messageId)} preload="metadata" />
        <button
          type="button"
          aria-label={playing ? t("Pausar áudio") : t("Reproduzir áudio")}
          onClick={toggle}
          disabled={failed}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
            failed && "cursor-not-allowed opacity-40",
            isOutbound
              ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
              : "bg-primary/10 text-primary hover:bg-primary/20",
          )}
        >
          {playing ? (
            <Pause size={16} weight="fill" aria-hidden />
          ) : (
            <Play size={16} weight="fill" aria-hidden />
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            type="range"
            aria-label={t("Progresso do áudio")}
            aria-valuetext={`${fmt(current)} ${t("de")} ${fmt(safeDuration)}`}
            min="0"
            max={String(safeDuration || 1)}
            step="0.1"
            value={current}
            disabled={failed}
            onChange={(e) => seek(Number(e.target.value))}
            className="h-1 w-full cursor-pointer accent-current disabled:cursor-not-allowed"
          />
          <span className="text-[10px] tabular-nums opacity-70">
            {fmt(current)} / {fmt(safeDuration)}
          </span>
        </div>
        <button
          type="button"
          aria-label={`${t("Velocidade de reprodução")}: ${RATES[rateIdx]}x`}
          onClick={cycleRate}
          disabled={failed}
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums transition-colors",
            failed && "cursor-not-allowed opacity-40",
            isOutbound
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          {RATES[rateIdx]}x
        </button>
      </div>

      {temTranscricao && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setVerTranscricao((v) => !v)}
            aria-expanded={verTranscricao}
            data-testid={`transcricao-toggle-${messageId}`}
            className={cn(
              // `rounded-md`, e não `rounded`: no Tailwind 4 o `rounded` puro é
              // 0.25rem e não o `--radius-md` do produto — o botão mudaria de
              // canto sozinho na migração.
              //
              // E o realce do hover é o SUBLINHADO, não o alpha do texto. O alpha
              // (`/80`) não pintava no v3 e passa a pintar no v4: em `--color-primary`
              // sobre `--color-surface-elevated` ele cai a 3.49:1, abaixo do 4.5:1
              // que a régua exige. Sem o alpha é o que a produção JÁ mostrava.
              "w-fit rounded-md text-[11px] font-medium underline underline-offset-2 transition-colors hover:no-underline",
              isOutbound ? "text-primary-foreground" : "text-primary",
            )}
          >
            {verTranscricao ? t("Ocultar transcrição") : t("Ver transcrição")}
          </button>
          {verTranscricao && (
            <p
              data-testid={`transcricao-${messageId}`}
              className={cn(
                "max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs",
                isOutbound
                  ? "bg-primary-foreground/15 text-primary-foreground"
                  : "bg-background/60 text-foreground",
              )}
            >
              {derivedText}
            </p>
          )}
        </div>
      )}

      {/* Só o desfecho NEGATIVO é anunciado: `null` é "ainda não derivou", e
          afirmar "transcrevendo…" prometeria um texto que áudios antigos podem
          nunca receber (o worker só roda nos que passam por ele). */}
      {!temTranscricao && derivedStatus === "failed" && (
        <p
          data-testid={`transcricao-falhou-${messageId}`}
          className={cn(
            "text-[11px]",
            // Sem o alpha: em `--color-primary` o `/70` pinta 3.78:1 no v4, abaixo
            // do 4.5:1. Sem ele, 5.80:1 — e é o que a produção já mostra.
            isOutbound ? "text-primary-foreground" : "text-muted-foreground",
          )}
        >
          {t("Não conseguimos transcrever este áudio.")}
        </p>
      )}
    </div>
  );
}
