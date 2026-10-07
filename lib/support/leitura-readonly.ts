/**
 * A CONEXÃO DE LEITURA DO SUPORTE — a trava que a RLS não dá.
 *
 * ── POR QUE ESTA CONEXÃO EXISTE ─────────────────────────────────────────────
 *
 * A IA de suporte lê a conta do cliente para responder ("quantos leads eu
 * tenho?", "como está o funil?"). Ela NÃO pode alterar nada — é decisão do dono,
 * e vale para a IA E para o humano.
 *
 * O humano é barrado por POLICY: as 3 RESTRICTIVE de `support_*`
 * (`fn_support_write_allowed`) recusam a escrita na sessão `authenticated`.
 *
 * A IA não pode usar essa trava: ela roda com `service_role`, e
 * `service_role.rolbypassrls = true` (MEDIDO em produção) — policies não a
 * alcançam. Uma policy a mais seria código morto.
 *
 * Então a trava é OUTRA, e é do BANCO: a conexão nasce em modo somente-leitura
 * e o PRÓPRIO SERVIDOR recusa a escrita, independente de quem se diz ser.
 *
 * ── O MECANISMO: `set` NA CONEXÃO, NÃO `options` NA STRING ──────────────────
 *
 * A tentação é `new Pool({ options: '-c default_transaction_read_only=on' })`.
 * MEDIDO (06/10/2026): NÃO FUNCIONA nesta instalação. O `SUPABASE_DB_URL` de
 * produção aponta para o POOLER do Supabase (`pooler.supabase.com:5432`), e o
 * Supavisor DESCARTA o parâmetro de startup `options` — a sessão nascia `off`
 * e a escrita passava. Medido nas três formas:
 *     PGOPTIONS=...            → show default_transaction_read_only = off
 *     ?options=-c%20...        → off
 *     -c "set ..." + -c "..."  → on  ✅
 *
 * Por isso o modo é aplicado no evento `connect` do pool: cada conexão nova
 * recebe o `set` ANTES de qualquer query do consumidor. Não depende do pooler
 * repassar nada — é uma query nossa, na nossa sessão.
 *
 *   MEDIDO (06/10/2026), com controle positivo:
 *     set default_transaction_read_only=on;  -- conexão
 *     update ... where false;
 *       → ERROR: cannot execute UPDATE in a read-only transaction   ✅ recusa
 *     (sem o set) update ... where false;
 *       → UPDATE 0  (passou — o instrumento está vivo)              ✅ controle
 *
 * ── A REGRA DE USO ──────────────────────────────────────────────────────────
 *
 * O módulo de suporte NUNCA lê a conta pela conexão de escrita. Ler pela de
 * escrita funcionaria — e é exatamente por isso que a guarda existe: o erro
 * passaria despercebido até o dia em que alguém escrevesse por engano.
 *
 * Escrever na CONVERSA de suporte (`support_messages`) é outra conexão — a de
 * escrita, que só toca as tabelas `support_*`.
 */
import pg from 'pg';

/**
 * O modo somente-leitura do Postgres. Nomeado para a guarda
 * (`suporte-ia-le-so-por-conexao-readonly.test.ts`) poder procurá-lo
 * literalmente: um teste que procurasse a STRING solta passaria com um
 * comentário que a citasse.
 */
export const MODO_SOMENTE_LEITURA = 'set default_transaction_read_only = on';

let _pool: pg.Pool | null = null;

/**
 * O pool de LEITURA da conta do cliente. Toda leitura da conta passa por aqui.
 *
 * `max: 4` — o suporte é de baixo volume e a leitura é curta; um teto baixo
 * evita que uma rajada de chamados consuma o `max_connections` que o app usa.
 *
 * O `set` no evento `connect` roda ANTES de o cliente sair do pool para o
 * consumidor — o `pg-pool` emite `connect` no instante em que a conexão TCP
 * fica pronta, e só a entrega depois. Não há janela em que o consumidor receba
 * um cliente ainda gravável.
 */
export function poolDeLeituraDoSuporte(databaseUrl: string): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    _pool.on('connect', (client) => {
      // `void` porque o evento não espera promessa; a rejeição vira o 'error'
      // do cliente, que o pool já trata. Falhar aqui é falhar ABERTO (o cliente
      // ficaria gravável), então a query não pode ser engolida em silêncio.
      client.query(MODO_SOMENTE_LEITURA).catch((err: Error) => {
        client.emit('error', err);
      });
    });
    // Mesma guarda do pool do harness: um 'error' sem listener derruba o processo.
    _pool.on('error', () => undefined);
  }
  return _pool;
}

/** Só para os testes — fecha o pool e zera o cache. */
export async function fecharPoolDeLeituraDoSuporte(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
