/**
 * O MODELO DE PLANILHA TEM DE SER ACEITO PELO PRÓPRIO IMPORTADOR.
 *
 * A tela de Contatos dizia, em prosa, quais colunas ela reconhece. Quem nunca
 * importou nada lê isso e adivinha o resto — separador, formato de data, se
 * campo vazio pode, se telefone com máscara serve — e descobre o que errou
 * depois de subir a planilha inteira.
 *
 * `gerarModeloDeImportacao` entrega o ARQUIVO. E um arquivo modelo que o
 * importador RECUSA seria pior que nenhum: o usuário faria tudo certo e
 * levaria erro, sem ter como saber que o erro era nosso.
 *
 * Por isso os testes abaixo não conferem o texto do modelo caractere a
 * caractere — eles passam o texto gerado pelo MESMO caminho da rota:
 *
 *     parseCsv → mapHeader → mapLinha
 *
 * Se um dia `HEADER_ALIASES` mudar de forma que o modelo deixe de casar, é
 * aqui que quebra — não na tela do cliente.
 */
import { describe, expect, it } from "vitest";

import { HEADER_ALIASES, mapHeader, mapLinha, parseCsv } from "@/lib/contacts/csv";
import { gerarModeloDeImportacao, NOME_DO_MODELO } from "@/lib/contacts/modelo-de-importacao";

/** Reproduz o caminho da rota: texto → linhas → índice de colunas → contato. */
function importarComoA(conteudo: string) {
  const rows = parseCsv(conteudo);
  const cabecalho = rows[0]!;
  const dados = rows.slice(1);
  const mapeado = mapHeader(cabecalho);
  const convertidas = dados.map((linha) => mapLinha(linha, mapeado.indices));
  return { cabecalho, dados, mapeado, convertidas };
}

describe("o modelo passa pelo importador de verdade", () => {
  it("o cabeçalho é reconhecido — nenhuma coluna fica de fora", () => {
    const { mapeado } = importarComoA(gerarModeloDeImportacao());
    expect(mapeado.motivo, `cabeçalho recusado: ${mapeado.motivo}`).toBeNull();
    // Um modelo com coluna que o leitor não conhece ensinaria o usuário a
    // preencher algo que seria ignorado em silêncio.
    // ⚠️ `cpf` NÃO está aqui de propósito: o armazenamento exige a cifra
    // `encrypt_cpf` (nunca provisionada) e a constraint `contacts_cpf_consistency`
    // recusaria o insert. Quando a cifra existir, a coluna volta — e este teste
    // volta junto.
    expect(Object.keys(mapeado.indices).sort()).toEqual([
      "birthdate",
      "email",
      "name",
      "phone_number",
      "tags",
    ]);
  });

  it("TODAS as linhas de exemplo são aceitas — nenhuma tem motivo de recusa", () => {
    const { convertidas } = importarComoA(gerarModeloDeImportacao());
    expect(convertidas.length).toBeGreaterThan(0);
    for (const [i, r] of convertidas.entries()) {
      expect(r.motivo, `exemplo ${i + 1} foi recusado: ${r.motivo}`).toBeNull();
    }
  });

  it("o exemplo preenche os campos como o produto espera", () => {
    const { convertidas } = importarComoA(gerarModeloDeImportacao());
    const primeiro = convertidas[0]!.contato;
    expect(primeiro.name).toContain("Maria Silva");
    // Telefone com máscara é o formato REAL que vem de planilha — o modelo
    // precisa mostrar que ele é aceito, e provar aqui que é.
    expect(primeiro.phone_number).toBeTruthy();
    expect(primeiro.email).toBe("maria.silva@exemplo.com");
    expect(primeiro.birthdate).toBe("1985-03-12");
  });

  it("tags com `|` viram DUAS tags — e não desalinham a linha", () => {
    // Esta é a armadilha central: o separador do arquivo é `;` e o leitor de
    // tags também aceita `;`. Se o modelo trouxesse `cliente;vip`, o `;` seria
    // lido como FIM DE COLUNA — a linha inteira desalinharia e o usuário
    // receberia "erro na linha N" sem entender por quê.
    const { convertidas } = importarComoA(gerarModeloDeImportacao());
    expect(convertidas[0]!.contato.tags).toEqual(["cliente", "vip"]);
    // E o resto da linha continuou no lugar: se o `;` tivesse sido tratado como
    // separador, `vip` cairia numa coluna inexistente e as tags viriam com um
    // elemento só.
    expect(convertidas[0]!.contato.tags).toHaveLength(2);
  });

  it("o cabeçalho não tem vírgula — senão a vírgula venceria a detecção", () => {
    // `DELIMITERS` testa `,` antes de `;` e o desempate fica com o primeiro.
    // Com UMA vírgula no cabeçalho e cinco `;`, o ponto e vírgula ainda ganha;
    // sem NENHUMA, o resultado não depende de contagem — é estrutural.
    const { cabecalho } = importarComoA(gerarModeloDeImportacao());
    expect(cabecalho.join("")).not.toContain(",");
  });

  it("as linhas de exemplo se anunciam como exemplo", () => {
    // Quem baixa o modelo pode esquecer de apagar os exemplos e importar
    // "Maria Silva" como contato real. O prefixo não impede o esquecimento:
    // torna o esquecimento VISÍVEL na lista de contatos, que é onde ele
    // precisa ser notado.
    const { dados } = importarComoA(gerarModeloDeImportacao());
    for (const linha of dados) {
      expect(linha[0]).toMatch(/EXEMPLO/);
    }
  });

  it("campo opcional VAZIO é aceito — o exemplo prova isso em vez de afirmar", () => {
    // Metade da dúvida de quem preenche é "posso deixar em branco?". O segundo
    // exemplo tem `birthdate` vazio justamente para responder isso sem uma frase.
    const { convertidas } = importarComoA(gerarModeloDeImportacao());
    const segundo = convertidas[1]!.contato;
    expect(segundo.birthdate).toBeUndefined();
    expect(segundo.name).toBeTruthy();
  });
});

describe("o modelo acompanha o catálogo de colunas", () => {
  it("a ordem do cabeçalho é a primeira forma sugerida de cada coluna", () => {
    const { cabecalho } = importarComoA(gerarModeloDeImportacao());
    // Lido de `HEADER_ALIASES`, não escrito de novo: duas listas de nomes de
    // coluna envelhecem em direções diferentes, e a que ninguém atualiza é a
    // do modelo — que é a que o usuário vai copiar.
    expect(cabecalho).toEqual([
      HEADER_ALIASES["name"]![0],
      HEADER_ALIASES["phone_number"]![0],
      HEADER_ALIASES["email"]![0],
      HEADER_ALIASES["birthdate"]![0],
      HEADER_ALIASES["tags"]![0],
    ]);
  });

  it("o nome do arquivo diz a que ele serve", () => {
    expect(NOME_DO_MODELO).toMatch(/\.csv$/);
    expect(NOME_DO_MODELO).toMatch(/contatos/);
  });
});
