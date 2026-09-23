"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  definirQualificacaoDaOrganizacao,
  type DefinirQualificacaoDaOrganizacaoResult,
} from "@/app/actions/settings/definirQualificacaoDaOrganizacao";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

const TEXTO_DO_ERRO: Record<string, string> = {
  invalid_input: "Não consegui salvar essa mudança agora.",
  tenant_nao_encontrado: "Não encontrei esta empresa.",
};

/**
 * O NÍVEL 2 DA QUALIFICAÇÃO DO LEAD — o superadmin libera a feature por
 * organização (migration 0267).
 *
 * Mora na ficha do tenant, junto das outras propriedades dele. Ligar aqui só
 * TORNA DISPONÍVEL: para o Jev de fato qualificar, o interruptor global da
 * instalação precisa estar ligado E a própria empresa precisa ter ligado o ponto
 * na conta dela. Efetivo = os três.
 */
export function QualificacaoDaOrganizacao({
  organizationId,
  ativa,
}: {
  organizationId: string;
  ativa: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [ligado, setLigado] = useState(ativa);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, iniciar] = useTransition();

  function aplicar(novo: boolean) {
    setErro(null);
    iniciar(async () => {
      const r: DefinirQualificacaoDaOrganizacaoResult = await definirQualificacaoDaOrganizacao({
        organization_id: organizationId,
        ativa: novo,
      });
      if (!r.ok) {
        setErro(TEXTO_DO_ERRO[r.error] ?? t("Não consegui salvar essa mudança agora."));
        return;
      }
      setLigado(r.ativa);
      // O servidor é a autoridade do que ficou gravado: invalida a ficha para o
      // próximo render vir do banco, não do estado otimista.
      await queryClient.invalidateQueries({ queryKey: ["admin", "tenant", organizationId] });
    });
  }

  return (
    <section className="rounded-lg border bg-card p-5 space-y-3" data-testid="qualificacao-do-tenant">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        {t("Qualificação do lead (JEV)")}
      </h2>

      <div className="flex items-center gap-3">
        <Switch
          checked={ligado}
          onCheckedChange={aplicar}
          disabled={salvando}
          data-testid="qualificacao-do-tenant-interruptor"
        />
        <span className="text-sm font-medium">
          {t("Liberar a qualificação do lead com o JEV para esta empresa")}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("Com isto ligado, a IA desta empresa pode usar o provedor de decisão para mover o funil. Depende também do interruptor geral da instalação e de a própria empresa ter ligado o ponto na conta dela.")}
      </p>

      <p className="text-sm" data-testid="qualificacao-do-tenant-estado">
        {ligado
          ? t("Liberado: a empresa pode ligar a qualificação na conta dela.")
          : t("Não liberado: nenhuma IA desta empresa qualifica por decisão.")}
      </p>

      {erro && (
        <p role="alert" className="text-sm text-destructive" data-testid="qualificacao-do-tenant-erro">
          {erro}
        </p>
      )}
    </section>
  );
}
