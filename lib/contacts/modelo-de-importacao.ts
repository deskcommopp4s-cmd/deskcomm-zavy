import { HEADER_ALIASES } from "@/lib/contacts/csv";

/**
 * A PLANILHA MODELO — o formato certo, em vez do formato descrito.
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * A tela dizia, em prosa: "colunas reconhecidas: nome, telefone, email, cpf,
 * nascimento, tags". Quem nunca importou nada lê isso e adivinha o resto: qual
 * separador, se a data é 12/03/1985 ou 1985-03-12, se o acento do cabeçalho
 * importa, se campo vazio pode, se telefone com máscara serve. Cada dúvida é
 * uma tentativa e erro sobre um arquivo de 300 linhas, e o erro só aparece
 * depois de subir a planilha inteira.
 *
 * Descrever o formato e entregar o formato não são a mesma coisa. Esta função
 * entrega o ARQUIVO: o usuário baixa, preenche por cima dos exemplos, devolve.
 *
 * ─── Três decisões que fazem a diferença entre funcionar e parecer funcionar ─
 *
 * 1. **Separador `;`, não vírgula.** O `parseCsv` detecta o delimitador pela
 *    PRIMEIRA linha, e `DELIMITERS` testa `,` antes de `;`. Com zeros empates,
 *    a vírgula ganharia — então o cabeçalho é gerado sem NENHUMA vírgula, e o
 *    ponto e vírgula vence por contagem. É também o que o Excel em português
 *    usa por padrão, então o arquivo abre com as colunas já separadas.
 *
 * 2. **Tags com `|`, nunca com `;`.** O leitor de tags separa por `/[;|]/`, e
 *    o delimitador É ponto e vírgula: escrever `cliente;vip` na célula de tags
 *    criaria uma coluna nova e desalinharia a linha inteira — o usuário veria
 *    "deu erro na linha 2" sem entender por quê. `|` é aceito pelo leitor e não
 *    colide com nada.
 *
 * 3. **Alinhamento com o leitor é TESTADO, não presumido.** Os testes deste
 *    arquivo passam o texto gerado por `parseCsv` → `mapHeader` → `mapLinha` —
 *    as mesmas funções que a rota usa. Um modelo que o próprio importador
 *    recusa seria pior que nenhum: o usuário faria tudo certo e levaria erro.
 *
 * ─── Por que os exemplos dizem EXEMPLO ─────────────────────────────────────
 *
 * Quem baixa uma planilha modelo com duas linhas preenchidas pode esquecer de
 * apagá-las e importar "Maria Silva" como contato real. O prefixo não impede o
 * esquecimento — torna o esquecimento VISÍVEL na lista de contatos, que é onde
 * ele precisa ser notado. Nome que parece nome de verdade é o que esconde o
 * erro até alguém mandar mensagem para a Maria.
 */

/** O separador do arquivo. Ver decisão 1 no cabeçalho. */
const SEPARADOR = ";";

/** O separador DENTRO da célula de tags. Ver decisão 2 no cabeçalho. */
const SEPARADOR_DE_TAGS = "|";

/**
 * As colunas do modelo, na ordem em que aparecem — a PRIMEIRA forma de cada
 * lista em `HEADER_ALIASES`, que é a que o produto sugere. Lidas de lá, e não
 * escritas de novo: duas listas de nomes de coluna envelhecem em direções
 * diferentes, e a que ninguém lembra de atualizar é a do modelo.
 */
const COLUNAS = [
  "name",
  "phone_number",
  "email",
  "cpf",
  "birthdate",
  "tags",
] as const;

/**
 * As linhas de exemplo. A segunda tem `cpf` VAZIO de propósito: metade da
 * dúvida de quem preenche é "posso deixar campo em branco?" — mostrar uma
 * linha com um campo em branco responde isso melhor que qualquer frase.
 */
const EXEMPLOS: readonly (readonly string[])[] = [
  ["EXEMPLO Maria Silva", "+55 11 99888-7777", "maria.silva@exemplo.com", "123.456.789-00", "1985-03-12", `cliente${SEPARADOR_DE_TAGS}vip`],
  ["EXEMPLO Joao Souza", "+55 11 91234-5678", "joao.souza@exemplo.com", "", "1990-07-25", "lead"],
];

/** A primeira forma sugerida de cada coluna — o nome que o Excel vai mostrar. */
function nomeDaColuna(campo: string): string {
  return HEADER_ALIASES[campo]?.[0] ?? campo;
}

/**
 * Gera o CSV do modelo, pronto para preencher.
 *
 * Sem BOM e sem CRLF de propósito: o `parseCsv` descarta o BOM e trata `\r\n`,
 * e o `Blob` da tela declara o tipo com charset. O que sai daqui é o arquivo
 * MAIS SIMPLES que o importador aceita — cada caractere a mais é um lugar onde
 * Excel, Google Sheets e LibreOffice podem divergir.
 */
export function gerarModeloDeImportacao(): string {
  const cabecalho = COLUNAS.map(nomeDaColuna).join(SEPARADOR);
  const linhas = EXEMPLOS.map((exemplo) => exemplo.join(SEPARADOR));
  return [cabecalho, ...linhas].join("\n");
}

/** O nome do arquivo baixado. */
export const NOME_DO_MODELO = "modelo-contatos.csv";
