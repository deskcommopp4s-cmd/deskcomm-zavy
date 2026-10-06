/**
 * Schemas do chat de suporte.
 *
 * Os limites são generosos de propósito: quem escreve aqui é o usuário do
 * cliente pedindo ajuda, e cortar o texto dele no meio é pior que guardar uma
 * mensagem longa. O teto existe só para não aceitar um upload de texto.
 */
import { z } from "zod";

/** O corpo de uma mensagem. Vazio não passa — a tabela tem o mesmo CHECK. */
export const corpoDaMensagemSchema = z
  .string({ error: "mensagem_obrigatoria" })
  .trim()
  .min(1, "mensagem_obrigatoria")
  .max(8000, "mensagem_longa_demais");

/** Abrir um chamado: o assunto é opcional (o corpo é que importa). */
export const abrirChamadoSchema = z.object({
  assunto: z.string().trim().max(120, "assunto_longo_demais").optional().nullable(),
  body: corpoDaMensagemSchema,
});
export type AbrirChamado = z.infer<typeof abrirChamadoSchema>;

/** Responder num chamado aberto. */
export const responderChamadoSchema = z.object({ body: corpoDaMensagemSchema });
export type ResponderChamado = z.infer<typeof responderChamadoSchema>;

/**
 * Fechar o chamado. O NPS é OPCIONAL e dispensável — NPS forçado irrita e
 * distorce a nota (quem está insatisfeito responde, quem está satisfeito ignora).
 */
export const fecharChamadoSchema = z.object({
  nps: z.number().int().min(0, "nps_invalido").max(10, "nps_invalido").optional().nullable(),
  nps_comment: z.string().trim().max(1000, "comentario_longo_demais").optional().nullable(),
});
export type FecharChamado = z.infer<typeof fecharChamadoSchema>;
