# Fork Opp4System — `deskcomm-zavy`

Este repositório é o **fork privado** do [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM)
mantido pela **Opp4System**, que dá base ao produto **zavy CRM**.

## Estado atual (24/09/2026)

| | |
|---|---|
| **Último commit** | `aaabb02f` |
| **Produção** | https://deskcomm.opp4s.com |
| **Health** | https://deskcomm.opp4s.com/api/v1/health |
| **Imagens** | `ghcr.io/deskcommopp4s-cmd/deskcommcrm:latest` · `deskcomm-worker:latest` · `deskcomm-scheduler:latest` |
| **Containers** | `deskcomm-app-1` · `-worker-1` · `-scheduler-1` · `-waha-1` · `-redis-1` · `-srh-1` |

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

## Correções ENTREGUES

| # | Correção | Onde | PR |
|---|---|---|---|
| 1 | **Mídia + texto no MESMO turno** — a espera da derivação olhava só a mensagem que disparou o evento; com FOTO seguida de TEXTO, o turno disparava pelo texto e respondia sem a visão da foto | `lib/agent-engine/edge/crm/drain.ts` | [#1594](https://github.com/melgarafael/DeskcommCRM/pull/1594) |
| 2 | **Visão do DeepSeek** — o registry de capacidades não tinha `deepseek`, então o media-derive tratava o modelo como sem visão e abria aviso na Central | `lib/agent-engine/edge/llm/capabilities.ts` | — |
| 3 | **Qualificação do lead por decisão (JEV/TypeSafe)** — provedor de decisão de primeira classe, com chave de plataforma | `lib/ai/decisao/` · `lib/agent-engine/agent/qualificacao-do-lead.ts` | — |
| 4 | **Níveis da qualificação + regressão de funil** — três níveis com JEV | `lib/agent-engine/agent/qualificacao-do-lead.ts` | — |
| 5 | **DeepSeek como provedor de primeira classe** — raciocínio desligável por knob | `lib/agent-engine/edge/llm/providers.ts` | [#1275](https://github.com/melgarafael/DeskcommCRM/pull/1275) |
| 6 | Vírgula nas opções de `select`/`multiselect` | — | [#1069](https://github.com/melgarafael/DeskcommCRM/pull/1069) |
| 7 | Chave de IA editável + DELETE que ensina a repontar | — | [#1112](https://github.com/melgarafael/DeskcommCRM/pull/1112) |

## Correções planejadas (ordem de risco)

| # | Correção | Motivo |
|---|---|---|
| 1 | **Paralelizar as chamadas de IA do turno** | Hoje 5 chamadas em fila (~22s). Ganho ~2× sem mudar lógica |
| 2 | **Não enviar as ferramentas do CRM nas chamadas internas** | Classificador, anti-jailbreak, detector de promessa e checkpoint não usam ferramenta — as 18 definições são ruído e custo |
| 3 | ~~"Digitando…" imediato e aleatório~~ | ✅ **JÁ IMPLEMENTADO** — ver a seção abaixo |
| 4 | **Fundir os avaliadores de "entender" no turno principal** | 5 chamadas → 2 (o anti-jailbreak continua separado — é segurança) |
| 5 | Validador de credencial respeitar gateway próprio | Hoje tem a URL da OpenRouter fixa no código |
| 6 | Avisar "alterações não publicadas" na tela do agente | Editar ≠ publicar é a causa de muito tempo perdido |
| 7 | Janela de envio configurável pela tela | Hoje o `channel_knobs` só se muda por banco |

### ⚠️ Item 3 — NÃO é pendência (medido em 24/09/2026)

O "digitando…" **já estava implementado** quando esta lista foi escrita, e a lista ficou
mentindo. O que existe:

| Peça | Onde | Estado |
|---|---|---|
| Batimento contínuo | `lib/agent-engine/agent/digitando-continuo.ts` | acende em ~400-700ms e re-sinaliza a cada 5s |
| Acendimento no turno | `inbound-turn.ts:3899` | **depois** das barreiras que descartam (`handoff`, `allowlist`, anti-ban, modo, horário) |
| Borda do canal | `lib/messaging/presenca.ts` | resolve sessão e destinatário pelas MESMAS funções do envio |
| Adapter | `lib/channels/adapters/waha.ts:119` | `POST /api/{session}/presence` → **201** |

**Verificado de ponta a ponta:** sinal enviado ao endereço CERTO (`@lid`, não `@c.us`)
aparece no aparelho do cliente.

**⚠️ A armadilha que custou uma medição errada:** o destinatário do WhatsApp é o
`wa_lid` quando existe, **não** o telefone — `resolveWahaChatId` testa `waLid` PRIMEIRO.
Testar presença com `{telefone}@c.us` num contato que tem lid **não acende nada**, e a
conclusão errada é "o engine não suporta". O endereço certo sai de `resolveWahaChatId`,
nunca do telefone.


## CI

O workflow `publish-image.yml` (herdado do upstream) constrói e publica as três imagens
no GHCR: `deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`.

**A VPS nunca constrói** — ela só faz `docker pull` da imagem pronta. Construir na VPS já
derrubou a produção uma vez (load 20,5 em 8 núcleos).

## Operação — o que dói saber

### O container roda a IMAGEM, não o código-fonte

Editar um `.ts` em `/opt/apps/deskcomm` **não tem efeito**: o container usa o bundle da
imagem publicada. O deploy real é:

```
1. git push (fork)         → GitHub Actions "Publicar imagem Docker (GHCR)" (~8-10 min)
2. ssh vps; cd /opt/apps/deskcomm
3. docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml pull app worker scheduler
4. docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d app worker scheduler
5. Validar: docker inspect <container> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

### Onde vive cada configuração

| Necessidade | Onde |
|---|---|
| Acesso da IA no canal (teste × público) | **Canais › Conexões › Configurar acesso da IA** |
| Qual modelo atende cada ponto | **Agente de IA › "Ver tudo em IA" › Provedores** |
| Credencial do provedor | **Agente de IA › "Ver tudo em IA" › Credenciais** |
| Notificações (Web Push) | **Configurações › Notificações** (coluna Push) |
| Por que a IA não respondeu | **Central de avisos** + log do worker |
| Auditoria de mudança | **Configurações › Audit** |

### Web Push exige DUAS coisas

1. **Chaves VAPID** no `.env` do servidor (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`) —
   gerar com `npx web-push generate-vapid-keys --json`
2. **Inscrição do navegador** em `push_subscriptions` — feita em Configurações › Notificações

Sem a primeira, o handler pula com `vapid_ausente`. Sem a segunda, não há para onde enviar.

### Diagnóstico rápido

| Sintoma no log | Significado |
|---|---|
| `ai-response-worker.v1: agent_inactive_or_missing` | **NORMAL** — worker legado desligado por design; quem responde é o agent-engine |
| `ai-sentiment-worker.v1: nao_elegivel_para_ia` | O gate do canal barrou (fora da lista de teste) |
| `drain: mídia ainda sendo transcrita — turno adiado` | A espera da derivação está funcionando |
| `web-push-inbound.v1: vapid_ausente` | Faltam as chaves VAPID |
