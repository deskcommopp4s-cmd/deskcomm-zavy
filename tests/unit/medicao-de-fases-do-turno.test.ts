import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FASES_DO_TURNO,
  comMedicao,
  criarMedicaoDeFases,
  fecharMedicaoDeFases,
  type FaseDoTurno,
} from "@/lib/agent-engine/agent/medicao-de-fases";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Logger de teste — guarda as linhas em vez de escrever em stdout. */
function logDeTeste(): Logger & {
  linhas: Array<{ msg: string; fields?: Record<string, unknown> }>;
  avisos: string[];
} {
  const linhas: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const avisos: string[] = [];
  return {
    linhas,
    avisos,
    info: (msg, fields) => linhas.push({ msg, fields }),
    warn: (msg) => avisos.push(msg),
    error: () => undefined,
  };
}

/** Relógio falso: cada leitura é controlada pelo teste — sem timer, sem espera real. */
function relogioFalso(_passo = 100): { agora: () => number; avancar: (ms: number) => void } {
  let t = 1_000_000;
  return {
    agora: () => t,
    avancar: (ms: number) => {
      t += ms;
    },
  };
}

describe("criarMedicaoDeFases", () => {
  it("mede CADA fase com o tempo que passou entre uma marca e a seguinte", () => {
    const relogio = relogioFalso();
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogio.agora });

    medicao.marcar('preparo'); // abre preparo
    relogio.avancar(3_000); // 3s de preparo
    medicao.marcar('etapa'); // fecha preparo, abre etapa
    relogio.avancar(6_500); // 6,5s do stage_classifier
    medicao.marcar('jailbreak');
    relogio.avancar(2_500);
    medicao.marcar('contexto');
    relogio.avancar(400);
    medicao.marcar('chamada_principal');
    relogio.avancar(9_300);
    medicao.marcar('envio');
    relogio.avancar(4_000);
    medicao.marcar('checkpoint');
    relogio.avancar(1_700);

    const resumo = medicao.resumo()!;
    expect(resumo.fases_ms).toEqual({
      preparo: 3_000,
      etapa: 6_500,
      jailbreak: 2_500,
      contexto: 400,
      chamada_principal: 9_300,
      envio: 4_000,
      checkpoint: 1_700,
    });
    // O total é do INÍCIO do turno, não a soma das fases: a diferença entre os
    // dois é o que revela tempo fora de qualquer fase instrumentada.
    expect(resumo.total_ms).toBe(27_400);
  });

  it("o rótulo é carimbado ANTES do trabalho da fase — o preparo cabe inteiro na 1ª marca", () => {
    const relogio = relogioFalso();
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogio.agora });

    // Nada marcado ainda: `inicioDaFase('preparo')` é null.
    expect(medicao.inicioDaFase('preparo')).toBeNull();
    medicao.marcar('preparo');
    // O I/O do preparo acontece DEPOIS desta chamada — é o que o torna medido.
    const inicio = medicao.inicioDaFase('preparo');
    expect(inicio).not.toBeNull();
    relogio.avancar(2_000);
    medicao.marcar('etapa');
    expect(medicao.inicioDaFase('preparo')).toBe(inicio);
  });

  it("resumo() fecha a fase CORRENTE — o checkpoint não precisa de marca seguinte", () => {
    const relogio = relogioFalso();
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogio.agora });
    medicao.marcar('checkpoint');
    relogio.avancar(1_700);
    expect(medicao.resumo()!.fases_ms.checkpoint).toBe(1_700);
  });

  it("fase REABERTA no mesmo turno ACUMULA — o fail-safe reabre o `envio` de verdade", () => {
    // A cadeia `before_send` re-roda quando um fail-safe veta (promessa fora de
    // tabela, vocabulário interno, falso-vazio). O `envio` é reaberto, e
    // sobrescrever perderia a passagem anterior — a fase subestimaria justo o
    // turno mais caro, e o diagnóstico apontaria para a fase errada.
    //
    // A reabertura é feita com `marcar('envio')` DUAS vezes direto: entre uma
    // passagem e outra da cadeia não há `marcar` nenhum (a re-execução acontece
    // dentro do mesmo `execute` da tool), então o que importa é que a soma
    // inclua as duas janelas em vez de só a última.
    const relogio = relogioFalso();
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogio.agora });
    medicao.marcar('envio');
    relogio.avancar(6_000); // 1ª passagem: espera humana + canal
    medicao.marcar('envio'); // reabre: o fail-safe re-roda a cadeia
    relogio.avancar(4_000); // 2ª passagem

    expect(medicao.resumo()!.fases_ms.envio).toBe(10_000); // 6s + 4s, não só os 4s
  });

  it("reabrir não reescreve o início da fase — `inicioDaFase` responde a 1ª abertura", () => {
    const relogio = relogioFalso();
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogio.agora });
    medicao.marcar('envio');
    const inicio = medicao.inicioDaFase('envio');
    relogio.avancar(1_000);
    medicao.marcar('checkpoint');
    relogio.avancar(500);
    medicao.marcar('envio');
    expect(medicao.inicioDaFase('envio')).toBe(inicio);
  });

  it("resumo() é idempotente e não devolve um segundo relatório", () => {
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogioFalso().agora });
    medicao.marcar('preparo');
    expect(medicao.resumo()).not.toBeNull();
    expect(medicao.resumo()).toBeNull();
  });

  it("marcar DEPOIS de resumo() é no-op — timer que vaza é pior que medição ausente", () => {
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogioFalso().agora });
    medicao.marcar('preparo');
    medicao.resumo();
    expect(() => medicao.marcar('etapa')).not.toThrow();
    expect(medicao.resumo()).toBeNull();
  });
});

