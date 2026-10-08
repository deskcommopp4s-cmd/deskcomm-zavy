/**
 * Schemas da campanha (A1). O `audience` é o FILTRO FECHADO — ver o cabeçalho
 * de `lib/campaign/audience.ts` (a mesa reprovou op/value livres).
 *
 * ⚠️ `.nullish()` NOS CAMPOS OPCIONAIS, não `.optional()`. A tela manda `null`
 * (não `undefined`) nos campos vazios, e `z.string().optional()` RECUSA `null`
 * — o formulário inteiro falhava com "Dados da campanha inválidos." por causa
 * de um `media_kind: null`. MEDIDO: o `safeParse` do payload real da tela
 * devolvia 3 issues, todas de `null`.
 */
import { z } from "zod";

export const publicoSchema = z
  .object({
    pipeline_ids: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string()).max(50).optional(),
    tags_exclude: z.array(z.string()).max(50).optional(),
    import_tags: z.array(z.string()).max(50).optional(),
    // Fase 2 — ver a materialização; recusado com erro mensageiro.
    custom_fields: z.unknown().optional(),
  })
  .strict();

const recorrenciaSchema = z.object({
  kind: z.enum(["semanal", "mensal", "dia_util", "intervalo"]),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  month_days: z.array(z.number().int().min(1).max(31)).optional(),
  last_month_day: z.boolean().optional(),
  business_day: z.enum(["primeiro", "ultimo"]).optional(),
  business_day_nth: z.number().int().min(1).max(5).optional(),
  interval_n: z.number().int().min(1).optional(),
  interval_unit: z.enum(["dia", "semana", "mes"]).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
});

export const passoDaCampanhaSchema = z
  .object({
    body: z.string().max(4000).nullish(),
    media_kind: z.enum(["image", "document", "voice"]).nullish(),
    media_storage_path: z.string().nullish(),
    media_mime: z.string().nullish(),
    delay_after_seconds: z.number().int().min(0).max(86_400).nullish(),
  })
  // Um passo sem texto E sem mídia não tem o que enviar — falha aqui, não no
  // worker (onde vira "passo sem texto e sem mídia" e o destinatário trava).
  .refine((p) => Boolean(p.body && p.body.trim()) || Boolean(p.media_storage_path), {
    message: "cada passo precisa de um texto ou de um arquivo",
    path: ["body"],
  });

export const criarCampanhaSchema = z
  .object({
    name: z.string().min(1).max(120),
    channel_session_ids: z.array(z.string().uuid()).min(1).max(10),
    new_lead_strategy: z.enum(["rotacionar", "fixa"]).default("rotacionar"),
    new_lead_session_id: z.string().uuid().nullish(),
    daily_limit: z.number().int().positive().nullish(),
    window_start_hour: z.number().int().min(0).max(23).nullish(),
    window_end_hour: z.number().int().min(0).max(23).nullish(),
    allowed_weekdays: z.array(z.number().int().min(0).max(6)).nullish(),
    // Fase 4 — a tela mandava estes e o schema os DESCARTAVA em silêncio (não
    // era `.strict()`): a variação por IA e a recorrência nunca salvavam.
    ai_variation: z.boolean().nullish(),
    schedule_kind: z.enum(["agora", "agendado", "recorrente"]).nullish(),
    scheduled_at: z.string().datetime().nullish(),
    recurrence: recorrenciaSchema.nullish(),
    audience: publicoSchema,
    steps: z.array(passoDaCampanhaSchema).min(1).max(10),
  })
  .refine((v) => v.new_lead_strategy !== "fixa" || v.new_lead_session_id, {
    message: "estratégia fixa exige escolher a conexão",
    path: ["new_lead_session_id"],
  })
  .refine((v) => v.schedule_kind !== "agendado" || v.scheduled_at, {
    message: "agendamento exige a data/hora",
    path: ["scheduled_at"],
  })
  .refine((v) => v.schedule_kind !== "recorrente" || v.recurrence, {
    message: "campanha recorrente exige a regra",
    path: ["recurrence"],
  });

export const ativarCampanhaSchema = z.object({
  audience: publicoSchema,
});

/** A primeira issue do Zod em texto legível — para a tela dizer QUAL campo. */
export function mensagemDaValidacao(err: z.ZodError): string {
  const primeira = err.issues[0];
  if (!primeira) return "Confira os dados da campanha.";
  const campo = primeira.path.join(".");
  return campo ? `${campo}: ${primeira.message}` : primeira.message;
}