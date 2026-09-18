---
impacto: capacidade_nova
secao: adicionado
titulo: O atendente na DeepSeek pode parar de "pensar" antes de responder
---

A DeepSeek, por padrão, escreve um raciocínio interno antes de cada resposta — e cobra
cada palavra dele como texto de saída. Em conversas longas isso pesa: medimos o turno do
atendente gastando cerca de oito vezes mais saída do que com a OpenAI e demorando mais
para responder, o que anulava a economia do preço mais barato.

Agora quem cuida do servidor pode desligar esse raciocínio com
`DEEPSEEK_THINKING=disabled` no `.env`. Sem configurar nada, tudo segue como está: o
raciocínio continua ligado. A mudança vale só para a DeepSeek — Anthropic, OpenAI, Google
e OpenRouter não são afetadas.
