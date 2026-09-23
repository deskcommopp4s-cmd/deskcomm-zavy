---
impacto: capacidade_nova
secao: adicionado
titulo: O lead é qualificado por um provedor de decisão e o funil anda na hora
---

O classificador de etapa lia a conversa e devolvia uma sugestão em texto, que o
modelo precisava confirmar antes de o negócio andar. Agora existe uma segunda
forma de qualificar: um **provedor de decisão** (a TypeSafe, com o modelo Jev)
recebe a conversa e devolve um julgamento pronto e tipado — em que etapa o funil
está, se a pessoa decide a compra, qual a urgência, se há necessidade e o quão
pronta para comprar ela está — e o negócio é **movido na hora** com base nele.

A decisão fica registrada como atividade na linha do tempo do negócio, com
lastro, e nos campos do lead. A etapa só muda para etapas que o funil da sua
organização mapeia: o sistema nunca inventa uma coluna.

O provedor de decisão é uma prateleira nova, separada da de conversa — uma IA
que devolve julgamento não é uma IA que escreve texto para o cliente, e misturar
as duas quebraria a escolha do modelo de conversa. Por isso a TypeSafe não
aparece na lista de provedores de chat: ela aparece no ponto de qualificação do
lead, e a chave dela é cadastrada na mesma tela de credenciais das outras.

A funcionalidade nasce **desligada**: só roda quando a organização habilita o
ponto (com a chave da TypeSafe cadastrada) e o superadmin não desliga o
interruptor global. Desligada, ou quando o provedor de decisão falha por
qualquer motivo, o classificador anterior continua funcionando exatamente como
hoje — o turno nunca quebra, e nenhuma conversa fica sem resposta por causa da
qualificação.
