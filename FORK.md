# Fork Opp4System — `deskcomm-zavy`

Este repositório é o **fork privado** do [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM)
mantido pela **Opp4System**, que dá base ao produto **zavy CRM**.

## Por que existe

O DeskcommCRM é MIT e roda a nossa operação. Mantemos este fork para:

1. Corrigir defeitos que impactam a operação (ver lista abaixo)
2. Adicionar o que falta para equiparar ao nosso produto anterior (disparos, créditos)
3. Ajustar o produto ao nosso modelo comercial (whitelabel, planos, custo de IA)

## Regra de sincronização com o upstream

O projeto original **continua evoluindo**. Para não perder as melhorias dele:

```
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git fetch upstream
git checkout -b sync/upstream-AAAA-MM-DD
git merge upstream/main
# rodar: pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit
```

**Regra de ouro: nossas mudanças são ADITIVAS.** Preferimos usar as costuras que o
projeto já oferece (`lib/channels/adapters/`, `lib/ai/pontos/`, migrations com apêndice
no `baseline.sql`, `event_log` + workers). Quanto mais aditivo, menor o conflito na
sincronização.

O que **nunca** fazer:

- Editar o **meio** do `supabase/baseline.sql` (só **apêndice** no fim)
- Renomear ou reescrever funções/arquivos do upstream sem necessidade
- Nomear provider fora de `lib/channels/` (o `lint:channels` reprova)

## Correções planejadas (ordem de risco)

| # | Correção | Motivo |
|---|---|---|
| 1 | **Paralelizar as chamadas de IA do turno** | Hoje 5 chamadas em fila (~22s). Ganho ~2× sem mudar lógica |
| 2 | **Não enviar as ferramentas do CRM nas chamadas internas** | Classificador, anti-jailbreak, detector de promessa e checkpoint não usam ferramenta — as 18 definições são ruído e custo |
| 3 | **"Digitando…" imediato e aleatório** | Hoje só aparece depois do processamento: o lead espera 20-45s em silêncio e reclama |
| 4 | **Fundir os avaliadores de "entender" no turno principal** | 5 chamadas → 2 (o anti-jailbreak continua separado — é segurança) |
| 5 | Validador de credencial respeitar gateway próprio | Hoje tem a URL da OpenRouter fixa no código |
| 6 | Avisar "alterações não publicadas" na tela do agente | Editar ≠ publicar é a causa de muito tempo perdido |
| 7 | Janela de envio configurável pela tela | Hoje o `channel_knobs` só se muda por banco |

## CI

O workflow `publish-image.yml` (herdado do upstream) constrói e publica as três imagens
no GHCR: `deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`.

**A VPS nunca constrói** — ela só faz `docker pull` da imagem pronta. Construir na VPS já
derrubou a produção uma vez (load 20,5 em 8 núcleos).