describe("fecharMedicaoDeFases", () => {
  it("emite UMA linha com todas as fases e o total", () => {
    const log = logDeTeste();
    const relogio = relogioFalso();
    const medicao = criarMedicaoDeFases({ log, agora: relogio.agora });
    medicao.marcar('preparo');
    relogio.avancar(1_200);
    medicao.marcar('etapa');
    relogio.avancar(6_500);

    fecharMedicaoDeFases(medicao, log);

    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]!.msg).toBe('tempo por fase do turno');
    expect(log.linhas[0]!.fields).toMatchObject({
      preparo: 1_200,
      etapa: 6_500,
      total_ms: 7_700,
    });
  });

  it("medição ausente (knob off) não emite nada e não explode", () => {
    const log = logDeTeste();
    expect(() => fecharMedicaoDeFases(null, log)).not.toThrow();
    expect(log.linhas).toHaveLength(0);
  });

  it("log que LANÇA não derruba o turno — observabilidade não é o produto", () => {
    const medicao = criarMedicaoDeFases({ log: logDeTeste(), agora: relogioFalso().agora });
    medicao.marcar('preparo');
    const logQueExplode: Logger = {
      info: () => {
        throw new Error('stdout fechado');
      },
      warn: () => {
        throw new Error('stdout fechado');
      },
      error: () => undefined,
    };
    expect(() => fecharMedicaoDeFases(medicao, logQueExplode)).not.toThrow();
  });
});

describe("comMedicao", () => {
  it("mede o trecho, emite a linha e devolve o resultado", async () => {
    const log = logDeTeste();
    const relogio = relogioFalso();
    const out = await comMedicao(
      log,
      'preparo',
      async () => {
        relogio.avancar(2_000);
        return 'ok';
      },
      { agora: relogio.agora },
    );
    expect(out).toBe('ok');
    expect(log.linhas[0]!.fields).toMatchObject({ preparo: 2_000 });
  });

  it("emite mesmo quando o trecho FALHA — erro é quando mais se quer saber onde o tempo foi", async () => {
    const log = logDeTeste();
    await expect(
      comMedicao(log, 'preparo', async () => {
        throw new Error('crm fora');
      }),
    ).rejects.toThrow('crm fora');
    expect(log.linhas.map((l) => l.msg)).toContain('tempo por fase do turno');
  });

  it("a medicao NUNCA atrapalha o resultado: entrega a promise original", async () => {
    const log = logDeTeste();
    const valor = { a: 1 };
    await expect(comMedicao(log, 'etapa', async () => valor)).resolves.toBe(valor);
  });
});

