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

// ✅ ATLAS v3.5: Configurações para R_50 (Volatility 50)
// MODO VELOZ: 6 ticks, alvo 3000 ops/dia
export const ATLAS_VELOZ_CONFIG: ModeConfig = {
  amostraInicial: 6,
  intervaloSegundos: 4.8,
  desequilibrioMin: 0.0,
  confianciaMin: 0.0,
  taxaAcertoEsperada: 0.70,
  payout: 0.35,
  minStake: 0.35,
  betPercent: 0.005,
};

// MODO NORMAL: 10 ticks, alvo 1500 ops/dia
export const ATLAS_NORMAL_CONFIG: ModeConfig = {
  amostraInicial: 10,
  intervaloSegundos: 2.9,
  desequilibrioMin: 1.0,
  confianciaMin: 0.0,
  taxaAcertoEsperada: 0.70,
  payout: 0.35,
  minStake: 0.35,
  betPercent: 0.0075,
};

// MODO PRECISO: 15 ticks, alvo 700 ops/dia
export const ATLAS_PRECISO_CONFIG: ModeConfig = {
  amostraInicial: 15,
  intervaloSegundos: 1.8,
  desequilibrioMin: 1.0,
  confianciaMin: 0.0,
  taxaAcertoEsperada: 0.70,
  payout: 0.35,
  minStake: 0.35,
  betPercent: 0.01,
};

// Alias para compatibilidade
export const ATLAS_LENTO_CONFIG = ATLAS_PRECISO_CONFIG;

