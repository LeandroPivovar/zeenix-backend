import { Tick, DigitParity } from '../ai.service';
import { ModeConfig, SignalResult } from './common.types';

/**
 * ANÁLISE 1: Desequilíbrio Estatístico
 * Calcula distribuição PAR vs ÍMPAR nos últimos N ticks
 */
export function calcularDesequilibrio(ticks: Tick[], janela: number): {
  percentualPar: number;
  percentualImpar: number;
  desequilibrio: number;
  operacao: DigitParity | null;
} {
  const ultimos = ticks.slice(-janela);
  const pares = ultimos.filter(t => t.digit % 2 === 0).length;
  const impares = ultimos.filter(t => t.digit % 2 === 1).length;
  
  const percentualPar = pares / janela;
  const percentualImpar = impares / janela;
  
  // Determinar operação (operar no OPOSTO do desequilíbrio)
  let operacao: DigitParity | null = null;
  if (percentualPar > percentualImpar) {
    operacao = 'IMPAR'; // Desequilíbrio de PAR → operar ÍMPAR (reversão)
  } else if (percentualImpar > percentualPar) {
    operacao = 'PAR'; // Desequilíbrio de ÍMPAR → operar PAR (reversão)
  }
  // Se percentualPar === percentualImpar (50%/50%), operacao fica null
  
  return {
    percentualPar,
    percentualImpar,
    desequilibrio: Math.max(percentualPar, percentualImpar),
    operacao,
  };
}

/**
 * ANÁLISE 2: Sequências Repetidas
 * Detecta 5+ dígitos de mesma paridade consecutivos
 * Aumenta probabilidade de reversão → Bônus +12%
 */
export function analisarSequencias(ticks: Tick[]): {
  tamanho: number;
  paridade: DigitParity;
  bonus: number;
} {
  if (ticks.length === 0) {
    return { tamanho: 0, paridade: 'PAR', bonus: 0 };
  }
  
  let sequenciaAtual = 1;
  const ultimoTick = ticks[ticks.length - 1];
  const paridadeAtual: DigitParity = ultimoTick.digit % 2 === 0 ? 'PAR' : 'IMPAR';
  
  // Contar quantos ticks consecutivos têm a mesma paridade
  for (let i = ticks.length - 2; i >= 0; i--) {
    const paridadeTick: DigitParity = ticks[i].digit % 2 === 0 ? 'PAR' : 'IMPAR';
    if (paridadeTick === paridadeAtual) {
      sequenciaAtual++;
    } else {
      break;
    }
  }
  
  return {
    tamanho: sequenciaAtual,
    paridade: paridadeAtual,
    bonus: sequenciaAtual >= 5 ? 12 : 0, // Bônus +12% se sequência ≥ 5
  };
}

/**
 * ANÁLISE 3: Micro-Tendências
 * Compara desequilíbrio dos últimos 10 vs últimos 20 ticks
 * Detecta aceleração do desequilíbrio → Bônus +8% se aceleração > 10%
 */
export function analisarMicroTendencias(ticks: Tick[]): {
  aceleracao: number;
  bonus: number;
} {
  if (ticks.length < 20) {
    return { aceleracao: 0, bonus: 0 };
  }
  
  const deseq10 = calcularDesequilibrio(ticks.slice(-10), 10).desequilibrio;
  const deseq20 = calcularDesequilibrio(ticks.slice(-20), 20).desequilibrio;
  
  const aceleracao = Math.abs(deseq10 - deseq20);
  
  return {
    aceleracao,
    bonus: aceleracao > 0.10 ? 8 : 0, // Bônus +8% se aceleração > 10%
  };
}

/**
 * ANÁLISE 4: Força do Desequilíbrio
 * Mede velocidade de crescimento do desequilíbrio
 * Detecta desequilíbrio crescendo rapidamente → Bônus +10% se velocidade > 5%
 */
export function analisarForcaDesequilibrio(ticks: Tick[], janela: number): {
  velocidade: number;
  bonus: number;
} {
  if (ticks.length < janela + 1) {
    return { velocidade: 0, bonus: 0 };
  }
  
  const deseqAtual = calcularDesequilibrio(ticks, janela).desequilibrio;
  const deseqAnterior = calcularDesequilibrio(ticks.slice(0, -1), janela).desequilibrio;
  
  const velocidade = Math.abs(deseqAtual - deseqAnterior);
  
  return {
    velocidade,
    bonus: velocidade > 0.05 ? 10 : 0, // Bônus +10% se velocidade > 5%
  };
}

