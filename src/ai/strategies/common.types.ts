import { DigitParity, Tick } from '../ai.service';

// Tipos comuns para estratégias
export type ModoMartingale = 'conservador' | 'moderado' | 'agressivo';
export type TradingMode = 'veloz' | 'moderado' | 'preciso';

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
export const VELOZ_CONFIG: ModeConfig = {
  amostraInicial: 10,
  intervaloTicks: 3,
  desequilibrioMin: 0.50,
  confianciaMin: 0.50,
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

