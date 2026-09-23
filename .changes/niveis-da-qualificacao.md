---
impacto: capacidade_nova
secao: adicionado
titulo: A qualificação por Jev ganha três níveis e a chave vira da instalação
---

A qualificação do lead com o Jev (TypeSafe) já movia o funil por decisão própria, mas ligava
com um interruptor só e guardava uma chave por empresa. Agora são **três níveis**, e o
efetivo é o E de todos: o superadmin liga na instalação inteira, o superadmin libera por
empresa na ficha do tenant, e o admin da própria conta liga o ponto. Qualquer um desligado
devolve o classificador de etapa de sempre — nada muda para quem não ligou.

A chave do provedor de decisão deixou de ser por organização e passou a ser **da instalação**:
o superadmin cadastra uma vez, em Admin › Provedor de decisão (JEV), e todas as empresas usam.
A chave é guardada cifrada com a mesma cifra das chaves de IA e nunca volta a aparecer na
tela.

Também entrou a **regressão de funil**: por padrão o agente só avança o card, como sempre.
Se o admin da conta ligar a opção em Configurações › Etapas do funil, a IA pode trazer o
card **um passo para trás** quando a conversa mostrar que o cliente retrocedeu — sempre por
uma transição válida do funil, nunca um salto.

Nada disso aparece sozinho: instalação que atualiza continua igual até alguém ligar os
níveis e cadastrar a chave.
