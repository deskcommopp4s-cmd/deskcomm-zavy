import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";

import { Campanhas } from "./_components/Campanhas";

export const dynamic = "force-dynamic";

/**
 * Disparos em massa (A1). Qualquer usuário `agent` da conta entra — quem atende
 * é quem dispara. As rotas da API exigem `requireRole("agent")` (a permissão
 * refinada — quem pode disparar — é Fase 4 do desenho).
 */
export default async function CampanhasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return <Campanhas />;
}