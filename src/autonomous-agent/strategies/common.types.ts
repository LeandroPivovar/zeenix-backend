// ============================================
// TIPOS COMUNS PARA AGENTES AUTÔNOMOS
// ============================================

export type AutonomousAgentType = 'sentinel' | 'falcon' | 'orion' | 'zeus';

export interface AutonomousAgentConfig {
  userId: string;
  initialStake: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  derivToken: string;
  currency: string;
  symbol: string;
  initialBalance?: number;
  // Configurações específicas por agente
  [key: string]: any;
}

export interface AutonomousAgentState {
  userId: string;
  isActive: boolean;
  currentProfit: number;
  currentLoss: number;
  operationsCount: number;
  [key: string]: any;
}

export interface MarketAnalysis {
  probability: number;
  signal: 'CALL' | 'PUT' | 'DIGIT' | 'MATCH' | 'ODD' | 'EVEN' | null;
  payout: number;
  confidence: number;
  details?: any;
}

export interface TradeDecision {
  action: 'BUY' | 'WAIT' | 'STOP';
  stake?: number;
  contractType?: string;
  reason?: string;
  mode?: string;
}

// Interface base para agentes autônomos
export interface IAutonomousAgentStrategy {
  name: string;
  displayName: string;
  description: string;

  initialize(): Promise<void>;
  activateUser(userId: string, config: AutonomousAgentConfig): Promise<void>;
  deactivateUser(userId: string): Promise<void>;
  processAgent(userId: string, marketAnalysis: MarketAnalysis): Promise<TradeDecision>;
  onContractFinish(userId: string, result: { win: boolean; profit: number; contractId: string }): Promise<void>;
  getUserState(userId: string): Promise<AutonomousAgentState | null>;
  resetDailySession(userId: string): Promise<void>;
  isUserActive(userId: string): boolean;
}

