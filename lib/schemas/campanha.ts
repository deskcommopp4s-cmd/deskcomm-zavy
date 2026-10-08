/**
 * Schemas da campanha (A1). O `audience` é o FILTRO FECHADO — ver o cabeçalho
 * de `lib/campaign/audience.ts` (a mesa reprovou op/value livres).
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

export const passoDaCampanhaSchema = z.object({
  body: z.string().min(1).max(4000).optional(),
  media_kind: z.enum(["image", "document", "voice"]).optional(),
  media_storage_path: z.string().optional(),
  delay_after_seconds: z.number().int().min(0).max(86_400).optional(),
});

export const criarCampanhaSchema = z
  .object({
    name: z.string().min(1).max(120),
    channel_session_ids: z.array(z.string().uuid()).min(1).max(10),
    new_lead_strategy: z.enum(["rotacionar", "fixa"]).default("rotacionar"),
    new_lead_session_id: z.string().uuid().optional(),
    daily_limit: z.number().int().positive().nullable().optional(),
    window_start_hour: z.number().int().min(0).max(23).optional(),
    window_end_hour: z.number().int().min(0).max(23).optional(),
    allowed_weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    audience: publicoSchema,
    steps: z.array(passoDaCampanhaSchema).min(1).max(10),
  })
  .refine((v) => v.new_lead_strategy !== "fixa" || v.new_lead_session_id, {
    message: "estratégia fixa exige new_lead_session_id",
    path: ["new_lead_session_id"],
  });

export const ativarCampanhaSchema = z.object({
  audience: publicoSchema,
});