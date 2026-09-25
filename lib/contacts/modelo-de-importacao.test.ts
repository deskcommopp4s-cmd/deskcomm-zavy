/**
 * O MODELO PASSA PELO PRÓPRIO IMPORTADOR — e um dia não passava.
 *
 * O cabeçalho de `modelo-de-importacao.ts` promete: "Alinhamento com o leitor é
 * TESTADO, não presumido... Um modelo que o próprio importador recusa seria
 * pior que nenhum: o usuário faria tudo certo e levaria erro."
 *
 * A promessa era falsa. O CPF do exemplo era `123.456.789-00` — dígitos
 * verificadores INVÁLIDOS (o correto seria `-09`) — e o telefone era
 * `+55 11 99888-7777`, com espaços e traço, fora do E.164 `^\+\d{8,15}$` que o
 * schema exige. Quem baixava o modelo, preenchia por cima e mandava o arquivo
 * de volta levava "Linha 2: CPF inválido: '12345678900'". O modelo ensinava o
 * formato que ele mesmo recusa — o pior desfecho possível, porque o usuário
 * fez exatamente o que a tela mandou.
 *
 * Este arquivo fecha a promessa: gera o modelo, passa o texto pelas MESMAS
 * funções que a rota usa (`parseCsv` → `mapHeader` → `mapLinha` → `isValidCpf`
 * → `contactCreateSchema.safeParse`) e exige ZERO erros. Se um exemplo novo
 * nascer inválido, o teste fica vermelho — e o comentário do cabeçalho volta a
 * ser verdade.
 *
 * Roda com: npx vitest run lib/contacts/modelo-de-importacao.test.ts
 */
import { describe, expect, it } from "vitest";

import { mapHeader, mapLinha, parseCsv } from "@/lib/contacts/csv";
import { gerarModeloDeImportacao } from "@/lib/contacts/modelo-de-importacao";
import { contactCreateSchema, isValidCpf } from "@/lib/schemas";

describe("o modelo de importação passa pelo próprio importador", () => {
  it("nenhuma linha de exemplo é recusada pelo caminho que a rota usa", () => {
    const texto = gerarModeloDeImportacao();
    const linhas = parseCsv(texto);
    expect(linhas.length).toBeGreaterThan(1); // cabeçalho + exemplos

    const [cabecalho, ...dataRows] = linhas;
    const { indices, motivo } = mapHeader(cabecalho!);
    expect(motivo, "o cabeçalho do modelo não é reconhecido pelo leitor").toBeNull();

    const erros: string[] = [];
    for (let i = 0; i < dataRows.length; i++) {
      const linha = i + 2; // 1-based contando o cabeçalho — igual à rota.
      const { contato, motivo: motivoLinha } = mapLinha(dataRows[i]!, indices);
      if (motivoLinha !== null) {
        erros.push(`linha ${linha}: ${motivoLinha}`);
        continue;
      }
      if (contato.cpf && !isValidCpf(contato.cpf)) {
        erros.push(`linha ${linha}: CPF inválido: "${contato.cpf}"`);
        continue;
      }
      const parsed = contactCreateSchema.safeParse({ ...contato, source: "import_csv" });
      if (!parsed.success) {
        erros.push(`linha ${linha}: ${parsed.error.issues[0]?.message ?? "dados inválidos"}`);
      }
    }

    expect(
      erros,
      "o modelo que a tela entrega não pode ser recusado pelo importador que a tela usa — " +
        "senão o usuário faz tudo certo e leva erro",
    ).toEqual([]);
  });

  it("o CPF do exemplo é VÁLIDO de verdade (dígitos verificadores)", () => {
    // O defeito original: `123.456.789-00` é inválido (o correto seria -09).
    // Este teste existe para o exemplo não voltar a ser um número de mentira.
    const texto = gerarModeloDeImportacao();
    const linhas = parseCsv(texto);
    const { indices } = mapHeader(linhas[0]!);
    const { contato } = mapLinha(linhas[1]!, indices);
    expect(contato.cpf).toBeTruthy();
    expect(isValidCpf(contato.cpf!)).toBe(true);
  });

  it("o telefone do exemplo é E.164 puro (sem espaços nem traço)", () => {
    // O segundo defeito: `+55 11 99888-7777` tem espaços e traço, e o schema
    // exige `^\+\d{8,15}$`. O modelo mostrava um formato que ele recusa.
    const texto = gerarModeloDeImportacao();
    const linhas = parseCsv(texto);
    const { indices } = mapHeader(linhas[0]!);
    const { contato } = mapLinha(linhas[1]!, indices);
    expect(contato.phone_number).toMatch(/^\+\d{8,15}$/);
  });
});