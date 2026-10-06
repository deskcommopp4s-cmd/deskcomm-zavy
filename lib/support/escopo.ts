/**
 * Quem, na plataforma, pode ver e responder chamados de suporte.
 *
 * ─── Por que isto existe separado do `requirePlatformAdmin` ──────────────────
 *
 * O `requirePlatformAdmin` responde "é admin da plataforma?" — e a coluna
 * `scope` existe desde a 0220, mas **só uma rota no app inteiro a lia**
 * (`admin/tenants`). Ou seja: um admin com perfil restrito entrava no `/admin`
 * e alcançava tenants, LGPD e impersonate.
 *
 * Aqui o perfil passa a valer para o SUPORTE: só `full` e `suporte` entram.
 * O banco acompanha — `fn_is_platform_admin()` passou a exigir `full` (0268),
 * então um admin de suporte não satisfaz as 106 policies de dado de tenant.
 *
 * Os dois lados são necessários: a função do banco protege o DADO (o PostgREST
 * recusa a leitura), e esta protege a TELA e a ROTA (o admin de suporte não
 * navega para onde não deve).
 */
import type { PlatformAdminContext } from "@/lib/auth/requirePlatformAdmin";

/** Os perfis que atendem suporte. `support_readonly` NÃO é um deles — é o modo
 *  de impersonação da 0220, outro eixo. */
export const ESCOPOS_DE_SUPORTE = ["full", "suporte"] as const;

export function podeAtenderSuporte(ctx: PlatformAdminContext): boolean {
  return (ESCOPOS_DE_SUPORTE as readonly string[]).includes(ctx.platformAdmin.scope);
}
