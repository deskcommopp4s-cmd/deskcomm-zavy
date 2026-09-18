---
impacto: nada_mudou
secao: alterado
titulo: A resposta do agente deixa de somar a pausa humana aos guardrails
---

Antes de responder, o agente espera de propósito um tempo proporcional ao texto — a pausa que
existe para a resposta não sair colada no "✓✓" do lead. Só DEPOIS dessa pausa é que ele rodava
a cadeia de guardrails do envio (as consultas de bloqueio, janela, anti-ban e a checagem
semântica de promessa). Eram duas etapas em fila, e as duas somavam.

Agora as duas correm juntas: a pausa começa antes da cadeia e o envio só sai quando as duas
terminam. O lead recebe exatamente a mesma mensagem, no mesmo formato, com os mesmos guardrails
decidindo se algo sai ou não — só que cerca de dois segundos mais cedo por resposta, sem nada
novo para configurar. Se um guardrail veta o envio, nada é enviado, como antes.

Não há nada a fazer na VPS: é só a atualização de sempre.
