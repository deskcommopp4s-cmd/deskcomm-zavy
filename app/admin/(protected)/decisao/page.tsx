import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { IDS_DE_PROVEDOR_DE_DECISAO } from "@/lib/ai/pontos/provedores-de-decisao";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDaChaveDeDecisao } from "./_form";

export const metadata = { title: "Provedor de decisão (JEV) da instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o superadmin cadastra a chave do provedor de DECISÃO (Jev/TypeSafe)
 * da instalação.
 *
 * ── Por que a chave é da INSTALAÇÃO ─────────────────────────────────────────
 *
 * O julgamento do Jev move o funil de qualquer organização que tenha o ponto
 * ligado. A chave é UMA, da plataforma (migration 0267), e não uma por tenant —
 * deixar o admin de um cliente trocá-la mudaria o julgamento de todos. Irmã de
 * `/admin/meta` e `/admin/google`, que são o molde.
 *
 * ── Por que `notFound()` ────────────────────────────────────────────────────
 *
 * Mesma decisão de `/admin/meta`: o layout de `(protected)` já roda
 * `requirePlatformAdmin()`, e o gate local fica porque um layout pode ser movido.
 *
 * ⚠️ NENHUMA CHAVE VAI AO CLIENTE — nem cifrada. A leitura abaixo traz só o
 * `api_key_last4` (identificação) e a data; o valor em claro nunca sai do
 * servidor, e não há leitura que o devolva.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  // Server-side only (RLS ligada, zero policies, grants revogados): o admin
  // client é o único caminho.
  const { data, error } = await createAdminClient()
    .from("platform_decision_credentials")
    .select("provider, api_key_last4, updated_at")
    .eq("provider", "typesafe")
    .maybeSingle();

  const linha = data as
    | { provider: string; api_key_last4: string | null; updated_at: string | null }
    | null;

  // O `.env` é o último degrau da escada de chave (`chaveDePlataforma`). Dizer
  // que ele existe torna a precedência visível: quem tem a chave no arquivo abre
  // esta tela vazia e conclui que a qualificação não tem chave nenhuma.
  const temNoAmbiente = chaveDePlataforma("typesafe") !== null;

  return (
    <FormularioDaChaveDeDecisao
      providers={[...IDS_DE_PROVEDOR_DE_DECISAO]}
      temChaveSalva={Boolean(linha?.api_key_last4)}
      last4={linha?.api_key_last4 ?? null}
      atualizadoEm={formatar(linha?.updated_at ?? null, usuario.idioma)}
      temNoAmbiente={temNoAmbiente}
      // Leitura que falhou não pode virar "nunca configurado": essa frase levaria
      // o dono a cadastrar por cima do que já está gravado.
      leituraFalhou={Boolean(error)}
    />
  );
}

function formatar(iso: string | null, idioma: Idioma): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(tagDeIdioma(idioma), {
    // Fuso fixo pelo mesmo motivo de `/admin/meta`: a linha é da INSTALAÇÃO, não
    // há organização de onde tirar um.
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}
