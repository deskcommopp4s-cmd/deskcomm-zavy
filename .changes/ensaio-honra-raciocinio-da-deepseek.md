---
impacto: nada_mudou
secao: corrigido
titulo: O botão Teste também desliga o raciocínio da DeepSeek, igual ao atendimento real
---

Com a DeepSeek configurada para não escrever raciocínio interno (`DEEPSEEK_THINKING=disabled`), o
atendimento de verdade já respondia mais rápido e mais barato, mas o botão "Testar" continuava
usando o raciocínio ligado. O mesmo acontecia na sugestão de quadro durante a instalação. Agora os
dois caminhos mandam o mesmo desligamento — testar mostra o custo e a demora que o cliente recebe.

Sem a variável configurada, nada muda: o raciocínio segue como o provedor entrega.
