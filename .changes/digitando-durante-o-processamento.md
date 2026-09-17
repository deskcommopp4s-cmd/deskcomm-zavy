---
impacto: nada_mudou
secao: corrigido
titulo: O cliente vê "digitando…" enquanto o agente pensa, em vez de esperar em silêncio
---

Antes, quando uma pessoa mandava uma mensagem, ela ficava sem nenhum sinal durante todo o
processamento da IA (~44s) e só via a resposta no fim — sem "digitando…", o tempo de espera
parecia abandono, e o cliente mandava "alô?" ou desistia.

Agora o "digitando…" acende assim que o agente decide responder e se mantém aceso, com
reacendimento periódico, até a resposta sair. Não é aceso em conversas que o agente vai ignorar
(número fora da allowlist, fora da janela de atendimento, modo assistido, bot pausado, handoff):
nesses casos o indicador apareceria e a resposta nunca chegaria, o que é pior que o silêncio. O
indicador é apagado antes da primeira bolha e em qualquer desfecho do turno, inclusive em erro.

O tempo entre a resposta e a chegada dela também deixou de ser sempre o mesmo número: ganhou uma
variação de 25% para cima ou para baixo, para dois turnos de tamanho parecido não responderem no
mesmo milissegundo.