/**
 * FIAÇÃO — o turno mora num arquivo de ~4.300 linhas e não é alcançável por
 * teste de unidade (precisa de pool, modelo e canal). A perda seria silenciosa:
 * uma marca faltando deixa a fase de fora do diagnóstico e ninguém percebe —
 * que é exatamente o defeito que este trabalho conserta. Prender a fiação na
 * fonte é a rede mais barata, e é o mesmo padrão de `digitando-continuo.test.ts`.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'),
  'utf8',
);

describe("fiação — as fases do turno são marcadas no lugar certo", () => {
  // A lista vem do PRÓPRIO módulo: uma fase nova em `FASES_DO_TURNO` sem `marcar`
  // no turno passa a reprovar aqui, em vez de virar uma coluna sempre ausente no
  // diagnóstico — que é o defeito que este trabalho existe para não repetir.
  const marcas: readonly FaseDoTurno[] = FASES_DO_TURNO;

  it("marca todas as fases esperadas", () => {
    for (const fase of marcas) {
      expect(FONTE_INBOUND).toContain(`marcar('${fase}')`);
    }
  });

  it("a medição nasce ANTES da escolta de orçamento — senão o turno que estoura fica cego", () => {
    const cria = FONTE_INBOUND.indexOf('criarMedicaoDeFases({ log: logDaEscolta })');
    const escolta = FONTE_INBOUND.indexOf('await comHandoffSeOrcamentoAcabar(');
    expect(cria).toBeGreaterThan(-1);
    expect(escolta).toBeGreaterThan(-1);
    expect(cria).toBeLessThan(escolta);
    // `preparo` é aberto na sequência imediata da criação: é ele que cobre as
    // barreiras baratas (fuso, orçamento, elegibilidade, janela, config).
    expect(FONTE_INBOUND.slice(cria, escolta)).toContain("marcar('preparo')");
  });

  it("a medição fecha no `finally` — sai também no turno que morre no meio", () => {
    const limpeza = FONTE_INBOUND.indexOf('await mcpCleanup?.();');
    expect(limpeza).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(Math.max(0, limpeza - 500), limpeza);
    expect(janela).toContain('fecharMedicaoDeFases(medicaoDoTurno ?? null, runLog)');
  });

  it("`chamada_principal` é marcada ANTES do runModelCall principal e `checkpoint` depois", () => {
    const principal = FONTE_INBOUND.indexOf("purpose: preview ? 'agent_preview' : 'agent_turn'");
    const checkpoint = FONTE_INBOUND.indexOf("purpose: 'checkpoint'");
    expect(principal).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(principal);

    const marcaPrincipal = FONTE_INBOUND.indexOf("marcar('chamada_principal')");
    const marcaEnvio = FONTE_INBOUND.indexOf("marcar('envio')");
    const marcaCheckpoint = FONTE_INBOUND.indexOf("marcar('checkpoint')");
    expect(marcaPrincipal).toBeGreaterThan(-1);
    expect(marcaPrincipal).toBeLessThan(principal);
    expect(marcaCheckpoint).toBeGreaterThan(checkpoint - 200);
    expect(marcaCheckpoint).toBeLessThan(checkpoint);

    // A `envio` só pode abrir DENTRO da tool `send_message` — que é executada
    // pela chamada principal. Abri-la antes dela colocaria o modelo inteiro na
    // conta do envio, e o oposto (depois) perderia a espera humana. As tools são
    // definidas ANTES do `runModelCall` (é ele quem as executa), então o que
    // ancora a ordem é o `execute` do `send_message`, não o `runModelCall`.
    const defineSendMessage = FONTE_INBOUND.indexOf('send_message: tool({');
    const constroiEAbertura = FONTE_INBOUND.indexOf('const openingBase = input.buildOpening({');
    expect(defineSendMessage).toBeGreaterThan(-1);
    expect(marcaEnvio).toBeGreaterThan(defineSendMessage);
    expect(marcaEnvio).toBeLessThan(constroiEAbertura);
    expect(marcaPrincipal).toBeGreaterThan(constroiEAbertura);
    expect(marcaEnvio).toBeLessThan(marcaCheckpoint);
  });

  it("a espera humana é medida com o relógio do turno, não com um segundo relógio", () => {
    // O gancho `onEsperaHumana` é o único jeito de separar "espera deliberada" de
    // "rede do canal" sem reimplementar o atraso humano — ver o cabeçalho de
    // `split-message.ts`.
    expect(FONTE_INBOUND).toContain('onEsperaHumana: (inicioMs, fimMs)');
    expect(FONTE_INBOUND).toContain("runLog.info('espera humana medida'");
  });
});
