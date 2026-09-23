---
impacto: nada_mudou
secao: corrigido
titulo: O tempo da etapa de envio para de engolir a chamada de IA do atendimento
---

O registro de tempo por etapa de cada atendimento mostrava a etapa de envio com a maior parte do
turno: num atendimento de 77,6 segundos, 53,9 segundos apareciam como "envio", enquanto a resposta
do modelo aparecia com apenas 6,8 segundos. O número não fechava — a espera antes de responder e a
checagem de guardrails levam poucos segundos, não a maior parte do atendimento.

A causa era de medição, não de comportamento: a marcação da etapa de envio passou a abrir antes da
chamada de IA e não era fechada quando essa chamada continuava depois, dentro do mesmo turno,
então todo o restante do trabalho do modelo caía na conta do envio. Agora a etapa de envio mede o
que o nome diz — a espera proposital antes da primeira mensagem, a checagem de guardrails e o envio
pelo canal — e o relógio volta para a etapa da resposta do modelo assim que cada tentativa de envio
termina, em todos os caminhos: com envio, com veto (nada sai), com erro e na repetição de uma
tentativa.

Nada muda para quem usa o sistema: a mensagem enviada, a ordem das bolhas, os guardrails e a espera
são exatamente os mesmos. O que muda é o diagnóstico — os tempos por etapa passam a somar certo e a
apontar a etapa realmente lenta.
