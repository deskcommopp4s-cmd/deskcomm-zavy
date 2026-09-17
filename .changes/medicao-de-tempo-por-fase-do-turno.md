---
impacto: nada_mudou
secao: adicionado
titulo: O tempo de cada etapa do atendimento passa a ser medido e registrado
---

Cada atendimento agora registra, no log do sistema, quanto tempo levou em cada etapa: o preparo
(leitura do material do agente, do histórico do contato e das ferramentas), a classificação de
etapa, a checagem de manipulação, a montagem do contexto, a resposta do modelo, a espera antes da
primeira mensagem, o envio pelo canal e o fechamento do atendimento — mais o total.

Antes disso não havia nenhuma medição: sabia-se quanto cada chamada de IA levava, mas não onde
estavam os demais segundos de um atendimento que podia chegar a 45 segundos. Sem medir, qualquer
otimização de velocidade é tentativa às cegas.

O que a medição permite responder, para quem opera: qual etapa é a mais lenta numa conversa que
demorou, e quanto do tempo é espera proposital (a pausa que faz a resposta não parecer robótica)
contra tempo de rede do canal. Nenhum conteúdo de conversa nem dado de contato entra no registro —
apenas números de tempo.

Ligada por padrão e desligável por `AGENT_TURN_TIMING=false`.
