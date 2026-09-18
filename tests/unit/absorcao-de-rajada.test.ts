import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  inboundJaRespondido,
  inboundMaisRecenteId,
  inboundsNaoRespondidos,
} from '@/lib/agent-engine/agent/inbound-turn';
import {
  detectAmbiguousOptOut,
  detectHumanHandoffRequest,
} from '@/lib/agent-engine/agent/human-handoff';
import type { LeadContext, LeadContextMessage } from '@/lib/agent-engine/edge/crm/get-lead-context';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

/**
 * O TURNO ABSORVENTE — mensagem que chega DURANTE o turno vira UMA resposta.
 *
 * Com `INBOUND_DEBOUNCE_MS=0` o turno começa no mesmo instante e a janela de
 * rajada passa a ser o próprio tempo de processamento. Duas peças fazem o
 * "uma resposta só":
 *
 *   1. o turno relê a conversa antes do primeiro envio e, se chegou mensagem
 *      nova, devolve ao modelo o erro instrutivo `novas_mensagens_durante_o_turno`
 *      — ele relê com `get_lead_context` e compõe UMA resposta para o conjunto
 *      (mesmo sem emendar texto: a detecção de opt-out continua por mensagem);
 *   2. o job duplicado que ainda assim nascer encontra, no início, a resposta
 *      que o primeiro turno já deu (`inboundJaRespondido`) e encerra sem gastar
 *      — a segunda resposta picada é o defeito que isto fecha.
 *
 * A mensagem que chega DEPOIS de a resposta sair não é absorvida (não há como
 * cancelar o que saiu): vira um 2º turno normal. É o desenho, não um buraco.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. As duas consultas de marca: recência e "já respondido"
// ─────────────────────────────────────────────────────────────────────────────

function pool(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { db: { query } as unknown as Queryable, query };
}

describe('inboundMaisRecenteId — a testemunha de "chegou mensagem nova"', () => {
  it('recorta por organização, conversa e inbound; desempata por recência real', async () => {
    const { db, query } = pool([{ id: 'msg-2' }]);
    const id = await inboundMaisRecenteId(db, { tenantId: 'org-1', conversationId: 'conv-1' });
    expect(id).toBe('msg-2');

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/organization_id\s*=\s*\$1/);
    expect(sql).toMatch(/conversation_id\s*=\s*\$2/);
    expect(sql).toMatch(/direction\s*=\s*'inbound'/);
    // O mesmo desempate do anti-backlog do drain: `id` é uuid aleatório e não
    // pode eleger a mensagem antiga quando dois inbound compartilham `sent_at`.
    expect(sql).toContain('coalesce(sent_at, created_at) desc');
    expect(sql).toContain('created_at desc');
    expect(params).toEqual(['org-1', 'conv-1']);
  });

  it('conversa sem inbound devolve null — e o turno segue sem absorver', async () => {
    const { db } = pool([]);
    await expect(
      inboundMaisRecenteId(db, { tenantId: 'o', conversationId: 'c' }),
    ).resolves.toBeNull();
  });
});

describe('inboundJaRespondido — o job duplicado não responde de novo', () => {
  it('só é verdade quando existe OUTBOUND mais recente que a mensagem do job', async () => {
    const { db, query } = pool([{ respondido: true }]);
    await expect(
      inboundJaRespondido(db, {
        tenantId: 'org-1',
        conversationId: 'conv-1',
        inboundMessageId: 'msg-1',
      }),
    ).resolves.toBe(true);

    const [sql, params] = query.mock.calls[0]!;
    // A mensagem-alvo é recortada por org + conversa + id + direção; sem a
    // direção, uma outbound nossa viraria "a mensagem do job".
    expect(sql).toMatch(/t\.organization_id\s*=\s*\$1/);
    expect(sql).toMatch(/t\.conversation_id\s*=\s*\$2/);
    expect(sql).toMatch(/t\.id\s*=\s*\$3/);
    expect(sql).toMatch(/t\.direction\s*=\s*'inbound'/);
    expect(sql).toMatch(/o\.direction\s*=\s*'outbound'/);
    // A comparação é de RECÊNCIA, não de existência: uma outbound anterior à
    // mensagem (resposta a um inbound passado) não pode calar esta.
    expect(sql).toMatch(/coalesce\(o\.sent_at, o\.created_at\)\s*>\s*coalesce\(t\.sent_at, t\.created_at\)/);
    expect(params).toEqual(['org-1', 'conv-1', 'msg-1']);
  });

  it('sem outbound posterior devolve false — o turno precisa rodar', async () => {
    const { db } = pool([{ respondido: false }]);
    await expect(
      inboundJaRespondido(db, { tenantId: 'o', conversationId: 'c', inboundMessageId: 'm' }),
    ).resolves.toBe(false);
  });

  it('linha ausente (mensagem do job sumiu) devolve false — nunca cala por engano', async () => {
    const { db } = pool([]);
    await expect(
      inboundJaRespondido(db, { tenantId: 'o', conversationId: 'c', inboundMessageId: 'm' }),
    ).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A rajada absorvida — os invariantes continuam por MENSAGEM
// ─────────────────────────────────────────────────────────────────────────────

const contextoDeRajada = {
  messages: [
    { direction: 'outbound', body: 'Oi! Como posso ajudar?', sent_at: '2026-09-06T09:00:00-04:00' },
    { direction: 'inbound', body: 'oi', sent_at: '2026-09-06T09:03:00-04:00' },
    { direction: 'inbound', body: 'PARAR', sent_at: '2026-09-06T09:03:03-04:00' },
  ],
} as unknown as LeadContext;

describe('o que foi absorvido continua passando pelo detector REAL, por mensagem', () => {
  it('opt-out na 2ª mensagem absorvida É detectado', () => {
    const pendentes = inboundsNaoRespondidos(contextoDeRajada.messages as LeadContextMessage[]);
    expect(pendentes).toEqual(['oi', 'PARAR']);
    // Emendar a rajada num texto só ("oi\nPARAR") mataria a palavra isolada —
    // por isso o detector roda POR MENSAGEM, nunca no join.
    expect(detectAmbiguousOptOut(pendentes.join('\n'))).toBe(false);
    expect(pendentes.some((t) => detectAmbiguousOptOut(t))).toBe(true);
  });

  it('pedido de humano na 2ª mensagem absorvida É detectado', () => {
    const pendentes = inboundsNaoRespondidos([
      { direction: 'outbound', body: 'Oi!', sent_at: '2026-09-06T09:00:00-04:00' },
      { direction: 'inbound', body: 'oi', sent_at: '2026-09-06T09:03:00-04:00' },
      { direction: 'inbound', body: 'quero falar com uma pessoa', sent_at: '2026-09-06T09:03:03-04:00' },
    ] as LeadContextMessage[]);
    expect(pendentes.some((t) => detectHumanHandoffRequest(t))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A fiação — sem ela as funções acima seriam só biblioteca
// ─────────────────────────────────────────────────────────────────────────────

const FONTE = readFileSync(
  join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'),
  'utf8',
);

describe('fiação do turno absorvente', () => {
  it('no início do turno, mensagem já respondida encerra sem gastar', () => {
    expect(FONTE).toMatch(/inboundJaRespondido\(/);
    expect(FONTE).toMatch(/turno pulado — a mensagem do job já foi respondida/);
  });

  it('o turno guarda a testemunha da recência depois de ler o contexto', () => {
    // `let`: a absorção reescreve a testemunha quando encontra mensagem nova.
    // E a consulta só acontece com o caminho absorvente LIGADO — com o default
    // do env (8s), o turno não paga query nenhuma a mais.
    expect(FONTE).toMatch(
      /let vistoInboundId =\s*\n?\s*preview \|\| deps\.knobs\.absorverRajada !== true \|\| liveJob\(\)\.kind !== 'inbound_turn'\s*\n?\s*\? null\s*\n?\s*: await inboundMaisRecenteId\(/,
    );
  });

  it('o caminho absorvente é opt-in pelo MESMO env que o drain lê', () => {
    const FONTE_KNOBS = readFileSync(
      join(process.cwd(), 'lib/agent-engine/agent/turn-knobs.ts'),
      'utf8',
    );
    expect(FONTE_KNOBS).toMatch(/absorverRajada: env\.INBOUND_DEBOUNCE_MS === 0/);
    // E o turno só absorve com o knob ligado — o default (8s) fica intacto.
    expect(FONTE).toMatch(/deps\.knobs\.absorverRajada === true/);
    const i = FONTE.indexOf('const absorverMensagemNova');
    expect(FONTE.slice(i, i + 400)).toMatch(/absorverRajada !== true/);
  });

  it('o primeiro send_message absorve antes de enviar', () => {
    const i = FONTE.indexOf('send_message: tool({');
    const j = FONTE.indexOf('update_lead_state: tool({', i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const corpo = FONTE.slice(i, j);
    expect(corpo).toMatch(/seq === 0/);
    expect(corpo).toMatch(/absorverMensagemNova\(/);
    // O erro instrutivo: o modelo relê e compõe UMA resposta para o conjunto.
    expect(corpo).toMatch(/novas_mensagens_durante_o_turno/);
  });

  it('a absorção roda os detectores DETERMINÍSTICOS sobre os inbounds pendentes', () => {
    const i = FONTE.indexOf('const absorverMensagemNova');
    expect(i, 'a função de absorção sumiu').toBeGreaterThan(-1);
    const j = FONTE.indexOf('const rawTools', i);
    expect(j).toBeGreaterThan(i);
    const corpo = FONTE.slice(i, j);
    expect(corpo).toMatch(/inboundMaisRecenteId\(/);
    expect(corpo).toMatch(/inboundsNaoRespondidos\(/);
    expect(corpo).toMatch(/detectHumanHandoffRequest\(/);
    expect(corpo).toMatch(/detectAmbiguousOptOut\(/);
    // E os dois desfechos que importam: encerra (handoff/opt-out) ou ensina o
    // modelo a reler.
    expect(corpo).toMatch(/acionarHandoffDeterministico\(/);
  });

  it('a absorção é IRMÃ do gate de abertura, não uma segunda cópia da ação', () => {
    // Um único ponto que avisa-e-silencia, chamado pelo gate do topo do turno e
    // pela absorção: duas cópias divergiriam no texto do aviso e no motivo.
    expect(FONTE).toMatch(/const acionarHandoffDeterministico = async/);
    expect(FONTE).toMatch(/acionarHandoffDeterministico\('pediu_humano'\)/);
    expect(FONTE).toMatch(/acionarHandoffDeterministico\('suspeita_de_opt_out'\)/);
  });

  it('o envio após o encerramento por padrão determinístico é recusado', () => {
    const i = FONTE.indexOf('send_message: tool({');
    const j = FONTE.indexOf('update_lead_state: tool({', i);
    expect(FONTE.slice(i, j)).toMatch(/turnoEncerradoPorPadrao/);
  });

  it('CONTROLE NEGATIVO: a absorção vive no send_message, não no send_template', () => {
    // Sem este controle, um `replaceAll` que copiasse o bloco para o template
    // passaria despercebido — e a absorção dispararia onde não há releitura de
    // contexto para o modelo usar.
    const i = FONTE.indexOf('send_template: tool({');
    const j = FONTE.indexOf('search_knowledge: tool({', i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(FONTE.slice(i, j)).not.toMatch(/novas_mensagens_durante_o_turno/);
    expect(FONTE.slice(i, j)).not.toMatch(/absorverMensagemNova\(/);
  });
});

const FONTE_ENV = readFileSync(join(process.cwd(), 'lib/agent-engine/env.ts'), 'utf8');

describe('a semântica do knob', () => {
  it('o default NÃO muda (opt-in explícito) e o 0 é aceito', () => {
    expect(FONTE_ENV).toMatch(/INBOUND_DEBOUNCE_MS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.default\(8_000\)/);
  });
});
