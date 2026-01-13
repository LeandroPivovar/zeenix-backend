import { DigitParity, Tick } from '../ai.service';

// Tipos comuns para estratégias
export type ModoMartingale = 'conservador' | 'moderado' | 'agressivo';
export type TradingMode = 'veloz' | 'moderado' | 'preciso' | 'lenta';

// Configurações de modo
export interface ModeConfig {
  amostraInicial: number;
  intervaloTicks?: number;
  intervaloSegundos?: number;
  desequilibrioMin: number;
  confianciaMin: number;
  taxaAcertoEsperada: number;
  payout: number;
  minStake: number;
  betPercent: number;
}

// Resultado de sinal gerado
export interface SignalResult {
  sinal: DigitParity | null;
  confianca: number;
  motivo: string;
  detalhes: any;
}

// Interface base para estratégias
export interface IStrategy {
  name: string;
  initialize(): Promise<void>;
  processTick(tick: Tick, symbol?: string): Promise<void>;
  activateUser(userId: string, config: any): Promise<void>;
  deactivateUser(userId: string): Promise<void>;
  getUserState(userId: string): any;
}

// Configurações exportadas
// ✅ CORRIGIDO conforme documentação TRINITY:
// - Modo VELOZ: Amostra 10 ticks, intervalo 3 ticks, desequilíbrio ≥50%, confiança ≥50%
// - Modo NORMAL usa 60%/60% (definido em MODERADO_CONFIG)
export const VELOZ_CONFIG: ModeConfig = {
  amostraInicial: 10, // ✅ Documentação: 10 ticks para modo VELOZ
  intervaloTicks: 3,  // ✅ Documentação: 3 ticks entre operações
  desequilibrioMin: 0.50, // ✅ Documentação: ≥50% para modo VELOZ
  confianciaMin: 0.50,    // ✅ Documentação: ≥50% para modo VELOZ
  taxaAcertoEsperada: 0.67,
  payout: 0.95,
  minStake: 0.35,
  betPercent: 0.005,
};

export const MODERADO_CONFIG: ModeConfig = {
  amostraInicial: 20,
  intervaloSegundos: 17,
  desequilibrioMin: 0.60,
  confianciaMin: 0.60,
  taxaAcertoEsperada: 0.76,
  payout: 0.95,
  minStake: 0.35,
  betPercent: 0.0075,
};

export const PRECISO_CONFIG: ModeConfig = {
  amostraInicial: 50,
  desequilibrioMin: 0.70,
  confianciaMin: 0.70,
  taxaAcertoEsperada: 0.82,
  payout: 0.95,
  minStake: 0.35,
  betPercent: 0.01,
};

export const LENTA_CONFIG: ModeConfig = {
  amostraInicial: 50,
  intervaloTicks: 5, // ✅ Adicionado intervalo de 5 ticks entre operações para modo Lenta
  desequilibrioMin: 0.70,
  confianciaMin: 0.80, // ✅ Modo lenta requer 80% de confiança (conforme documentação)
  taxaAcertoEsperada: 0.85,
  payout: 0.95,
  minStake: 0.35,
  betPercent: 0.01,
};

// ✅ ATLAS v2.0: Configurações para Extrema Alta Frequência (EHF)
// Modo VELOZ: 3.000 ops/dia (~125 ops/minuto), intervalo 4.8s, sem loss virtual
export const ATLAS_VELOZ_CONFIG: ModeConfig = {
  amostraInicial: 3, // Buffer mínimo de 3 dígitos
  intervaloSegundos: 4.8, // Uma operação a cada ~4.8 segundos
  desequilibrioMin: 0.0, // Sem filtro de desequilíbrio mínimo (análise simplificada)
  confianciaMin: 0.0, // Sem filtro de confiança mínimo
  taxaAcertoEsperada: 0.55, // 55-60% (compensado pelo volume)
  payout: 0.63,
  minStake: 0.35,
  betPercent: 0.005,
};

// Modo NORMAL: 5.000 ops/dia (~208 ops/minuto), intervalo 2.9s, máximo 1 derrota virtual
// DOCUMENTAÇÃO: Verifica últimos 5 dígitos. Se ratio > 0.8 (4 ou 5 > 3), aguarda.
export const ATLAS_NORMAL_CONFIG: ModeConfig = {
  amostraInicial: 5, // Buffer de 5 dígitos para análise de desequilíbrio
  intervaloSegundos: 2.9, // Uma operação a cada ~2.9 segundos
  desequilibrioMin: 0.8, // Filtro: se >80% Over (>3), aguarda
  confianciaMin: 0.0,
  taxaAcertoEsperada: 0.60, // 60-65%
  payout: 0.63,
  minStake: 0.35,
  betPercent: 0.0075,
};

// Modo LENTO: 8.000 ops/dia (~333 ops/minuto), intervalo 1.8s, máximo 2 derrotas virtuais
// DOCUMENTAÇÃO: Verifica últimos 10 dígitos. Se ratio > 0.7, aguarda.
export const ATLAS_LENTO_CONFIG: ModeConfig = {
  amostraInicial: 10, // Buffer de 10 dígitos para análise mais profunda
  intervaloSegundos: 1.8, // Uma operação a cada ~1.8 segundos
  desequilibrioMin: 0.7, // Filtro: se >70% Over, aguarda
  confianciaMin: 0.0,
  taxaAcertoEsperada: 0.62, // 62-67%
  payout: 0.63,
  minStake: 0.35,
  betPercent: 0.01,
};

