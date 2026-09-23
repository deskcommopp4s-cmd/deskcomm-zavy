"use client";

import { useState, useTransition } from "react";

import {
  definirRegressaoDeFunil,
  type ErroRegressaoDeFunil,
} from "@/app/actions/settings/definirRegressaoDeFunil";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

/** As frases de recusa — as mesmas que a tela irmã de agenda já usa. */
const TEXTO_DO_ERRO: Record<ErroRegressaoDeFunil, string> = {
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  falha: "Não consegui salvar essa mudança agora.",
};

/**
 * REGRESSÃO DE FUNIL — o interruptor do admin da organização.
 *
 * Mora em Configurações › Etapas do funil, junto do mapeamento do agente: é a
 * única tela que decide como o agente move o card. Por default DESLIGADA — o
 * comportamento de sempre é só avançar. Ligada, o agente pode trazer o card UM
 * passo para trás quando o cliente retroceder, sempre por uma transição válida
 * do funil (não é pular para qualquer lugar).
 */
export function RegressaoDeFunil({
  ligadaInicial,
  podeLigar,
}: {
  ligadaInicial: boolean;
  /** Espelha o papel `admin` que a server action cobra. Cortesia, não autorização. */
  podeLigar: boolean;
}) {
  const t = useT();
  const [ligada, setLigada] = useState(ligadaInicial);
  const [erro, setErro] = useState<ErroRegressaoDeFunil | null>(null);
  const [salvando, iniciar] = useTransition();

  function aplicar(novo: boolean) {
    setErro(null);
    iniciar(async () => {
      const r = await definirRegressaoDeFunil(novo);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      setLigada(r.ativa);
    });
  }

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="regressao-de-funil">
      <h2 className="font-semibold">{t("Regressão de funil")}</h2>

      <div className="flex items-center gap-3">
        <Switch
          checked={ligada}
          onCheckedChange={aplicar}
          disabled={!podeLigar || salvando}
          data-testid="regressao-de-funil-interruptor"
        />
        <span className="text-sm font-medium">
          {t("Deixar o agente voltar uma etapa quando o cliente retroceder")}
        </span>
      </div>

      <p className="text-sm text-text-muted">
        {t("Por padrão, o agente só avança o card no funil. Com isto ligado, ele pode trazer o card UM passo para trás quando a conversa mostrar que o cliente retrocedeu — por exemplo, voltar de “em negociação” para “qualificado”. Nunca é um salto: a volta respeita as etapas do funil, uma a uma.")}
      </p>

      <p className="text-sm" data-testid="regressao-de-funil-estado">
        {ligada
          ? t("Ligado: o agente pode trazer o card um passo para trás quando o cliente retroceder.")
          : t("Desligado: o agente só avança o card, como sempre.")}
      </p>

      {!podeLigar && (
        <p className="text-sm text-text-muted">{t("Só um administrador pode mudar essa regra.")}</p>
      )}

      {erro && (
        <p role="alert" className="text-sm text-destructive" data-testid="regressao-de-funil-erro">
          {t(TEXTO_DO_ERRO[erro])}
        </p>
      )}
    </section>
  );
}
