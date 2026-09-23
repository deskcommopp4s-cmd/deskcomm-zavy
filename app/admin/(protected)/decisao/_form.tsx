"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  updateDecisionCredential,
  type UpdateDecisionCredentialResult,
} from "@/app/actions/settings/updateDecisionCredential";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores-de-decisao";

interface Props {
  /** Os ids oferecidos — derivados da prateleira, nunca redigitados. */
  readonly providers: readonly string[];
  /** SE existe chave gravada. */
  readonly temChaveSalva: boolean;
  /** Os 4 últimos caracteres, só para identificar qual está no ar. */
  readonly last4: string | null;
  readonly atualizadoEm: string | null;
  /** A chave está no `.env` desta instalação (o último degrau da escada). */
  readonly temNoAmbiente: boolean;
  readonly leituraFalhou: boolean;
}

/** O piso do schema da action. Abaixo disso o Zod recusa e a tela culparia o dono. */
const TAMANHO_MINIMO_DA_CHAVE = 8;

export function FormularioDaChaveDeDecisao({
  providers,
  temChaveSalva,
  last4,
  atualizadoEm,
  temNoAmbiente,
  leituraFalhou,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [provider, setProvider] = useState(providers[0] ?? "typesafe");
  const [chave, setChave] = useState("");
  const [ocupado, iniciar] = useTransition();

  const podeSalvar = chave.trim().length >= TAMANHO_MINIMO_DA_CHAVE;

  function motivoDaRecusa(r: Extract<UpdateDecisionCredentialResult, { ok: false }>): string {
    if (r.error === "invalid_input") {
      return t("A chave parece incompleta. Cole a chave inteira, do começo ao fim.");
    }
    // Cifra indisponível ou erro do banco: o texto da action diz qual, e quem
    // administra o servidor precisa dele para agir. Nada foi gravado.
    return `${t("Não deu para salvar, e nada foi gravado.")} ${r.error}`;
  }

  function salvar() {
    iniciar(async () => {
      const r = await updateDecisionCredential({ provider, api_key: chave.trim() });
      if (!r.ok) {
        toast.error(motivoDaRecusa(r));
        return;
      }
      setChave("");
      toast.success(t("Chave salva."));
      router.refresh();
    });
  }

  const opcao = PROVEDORES_DE_DECISAO.find((p) => p.id === provider);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Provedor de decisão (JEV)")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("É a inteligência que lê a conversa e move o funil do cliente. A chave é uma só para a instalação inteira — todas as empresas usam a mesma.")}
        </p>
      </header>

      {leituraFalhou ? (
        <p
          role="alert"
          className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted"
        >
          {t("Não deu para ler a configuração salva agora, então o que aparece abaixo pode não ser o que está valendo. Recarregue a página antes de trocar qualquer coisa.")}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decisao-provider">{t("Provedor")}</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="decisao-provider" data-testid="decisao-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((id) => (
                <SelectItem key={id} value={id}>
                  {PROVEDORES_DE_DECISAO.find((p) => p.id === id)?.rotulo ?? id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decisao-chave">{t("Chave da API")}</Label>
          <Input
            id="decisao-chave"
            data-testid="decisao-chave"
            type="password"
            autoComplete="off"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={temChaveSalva ? t("••••••••  (já cadastrada)") : t("apikey_…")}
          />
          <p className="text-xs text-muted-foreground">
            {temChaveSalva
              ? t("Já existe uma chave cadastrada. Deixe em branco para mantê-la, ou digite uma nova para substituir.")
              : t("A chave é guardada cifrada e nunca volta a aparecer nesta tela.")}
            {opcao ? ` ${t("Onde pegar a chave:")} ${opcao.ondePegarAChave}` : ""}
          </p>
        </div>

        {temNoAmbiente ? (
          <p
            data-testid="decisao-tem-no-ambiente"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {t("Esta instalação também tem uma chave no arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar dela.")}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {atualizadoEm
              ? `${t("Última alteração em")} ${atualizadoEm}.${last4 ? ` ••••${last4}` : ""}`
              : t("Nunca configurado por aqui.")}
          </span>
          <Button data-testid="decisao-salvar" disabled={!podeSalvar || ocupado} onClick={salvar}>
            {ocupado ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