/**
 * SISTEMA DE CONFIANÇA INTEGRADO
 * Combina confiança base + bônus das análises complementares
 * Máximo: 95% (nunca 100% para evitar overconfidence)
 */
export function calcularConfiancaFinal(
  confiancaBase: number,
  bonusSequencias: number,
  bonusMicroTendencias: number,
  bonusForca: number,
): number {
  const confiancaTotal = confiancaBase + bonusSequencias + bonusMicroTendencias + bonusForca;
  return Math.min(95, confiancaTotal); // Máximo 95%
}

/**
 * GERADOR DE SINAL ZENIX v2.0
 * Integra todas as 4 análises complementares
 * Retorna sinal somente se todas as condições forem satisfeitas
 */
export function gerarSinalZenix(
  ticks: Tick[],
  config: ModeConfig,
  modo: string,
): SignalResult | null {
  // 1. Verificar amostra mínima
  if (ticks.length < config.amostraInicial) {
    return null;
  }
  
  // 2. ANÁLISE 1: Desequilíbrio Estatístico (Base)
  const analiseDeseq = calcularDesequilibrio(ticks, config.amostraInicial);
  
  // Verificar se atingiu limiar mínimo
  if (analiseDeseq.desequilibrio < config.desequilibrioMin) {
    return null; // Desequilíbrio insuficiente
  }
  
  // Se não há operação definida (50%/50%), não gerar sinal
  if (!analiseDeseq.operacao) {
    return null;
  }
  
  // Confiança base = desequilíbrio em % (ex: 70% → 70)
  const confiancaBase = analiseDeseq.desequilibrio * 100;
  
  // 3. ANÁLISE 2: Sequências Repetidas
  const analiseSeq = analisarSequencias(ticks);
  
  // 4. ANÁLISE 3: Micro-Tendências
  const analiseMicro = analisarMicroTendencias(ticks);
  
  // 5. ANÁLISE 4: Força do Desequilíbrio
  const analiseForca = analisarForcaDesequilibrio(ticks, config.amostraInicial);
  
  // 6. Calcular confiança final
  const confiancaFinal = calcularConfiancaFinal(
    confiancaBase,
    analiseSeq.bonus,
    analiseMicro.bonus,
    analiseForca.bonus,
  );
  
  // 7. Verificar confiança mínima do modo
  if (confiancaFinal < config.confianciaMin * 100) {
    return null; // Confiança insuficiente
  }
  
  // 8. Construir motivo detalhado
  const motivoParts: string[] = [];
  motivoParts.push(`Deseq: ${(analiseDeseq.desequilibrio * 100).toFixed(1)}% ${analiseDeseq.percentualPar > analiseDeseq.percentualImpar ? 'PAR' : 'ÍMPAR'}`);
  
  if (analiseSeq.bonus > 0) {
    motivoParts.push(`Seq: ${analiseSeq.tamanho} ${analiseSeq.paridade} (+${analiseSeq.bonus}%)`);
  }
  
  if (analiseMicro.bonus > 0) {
    motivoParts.push(`Micro: ${(analiseMicro.aceleracao * 100).toFixed(1)}% (+${analiseMicro.bonus}%)`);
  }
  
  if (analiseForca.bonus > 0) {
    motivoParts.push(`Força: ${(analiseForca.velocidade * 100).toFixed(1)}% (+${analiseForca.bonus}%)`);
  }
  
  // 9. Retornar sinal completo
  return {
    sinal: analiseDeseq.operacao,
    confianca: confiancaFinal,
    motivo: motivoParts.join(' | '),
    detalhes: {
      desequilibrio: analiseDeseq,
      sequencias: analiseSeq,
      microTendencias: analiseMicro,
      forca: analiseForca,
      confiancaBase,
      bonusTotal: analiseSeq.bonus + analiseMicro.bonus + analiseForca.bonus,
    },
  };
}

