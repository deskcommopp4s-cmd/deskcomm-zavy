---
impacto: capacidade_nova
secao: adicionado
titulo: O agente começa a responder na hora e absorve as mensagens que chegam durante o atendimento
---

Até agora, quando uma pessoa mandava uma mensagem, o agente ficava 8 segundos parado antes de começar a
pensar — uma espera fixa só para juntar as mensagens picadas do mesmo contato. O tempo que o cliente
sentia era essa espera mais o atendimento inteiro. E havia o defeito simétrico: uma mensagem que chegava
logo depois da janela virava um segundo atendimento, e o cliente recebia duas respostas separadas.

Com `INBOUND_DEBOUNCE_MS=0` o agente começa a pensar no mesmo instante e passa a usar o próprio tempo de
processamento como janela: a mensagem que chega enquanto ele prepara a resposta entra no mesmo
atendimento, e o cliente recebe UMA resposta cobrindo tudo. Se por acaso um segundo atendimento chegar a
ser criado, ele encontra a resposta que o primeiro já deu e encerra sem responder de novo.

Nada muda no que o cliente lê: a resposta é escrita pelo mesmo agente, com os mesmos guardrails de envio.
"PARAR" continua sendo reconhecido como palavra inteira (as mensagens nunca são emendadas) e pedidos de
atendimento humano ou de descadastro que cheguem no meio do processamento continuam sendo atendidos antes
de qualquer resposta.

O comportamento antigo continua sendo o padrão: sem configurar nada, o sistema segue esperando os 8
segundos de sempre. Para ligar o modo novo, defina `INBOUND_DEBOUNCE_MS=0` no ambiente do worker. Não há
nada a fazer na VPS além da atualização de sempre.
