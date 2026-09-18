import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { drainTick } from '@/lib/agent-engine/edge/crm/drain';

/**
 * O DEBOUNCE ABSORVENTE — o lado do DRAIN.
 *
 * A espera morta de `INBOUND_DEBOUNCE_MS` (8s) existe para o turno começar com a
 * rajada inteira. O caminho novo (valor 0) começa JÁ e usa o próprio tempo de
 * processamento como janela: a mensagem que chega durante o turno é absorvida
 * por ele, e o job duplicado — se nascer — encontra a resposta já dada e
 * encerra sem gastar (`inboundJaRespondido`, no turno).
 *
 * Aqui se mede o que MUDA no drain: com 0 o job nasce para AGORA (a âncora da
 * coalescência deixa de ser um job futuro), e a consulta de coalescência não
 * roda; com > 0 nada disto acontece e a semântica antiga continua valendo.
 *
 * O valor default NÃO muda (8_000): o caminho novo é opt-in explícito.
 */

const event = {
  id: 'e1',
  organization_id: 'org1',
  attempts: 1,
  created_at: new Date().toISOString(),
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/** Captura os parâmetros do `insert into job_queue` para inspecionar o `run_after`. */
function poolQueEnfileira() {
  const inserts: unknown[][] = [];
  const calls: string[] = [];
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [event] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("direction = 'inbound'")) return { rows: [{ id: event.payload.inbound_message_id }] };
    if (sql.includes('media_derived_status')) {
      return { rows: [{ type: 'text', media_derived_status: null }] };
    }
    if (sql.includes('insert into job_queue')) {
      inserts.push(params);
      return { rows: [{ id: 'job-1' }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, inserts, calls };
}

const knobs = (debounceMs: number) => ({
  batchSize: 10,
  intervalMs: 0,
  idleIntervalMs: 0,
  debounceMs,
  reapTimeoutMs: 60_000,
});

it('INBOUND_DEBOUNCE_MS=0: o job nasce para AGORA — sem espera morta', async () => {
  const { pool, inserts, calls } = poolQueEnfileira();
  await drainTick(pool, knobs(0), log);

  expect(inserts).toHaveLength(1);
  // params = [tenant, leadId, kind, sourceEventId, payload, priority, run_after, max_attempts]
  const runAfter = inserts[0]![6];
  expect(runAfter, 'com debounce 0 o run_after precisa ser NULO (= now())').toBeNull();
  // E a âncora antiga (job PENDING futuro) some do caminho: não há consulta de
  // coalescência a fazer quando o turno já começou.
  expect(calls.some((s) => s.includes('select id from job_queue'))).toBe(false);
});

it('INBOUND_DEBOUNCE_MS>0: a semântica antiga continua — espera antes de começar', async () => {
  const { pool, inserts, calls } = poolQueEnfileira();
  await drainTick(pool, knobs(8_000), log);

  expect(inserts).toHaveLength(1);
  const runAfter = inserts[0]![6];
  expect(runAfter).toBeInstanceOf(Date);
  const deltaMs = (runAfter as Date).getTime() - Date.now();
  expect(deltaMs).toBeGreaterThan(7_000);
  expect(deltaMs).toBeLessThanOrEqual(8_000);
  // A coalescência em job PENDING futuro continua sendo consultada.
  expect(calls.some((s) => s.includes('select id from job_queue'))).toBe(true);
});
