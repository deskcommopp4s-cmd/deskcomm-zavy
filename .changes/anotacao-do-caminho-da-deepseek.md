---
impacto: nada_mudou
secao: corrigido
titulo: Corrigida uma anotação interna sobre o caminho da DeepSeek
---

Uma anotação no código afirmava que a biblioteca de integração falava com o endereço antigo da API
da DeepSeek. Na versão instalada ela usa o endereço novo, e foi essa anotação errada que levou a
testar o campo errado ao desligar o raciocínio do provedor. A anotação agora diz o caminho real e
onde comprová-lo dentro da própria biblioteca.
