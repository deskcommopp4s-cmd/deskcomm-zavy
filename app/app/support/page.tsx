import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";

import { ChatDeSuporte } from "./_components/ChatDeSuporte";

export const dynamic = "force-dynamic";

/**
 * Onde o usuário do cliente pede ajuda ao suporte do SISTEMA.
 *
 * Qualquer usuário da conta entra (o atendente é quem mais tropeça em dúvida de
 * uso) — não há gate de papel aqui. O que separa o que cada um vê é a RLS: a
 * policy de SELECT libera só as threads do próprio `opened_by`.
 */
export default async function SuportePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return <ChatDeSuporte />;
}
