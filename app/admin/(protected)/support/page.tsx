import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { podeAtenderSuporte } from "@/lib/support/escopo";
import { redirect } from "next/navigation";

import { FilaDeSuporte } from "./_components/FilaDeSuporte";

export const dynamic = "force-dynamic";

/**
 * A fila de chamados — do lado de quem responde (a plataforma).
 *
 * O gate de PERFIL fica aqui, além da rota: quem tem `scope` restrito não
 * navega para a tela. A proteção do DADO é outra — `fn_is_platform_admin()`
 * passou a exigir `full` (migration 0268), então um admin de suporte não lê
 * tenant nenhum pelo PostgREST. Sem os dois, contratar suporte = admin total.
 */
export default async function SuporteDaPlataformaPage() {
  const ctx = await requirePlatformAdmin();
  if (!podeAtenderSuporte(ctx)) redirect("/admin/forbidden");

  return <FilaDeSuporte />;
}
