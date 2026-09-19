---
impacto: nada_mudou
secao: adicionado
titulo: O sistema passa a registrar o tamanho de cada parte do comando enviado à IA
---

Cada atendimento agora registra, no log, quanto ocupa cada parte do comando que o atendente envia à
inteligência artificial: as instruções do agente (e cada bloco delas — roteiro, memória da empresa,
índice de habilidades), a definição das ferramentas, o histórico da conversa (quantas mensagens, e
quanto é texto contra resultado de ferramenta) e o total. Também registra, por passo, quantos
tokens de entrada aquela resposta consumiu.

Antes, quando uma conta mostrava um consumo de entrada muito acima do esperado, não havia como
saber de onde ele vinha: a soma das partes conhecidas não fechava com o número cobrado. O motivo
mais comum é que uma resposta com ferramentas faz o modelo reler todo o comando a cada passo, e o
número guardado é a soma desses passos — não o tamanho de um envio só. Com a medição por passo, o
dono da conta vê exatamente isso.

Nenhum texto de conversa nem dado de contato entra no registro — apenas contagens e tamanhos.
Ligada por padrão e desligável por `LLM_PROMPT_COMPOSITION=false`.
