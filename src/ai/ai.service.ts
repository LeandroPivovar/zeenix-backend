import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import WebSocket from 'ws';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { StatsIAsService } from './stats-ias.service';

import { StrategyManagerService } from './strategies/strategy-manager.service';
import { LogQueueService } from '../utils/log-queue.service';
import { AutonomousAgentService } from '../autonomous-agent/autonomous-agent.service';
import { getMinStakeByCurrency, formatCurrency } from '../utils/currency.utils';

export type DigitParity = 'PAR' | 'IMPAR';

export interface Tick {
  value: number;
  epoch: number;
  timestamp: string;
  digit: number;
  parity: DigitParity;
}

interface VelozUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
  modoMartingale: ModoMartingale;
  perdaAcumulada: number;
  apostaInicial: number;
  lastOperationTickIndex: number; // ✅ ZENIX v2.0: Controle de intervalo (3 ticks) - DEPRECATED, usar ticksDesdeUltimaOp
  ticksDesdeUltimaOp: number; // ✅ ZENIX v2.0: Contador de ticks desde última operação (mais confiável)
  vitoriasConsecutivas: number; // ✅ ZENIX v2.0: Estratégia Soros - rastrear vitórias consecutivas (0, 1, 2)
  apostaBase: number; // ✅ ZENIX v2.0: Valor base da aposta (para Soros)
  ultimoLucro: number; // ✅ ZENIX v2.0: Lucro da última entrada (para calcular Soros)
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
}

interface ModeradoUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
  modoMartingale: ModoMartingale;
  perdaAcumulada: number;
  apostaInicial: number;
  lastOperationTimestamp: Date | null; // ✅ ZENIX v2.0: Controle de intervalo (15-20 segundos)
  vitoriasConsecutivas: number; // ✅ ZENIX v2.0: Estratégia Soros - rastrear vitórias consecutivas (0, 1, 2)
  apostaBase: number; // ✅ ZENIX v2.0: Valor base da aposta (para Soros)
  ultimoLucro: number; // ✅ ZENIX v2.0: Lucro da última entrada (para calcular Soros)
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
}

interface PrecisoUserState {
  userId: string;
  derivToken: string;
  currency: string;
  capital: number;
  virtualCapital: number;
  lossVirtualActive: boolean;
  lossVirtualCount: number;
  lossVirtualOperation: DigitParity | null;
  isOperationActive: boolean;
  martingaleStep: number;
  modoMartingale: ModoMartingale;
  perdaAcumulada: number;
  apostaInicial: number;
  // ✅ ZENIX v2.0: PRECISO não tem intervalo fixo (baseado em qualidade)
  vitoriasConsecutivas: number; // ✅ ZENIX v2.0: Estratégia Soros - rastrear vitórias consecutivas (0, 1, 2)
  apostaBase: number; // ✅ ZENIX v2.0: Valor base da aposta (para Soros)
  ultimoLucro: number; // ✅ ZENIX v2.0: Lucro da última entrada (para calcular Soros)
  ultimaDirecaoMartingale: DigitParity | null; // ✅ CORREÇÃO: Direção da última operação quando em martingale
  totalProfitLoss: number; // Lucro/prejuízo total acumulado
}

interface DigitTradeResult {
  profitLoss: number;
  status: 'WON' | 'LOST';
  exitPrice: number;
  contractId: string;
}

// ============================================
// ESTRATÉGIA ZENIX v2.0 - CONFIGURAÇÕES
// ============================================

const VELOZ_CONFIG = {
  amostraInicial: 10, // 10 ticks (~10 segundos) - Início rápido
  intervaloTicks: 3, // Gerar sinal a cada 3 ticks (~3 segundos)
  desequilibrioMin: 0.50, // 50% mínimo para gerar sinal (relaxado)
  confianciaMin: 0.50, // 50% confiança mínima (relaxado)
  taxaAcertoEsperada: 0.67, // Taxa esperada: 65-70%
  payout: 0.95, // Payout Deriv (95% com spread)
  minStake: 0.35, // Valor mínimo permitido pela Deriv
  betPercent: 0.005, // 0.5% do capital por operação
  // Compatibilidade com código legado
  window: 10,
  dvxMax: 70,
  lossVirtualTarget: 0,
  martingaleMax: 5,
};

const MODERADO_CONFIG = {
  amostraInicial: 20, // 20 ticks (~20 segundos) - Equilíbrio
  intervaloSegundos: 17, // Gerar sinal a cada 15-20 segundos
  desequilibrioMin: 0.60, // 60% mínimo para gerar sinal (balanceado)
  confianciaMin: 0.60, // 60% confiança mínima (balanceado)
  taxaAcertoEsperada: 0.76, // Taxa esperada: 75-77%
  payout: 0.95, // Payout Deriv (95% com spread)
  minStake: 0.35, // Valor mínimo permitido pela Deriv
  betPercent: 0.0075, // 0.75% do capital por operação
  trendWindow: 20, // Janela para análise de micro-tendências
  anomalyWindow: 10, // Janela para detecção de anomalias
  // Compatibilidade com código legado
  window: 20,
  dvxMax: 60,
  lossVirtualTarget: 0,
  martingaleMax: 3,
  desequilibrioPercent: 0.60,
  trendPercent: 0.60,
  anomalyAlternationMin: 6,
  anomalyRepetitionMin: 6,
  anomalyHomogeneityMin: 8,
  minTicks: 20,
};

const PRECISO_CONFIG = {
  amostraInicial: 50, // 50 ticks (~50 segundos) - Máxima precisão
  intervaloSegundos: null, // Sem intervalo fixo (baseado em qualidade)
  desequilibrioMin: 0.70, // 70% mínimo para gerar sinal (rigoroso)
  confianciaMin: 0.70, // 70% confiança mínima (rigoroso)
  taxaAcertoEsperada: 0.82, // Taxa esperada: 80-85%
  payout: 0.95, // Payout Deriv (95% com spread)
  minStake: 0.35, // Valor mínimo permitido pela Deriv
  betPercent: 0.01, // 1.0% do capital por operação
  trendWindow: 20, // Janela para análise de micro-tendências
  anomalyWindow: 10, // Janela para detecção de anomalias
  // Compatibilidade com código legado
  window: 50,
  dvxMax: 50,
  lossVirtualTarget: 0,
  martingaleMax: 4,
  desequilibrioPercent: 0.70,
  trendPercent: 0.60,
  anomalyAlternationMin: 6,
  anomalyRepetitionMin: 6,
  anomalyHomogeneityMin: 8,
  minTicks: 50,
};

// Compatibilidade com código legado (alias para VELOZ_CONFIG)
const FAST_MODE_CONFIG = VELOZ_CONFIG;

// ============================================
// SISTEMA UNIFICADO DE MARTINGALE - ZENIX v2.0
// ============================================
type ModoMartingale = 'conservador' | 'moderado' | 'agressivo';

interface ConfigMartingale {
  maxEntradas: number;
}

export const CONFIGS_MARTINGALE: Record<ModoMartingale, ConfigMartingale> = {
  conservador: {
    maxEntradas: 5, // ✅ ZENIX v2.0: Até 5ª entrada, depois reseta
  },
  moderado: {
    maxEntradas: Infinity, // ✅ ZENIX v2.0: Infinito até recuperar
  },
  agressivo: {
    maxEntradas: Infinity, // ✅ ZENIX v2.0: Infinito até recuperar + lucro
  },
};

const MARKUP_ZENIX = 3; // Markup fixo em pontos percentuais

// ============================================
// ESTRATÉGIA SOROS - ZENIX v2.0 CORRIGIDO
// ============================================
const SOROS_MAX_NIVEL = 2; // Soros tem apenas 2 níveis (entrada 1, 2, 3)

/**
 * Calcula aposta com estratégia Soros aplicada
 * Soros funciona apenas até o nível 2 (3 entradas):
 * - Entrada 1: valor inicial
 * - Entrada 2 (Soros Nível 1): entrada anterior + lucro da entrada anterior
 * - Entrada 3 (Soros Nível 2): entrada anterior + lucro da entrada anterior
 * 
 * @param entradaAnterior - Valor da entrada anterior
 * @param lucroAnterior - Lucro obtido na entrada anterior
 * @param vitoriasConsecutivas - Número de vitórias consecutivas (0, 1, ou 2)
 * @returns Valor da aposta com Soros aplicado, ou null se Soros não deve ser aplicado
 */
function calcularApostaComSoros(
  entradaAnterior: number,
  lucroAnterior: number,
  vitoriasConsecutivas: number,
): number | null {
  // Soros só funciona até o nível 2 (vitoriasConsecutivas = 0, 1, ou 2)
  if (vitoriasConsecutivas <= 0 || vitoriasConsecutivas > SOROS_MAX_NIVEL) {
    return null; // Não está no Soros ou já passou do limite
  }

  // Soros: entrada anterior + lucro anterior
  const apostaComSoros = entradaAnterior + lucroAnterior;

  // Arredondar para 2 casas decimais
  return Math.round(apostaComSoros * 100) / 100;
}

/**
 * Calcula a próxima aposta baseado no modo de martingale - ZENIX v2.0 CORRIGIDO
 * 
 * Fórmula geral: entrada_próxima = meta_de_recuperação × 100 / payout_cliente
 * 
 * CONSERVADOR: meta = perdas_totais (break-even)
 * MODERADO:    meta = perdas_totais × 1,25 (100% das perdas + 25% de lucro)
 * AGRESSIVO:   meta = perdas_totais × 1,50 (100% das perdas + 50% de lucro)
 * 
 * @param perdasTotais - Total de perdas acumuladas no martingale
 * @param modo - Modo de martingale (conservador/moderado/agressivo)
 * @param payoutCliente - Payout do cliente (payout_original - 3)
 * @returns Valor da próxima aposta calculada
 */
function calcularProximaAposta(
  perdasTotais: number,
  modo: ModoMartingale,
  payoutCliente: number,
): number {
  let metaRecuperacao = 0;

  switch (modo) {
    case 'conservador':
      // Meta: recuperar 100% das perdas (break-even)
      metaRecuperacao = perdasTotais;
      break;
    case 'moderado':
      // Meta: recuperar 100% das perdas + 25% de lucro
      metaRecuperacao = perdasTotais * 1.25;
      break;
    case 'agressivo':
      // Meta: recuperar 100% das perdas + 50% de lucro
      metaRecuperacao = perdasTotais * 1.50;
      break;
  }

  // Fórmula: entrada_próxima = meta_de_recuperação × 100 / payout_cliente
  const aposta = (metaRecuperacao * 100) / payoutCliente;

  return Math.round(aposta * 100) / 100; // 2 casas decimais
}

// ============================================
// ANÁLISES COMPLEMENTARES - ZENIX v2.0
// ============================================

/**
 * ANÁLISE 1: Desequilíbrio Estatístico (Base)
 * Calcula % de PAR vs ÍMPAR na janela
 * Identifica quando há desequilíbrio significativo para reversão à média
 */
function calcularDesequilibrio(ticks: Tick[], janela: number): {
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
function analisarSequencias(ticks: Tick[]): {
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
function analisarMicroTendencias(ticks: Tick[]): {
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
function analisarForcaDesequilibrio(ticks: Tick[], janela: number): {
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
function calcularConfiancaFinal(
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
function gerarSinalZenix(
  ticks: Tick[],
  config: typeof VELOZ_CONFIG | typeof MODERADO_CONFIG | typeof PRECISO_CONFIG,
  modo: string,
): {
  sinal: DigitParity | null;
  confianca: number;
  motivo: string;
  detalhes: any;
} | null {
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

// ============================================
// CACHE DE CONFIGURAÇÃO - OTIMIZAÇÃO PERFORMANCE
// ============================================
interface CachedUserConfig {
  sessionBalance: number;
  profitTarget: number | null;
  lossLimit: number | null;
  sessionStatus: string | null;
  isActive: boolean;
  lastUpdate: number;
}

@Injectable()
export class AiService implements OnModuleInit {
  // Cache de configuração de usuários (TTL: 1 segundo)
  private userConfigCache = new Map<string, CachedUserConfig>();
  private readonly CONFIG_CACHE_TTL = 1000; // 1 segundo
  private readonly logger = new Logger(AiService.name);
  private ws: WebSocket.WebSocket | null = null;
  private ticks: Tick[] = [];
  private maxTicks = 100; // Armazena os últimos 100 preços (suficiente para análise)
  private appId: string;
  private symbol = 'R_100';
  private isConnected = false;
  private subscriptionId: string | null = null;
  private subscriptionIds = new Map<string, string>(); // Mapeia símbolo para subscriptionId
  private keepAliveInterval: NodeJS.Timeout | null = null; // ✅ Keep-alive para evitar expiração (2 min inatividade)
  private hasReceivedAlreadySubscribed = false; // ✅ Flag para indicar que já recebemos erro "already subscribed"
  private lastAlreadySubscribedTime: number = 0; // ✅ Timestamp da última vez que recebemos "already subscribed"
  private lastTickReceivedTime: number = 0; // ✅ Timestamp do último tick recebido
  private websocketReconnectAttempts: number = 0; // ✅ Contador de tentativas de reconexão
  private isRecreating = false; // ✅ Lock para evitar múltiplas recriações simultâneas
  private velozUsers = new Map<string, VelozUserState>();
  private moderadoUsers = new Map<string, ModeradoUserState>();
  private precisoUsers = new Map<string, PrecisoUserState>();
  private userSessionIds = new Map<string, string>(); // Mapeia userId para sessionId único

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private readonly statsIAsService: StatsIAsService,
    @Inject(forwardRef(() => StrategyManagerService))
    private readonly strategyManager?: StrategyManagerService, // ✅ Injetar StrategyManager
    @Inject(forwardRef(() => AutonomousAgentService))
    private readonly autonomousAgentService?: AutonomousAgentService, // ✅ Injetar AutonomousAgentService para compartilhar ticks
    private readonly logQueueService?: LogQueueService, // ✅ Serviço centralizado de logs
  ) {
    this.appId = process.env.DERIV_APP_ID || '111346';
  }

  async onModuleInit() {
    this.logger.log('🚀 Inicializando AiService...');

    // ✅ LIMPEZA DE ESTADO PÓS-RESTART
    // Garante que o banco reflita que não há sessões ativas na memória (pois o processo reiniciou)
    try {
      this.logger.log('🧹 Realizando limpeza de cache e estados persistentes...');

      // 1. Desativar IAs que estavam marcadas como ativas
      await this.dataSource.query(
        `UPDATE ai_user_config 
         SET is_active = 0, session_status = 'stopped_server_restart', deactivated_at = NOW(), deactivation_reason = 'Server Restart'
         WHERE is_active = 1`
      );

      // 2. Marcar trades pendentes como erro (pois conexão websocket foi perdida)
      await this.dataSource.query(
        `UPDATE ai_trades 
         SET status = 'ERROR', error_message = 'Server Restart - Connection Lost', closed_at = NOW() 
         WHERE status = 'PENDING'`
      );

      // 3. Encerrar sessões de copy trading ativas
      await this.dataSource.query(
        `UPDATE copy_trading_sessions 
         SET status = 'stopped', end_time = NOW()
         WHERE status = 'active'`
      );

      this.logger.log('✅ Limpeza de estados concluída com sucesso.');
    } catch (cleanupError) {
      this.logger.error('❌ Erro na limpeza de inicialização:', cleanupError);
    }

    try {
      // Inicializar tabelas da IA - REMOVIDO: Agora gerenciado pelo StrategyManager
      // await this.initializeTables();
      // this.logger.log('✅ Tabelas da IA inicializadas com sucesso');

      // Inicializar conexão WebSocket
      this.logger.log('🔌 Inicializando conexão WebSocket com Deriv API...');
      try {
        await this.initialize();
        this.logger.log('✅ Conexão WebSocket estabelecida com sucesso');
        // ✅ Sincronizar usuários ativos
        // ✅ Sincronizar usuários ativos - REMOVIDO: Agora gerenciado pelo StrategyManager
        // this.logger.log('🔄 Sincronizando usuários ativos...');
        // await this.syncAtlasUsersFromDb().catch(e => this.logger.error('Erro ao sincronizar Atlas:', e));
      } catch (error) {
        this.logger.error('❌ Erro ao inicializar WebSocket:', error.message);
      }
    } catch (error) {
      this.logger.error('❌ Erro ao inicializar tabelas da IA:', error.message);
    }
  }

  async initialize() {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.log('✅ Já está conectado ao Deriv API');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.logger.log(`🔌 Inicializando conexão com Deriv API (app_id: ${this.appId})...`);

      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      this.ws = new WebSocket.WebSocket(endpoint);

      this.ws.on('open', async () => {
        this.logger.log('✅ Conexão WebSocket aberta com sucesso');
        this.isConnected = true;

        // ✅ Salvar estado da nova conexão
        await this.saveWebSocketState();

        this.subscribeToTicks();
        // ✅ Subscritar também R_10, R_25, 1HZ10V (Vol 10 1s) e 1HZ100V (Vol 100 1s) para Atlas/Orion/Apollo
        this.subscribeToSymbol('R_10');
        this.subscribeToSymbol('R_25');
        this.subscribeToSymbol('1HZ10V');
        this.subscribeToSymbol('1HZ100V');
        // ✅ Iniciar keep-alive (ping a cada 90 segundos para evitar expiração de 2 minutos)
        this.startKeepAlive();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error('Erro no WebSocket:', error.message);
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.log('Conexão WebSocket fechada');
        this.isConnected = false;
        this.stopKeepAlive();
        this.ws = null;
      });

      // Timeout de 10 segundos
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Timeout ao conectar com Deriv API'));
        }
      }, 10000);
    });
  }

  private subscribeToTicks() {
    this.logger.log(`📡 Inscrevendo-se nos ticks de ${this.symbol}...`);
    const subscriptionPayload = {
      ticks_history: this.symbol,
      adjust_start_time: 1,
      count: this.maxTicks,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    };
    this.logger.debug(`[subscribeToTicks] 📤 Payload da subscription: ${JSON.stringify(subscriptionPayload)}`);
    this.send(subscriptionPayload);
    this.logger.log(`✅ Requisição de inscrição enviada para ${this.symbol}`);
  }

  /**
   * ✅ Subscritar a um símbolo específico (R_10, R_25)
   */
  private subscribeToSymbol(symbol: string) {
    this.logger.log(`📡 Inscrevendo-se nos ticks de ${symbol}...`);
    const subscriptionPayload = {
      ticks_history: symbol,
      adjust_start_time: 1,
      count: this.maxTicks,
      end: 'latest',
      subscribe: 1,
      style: 'ticks',
    };
    this.logger.debug(`[subscribeToSymbol] 📤 Payload da subscription: ${JSON.stringify(subscriptionPayload)}`);
    this.send(subscriptionPayload);
    this.logger.log(`✅ Requisição de inscrição enviada para ${symbol}`);
  }

  /**
   * ✅ Cancela uma subscription usando o comando forget
   */
  private cancelSubscription(subscriptionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[cancelSubscription] ⚠️ WebSocket não está aberto, não é possível cancelar subscription ${subscriptionId}`);
      return;
    }

    try {
      const forgetPayload = { forget: subscriptionId };
      this.ws.send(JSON.stringify(forgetPayload));
      this.logger.log(`[cancelSubscription] ✅ Comando forget enviado para subscription ${subscriptionId}`);
    } catch (error) {
      this.logger.error(`[cancelSubscription] ❌ Erro ao cancelar subscription ${subscriptionId}:`, error);
    }
  }

  /**
   * ✅ Keep-alive: Envia ping a cada 90 segundos para evitar expiração (sessão expira após 2 min de inatividade)
   */
  private startKeepAlive(): void {
    this.stopKeepAlive(); // Garantir que não há intervalo duplicado

    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ ping: 1 }));
          this.logger.debug('[KeepAlive] Ping enviado para manter conexão ativa');
        } catch (error) {
          this.logger.error('[KeepAlive] Erro ao enviar ping:', error);
        }
      } else {
        this.logger.warn('[KeepAlive] WebSocket não está aberto, parando keep-alive');
        this.stopKeepAlive();
      }
    }, 90000); // 90 segundos (menos de 2 minutos)

    this.logger.log('✅ Keep-alive iniciado (ping a cada 90s)');
  }

  /**
   * ✅ Para o keep-alive
   */
  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      this.logger.debug('[KeepAlive] Keep-alive parado');
    }
  }



  // ======================== TRINITY REMOVIDO ========================

  private handleMessage(msg: any) {
    // ✅ Log de todas as mensagens recebidas para diagnóstico
    if (msg.msg_type) {
      this.logger.debug(`[AiService] 📥 Mensagem recebida: msg_type=${msg.msg_type} | subscription=${msg.subscription?.id || 'N/A'}`);

      // ✅ Log detalhado para mensagens de tick_history que podem conter subscription ID
      if (msg.msg_type === 'ticks_history' || msg.msg_type === 'tick') {
        this.logger.debug(`[AiService] 📊 Estrutura da mensagem ${msg.msg_type}: subscription=${JSON.stringify(msg.subscription)}, subscription_id=${msg.subscription_id}, id=${msg.id}`);
      }
    }

    // ✅ Tentar capturar subscription ID mesmo em mensagens de erro
    if (msg.subscription?.id) {
      if (this.subscriptionId !== msg.subscription.id) {
        this.subscriptionId = msg.subscription.id;
        this.hasReceivedAlreadySubscribed = false; // ✅ Resetar flag quando subscriptionId for capturado
        this.logger.log(`[AiService] 📋 Subscription ID capturado de mensagem: ${this.subscriptionId}`);
      }
    }

    if (msg.error) {
      const errorMsg = msg.error.message || JSON.stringify(msg.error);
      this.logger.error('❌ Erro da API:', errorMsg);

      // ✅ Se o erro é genérico, recriar WebSocket imediatamente (provavelmente após restart do servidor)
      if (errorMsg.includes('Sorry, an error occurred') || errorMsg.includes('error occurred while processing')) {
        this.logger.warn(`[AiService] ⚠️ Erro genérico da API detectado - Recriando WebSocket imediatamente...`);
        // Cancelar subscription antiga se existir
        if (this.subscriptionId) {
          this.logger.log(`[AiService] 🔄 Cancelando subscription antiga: ${this.subscriptionId}`);
          this.cancelSubscription(this.subscriptionId);
        }
        this.recreateWebSocket().catch((error) => {
          this.logger.error(`[AiService] ❌ Erro ao recriar WebSocket:`, error);
        });
        return;
      }

      // ✅ Se o erro é "You are already subscribed", significa que há uma subscription ativa
      // Tentar extrair o subscription ID da mensagem de erro ou da mensagem completa
      if (errorMsg.includes('already subscribed')) {
        this.logger.warn(`[AiService] ⚠️ Subscription já existe, mas subscriptionId não foi capturado. Tentando extrair...`);
        this.logger.debug(`[AiService] 📊 Estrutura completa da mensagem de erro: ${JSON.stringify(msg, null, 2)}`);

        // Tentar extrair subscription ID de vários lugares possíveis
        const possibleSubId = msg.subscription?.id ||
          msg.subscription_id ||
          msg.id ||
          msg.echo_req?.req_id ||
          msg.req_id;

        if (possibleSubId) {
          this.subscriptionId = possibleSubId;
          this.hasReceivedAlreadySubscribed = false; // ✅ Resetar flag quando subscriptionId for capturado
          this.logger.log(`[AiService] 📋 Subscription ID capturado do erro: ${this.subscriptionId}`);
        } else {
          // Se não conseguimos capturar o ID, mas sabemos que há uma subscription ativa,
          // recriar WebSocket imediatamente (provavelmente após restart do servidor)
          this.logger.warn(`[AiService] ⚠️ Não foi possível extrair subscription ID do erro "already subscribed".`);
          this.logger.warn(`[AiService] ⚠️ Recriando WebSocket para limpar subscription antiga...`);

          // Recriar WebSocket imediatamente para limpar estado
          this.recreateWebSocket().catch((error) => {
            this.logger.error(`[AiService] ❌ Erro ao recriar WebSocket:`, error);
          });
        }
      }
      return;
    }

    switch (msg.msg_type) {
      case 'history':
        this.logger.log(`[AiService] 📊 Histórico recebido: ${msg.history?.prices?.length || 0} preços`);
        this.processHistory(msg.history, msg.subscription?.id);
        break;

      case 'ticks_history':
        // ✅ Processar resposta da subscription de ticks
        this.logger.log(`[AiService] 📊 Resposta de ticks_history recebida`);
        this.logger.debug(`[AiService] 📊 Estrutura completa da mensagem: ${JSON.stringify(Object.keys(msg))}`);
        this.logger.debug(`[AiService] 📊 Conteúdo completo da mensagem: ${JSON.stringify(msg, null, 2)}`);

        // Capturar subscription ID (pode estar em diferentes lugares)
        const subId = msg.subscription?.id || msg.subscription_id || msg.id || msg.echo_req?.req_id;
        // ✅ Tentar identificar o símbolo pelo echo_req
        const symbolFromReq = msg.echo_req?.ticks_history || msg.echo_req?.subscribe?.ticks_history;
        if (subId) {
          // Se for R_100, atualizar subscriptionId principal
          if (!symbolFromReq || symbolFromReq === 'R_100') {
            this.subscriptionId = subId;
            this.hasReceivedAlreadySubscribed = false;
            this.logger.log(`[AiService] 📋 Subscription ID capturado: ${this.subscriptionId}`);
          }
          // Mapear subscriptionId para símbolo
          if (symbolFromReq && ['R_10', 'R_25', 'R_100', '1HZ10V', '1HZ100V'].includes(symbolFromReq)) {
            this.subscriptionIds.set(symbolFromReq, subId);
            this.logger.log(`[AiService] 📋 Subscription ID ${subId} mapeado para símbolo ${symbolFromReq}`);
          }
        } else {
          this.logger.warn(`[AiService] ⚠️ Subscription ID não encontrado na mensagem ticks_history`);
          this.logger.warn(`[AiService] ⚠️ Tentando extrair de outros campos: subscription=${JSON.stringify(msg.subscription)}, subscription_id=${msg.subscription_id}, id=${msg.id}, echo_req=${JSON.stringify(msg.echo_req)}`);
        }

        // Processar histórico se presente
        if (msg.history?.prices) {
          this.logger.log(`[AiService] 📊 Processando histórico da subscription: ${msg.history.prices.length} preços`);
          this.processHistory(msg.history, subId);
        } else if (msg.ticks_history) {
          // Se vier em formato diferente, processar também
          this.logger.log(`[AiService] 📊 Processando ticks_history em formato alternativo`);
          this.processHistory(msg.ticks_history, subId);
        } else {
          this.logger.warn(`[AiService] ⚠️ Mensagem ticks_history sem dados de histórico`);
        }
        break;

      case 'tick':
        // ✅ Tentar capturar subscription ID das mensagens de tick
        const tickSubId = msg.subscription?.id;
        if (tickSubId) {
          // Se for R_100, atualizar subscriptionId principal
          if (!this.subscriptionId || this.subscriptionId !== tickSubId) {
            this.subscriptionId = tickSubId;
            this.hasReceivedAlreadySubscribed = false;
            this.logger.log(`[AiService] 📋 Subscription ID capturado de mensagem tick: ${this.subscriptionId}`);
          }
        }
        // ✅ Identificar símbolo do tick (pode vir no tick ou na mensagem)
        const tickSymbol = msg.tick?.symbol || msg.symbol || this.identifySymbolFromSubscription(tickSubId) || this.symbol;
        this.logger.debug(`[AiService] 📊 Tick recebido: ${JSON.stringify(msg.tick)} | subscription=${tickSubId || 'N/A'} | symbol=${tickSymbol}`);
        this.processTick(msg.tick, tickSymbol);
        break;

      default:
        // ✅ Log de mensagens desconhecidas para diagnóstico
        if (msg.msg_type) {
          this.logger.debug(`[AiService] ⚠️ Mensagem desconhecida: msg_type=${msg.msg_type}`);
        }
        break;
    }
  }

  private processHistory(history: any, subscriptionId?: string) {
    if (!history || !history.prices) {
      this.logger.warn('⚠️ Histórico recebido sem dados de preços');
      return;
    }

    if (subscriptionId) {
      this.subscriptionId = subscriptionId;
      this.logger.log(`📋 Subscription ID recebido: ${subscriptionId}`);
    }

    this.logger.log(`📊 Processando histórico: ${history.prices?.length || 0} preços recebidos`);

    this.ticks = history.prices.map((price: string, index: number) => {
      const value = parseFloat(price);
      const digit = this.extractLastDigit(value);
      const parity = this.getParityFromDigit(digit);

      return {
        value,
        epoch: history.times ? history.times[index] : Date.now() / 1000,
        timestamp: history.times
          ? new Date(history.times[index] * 1000).toLocaleTimeString('pt-BR')
          : new Date().toLocaleTimeString('pt-BR'),
        digit,
        parity,
      };
    });

    this.logger.log(`✅ ${this.ticks.length} ticks carregados no histórico`);
  }

  private processTick(tick: any, symbol?: string) {
    if (!tick || !tick.quote) {
      this.logger.debug('⚠️ Tick recebido sem quote');
      return;
    }

    // ✅ Usar símbolo do tick ou o fornecido como parâmetro
    const tickSymbol = symbol || tick.symbol || this.symbol;

    const value = parseFloat(tick.quote);
    const digit = this.extractLastDigit(value);
    const parity = this.getParityFromDigit(digit);

    // ✅ DIAGNÓSTICO: Log de tick recebido para qualquer símbolo (limitado)
    if (tickSymbol === '1HZ100V' || tickSymbol === '1HZ10V' || this.ticks.length % 100 === 0) {
      this.logger.debug(`[AiService] 📊 Tick ${tickSymbol}: ${value} (digit: ${digit})`);
    }

    const newTick: Tick = {
      value,
      epoch: tick.epoch || Date.now() / 1000,
      timestamp: new Date(
        (tick.epoch || Date.now() / 1000) * 1000,
      ).toLocaleTimeString('pt-BR'),
      digit,
      parity,
    };

    // ✅ Manter ticks separados por símbolo (apenas para R_100 manter no array principal para compatibilidade)
    if (tickSymbol === 'R_100') {
      this.ticks.push(newTick);
      this.lastTickReceivedTime = Date.now();

      // Manter apenas os últimos maxTicks
      if (this.ticks.length > this.maxTicks) {
        this.ticks.shift();
      }

      // Log a cada 10 ticks para não poluir muito
      if (this.ticks.length % 10 === 0) {
        this.logger.debug(
          `[Tick] Total: ${this.ticks.length} | Último: valor=${newTick.value} | dígito=${digit} | paridade=${parity}`,
        );
      }
    }

    // ✅ Usar StrategyManager para processar tick em todas as estratégias (sem fallback legado)
    if (!this.strategyManager) {
      this.logger.error('[StrategyManager] Indisponível - tick ignorado');
      return;
    }

    // Log de diagnóstico a cada 50 ticks
    if (this.ticks.length % 50 === 0) {
      this.logger.debug(`[AiService] 🔄 Enviando tick para StrategyManager | Total ticks R_100: ${this.ticks.length} | Symbol: ${tickSymbol}`);
    }

    this.strategyManager.processTick(newTick, tickSymbol).catch((error) => {
      this.logger.error(`[StrategyManager] Erro ao processar tick (${tickSymbol}):`, error);
    });

    // ✅ Compartilhar tick de R_100 com AutonomousAgentService
    if (tickSymbol === 'R_100' && this.autonomousAgentService) {
      try {
        this.autonomousAgentService.receiveExternalTick(newTick, tickSymbol);
      } catch (error) {
        // Ignorar erros silenciosamente (pode não estar inicializado ainda)
      }
    }
  }

  /**
   * ✅ Identifica o símbolo baseado no subscriptionId (fallback)
   */
  private identifySymbolFromSubscription(subscriptionId: string | undefined): string | null {
    if (!subscriptionId) return null;
    // Se tiver mapeamento, usar
    for (const [symbol, subId] of this.subscriptionIds.entries()) {
      if (subId === subscriptionId) {
        return symbol;
      }
    }
    return null;
  }

  private extractLastDigit(value: number): number {
    const numeric = Math.abs(value);
    const normalized = numeric.toString().replace('.', '').replace('-', '');
    const lastChar = normalized.charAt(normalized.length - 1);
    const digit = parseInt(lastChar, 10);
    return Number.isNaN(digit) ? 0 : digit;
  }

  private getParityFromDigit(digit: number): DigitParity {
    return digit % 2 === 0 ? 'PAR' : 'IMPAR';
  }

  /**
   * ZENIX v2.0: Processamento de estratégia Veloz
   * - Amostra inicial: 10 ticks
   * - Intervalo entre operações: 3 ticks
   * - Desequilíbrio mínimo: 50%
   * - Confiança mínima: 50%
   */


  private calculateDVX(ticks: Tick[]): number {
    const relevantTicks = ticks.slice(-Math.min(100, ticks.length));
    if (relevantTicks.length === 0) {
      return 0;
    }

    const frequencies = new Array(10).fill(0);
    for (const item of relevantTicks) {
      const digit =
        typeof item.digit === 'number' ? item.digit : this.extractLastDigit(item.value);
      frequencies[digit]++;
    }

    const mean = relevantTicks.length / 10;
    if (mean === 0) {
      return 0;
    }

    let sumSquares = 0;
    for (const freq of frequencies) {
      sumSquares += Math.pow(freq - mean, 2);
    }

    const variance = sumSquares / 10;
    const dvx = Math.min(100, (variance / mean) * 10);
    return Math.round(dvx);
  }

  /**
   * Obtém configuração do usuário com cache (otimizado)
   */
  private async getCachedUserConfig(userId: string): Promise<CachedUserConfig | null> {
    const cached = this.userConfigCache.get(userId);
    const now = Date.now();

    // Se cache é válido (menos de 1 segundo), retornar
    if (cached && (now - cached.lastUpdate) < this.CONFIG_CACHE_TTL) {
      return cached;
    }

    // Buscar do banco e atualizar cache
    try {
      const configResult = await this.dataSource.query(
        `SELECT 
          session_status, 
          is_active,
          profit_target,
          loss_limit,
          COALESCE(session_balance, 0) as sessionBalance
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId],
      );

      if (!configResult || configResult.length === 0) {
        return null;
      }

      const config = configResult[0];
      const cachedConfig: CachedUserConfig = {
        sessionBalance: parseFloat(config.sessionBalance) || 0,
        profitTarget: config.profit_target ? parseFloat(config.profit_target) : null,
        lossLimit: config.loss_limit ? parseFloat(config.loss_limit) : null,
        sessionStatus: config.session_status || null,
        isActive: config.is_active === true || config.is_active === 1,
        lastUpdate: now,
      };

      this.userConfigCache.set(userId, cachedConfig);
      return cachedConfig;
    } catch (error) {
      this.logger.error(`[GetCachedUserConfig][${userId}] Erro:`, error);
      return null;
    }
  }

  /**
   * Invalida cache de configuração do usuário (chamar quando config mudar)
   */
  private invalidateUserConfigCache(userId: string): void {
    this.userConfigCache.delete(userId);
  }

  private async canProcessVelozState(state: VelozUserState): Promise<boolean> {
    if (state.isOperationActive) {
      this.logger.debug(
        `[Veloz][${state.userId}] Operação em andamento - aguardando finalização`,
      );
      return false;
    }
    if (!state.derivToken) {
      this.logger.warn(
        `[Veloz][${state.userId}] Usuário sem token Deriv configurado - ignorando`,
      );
      return false;
    }
    if ((state.virtualCapital || state.capital) <= 0) {
      this.logger.warn(
        `[Veloz][${state.userId}] Usuário sem capital configurado - ignorando`,
      );
      return false;
    }

    // ✅ OTIMIZAÇÃO: Usar cache em vez de consultar banco a cada tick
    const config = await this.getCachedUserConfig(state.userId);

    if (!config) {
      // Não há sessão ativa
      this.logger.warn(
        `[Veloz][${state.userId}] Nenhuma sessão ativa encontrada - não executando novos trades`,
      );
      return false;
    }

    // Verificar se já foi parada
    if (config.sessionStatus === 'stopped_profit' || config.sessionStatus === 'stopped_loss' || config.sessionStatus === 'stopped_blindado') {
      this.logger.warn(
        `[Veloz][${state.userId}] Sessão parada (${config.sessionStatus}) - não executando novos trades`,
      );
      return false;
    }

    // ✅ VERIFICAR LIMITES ANTES DE OPERAR
    // Se atingiu take profit (stop win)
    if (config.profitTarget && config.sessionBalance >= config.profitTarget) {
      this.logger.warn(
        `[Veloz][${state.userId}] 🎯 STOP WIN ATINGIDO! Saldo: ${formatCurrency(config.sessionBalance, state.currency)} >= Meta: ${formatCurrency(config.profitTarget, state.currency)} - PARANDO IMEDIATAMENTE`,
      );
      // Desativar imediatamente
      await this.checkAndEnforceLimits(state.userId);
      // Invalidar cache após mudança de configuração
      this.invalidateUserConfigCache(state.userId);
      return false;
    }

    // Se atingiu stop loss
    if (config.lossLimit && config.sessionBalance <= -config.lossLimit) {
      this.logger.warn(
        `[Veloz][${state.userId}] 🛑 STOP LOSS ATINGIDO! Saldo: -${formatCurrency(Math.abs(config.sessionBalance), state.currency)} >= Limite: ${formatCurrency(config.lossLimit, state.currency)} - PARANDO IMEDIATAMENTE`,
      );
      // Desativar imediatamente
      await this.checkAndEnforceLimits(state.userId);
      // Invalidar cache após mudança de configuração
      this.invalidateUserConfigCache(state.userId);
      return false;
    }

    return true;
  }

  private handleLossVirtualState(
    state: VelozUserState,
    proposal: DigitParity,
    tick: Tick,
    dvx: number,
  ) {
    if (!state.lossVirtualActive || state.lossVirtualOperation !== proposal) {
      state.lossVirtualActive = true;
      state.lossVirtualOperation = proposal;
      state.lossVirtualCount = 0;
      this.logger.debug(
        `[Veloz][${state.userId}] Iniciando ciclo de loss virtual para ${proposal}`,
      );
    }

    const simulatedWin = tick.parity === proposal;

    if (simulatedWin) {
      if (state.lossVirtualCount > 0) {
        this.logger.debug(
          `[Veloz][${state.userId}] Simulação venceria | Resetando contador`,
        );
      }
      state.lossVirtualCount = 0;
      return;
    }

    state.lossVirtualCount += 1;
    this.logger.log(
      `[Veloz][${state.userId}] Loss virtual ${state.lossVirtualCount}/${VELOZ_CONFIG.lossVirtualTarget} | tick=${tick.value} (${tick.parity}) | proposta=${proposal} | DVX=${dvx}`,
    );

    if (state.lossVirtualCount < VELOZ_CONFIG.lossVirtualTarget) {
      return;
    }

    state.lossVirtualActive = false;
    state.lossVirtualCount = 0;

    this.logger.log(
      `[Veloz][${state.userId}] ✅ Loss virtual completo -> executando operação ${proposal}`,
    );

    this.executeVelozOperation(state, proposal).catch((error) => {
      this.logger.error(
        `[Veloz] Erro ao executar operação para usuário ${state.userId}:`,
        error,
      );
    });
  }

  /**
   * Consulta payout via API e calcula payout_cliente
   * @param derivToken - Token de autenticação Deriv
   * @param currency - Moeda da operação
   * @param contractType - Tipo de contrato (DIGITEVEN ou DIGITODD)
   * @returns payout_cliente (payout_original - 3)
   */
  private async consultarPayoutCliente(
    derivToken: string,
    currency: string,
    contractType: 'DIGITEVEN' | 'DIGITODD',
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);
      let isCompleted = false;

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          ws.close();
          reject(new Error('Timeout ao consultar payout'));
        }
      }, 10000);

      const finalize = (error?: Error, payoutCliente?: number) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (e) { }
        if (error) {
          reject(error);
        } else {
          resolve(payoutCliente || 0);
        }
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: derivToken }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            finalize(new Error(msg.error.message || 'Erro ao consultar payout'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            // Enviar proposal para consultar payout (usar stake mínimo para consulta)
            ws.send(JSON.stringify({
              proposal: 1,
              amount: 1, // Stake mínimo para consulta
              basis: 'stake',
              contract_type: contractType,
              currency,
              duration: 1,
              duration_unit: 't',
              symbol: this.symbol,
            }));
            return;
          }

          if (msg.msg_type === 'proposal') {
            const proposal = msg.proposal;
            if (!proposal) {
              finalize(new Error('Proposta inválida'));
              return;
            }

            const askPrice = Number(proposal.ask_price || 1);
            const payoutAbsolute = Number(proposal.payout || 0);

            // Calcular payout percentual: (payout / ask_price - 1) × 100
            const payoutPercentual = askPrice > 0
              ? ((payoutAbsolute / askPrice - 1) * 100)
              : 0;

            // Calcular payout_cliente = payout_original - 3%
            const payoutCliente = payoutPercentual - MARKUP_ZENIX;

            if (payoutCliente <= 0) {
              finalize(new Error('Payout cliente inválido'));
              return;
            }

            this.logger.debug(
              `[ConsultarPayout] payout_original=${payoutPercentual.toFixed(2)}%, ` +
              `payout_cliente=${payoutCliente.toFixed(2)}%`,
            );

            finalize(undefined, payoutCliente);
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (error) => finalize(error));
      ws.on('close', () => {
        if (!isCompleted) {
          finalize(new Error('Conexão fechada antes de receber payout'));
        }
      });
    });
  }

  private async calculateVelozStake(state: VelozUserState, entry: number, proposal?: DigitParity): Promise<number> {
    // ✅ ZENIX v2.0: Soros funciona apenas até a entrada 3 (níveis 0, 1, 2)
    // Entrada 1: valor inicial
    // Entrada 2: Soros Nível 1 (entrada 1 + lucro entrada 1)
    // Entrada 3: Soros Nível 2 (entrada 2 + lucro entrada 2)
    // Entrada 4+: Martingale (recuperação)

    if (entry === 1) {
      // Primeira entrada: usar valor inicial
      if (state.apostaBase <= 0) {
        state.apostaBase = state.capital || getMinStakeByCurrency(state.currency);
      }
      return Math.max(getMinStakeByCurrency(state.currency), state.apostaBase); // ✅ Moeda dinâmica
    }

    if (entry === 2) {
      // Entrada 2: Soros Nível 1 (se entrada 1 foi vitoriosa)
      if (state.vitoriasConsecutivas === 1 && state.ultimoLucro > 0 && state.perdaAcumulada === 0) {
        const apostaComSoros = calcularApostaComSoros(
          state.apostaInicial || state.apostaBase,
          state.ultimoLucro,
          1, // Soros nível 1
        );

        if (apostaComSoros !== null) {
          return Math.max(getMinStakeByCurrency(state.currency), apostaComSoros); // ✅ Moeda dinâmica
        }
      }
      // Se não está no Soros, entrar em martingale
    }

    if (entry === 3) {
      // Entrada 3: Soros Nível 2 (se entrada 2 foi vitoriosa)
      if (state.vitoriasConsecutivas === 2 && state.ultimoLucro > 0 && state.perdaAcumulada === 0) {
        const apostaComSoros = calcularApostaComSoros(
          state.apostaInicial || state.apostaBase,
          state.ultimoLucro,
          2, // Soros nível 2
        );

        if (apostaComSoros !== null) {
          return Math.max(getMinStakeByCurrency(state.currency), apostaComSoros); // ✅ Moeda dinâmica
        }
      }
      // Se não está no Soros, entrar em martingale
    }

    // SISTEMA UNIFICADO DE MARTINGALE (para entradas > 3 ou se Soros falhou)
    // Consultar payout via API antes de calcular
    const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
    let payoutCliente = 92; // Valor padrão caso falhe a consulta (95 - 3)

    try {
      payoutCliente = await this.consultarPayoutCliente(
        state.derivToken,
        state.currency || 'USD',
        contractType,
      );
    } catch (error) {
      this.logger.warn(
        `[Veloz][Martingale] Erro ao consultar payout, usando padrão (92%): ${error.message}`,
      );
    }

    const proximaAposta = calcularProximaAposta(
      state.perdaAcumulada,
      state.modoMartingale,
      payoutCliente,
    );

    this.logger.debug(
      `[Veloz][Martingale ${state.modoMartingale.toUpperCase()}] ` +
      `Perdas totais: ${formatCurrency(state.perdaAcumulada, state.currency)} | ` +
      `Payout cliente: ${payoutCliente.toFixed(2)}% | ` +
      `Próxima aposta: ${formatCurrency(proximaAposta, state.currency)}`,
    );

    return Math.max(getMinStakeByCurrency(state.currency), proximaAposta); // ✅ Moeda dinâmica
  }


  private async executeVelozOperation(
    state: VelozUserState,
    proposal: DigitParity,
    entry: number = 1,
  ): Promise<DigitTradeResult> {
    const stakeAmount = await this.calculateVelozStake(state, entry, proposal);
    const currency = state.currency || 'USD'; // ZENIX v3.5: Fallback final seguro
    const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
    const derivToken = state.derivToken;

    // Criar registro inicial do trade
    const insertResult = await this.dataSource.query(
      `INSERT INTO ai_trades 
       (user_id, symbol, contract_type, stake_amount, status, strategy, started_at)
       VALUES (?, ?, ?, ?, 'PENDING', 'VELOZ', NOW())`,
      [state.userId, this.symbol, contractType, stakeAmount],
    );
    const tradeId = insertResult.insertId;

    this.logger.log(`[Veloz] Iniciando trade ${tradeId} | ${proposal} | ${formatCurrency(stakeAmount, state.currency)} | entrada=${entry}`);

    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);

      let contractId: string | null = null;
      let isCompleted = false;
      let proposalId: string | null = null;
      let proposalPrice: number = 0;

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          try {
            ws.close();
          } catch (e) { }
          reject(new Error('Timeout ao executar contrato dígito'));
        }
      }, 60000);

      const finalize = async (error?: Error, result?: DigitTradeResult) => {
        if (isCompleted) {
          return;
        }
        isCompleted = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (closeError) {
          this.logger.warn('Erro ao fechar WebSocket do modo veloz:', closeError);
        }
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        }
      };

      ws.on('open', () => {
        this.logger.log(
          `[Veloz] WS conectado para trade ${tradeId} | contrato=${contractType}`,
        );
        ws.send(JSON.stringify({ authorize: derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            await this.dataSource.query(
              'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
              ['ERROR', msg.error.message || 'Erro da Deriv', tradeId],
            );
            finalize(new Error(msg.error.message || 'Erro da Deriv'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            const proposalPayload = {
              proposal: 1,
              amount: stakeAmount,
              basis: 'stake',
              contract_type: contractType,
              currency,
              duration: 1,
              duration_unit: 't',
              symbol: this.symbol,
            };

            this.logger.log('[Veloz] Enviando proposal dígito', proposalPayload);
            ws.send(JSON.stringify(proposalPayload));
            return;
          }

          if (msg.msg_type === 'proposal') {
            const proposalResponse = msg.proposal;
            if (!proposalResponse || !proposalResponse.id) {
              finalize(new Error('Proposta inválida para contrato dígito'));
              return;
            }

            proposalId = proposalResponse.id;
            proposalPrice = Number(proposalResponse.ask_price);
            const payout = Number(proposalResponse.payout || 0);

            await this.dataSource.query(
              'UPDATE ai_trades SET payout = ? WHERE id = ?',
              [payout - stakeAmount, tradeId],
            );

            ws.send(
              JSON.stringify({
                buy: proposalId,
                price: proposalPrice,
              }),
            );
            return;
          }

          if (msg.msg_type === 'buy') {
            const buy = msg.buy;
            if (!buy || !buy.contract_id) {
              finalize(new Error('Compra de contrato dígito não confirmada'));
              return;
            }

            contractId = buy.contract_id;
            const buyPrice = Number(buy.buy_price);
            const entrySpot = Number(buy.entry_spot || this.getCurrentPrice() || 0);

            this.logger.log(
              `[Veloz] Atualizando entry_price | tradeId=${tradeId} | entrySpot=${entrySpot} | buy.entry_spot=${buy.entry_spot}`,
            );

            await this.dataSource.query(
              `UPDATE ai_trades 
               SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
               WHERE id = ?`,
              [contractId, entrySpot, tradeId],
            );

            this.logger.log(`[Veloz] ✅ entry_price atualizado no banco | tradeId=${tradeId} | entryPrice=${entrySpot}`);

            ws.send(
              JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1,
              }),
            );
            this.logger.log(
              `[Veloz] Compra confirmada | trade=${tradeId} | contrato=${contractId} | preço=${buyPrice}`,
            );
            return;
          }

          if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            if (!contract || contract.is_sold !== 1) {
              return;
            }

            const profit = Number(contract.profit || 0);
            const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
            const status = profit >= 0 ? 'WON' : 'LOST';

            this.logger.log(
              `[Veloz] Atualizando exit_price | tradeId=${tradeId} | exitPrice=${exitPrice} | profit=${profit} | status=${status}`,
            );

            await this.dataSource.query(
              `UPDATE ai_trades
               SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
               WHERE id = ?`,
              [exitPrice, profit, status, tradeId],
            );

            // Removido lógica de CopyTrading (vazio)

            finalize(undefined, {
              profitLoss: profit,
              status,
              exitPrice,
              contractId: contract.contract_id || contractId || '',
            });
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (error) => {
        finalize(error);
      });

      ws.on('close', () => {
        if (!isCompleted) {
          finalize(new Error('WebSocket do contrato dígito fechado inesperadamente'));
        }
      });
    });
  }

  /**
   * Helper genérico para executar operações de dígitos na Deriv
   */
  private async executeDigitTradeOnDeriv(params: {
    tradeId: number;
    derivToken: string;
    currency: string;
    stakeAmount: number;
    contractType: 'DIGITEVEN' | 'DIGITODD';
  }): Promise<DigitTradeResult> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket(endpoint);
      let isCompleted = false;
      let contractId = '';
      let proposalId = '';

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          try { ws.close(); } catch (e) { }
          reject(new Error('Timeout ao executar contrato dígito'));
        }
      }, 60000);

      const finalize = (error?: Error, result?: DigitTradeResult) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeout);
        try { ws.close(); } catch (e) { }
        if (error) reject(error);
        else resolve(result!);
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: params.derivToken }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            finalize(new Error(msg.error.message || 'Erro da Deriv'));
            return;
          }

          if (msg.msg_type === 'authorize') {
            ws.send(JSON.stringify({
              proposal: 1,
              amount: params.stakeAmount,
              basis: 'stake',
              contract_type: params.contractType,
              currency: params.currency,
              duration: 1,
              duration_unit: 't',
              symbol: this.symbol,
            }));
          } else if (msg.msg_type === 'proposal') {
            if (!msg.proposal || !msg.proposal.id) {
              finalize(new Error('Proposta inválida'));
              return;
            }
            proposalId = msg.proposal.id;
            const payout = Number(msg.proposal.payout || 0);

            // Atualizar payout
            await this.dataSource.query(
              'UPDATE ai_trades SET payout = ? WHERE id = ?',
              [payout - params.stakeAmount, params.tradeId],
            );

            ws.send(JSON.stringify({ buy: proposalId, price: Number(msg.proposal.ask_price) }));
          } else if (msg.msg_type === 'buy') {
            if (!msg.buy || !msg.buy.contract_id) {
              finalize(new Error('Compra falhou'));
              return;
            }
            contractId = msg.buy.contract_id;
            const entrySpot = Number(msg.buy.entry_spot || this.getCurrentPrice() || 0);

            // Atualizar entry
            await this.dataSource.query(
              `UPDATE ai_trades 
                 SET contract_id = ?, entry_price = ?, status = 'ACTIVE', started_at = NOW() 
                 WHERE id = ?`,
              [contractId, entrySpot, params.tradeId],
            );

            ws.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: contractId,
              subscribe: 1,
            }));
          } else if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            if (contract.is_sold === 1) {
              const profit = Number(contract.profit || 0);
              const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
              const status = profit >= 0 ? 'WON' : 'LOST';

              // Atualizar resultado
              await this.dataSource.query(
                `UPDATE ai_trades
                 SET exit_price = ?, profit_loss = ?, status = ?, closed_at = NOW()
                 WHERE id = ?`,
                [exitPrice, profit, status, params.tradeId],
              );

              finalize(undefined, {
                profitLoss: profit,
                status,
                exitPrice,
                contractId,
              });
            }
          }
        } catch (error) {
          finalize(error as Error);
        }
      });

      ws.on('error', (err) => finalize(err));
      ws.on('close', () => {
        if (!isCompleted) finalize(new Error('Conexão fechada'));
      });
    });
  }

  private async handleVelozTradeOutcome(
    state: VelozUserState,
    proposal: DigitParity,
    tradeId: number,
    stakeAmount: number,
    result: DigitTradeResult,
    entry: number,
  ): Promise<void> {
    const won = result.status === 'WON';
    const config = CONFIGS_MARTINGALE[state.modoMartingale];

    await this.incrementVelozStats(state.userId, won, result.profitLoss);

    if (won) {
      // ✅ VITÓRIA
      state.virtualCapital += result.profitLoss;
      const lucroLiquido = result.profitLoss - state.perdaAcumulada;

      // ✅ VALIDAÇÃO: Verificar se recuperou toda a perda acumulada (se estava em martingale)
      if (entry > 1 && state.perdaAcumulada > 0) {
        const recuperacaoEsperada = state.perdaAcumulada;
        const recuperacaoReal = result.profitLoss;

        if (recuperacaoReal < recuperacaoEsperada) {
          this.logger.warn(
            `[Veloz][Martingale] ⚠️ Recuperação incompleta: esperado ${formatCurrency(recuperacaoEsperada, state.currency)}, obtido ${formatCurrency(recuperacaoReal, state.currency)}`,
          );
        } else {
          this.logger.log(
            `[Veloz][Martingale] ✅ Recuperação completa: ${formatCurrency(recuperacaoEsperada, state.currency)} recuperado`,
          );
        }
      }

      // ✅ ZENIX v2.0: ESTRATÉGIA SOROS CORRIGIDA
      // Soros funciona apenas até a entrada 3 (níveis 0, 1, 2)
      // Entrada 1: vitoriasConsecutivas = 0 → após vitória, vira 1
      // Entrada 2: vitoriasConsecutivas = 1 (Soros nível 1) → após vitória, vira 2
      // Entrada 3: vitoriasConsecutivas = 2 (Soros nível 2) → após vitória, reinicia tudo

      if (entry <= 3 && state.perdaAcumulada === 0) {
        // Está no Soros (entradas 1, 2 ou 3 sem perda acumulada)
        if (entry === 1) {
          // Vitória na entrada 1: ativar Soros nível 1
          state.vitoriasConsecutivas = 1;
          state.ultimoLucro = result.profitLoss;
          this.logger.log(
            `[Veloz][Soros] ✅ Entrada 1 vitoriosa | Ativando Soros Nível 1 | ` +
            `Próxima: ${formatCurrency(stakeAmount, state.currency)} + ${formatCurrency(result.profitLoss, state.currency)} = ${formatCurrency(stakeAmount + result.profitLoss, state.currency)}`,
          );
        } else if (entry === 2 && state.vitoriasConsecutivas === 1) {
          // Vitória no Soros nível 1: ativar Soros nível 2
          state.vitoriasConsecutivas = 2;
          state.ultimoLucro = result.profitLoss;
          this.logger.log(
            `[Veloz][Soros] ✅ Soros Nível 1 vitorioso | Ativando Soros Nível 2 | ` +
            `Próxima: $${stakeAmount.toFixed(2)} + $${result.profitLoss.toFixed(2)} = $${(stakeAmount + result.profitLoss).toFixed(2)}`,
          );
        } else if (entry === 3 && state.vitoriasConsecutivas === 2) {
          // Vitória no Soros nível 2: ciclo perfeito, reiniciar tudo
          this.logger.log(
            `[Veloz][Soros] 🎉 CICLO PERFEITO! Soros Nível 2 completo | Reiniciando tudo`,
          );
          state.vitoriasConsecutivas = 0;
          state.ultimoLucro = 0;
          // Reiniciar para valor inicial
        }
      } else {
        // Vitória em martingale: resetar Soros
        state.vitoriasConsecutivas = 0;
        state.ultimoLucro = 0;
        this.logger.log(`[Veloz][Soros] 🔄 Resetado (vitória em martingale não conta para Soros)`);
      }

      this.logger.log(
        `[Veloz][${state.modoMartingale.toUpperCase()}] ✅ VITÓRIA na ${entry}ª entrada! | ` +
        `Ganho: ${formatCurrency(result.profitLoss, state.currency)} | ` +
        `Perda recuperada: ${formatCurrency(state.perdaAcumulada, state.currency)} | ` +
        `Lucro líquido: ${formatCurrency(lucroLiquido, state.currency)} | ` +
        `Capital: ${formatCurrency(state.virtualCapital, state.currency)} | ` +
        `Vitórias consecutivas: ${state.vitoriasConsecutivas}`,
      );

      // 📋 LOG: Resultado - VITÓRIA
      this.saveLogAsync(state.userId, 'resultado', '🎉 VITÓRIA!');
      this.saveLogAsync(state.userId, 'resultado', `Operação #${tradeId}: ${proposal}`);
      this.saveLogAsync(state.userId, 'resultado', `Resultado: ${Math.floor(result.exitPrice) % 10} ✅`);
      this.saveLogAsync(state.userId, 'resultado', `Investido: -${formatCurrency(stakeAmount, state.currency)}`);
      this.saveLogAsync(state.userId, 'resultado', `Retorno: +${formatCurrency(stakeAmount + result.profitLoss, state.currency)}`);
      this.saveLogAsync(state.userId, 'resultado', `Lucro: +${formatCurrency(result.profitLoss, state.currency)}`);
      this.saveLogAsync(state.userId, 'resultado', `Capital: ${formatCurrency(state.virtualCapital - result.profitLoss, state.currency)} → ${formatCurrency(state.virtualCapital, state.currency)}`);

      if (entry > 1) {
        this.saveLogAsync(state.userId, 'resultado', `🔄 MARTINGALE RESETADO`);
        this.saveLogAsync(state.userId, 'resultado', `Perda recuperada: +${formatCurrency(state.perdaAcumulada, state.currency)}`);
      }

      // ✅ CORREÇÃO: Manter apostaBase e apostaInicial (não resetar para 0)
      // Se completou Soros nível 2, reiniciar tudo
      if (entry === 3 && state.vitoriasConsecutivas === 2) {
        this.saveLogAsync(state.userId, 'resultado', `🎉 SOROS CICLO PERFEITO! Reiniciando para entrada inicial`);
        state.isOperationActive = false;
        state.martingaleStep = 0;
        state.perdaAcumulada = 0;
        state.vitoriasConsecutivas = 0;
        state.ultimoLucro = 0;
        // Próxima entrada será o valor inicial
        this.saveLogAsync(state.userId, 'resultado', `Próxima aposta: ${formatCurrency(state.apostaBase, state.currency)} (entrada inicial)`);
        this.saveLogAsync(state.userId, 'info', '📡 Aguardando próximo sinal...');
        return;
      }

      // Se ainda está no Soros, calcular próxima aposta
      if (state.vitoriasConsecutivas > 0 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL) {
        const proximaApostaComSoros = calcularApostaComSoros(
          stakeAmount,
          result.profitLoss,
          state.vitoriasConsecutivas,
        );
        if (proximaApostaComSoros !== null) {
          this.saveLogAsync(state.userId, 'resultado', `Próxima aposta: ${formatCurrency(proximaApostaComSoros, state.currency)} (Soros Nível ${state.vitoriasConsecutivas})`);
        }
      } else {
        this.saveLogAsync(state.userId, 'resultado', `Próxima aposta: ${formatCurrency(state.apostaBase, state.currency)} (entrada inicial)`);
      }

      this.saveLogAsync(state.userId, 'info', '📡 Aguardando próximo sinal...');

      // Resetar martingale (mas manter apostaBase e vitoriasConsecutivas se ainda no Soros)
      state.isOperationActive = false;
      state.martingaleStep = 0;
      state.perdaAcumulada = 0;
      state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale
      // ✅ CORREÇÃO: Não resetar apostaInicial para 0, manter com valor atual
      // state.apostaInicial mantém o valor da última aposta para referência
      return;
    }

    // ❌ PERDA
    state.virtualCapital += result.profitLoss;
    state.perdaAcumulada += stakeAmount;
    // ✅ CORREÇÃO: Salvar direção da operação para continuar martingale
    state.ultimaDirecaoMartingale = proposal;

    // ✅ ZENIX v2.0: ESTRATÉGIA SOROS CORRIGIDA
    // Se perder em qualquer entrada do Soros (1, 2 ou 3), entrar em recuperação
    if (entry <= 3 && state.perdaAcumulada === stakeAmount) {
      // Perdeu no Soros: resetar Soros e entrar em recuperação
      if (state.vitoriasConsecutivas > 0) {
        this.logger.log(
          `[Veloz][Soros] ❌ Soros Nível ${state.vitoriasConsecutivas} falhou! Entrando em recuperação`,
        );
      } else {
        this.logger.log(
          `[Veloz][Soros] ❌ Entrada 1 falhou! Entrando em recuperação`,
        );
      }
      state.vitoriasConsecutivas = 0;
      state.ultimoLucro = 0;
      // perdaAcumulada já foi incrementada acima, então entrará em martingale
    } else if (entry === 1) {
      // Perda na primeira entrada (não estava no Soros)
      state.vitoriasConsecutivas = 0;
      state.ultimoLucro = 0;
    }

    this.logger.warn(
      `[Veloz][${state.modoMartingale.toUpperCase()}] ❌ PERDA na ${entry}ª entrada: -${formatCurrency(stakeAmount, state.currency)} | ` +
      `Perda acumulada: ${formatCurrency(state.perdaAcumulada, state.currency)} | ` +
      `Vitórias consecutivas: ${state.vitoriasConsecutivas}`,
    );

    // 📋 LOG: Resultado - DERROTA (✅ OTIMIZADO: sem await para não bloquear)
    this.saveLog(state.userId, 'resultado', '❌ DERROTA');
    this.saveLog(state.userId, 'resultado', `Operação #${tradeId}: ${proposal}`);
    this.saveLog(state.userId, 'resultado', `Resultado: ${Math.floor(result.exitPrice) % 10} ❌`);
    this.saveLog(state.userId, 'resultado', `Investido: -${formatCurrency(stakeAmount, state.currency)}`);
    this.saveLog(state.userId, 'resultado', `Perda: ${formatCurrency(result.profitLoss, state.currency)}`);
    this.saveLog(state.userId, 'resultado', `Perda acumulada: -${formatCurrency(state.perdaAcumulada, state.currency)}`);

    // ✅ ZENIX v2.0: Verificar limite ANTES de incrementar e calcular próxima aposta
    // Conservador: máximo 5 entradas (entry 1-5, reseta quando chegar em 5)
    // Moderado/Agressivo: infinito (maxEntradas = Infinity)
    // ✅ Verificar se a PRÓXIMA entrada (entry + 1) ainda está dentro do limite
    if (config.maxEntradas === Infinity || (entry + 1) <= config.maxEntradas) {
      // Consultar payout via API antes de calcular
      const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
      let payoutCliente = 92; // Valor padrão caso falhe a consulta (95 - 3)

      try {
        payoutCliente = await this.consultarPayoutCliente(
          state.derivToken,
          state.currency || 'USD',
          contractType,
        );
      } catch (error) {
        this.logger.warn(
          `[Veloz][Martingale] Erro ao consultar payout, usando padrão (92%): ${error.message}`,
        );
      }

      let proximaAposta = calcularProximaAposta(
        state.perdaAcumulada,
        state.modoMartingale,
        payoutCliente,
      );

      // ✅ STOP-LOSS NORMAL - ZENIX v2.0
      // Protege durante martingale: evita que próxima aposta ultrapasse limite disponível
      try {
        const limitsResult = await this.dataSource.query(
          `SELECT 
            stake_amount as initialCapital,
            COALESCE(session_balance, 0) as sessionBalance,
            COALESCE(loss_limit, 0) as lossLimit
           FROM ai_user_config 
           WHERE user_id = ? AND is_active = TRUE
           LIMIT 1`,
          [state.userId],
        );

        if (limitsResult && limitsResult.length > 0) {
          const initialCapital = parseFloat(limitsResult[0].initialCapital) || 0;
          const sessionBalance = parseFloat(limitsResult[0].sessionBalance) || 0;
          const lossLimit = parseFloat(limitsResult[0].lossLimit) || 0;

          if (lossLimit > 0) {
            // Capital disponível = capital inicial + saldo da sessão
            const capitalDisponivel = initialCapital + sessionBalance;

            // Stop-loss disponível = quanto ainda pode perder
            const stopLossDisponivel = capitalDisponivel - (initialCapital - lossLimit);

            // Se próxima aposta + perda acumulada ultrapassar limite disponível
            if (state.perdaAcumulada + proximaAposta > stopLossDisponivel) {
              this.logger.warn(
                `[Veloz][StopNormal][${state.userId}] ⚠️ Próxima aposta ($${proximaAposta.toFixed(2)}) ultrapassaria stop-loss! ` +
                `Reduzindo para valor inicial ($${state.capital.toFixed(2)}) e resetando martingale.`,
              );

              // 📋 LOG: Stop-Loss Normal ativado
              this.saveLogAsync(state.userId, 'alerta', `⚠️ STOP-LOSS NORMAL: Próxima aposta ultrapassaria limite`);
              this.saveLogAsync(state.userId, 'alerta', `Reduzindo para $${state.capital.toFixed(2)} e resetando martingale`);

              // Reduzir para valor inicial
              proximaAposta = state.capital;

              // Resetar martingale (mas continuar operando)
              state.isOperationActive = false;
              state.martingaleStep = 0;
              state.perdaAcumulada = 0;
              state.apostaInicial = 0;
              state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale

              this.logger.log(
                `[Veloz][StopNormal][${state.userId}] 🔄 Martingale resetado. Continuando com valor inicial.`,
              );
              return;
            }
          }
        }
      } catch (error) {
        this.logger.error(`[Veloz][StopNormal][${state.userId}] Erro ao verificar stop-loss normal:`, error);
      }

      // Calcular lucro esperado baseado no modo
      const multiplicadorLucro = state.modoMartingale === 'conservador' ? 0 :
        state.modoMartingale === 'moderado' ? 0.25 : 0.50;
      const lucroEsperado = state.perdaAcumulada * multiplicadorLucro;

      this.logger.log(
        `[Veloz][${state.modoMartingale.toUpperCase()}] 🔁 Próxima entrada: $${proximaAposta.toFixed(2)} | ` +
        (lucroEsperado > 0
          ? `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} + Lucro $${lucroEsperado.toFixed(2)}`
          : `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} (break-even)`),
      );

      // 📋 LOG: Martingale ativado
      this.saveLogAsync(state.userId, 'alerta', `🔄 MARTINGALE ATIVADO (${state.modoMartingale.toUpperCase()})`);
      this.saveLogAsync(state.userId, 'alerta', `Próxima aposta: $${proximaAposta.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'alerta', `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)}`);

      // Executar próxima entrada
      await this.executeVelozOperation(state, proposal, entry + 1);
      return;
    }

    // 🛑 STOP-LOSS DE MARTINGALE (CONSERVADOR: máx 5 entradas)
    const prejuizoAceito = state.perdaAcumulada;

    this.logger.warn(
      `[Veloz][${state.modoMartingale.toUpperCase()}] 🛑 Limite de entradas atingido: ${entry}/${config.maxEntradas} | ` +
      `Perda total: -$${prejuizoAceito.toFixed(2)} | ` +
      `Resetando para valor inicial`,
    );

    // 📋 LOG: Martingale atingiu limite (CONSERVADOR específico)
    if (state.modoMartingale === 'conservador') {
      this.saveLogAsync(state.userId, 'alerta', `🛑 LIMITE MARTINGALE CONSERVADOR`);
      this.saveLogAsync(state.userId, 'alerta', `Atingiu ${entry}ª entrada (máximo: 5)`);
      this.saveLogAsync(state.userId, 'alerta', `Prejuízo aceito: -$${prejuizoAceito.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'alerta', `Resetando para valor inicial: $${state.capital.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'info', '🔄 Continuando operação com aposta normal...');
    } else {
      // Outros modos (não deveria chegar aqui pois moderado/agressivo são infinitos)
      this.saveLogAsync(state.userId, 'alerta', `🛑 MARTINGALE RESETADO`);
      this.saveLogAsync(state.userId, 'alerta', `Perda acumulada: -$${prejuizoAceito.toFixed(2)}`);
    }

    // Resetar martingale
    state.isOperationActive = false;
    state.martingaleStep = 0;
    state.perdaAcumulada = 0;
    state.apostaInicial = 0;
    state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale
  }

  private async incrementVelozStats(
    userId: string,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins = total_wins + 1' : 'total_losses = total_losses + 1';

    // Buscar saldo atual da sessão
    const currentBalanceResult = await this.dataSource.query(
      `SELECT COALESCE(session_balance, 0) as currentBalance
       FROM ai_user_config
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );

    const currentBalance = parseFloat(currentBalanceResult[0]?.currentBalance) || 0;
    const newBalance = currentBalance + profitLoss;

    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column},
           session_balance = ?,
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [newBalance, userId],
    );

    this.logger.debug(`[IncrementVelozStats][${userId}] Saldo atualizado: $${currentBalance.toFixed(2)} + $${profitLoss.toFixed(2)} = $${newBalance.toFixed(2)}`);

    // ✅ Verificar limites de lucro/perda após atualizar stats
    await this.checkAndEnforceLimits(userId);
    // Invalidar cache após atualização de saldo
    this.invalidateUserConfigCache(userId);

    // ✅ ZENIX v2.0: Verificar Stop Blindado (proteção de lucros)
    await this.checkStopBlindado(userId);
  }

  /**
   * Verifica se os limites de lucro/perda diários foram atingidos e desativa a IA automaticamente
   * Usa o session_balance que é atualizado após cada trade
   * Para imediatamente qualquer trade em andamento e grava o status da sessão
   */
  private async checkAndEnforceLimits(userId: string): Promise<void> {
    try {
      // Buscar configuração do usuário com o saldo atual da sessão
      const configResult = await this.dataSource.query(
        `SELECT profit_target, loss_limit, is_active, session_status, COALESCE(session_balance, 0) as sessionBalance
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE`,
        [userId],
      );

      if (!configResult || configResult.length === 0) {
        // Invalidar cache se não há mais sessão ativa
        this.invalidateUserConfigCache(userId);
        return;
      }

      const config = configResult[0];

      // Se já foi parada, não precisa verificar
      if (config.session_status && config.session_status !== 'active') {
        return;
      }

      const profitTarget = parseFloat(config.profit_target) || null;
      const lossLimit = parseFloat(config.loss_limit) || null;

      // Se não há limites configurados, não fazer nada
      if (!profitTarget && !lossLimit) {
        return;
      }

      // Usar o session_balance que já está atualizado após cada trade
      const sessionBalance = parseFloat(config.sessionBalance) || 0;

      this.logger.debug(`[CheckLimits][${userId}] Saldo: $${sessionBalance.toFixed(2)} | Alvo: ${profitTarget} | Limite: ${lossLimit}`);

      let shouldDeactivate = false;
      let deactivationReason = '';
      let sessionStatus: string | null = null;

      // Verificar se atingiu meta de lucro (stop win)
      if (profitTarget && sessionBalance >= profitTarget) {
        shouldDeactivate = true;
        sessionStatus = 'stopped_profit';
        deactivationReason = `Meta de lucro diária atingida: $${sessionBalance.toFixed(2)} (Meta: $${profitTarget})`;
        this.logger.log(`[CheckLimits][${userId}] 🎯 STOP WIN: ${deactivationReason}`);
      }

      // Verificar se atingiu limite de perda (stop loss)
      if (lossLimit && sessionBalance <= -lossLimit) {
        shouldDeactivate = true;
        sessionStatus = 'stopped_loss';
        deactivationReason = `Limite de perda diária atingido: -$${Math.abs(sessionBalance).toFixed(2)} (Limite: $${lossLimit})`;
        this.logger.warn(`[CheckLimits][${userId}] 🛑 STOP LOSS: ${deactivationReason}`);
      }

      // Desativar IA se necessário
      if (shouldDeactivate && sessionStatus) {
        // Atualizar configuração com status da sessão e desativar
        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET is_active = FALSE, 
               session_status = ?,
               deactivation_reason = ?,
               deactivated_at = NOW(),
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`,
          [sessionStatus, deactivationReason, userId],
        );

        // ✅ OTIMIZAÇÃO: Invalidar cache após mudança de configuração
        this.invalidateUserConfigCache(userId);

        // Parar imediatamente qualquer trade em andamento
        // Remover do mapa de usuários ativos para impedir novos trades
        if (this.velozUsers.has(userId)) {
          const state = this.velozUsers.get(userId);
          if (state) {
            // Marcar operação como inativa para parar qualquer trade em andamento
            state.isOperationActive = false;
          }
          this.velozUsers.delete(userId);
          this.logger.log(`[CheckLimits][${userId}] Usuário removido do mapa de usuários ativos (Veloz)`);
        }

        // Remover também dos outros modos se estiverem ativos
        if (this.moderadoUsers.has(userId)) {
          const state = this.moderadoUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.moderadoUsers.delete(userId);
          this.logger.log(`[CheckLimits][${userId}] Usuário removido do mapa de usuários ativos (Moderado)`);
        }

        if (this.precisoUsers.has(userId)) {
          const state = this.precisoUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.precisoUsers.delete(userId);
          this.logger.log(`[CheckLimits][${userId}] Usuário removido do mapa de usuários ativos (Preciso)`);
        }

        // Registrar log de desativação automática
        this.logger.log(`[CheckLimits][${userId}] 🚫 IA DESATIVADA AUTOMATICAMENTE: ${deactivationReason} | Status: ${sessionStatus} | Saldo final: $${sessionBalance.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.error(`[CheckLimits][${userId}] Erro ao verificar limites:`, error);
    }
  }

  /**
   * STOP-LOSS BLINDADO - ZENIX v2.0
   * Protege lucros conquistados movendo o stop-loss gradativamente
   * Quando o usuário está em lucro, protege 50% dele
   * Se o capital cair abaixo do stop blindado → PARA o sistema
   * 
   * Exemplo:
   * - Capital inicial: $1000
   * - Lucro atual: +$100 (capital = $1100)
   * - Stop blindado: $1000 + ($100 × 0.5) = $1050
   * - Se capital cair para $1050 → PARA (protege $50 de lucro)
   */
  private async checkStopBlindado(userId: string): Promise<void> {
    try {
      const configResult = await this.dataSource.query(
        `SELECT 
          stake_amount as initialBalance,
          COALESCE(session_balance, 0) as sessionBalance,
          COALESCE(stop_blindado_percent, 50.00) as stopBlindadoPercent,
          is_active,
          session_status
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE`,
        [userId],
      );

      if (!configResult || configResult.length === 0) {
        return;
      }

      const config = configResult[0];

      // Se já foi parada, não verificar
      if (config.session_status && config.session_status !== 'active') {
        return;
      }

      const initialBalance = parseFloat(config.initialBalance) || 0;
      const sessionBalance = parseFloat(config.sessionBalance) || 0; // ✅ session_balance já é o lucro/perda acumulada
      const stopBlindadoPercentRaw = config.stopBlindadoPercent;

      // ✅ ZENIX v2.0: Stop Blindado só funciona se estiver ativado (não NULL)
      if (stopBlindadoPercentRaw === null || stopBlindadoPercentRaw === undefined) {
        return; // Stop Blindado desativado
      }

      const stopBlindadoPercent = parseFloat(stopBlindadoPercentRaw) || 50.0;

      // ✅ session_balance já é o lucro líquido acumulada (pode ser negativo)
      const lucroLiquido = sessionBalance;

      // Stop Blindado só ativa se estiver em LUCRO
      if (lucroLiquido <= 0) {
        return; // Ainda não há lucro para proteger
      }

      // ✅ Calcular capital atual e stop blindado conforme documentação ZENIX v2.0
      // Capital Atual = Capital Inicial + Lucro Líquido
      const capitalAtual = initialBalance + lucroLiquido;

      // Stop Blindado = Capital Inicial + (Lucro Líquido × Percentual)
      const fatorProtecao = stopBlindadoPercent / 100; // 50% → 0.5
      const stopBlindado = initialBalance + (lucroLiquido * fatorProtecao);

      this.logger.debug(
        `[StopBlindado][${userId}] Capital Inicial Sessão: $${initialBalance.toFixed(2)} | ` +
        `Lucro Líquido Sessão: $${lucroLiquido.toFixed(2)} | ` +
        `Capital Sessão Atual: $${capitalAtual.toFixed(2)} | ` +
        `Stop Blindado: $${stopBlindado.toFixed(2)} (${stopBlindadoPercent}%)`,
      );

      // ✅ Se capital atual caiu abaixo do stop blindado → PARAR
      if (capitalAtual <= stopBlindado) {
        const lucroProtegido = capitalAtual - initialBalance; // Lucro que será protegido
        const percentualProtegido = (lucroProtegido / lucroLiquido) * 100;

        this.logger.warn(
          `[StopBlindado][${userId}] 🛡️ ATIVADO! ` +
          `Protegendo $${lucroProtegido.toFixed(2)} de lucro ` +
          `(${percentualProtegido.toFixed(0)}% de $${lucroLiquido.toFixed(2)})`,
        );

        const deactivationReason =
          `Stop-Loss Blindado ativado: protegeu $${lucroProtegido.toFixed(2)} de lucro ` +
          `(${stopBlindadoPercent}% de $${lucroLiquido.toFixed(2)} conquistados)`;

        // Desativar IA
        await this.dataSource.query(
          `UPDATE ai_user_config 
           SET is_active = FALSE, 
               session_status = 'stopped_blindado',
               deactivation_reason = ?,
               deactivated_at = NOW(),
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`,
          [deactivationReason, userId],
        );

        // ✅ OTIMIZAÇÃO: Invalidar cache após mudança de configuração
        this.invalidateUserConfigCache(userId);

        // Remover usuário dos mapas ativos (todos os modos)
        if (this.velozUsers.has(userId)) {
          const state = this.velozUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.velozUsers.delete(userId);
          this.logger.log(`[StopBlindado][${userId}] Removido do mapa Veloz`);
        }

        if (this.moderadoUsers.has(userId)) {
          const state = this.moderadoUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.moderadoUsers.delete(userId);
          this.logger.log(`[StopBlindado][${userId}] Removido do mapa Moderado`);
        }

        if (this.precisoUsers.has(userId)) {
          const state = this.precisoUsers.get(userId);
          if (state) {
            state.isOperationActive = false;
          }
          this.precisoUsers.delete(userId);
          this.logger.log(`[StopBlindado][${userId}] Removido do mapa Preciso`);
        }

        this.logger.log(
          `[StopBlindado][${userId}] 🛡️ IA DESATIVADA | ` +
          `Lucro protegido: $${lucroProtegido.toFixed(2)} | ` +
          `Capital Sessão final: $${capitalAtual.toFixed(2)}`,
        );
      }
    } catch (error) {
      this.logger.error(`[StopBlindado][${userId}] Erro:`, error);
    }
  }

  /**
   * SISTEMA DE LOGS EM TEMPO REAL - ZENIX v2.0
   * Salva logs detalhados no banco para exibição no frontend
   */
  // ============================================
  // SISTEMA DE LOGS OTIMIZADO - PERFORMANCE
  // ============================================

  // Fila de logs para processamento assíncrono
  private logQueue: Array<{
    userId: string;
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
    message: string;
    details?: any;
  }> = [];
  private logProcessing = false;

  /**
   * Salva log de forma assíncrona (não bloqueia execução)
   * Usa LogQueueService centralizado se disponível, senão usa fila local
   */
  private saveLogAsync(
    userId: string,
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro',
    message: string,
    details?: any,
  ): void {
    // Validar parâmetros
    if (!userId || !type || !message || message.trim() === '') {
      return;
    }

    // Usar LogQueueService centralizado se disponível
    if (this.logQueueService) {
      const sessionId = this.userSessionIds.get(userId) || userId;
      this.logQueueService.saveLogAsync({
        userId,
        type,
        message,
        details,
        sessionId,
        tableName: 'ai_logs',
      });
      return;
    }

    // Fallback: usar fila local (compatibilidade)
    this.logQueue.push({ userId, type, message, details });
    this.processLogQueue().catch(error => {
      this.logger.error(`[SaveLogAsync] Erro ao processar fila de logs:`, error);
    });
  }

  /**
   * Processa fila de logs em batch (otimizado)
   */
  private async processLogQueue(): Promise<void> {
    if (this.logProcessing || this.logQueue.length === 0) {
      return;
    }

    this.logProcessing = true;

    try {
      // Processar até 50 logs por vez
      const batch = this.logQueue.splice(0, 50);

      if (batch.length === 0) {
        this.logProcessing = false;
        return;
      }

      // Agrupar por userId para otimizar
      const logsByUser = new Map<string, typeof batch>();
      for (const log of batch) {
        if (!logsByUser.has(log.userId)) {
          logsByUser.set(log.userId, []);
        }
        logsByUser.get(log.userId)!.push(log);
      }

      // Processar cada usuário em paralelo
      await Promise.all(
        Array.from(logsByUser.entries()).map(([userId, logs]) =>
          this.saveLogsBatch(userId, logs)
        )
      );

      // Se ainda há logs na fila, processar novamente
      if (this.logQueue.length > 0) {
        setImmediate(() => this.processLogQueue());
      }
    } catch (error) {
      this.logger.error(`[ProcessLogQueue] Erro:`, error);
    } finally {
      this.logProcessing = false;
    }
  }

  /**
   * Salva múltiplos logs de um usuário em uma única query (otimizado)
   */
  private async saveLogsBatch(
    userId: string,
    logs: Array<{
      type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro';
      message: string;
      details?: any;
    }>,
  ): Promise<void> {
    if (logs.length === 0) return;

    try {
      const icons = {
        info: 'ℹ️',
        tick: '📥',
        analise: '🔍',
        sinal: '🎯',
        operacao: '💰',
        resultado: '✅',
        alerta: '⚠️',
        erro: '🚫',
      };

      const sessionId = this.userSessionIds.get(userId) || userId;

      // Preparar valores para INSERT em batch
      const values = logs.map(log => {
        const icon = icons[log.type] || 'ℹ️';
        return [
          userId,
          log.type,
          icon,
          log.message.substring(0, 5000),
          log.details ? JSON.stringify(log.details).substring(0, 10000) : null,
          sessionId,
        ];
      });

      // INSERT em batch (muito mais rápido)
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, NOW(3))').join(', ');
      const flatValues = values.flat();

      await this.dataSource.query(
        `INSERT INTO ai_logs (user_id, type, icon, message, details, session_id, timestamp)
         VALUES ${placeholders}`,
        flatValues,
      );
    } catch (error) {
      this.logger.error(`[SaveLogsBatch][${userId}] Erro ao salvar logs em batch:`, error);
    }
  }

  /**
   * Salva log de forma síncrona (DEPRECATED - usar saveLogAsync)
   * Mantido para compatibilidade, mas agora usa fila assíncrona
   */
  private async saveLog(
    userId: string,
    type: 'info' | 'tick' | 'analise' | 'sinal' | 'operacao' | 'resultado' | 'alerta' | 'erro',
    message: string,
    details?: any,
  ): Promise<void> {
    // ✅ OTIMIZAÇÃO: Usar fila assíncrona em vez de INSERT síncrono
    // Isso não bloqueia a execução e melhora performance significativamente
    this.saveLogAsync(userId, type, message, details);
  }

  /**
   * Busca logs recentes do usuário para exibição no frontend
   */
  async getUserLogs(userId: string, limit?: number): Promise<any[]> {
    try {
      // ✅ Buscar data de criação da sessão atual para filtrar apenas logs da sessão
      const sessionQuery = `
        SELECT created_at as sessionCreatedAt
        FROM ai_user_config
        WHERE user_id = ? AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 1
      `;

      const sessionResult = await this.dataSource.query(sessionQuery, [userId]);
      const sessionCreatedAt = sessionResult.length > 0 ? sessionResult[0].sessionCreatedAt : null;

      if (sessionCreatedAt) {
        this.logger.debug(`[GetUserLogs] 📅 Filtrando logs da sessão atual (desde ${sessionCreatedAt})`);
      } else {
        this.logger.warn(`[GetUserLogs] ⚠️ Nenhuma sessão ativa encontrada, retornando todos os logs`);
      }

      // 🕐 BUSCAR TIMESTAMPS E CONVERTER PARA HORÁRIO DE BRASÍLIA (UTC-3)
      // ✅ INCLUIR created_at PARA COMPARAÇÃO CORRETA NO FRONTEND
      // ✅ Filtrar apenas logs da sessão atual
      const query = limit
        ? `SELECT 
            id,
            timestamp,
            created_at,
            type,
            icon,
            message,
            details
           FROM ai_logs
           WHERE user_id = ?
           ${sessionCreatedAt ? 'AND created_at >= ?' : ''}
           ORDER BY created_at DESC
           LIMIT ?`
        : `SELECT 
            id,
            timestamp,
            created_at,
            type,
            icon,
            message,
            details
           FROM ai_logs
           WHERE user_id = ?
           ${sessionCreatedAt ? 'AND created_at >= ?' : ''}
           ORDER BY created_at DESC`;

      const params = limit
        ? (sessionCreatedAt ? [userId, sessionCreatedAt, limit] : [userId, limit])
        : (sessionCreatedAt ? [userId, sessionCreatedAt] : [userId]);
      const logs = await this.dataSource.query(query, params);

      // ✅ DEBUG: Logar quantos logs foram encontrados
      this.logger.debug(`[GetUserLogs][${userId}] Encontrados ${logs.length} logs no banco`);

      // Converter timestamps para horário de Brasília e formatar
      const logsWithBrazilTime = logs.map((log: any) => {
        // Se timestamp é string, converter para Date
        let date: Date;
        if (typeof log.timestamp === 'string') {
          date = new Date(log.timestamp);
        } else if (log.timestamp instanceof Date) {
          date = log.timestamp;
        } else if (log.created_at) {
          // Usar created_at se timestamp não estiver disponível
          date = new Date(log.created_at);
        } else {
          date = new Date();
        }

        // Converter para horário de Brasília (UTC-3) e formatar como HH:mm:ss
        const formattedTime = date.toLocaleTimeString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });

        return {
          ...log,
          timestamp: formattedTime,
          // ✅ MANTER created_at ORIGINAL PARA COMPARAÇÃO
          created_at: log.created_at,
        };
      });

      // ✅ NÃO INVERTER - Backend retorna mais novos primeiro (DESC)
      // Frontend espera mais novos primeiro
      return logsWithBrazilTime;
    } catch (error) {
      this.logger.error(`[GetUserLogs][${userId}] Erro:`, error);
      return [];
    }
  }

  /**
   * Deleta TODOS os logs do usuário
   */
  async deleteUserLogs(userId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM ai_logs WHERE user_id = ?`,
        [userId],
      );
      this.logger.log(`[DeleteUserLogs][${userId}] ✅ Todos os logs deletados`);
    } catch (error) {
      this.logger.error(`[DeleteUserLogs][${userId}] Erro:`, error);
      throw error;
    }
  }

  /**
   * Limpa logs antigos do usuário (mantém apenas os últimos N)
   */
  async clearOldLogs(userId: string, keep: number = 1000): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM ai_logs
         WHERE user_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM ai_logs
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ?
           ) AS keep_logs
         )`,
        [userId, userId, keep],
      );
    } catch (error) {
      this.logger.error(`[ClearOldLogs][${userId}] Erro:`, error);
    }
  }

  private async syncVelozUsersFromDb(): Promise<void> {
    const configs = await this.dataSource.query(
      `SELECT 
        user_id as userId,
        stake_amount as stakeAmount,
        deriv_token as derivToken,
        currency,
        modo_martingale as modoMartingale
       FROM ai_user_config
       WHERE is_active = TRUE
         AND LOWER(mode) = 'veloz'`,
    );

    if (configs.length > 0) {
      this.logger.log(
        `[SyncVeloz] Sincronizando ${configs.length} usuários do banco`,
      );
    }

    const activeIds = new Set<string>();

    for (const config of configs) {
      activeIds.add(config.userId);
      this.logger.debug(
        `[SyncVeloz] Lido do banco: userId=${config.userId} | stake=${config.stakeAmount} | martingale=${config.modoMartingale}`,
      );

      // ✅ ZENIX v2.0: Resolver conta antes de sincronizar/restaurar
      const resolved = await this.resolveDerivAccount(config.userId, config.derivToken, config.currency);
      const finalToken = resolved.token;
      // ✅ [ZENIX v3.4] Usar a moeda resolvida (pode ser BTC, ETH, etc) em vez de forçar USD
      const finalCurrency = resolved.currency || 'USD'; // ZENIX v3.5: Fallback final para USD se a resolução falhar totalmente

      this.upsertVelozUserState({
        userId: config.userId,
        stakeAmount: Number(config.stakeAmount) || 0,
        derivToken: finalToken,
        currency: finalCurrency,
        modoMartingale: config.modoMartingale || 'conservador',
      });
    }

    for (const existingId of Array.from(this.velozUsers.keys())) {
      if (!activeIds.has(existingId)) {
        this.velozUsers.delete(existingId);
      }
    }
  }

  // TRINITY REMOVIDO: syncTrinityUsersFromDb

  /**
   * ✅ ATLAS: Sincroniza usuários da Atlas do banco de dados
   */
  private async syncAtlasUsersFromDb(): Promise<void> {
    this.logger.debug(`[SyncAtlas] 🔍 Buscando usuários Atlas no banco...`);

    let configs: any[];
    try {
      configs = await this.dataSource.query(
        `SELECT 
          user_id as userId,
          stake_amount as stakeAmount,
          entry_value as entryValue,
          deriv_token as derivToken,
          currency,
          modo_martingale as modoMartingale,
          mode,
          profit_target as profitTarget,
          loss_limit as lossLimit
         FROM ai_user_config
         WHERE is_active = TRUE
           AND LOWER(strategy) = 'atlas'`,
      );
    } catch (error: any) {
      this.logger.error(`[SyncAtlas] Erro ao buscar usuários no banco:`, error);
      return;
    }

    if (configs.length > 0) {
      this.logger.log(
        `[SyncAtlas] Sincronizando ${configs.length} usuário(s) Atlas do banco`,
      );
    }

    const activeIds = new Set<string>();

    if (this.strategyManager) {
      for (const config of configs) {
        activeIds.add(config.userId);
        this.logger.debug(
          `[SyncAtlas] Lido do banco: userId=${config.userId} | stake=${config.stakeAmount} | mode=${config.mode}`,
        );

        // ✅ ZENIX v2.0: Resolver conta antes de sincronizar/restaurar
        const resolved = await this.resolveDerivAccount(config.userId, config.derivToken, config.currency);
        const finalToken = resolved.token;
        // ✅ [ZENIX v3.4] Usar a moeda resolvida (pode ser BTC, ETH, etc) em vez de forçar USD
        const finalCurrency = resolved.currency || 'USD'; // Garantir que resolved.currency seja priorizado

        // ✅ ZENIX v2.1: Se o token mudou, atualizar no banco para persistir a correção
        if (finalToken !== config.derivToken) {
          this.logger.warn(`[SyncAtlas] 🔄 Atualizando token no banco para user ${config.userId} | Antigo: ${config.derivToken?.substring(0, 10)}... | Novo: ${finalToken?.substring(0, 10)}...`);
          await this.dataSource.query(
            `UPDATE ai_user_config SET deriv_token = ? WHERE user_id = ? AND is_active = TRUE`,
            [finalToken, config.userId]
          );
        }

        try {
          await this.strategyManager.activateUser(config.userId, 'atlas', {
            mode: config.mode || 'veloz',
            stakeAmount: Number(config.stakeAmount) || 0,
            entryValue: Number(config.entryValue) || getMinStakeByCurrency(finalCurrency),
            derivToken: finalToken,
            currency: finalCurrency,
            modoMartingale: config.modoMartingale || 'conservador',
            profitTarget: config.profitTarget || null,
            lossLimit: config.lossLimit || null,
          });
        } catch (error) {
          this.logger.error(`[SyncAtlas] Erro ao ativar usuário ${config.userId}:`, error);
        }
      }

      // Remover usuários que não estão mais ativos na estratégia
      const atlasStrategy = this.strategyManager.getAtlasStrategy() as any;
      if (atlasStrategy && typeof atlasStrategy.getUsers === 'function') {
        const currentUsers = atlasStrategy.getUsers();
        for (const userId of currentUsers.keys()) {
          if (!activeIds.has(userId)) {
            this.logger.log(`[SyncAtlas] Desativando usuário ${userId} (não mais ativo no banco)`);
            await atlasStrategy.deactivateUser(userId);
          }
        }
      }
    }

    // TRINITY REMOVIDO: WebSockets da Trinity não são mais necessários
    // O Atlas agora gerencia seus próprios WebSockets se necessário
  }

  private upsertVelozUserState(params: {
    userId: string;
    stakeAmount: number;
    entryValue?: number; // ✅ Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }) {
    const { userId, stakeAmount, entryValue, derivToken, currency, modoMartingale = 'conservador' } = params;
    const apostaInicial = entryValue || getMinStakeByCurrency(currency); // ✅ Moeda dinâmica

    this.logger.log(
      `[UpsertVelozState] userId=${userId} | capital=${stakeAmount} | currency=${currency} | martingale=${modoMartingale}`,
    );

    const existing = this.velozUsers.get(userId);

    if (existing) {
      this.logger.debug(
        `[UpsertVelozState] Atualizando usuário existente | capital antigo=${existing.capital} | capital novo=${stakeAmount} | martingale=${modoMartingale}`,
      );
      existing.capital = stakeAmount;
      existing.derivToken = derivToken;
      existing.currency = currency;
      existing.modoMartingale = modoMartingale;
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = stakeAmount;
      }
      // ✅ ZENIX v2.0: Atualizar apostaBase e apostaInicial se necessário (mas manter vitoriasConsecutivas)
      if (entryValue !== undefined) {
        existing.apostaBase = apostaInicial;
        existing.apostaInicial = apostaInicial;
      } else if (existing.apostaBase <= 0) {
        existing.apostaBase = apostaInicial;
        existing.apostaInicial = apostaInicial;
      }
      // ✅ Resetar intervalo se não há operação ativa (permite nova operação imediatamente)
      if (!existing.isOperationActive) {
        existing.lastOperationTickIndex = -1; // DEPRECATED
        existing.ticksDesdeUltimaOp = -1; // Resetar contador
      }
      this.velozUsers.set(userId, existing);
      return;
    }

    this.logger.debug(
      `[UpsertVelozState] Criando novo usuário | capital=${stakeAmount} | martingale=${modoMartingale}`,
    );
    this.velozUsers.set(userId, {
      userId,
      derivToken,
      currency,
      capital: stakeAmount,
      virtualCapital: stakeAmount,
      lossVirtualActive: false,
      lossVirtualCount: 0,
      lossVirtualOperation: null,
      isOperationActive: false,
      martingaleStep: 0,
      modoMartingale: modoMartingale,
      perdaAcumulada: 0,
      apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
      lastOperationTickIndex: -1, // ✅ ZENIX v2.0: DEPRECATED - manter para compatibilidade
      ticksDesdeUltimaOp: -1, // ✅ ZENIX v2.0: Inicializar contador de ticks (-1 = pode operar imediatamente)
      vitoriasConsecutivas: 0, // ✅ ZENIX v2.0: Estratégia Soros - inicializar contador
      ultimoLucro: 0, // ✅ ZENIX v2.0: Lucro da última entrada (para calcular Soros)
      apostaBase: apostaInicial, // ✅ ZENIX v2.0: Inicializar aposta base com entryValue
      ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
    });
  }

  private removeVelozUserState(userId: string) {
    if (this.velozUsers.has(userId)) {
      this.velozUsers.delete(userId);
    }
  }

  getTicks(): Tick[] {
    return this.ticks;
  }

  getCurrentPrice(): number | null {
    if (this.ticks.length === 0) {
      return null;
    }
    return this.ticks[this.ticks.length - 1].value;
  }

  getStatistics() {
    if (this.ticks.length === 0) {

      return null;
    }

    const values = this.ticks.map((t) => t.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const current = values[values.length - 1];
    const first = values[0];
    const change = ((current - first) / first) * 100;

    return {
      min,
      max,
      avg,
      current,
      change,
    };
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      ticksCount: this.ticks.length,
      symbol: this.symbol,
      subscriptionId: this.subscriptionId,
    };
  }

  private send(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payloadStr = JSON.stringify(payload);
      this.ws.send(payloadStr);
      this.logger.debug(`[send] 📤 Mensagem enviada: ${payloadStr.substring(0, 200)}...`);
    } else {
      this.logger.warn(`[send] ⚠️ WebSocket não está aberto. Estado: ${this.ws?.readyState || 'null'}`);
    }
  }

  disconnect() {
    this.logger.log('Desconectando...');
    if (this.ws) {
      this.ws.close();
    }
    this.isConnected = false;
    this.ticks = [];
  }

  private async ensureTickStreamReady(
    minTicks: number = VELOZ_CONFIG.window,
  ): Promise<void> {
    this.logger.debug(`[ensureTickStreamReady] Verificando conexão WebSocket...`);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.debug(`[ensureTickStreamReady] WebSocket não conectado, inicializando...`);
      await this.initialize();
    }

    this.logger.debug(`[ensureTickStreamReady] Aguardando ${minTicks} ticks (atual: ${this.ticks.length})...`);
    let attempts = 0;
    const maxAttempts = 3; // ✅ Reduzido de 60 para 3 tentativas

    while (this.ticks.length < minTicks && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;

      // ✅ Log a cada tentativa
      this.logger.debug(`[ensureTickStreamReady] Tentativa ${attempts}/${maxAttempts} - Ticks: ${this.ticks.length}/${minTicks}`);

      // ✅ Na terceira tentativa, fazer verificação completa do WebSocket e imprimir logs detalhados
      if (attempts === maxAttempts) {
        this.logger.warn(`[ensureTickStreamReady] ⚠️ Terceira tentativa - Verificando WebSocket...`);

        // Verificação detalhada do WebSocket
        const wsState = this.ws ? {
          exists: true,
          readyState: this.ws.readyState,
          readyStateText: this.ws.readyState === WebSocket.OPEN ? 'OPEN' :
            this.ws.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
              this.ws.readyState === WebSocket.CLOSING ? 'CLOSING' :
                this.ws.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN',
          url: this.ws.url || 'N/A',
        } : { exists: false };

        this.logger.warn(`[ensureTickStreamReady] 📊 Estado do WebSocket:`, JSON.stringify(wsState, null, 2));
        this.logger.warn(`[ensureTickStreamReady] 📊 Estado da conexão (isConnected): ${this.isConnected}`);
        this.logger.warn(`[ensureTickStreamReady] 📊 Subscription ID: ${this.subscriptionId || 'N/A'}`);
        this.logger.warn(`[ensureTickStreamReady] 📊 Símbolo: ${this.symbol || 'N/A'}`);
        this.logger.warn(`[ensureTickStreamReady] 📊 Total de ticks recebidos: ${this.ticks.length}`);
        this.logger.warn(`[ensureTickStreamReady] 📊 Último tick: ${this.ticks.length > 0 ? JSON.stringify(this.ticks[this.ticks.length - 1]) : 'Nenhum'}`);

        // Verificar se há mensagens sendo recebidas
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.logger.warn(`[ensureTickStreamReady] ✅ WebSocket está OPEN, mas não está recebendo ticks`);

          // ✅ Se não há subscription ID, verificar se já recebemos erro "already subscribed"
          // Se sim, não tentar criar uma nova subscription - aguardar que os ticks cheguem
          if (!this.subscriptionId || this.subscriptionId === 'N/A') {
            const timeSinceLastError = Date.now() - this.lastAlreadySubscribedTime;
            const timeSinceLastTick = this.lastTickReceivedTime > 0 ? Date.now() - this.lastTickReceivedTime : Infinity;
            const shouldWaitForTicks = this.hasReceivedAlreadySubscribed && timeSinceLastError < 30000; // Aguardar 30 segundos após receber "already subscribed"

            // ✅ Se não estamos recebendo ticks há mais de 60 segundos, recriar WebSocket mesmo sem subscriptionId
            if (timeSinceLastTick > 60000 && this.lastTickReceivedTime > 0) {
              this.logger.warn(`[ensureTickStreamReady] ⚠️ Não recebendo ticks há ${Math.floor(timeSinceLastTick / 1000)}s e não temos subscriptionId - Recriando WebSocket...`);
              try {
                await this.recreateWebSocket();
                this.hasReceivedAlreadySubscribed = false; // Resetar flag após recriar
                this.lastAlreadySubscribedTime = 0;
              } catch (error) {
                this.logger.error(`[ensureTickStreamReady] ❌ Erro ao recriar WebSocket:`, error);
              }
            } else if (shouldWaitForTicks) {
              // Já recebemos "already subscribed" recentemente - não tentar criar nova subscription
              this.logger.warn(`[ensureTickStreamReady] 🔄 Subscription ID não encontrado, mas já recebemos "already subscribed" há ${Math.floor(timeSinceLastError / 1000)}s`);
              this.logger.warn(`[ensureTickStreamReady] 💡 A subscription está ativa - aguardando que os ticks cheguem (eles devem trazer o subscriptionId)...`);
              // Não tentar criar uma nova subscription para evitar erro "You are already subscribed"
            } else {
              // Ainda não recebemos "already subscribed" ou já passou tempo suficiente - tentar criar subscription
              if (this.hasReceivedAlreadySubscribed) {
                this.logger.warn(`[ensureTickStreamReady] ⏰ Já passou tempo suficiente desde "already subscribed" (${Math.floor(timeSinceLastError / 1000)}s) - tentando criar nova subscription...`);
                this.hasReceivedAlreadySubscribed = false; // Resetar flag para tentar novamente
              }
              this.logger.warn(`[ensureTickStreamReady] 🔄 Subscription ID não encontrado - Reenviando subscription...`);
              try {
                this.subscribeToTicks();
                this.logger.warn(`[ensureTickStreamReady] ✅ Subscription reenviada. Aguardando resposta...`);
              } catch (error) {
                this.logger.error(`[ensureTickStreamReady] ❌ Erro ao reenviar subscription:`, error);
              }
            }
          } else {
            // ✅ Se temos subscriptionId mas não estamos recebendo ticks, verificar se não recebemos há muito tempo
            const timeSinceLastTick = Date.now() - this.lastTickReceivedTime;
            if (timeSinceLastTick > 60000 && this.lastTickReceivedTime > 0) {
              // Não recebendo ticks há mais de 60 segundos - recriar WebSocket
              this.logger.warn(`[ensureTickStreamReady] ⚠️ Subscription ID existe (${this.subscriptionId}), mas não recebendo ticks há ${Math.floor(timeSinceLastTick / 1000)}s`);
              this.logger.warn(`[ensureTickStreamReady] 🔄 Recriando WebSocket...`);
              try {
                await this.recreateWebSocket();
              } catch (error) {
                this.logger.error(`[ensureTickStreamReady] ❌ Erro ao recriar WebSocket:`, error);
              }
            } else {
              this.logger.warn(`[ensureTickStreamReady] 💡 Subscription ID existe (${this.subscriptionId}), mas não está recebendo ticks`);
              this.logger.warn(`[ensureTickStreamReady] 💡 Possíveis causas: subscription expirada, símbolo incorreto, ou servidor não está enviando ticks`);
              this.logger.warn(`[ensureTickStreamReady] 💡 Aguardando mais alguns segundos...`);
            }
          }
        } else {
          this.logger.warn(`[ensureTickStreamReady] ❌ WebSocket não está OPEN (estado: ${wsState.readyStateText})`);
          this.logger.warn(`[ensureTickStreamReady] 💡 Tentando reconectar...`);
          try {
            await this.initialize();
            this.logger.warn(`[ensureTickStreamReady] ✅ Reconexão iniciada`);
          } catch (error) {
            this.logger.error(`[ensureTickStreamReady] ❌ Erro ao reconectar:`, error);
          }
        }
      }
    }

    if (this.ticks.length < minTicks) {
      // ✅ Verificar se não está recebendo ticks há muito tempo (mais de 60 segundos)
      const timeSinceLastTick = Date.now() - this.lastTickReceivedTime;
      if (timeSinceLastTick > 60000 && this.lastTickReceivedTime > 0) {
        this.logger.warn(`[ensureTickStreamReady] ⚠️ Não recebendo ticks há ${Math.floor(timeSinceLastTick / 1000)}s - Recriando WebSocket...`);
        try {
          await this.recreateWebSocket();
        } catch (error) {
          this.logger.error(`[ensureTickStreamReady] ❌ Erro ao recriar WebSocket:`, error);
        }
      }

      this.logger.error(`[ensureTickStreamReady] ❌ Timeout após ${maxAttempts} tentativas: Não foi possível obter ${minTicks} ticks (obtidos: ${this.ticks.length})`);
      throw new Error(
        `Não foi possível obter ${minTicks} ticks recentes do símbolo ${this.symbol}`,
      );
    }

    this.logger.debug(`[ensureTickStreamReady] ✅ Ticks suficientes: ${this.ticks.length}/${minTicks}`);
  }

  /**
   * ✅ Salva o estado atual do WebSocket no banco de dados
   */
  private async saveWebSocketState(): Promise<void> {
    try {
      let ticksData = this.ticks.slice(-50); // Salvar apenas os últimos 50 ticks

      // ✅ Garantir que ticksData é um array válido antes de stringificar
      if (!Array.isArray(ticksData)) {
        this.logger.warn(`[saveWebSocketState] ⚠️ ticksData não é um array, usando array vazio`);
        ticksData = [];
      }

      // ✅ Sempre stringificar (ticksData sempre será array aqui)
      const ticksJson = JSON.stringify(ticksData);

      await this.dataSource.query(`
        INSERT INTO ai_websocket_state 
        (symbol, subscription_id, ticks_data, total_ticks, last_tick_received_at, websocket_url, is_connected, connection_created_at)
        VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          subscription_id = VALUES(subscription_id),
          ticks_data = VALUES(ticks_data),
          total_ticks = VALUES(total_ticks),
          last_tick_received_at = VALUES(last_tick_received_at),
          websocket_url = VALUES(websocket_url),
          is_connected = VALUES(is_connected),
          updated_at = CURRENT_TIMESTAMP
      `, [
        this.symbol,
        this.subscriptionId || null,
        ticksJson,
        this.ticks.length,
        this.lastTickReceivedTime > 0 ? Math.floor(this.lastTickReceivedTime / 1000) : null,
        this.ws ? this.ws.url : null,
        this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN
      ]);

      this.logger.debug(`[saveWebSocketState] ✅ Estado salvo: ${this.ticks.length} ticks, subscriptionId=${this.subscriptionId || 'N/A'}`);
    } catch (error) {
      this.logger.error(`[saveWebSocketState] ❌ Erro ao salvar estado:`, error);
    }
  }

  /**
   * ✅ Recupera o estado do WebSocket do banco de dados
   */
  private async loadWebSocketState(): Promise<{ ticks: Tick[], subscriptionId: string | null } | null> {
    try {
      const result = await this.dataSource.query(`
        SELECT ticks_data, subscription_id, total_ticks
        FROM ai_websocket_state
        WHERE symbol = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `, [this.symbol]);

      if (result.length === 0) {
        this.logger.debug(`[loadWebSocketState] Nenhum estado salvo encontrado para ${this.symbol}`);
        return null;
      }

      const state = result[0];
      let ticks: Tick[] = [];

      if (state.ticks_data) {
        try {
          // ✅ Verificar se ticks_data é string antes de parsear
          let ticksDataStr = state.ticks_data;
          if (typeof ticksDataStr !== 'string') {
            // Se não é string, pode ser objeto corrompido - tentar stringificar primeiro
            this.logger.warn(`[loadWebSocketState] ⚠️ ticks_data não é string, tentando converter...`);
            if (typeof ticksDataStr === 'object' && ticksDataStr !== null) {
              ticksDataStr = JSON.stringify(ticksDataStr);
            } else {
              // Se é [object Object] ou similar, limpar e usar array vazio
              this.logger.warn(`[loadWebSocketState] ⚠️ ticks_data corrompido, limpando...`);
              await this.dataSource.query(
                `UPDATE ai_websocket_state SET ticks_data = '[]' WHERE symbol = ?`,
                [this.symbol]
              );
              ticksDataStr = '[]';
            }
          }

          ticks = JSON.parse(ticksDataStr);

          // ✅ Validar que o resultado é um array
          if (!Array.isArray(ticks)) {
            this.logger.warn(`[loadWebSocketState] ⚠️ ticks_data parseado não é array, usando array vazio`);
            ticks = [];
            // Limpar dados corrompidos
            await this.dataSource.query(
              `UPDATE ai_websocket_state SET ticks_data = '[]' WHERE symbol = ?`,
              [this.symbol]
            );
          } else {
            this.logger.debug(`[loadWebSocketState] ✅ Estado recuperado: ${ticks.length} ticks, subscriptionId=${state.subscription_id || 'N/A'}`);
          }
        } catch (error) {
          this.logger.warn(`[loadWebSocketState] ⚠️ Erro ao parsear ticks_data:`, error);
          // ✅ Limpar dados corrompidos
          try {
            await this.dataSource.query(
              `UPDATE ai_websocket_state SET ticks_data = '[]' WHERE symbol = ?`,
              [this.symbol]
            );
          } catch (cleanupError) {
            this.logger.error(`[loadWebSocketState] ❌ Erro ao limpar dados corrompidos:`, cleanupError);
          }
          ticks = [];
        }
      }

      return {
        ticks,
        subscriptionId: state.subscription_id || null
      };
    } catch (error) {
      this.logger.error(`[loadWebSocketState] ❌ Erro ao recuperar estado:`, error);
      return null;
    }
  }

  /**
   * ✅ Recria o WebSocket quando a subscription não está funcionando
   */
  private async recreateWebSocket(): Promise<void> {
    // ✅ Verificar se já está recriando (evitar múltiplas recriações simultâneas)
    if (this.isRecreating) {
      this.logger.warn(`[recreateWebSocket] ⚠️ Já está recriando WebSocket, ignorando nova tentativa...`);
      return;
    }

    this.isRecreating = true;
    this.websocketReconnectAttempts++;
    this.logger.warn(`[recreateWebSocket] 🔄 Tentativa ${this.websocketReconnectAttempts}: Recriando WebSocket...`);

    try {
      // ✅ Cancelar subscription antiga se existir antes de fechar
      if (this.subscriptionId && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.logger.log(`[recreateWebSocket] 🔄 Cancelando subscription antiga: ${this.subscriptionId}`);
        this.cancelSubscription(this.subscriptionId);
        // Aguardar um pouco para o comando forget ser processado
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // ✅ Salvar estado atual antes de fechar
      await this.saveWebSocketState();

      // ✅ Fechar conexão atual
      if (this.ws) {
        try {
          this.ws.removeAllListeners();
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
          }
        } catch (error) {
          this.logger.warn(`[recreateWebSocket] ⚠️ Erro ao fechar WebSocket antigo:`, error);
        }
        this.ws = null;
      }

      this.isConnected = false;
      this.subscriptionId = null;
      this.hasReceivedAlreadySubscribed = false; // Resetar flag
      this.lastAlreadySubscribedTime = 0; // Resetar timestamp
      this.stopKeepAlive();

      // ✅ Aguardar um pouco antes de reconectar
      await new Promise(resolve => setTimeout(resolve, 2000));

      // ✅ Tentar recuperar estado salvo
      const savedState = await this.loadWebSocketState();
      if (savedState && savedState.ticks.length > 0) {
        this.ticks = savedState.ticks;
        this.logger.log(`[recreateWebSocket] ✅ Recuperados ${savedState.ticks.length} ticks do estado salvo`);
        if (savedState.subscriptionId) {
          this.subscriptionId = savedState.subscriptionId;
          this.logger.log(`[recreateWebSocket] ✅ Subscription ID recuperado: ${savedState.subscriptionId}`);
        }
      }

      // ✅ Criar nova conexão
      await this.initialize();
      this.logger.log(`[recreateWebSocket] ✅ Nova conexão WebSocket criada com sucesso`);
      this.websocketReconnectAttempts = 0; // Resetar contador após sucesso
    } catch (error) {
      this.logger.error(`[recreateWebSocket] ❌ Erro ao criar nova conexão:`, error);
      throw error;
    } finally {
      // ✅ Sempre liberar lock, mesmo em caso de erro
      this.isRecreating = false;
    }
  }

  async getVelozDiagnostics(userId?: string) {
    await this.ensureTickStreamReady();

    const dvx = this.calculateDVX(this.ticks);
    const windowTicks = this.ticks.slice(-VELOZ_CONFIG.window);
    const evenCount = windowTicks.filter((t) => t.parity === 'PAR').length;
    const oddCount = VELOZ_CONFIG.window - evenCount;

    let proposal: DigitParity | null = null;
    if (evenCount === VELOZ_CONFIG.window) {
      proposal = 'IMPAR';
    } else if (oddCount === VELOZ_CONFIG.window) {
      proposal = 'PAR';
    }

    const userState = userId ? this.velozUsers.get(userId) : undefined;

    return {
      totalTicks: this.ticks.length,
      lastTick: this.ticks[this.ticks.length - 1] || null,
      windowParities: windowTicks.map((t) => t.parity),
      dvx,
      proposal,
      sinal: proposal,
      confianca: proposal ? 85 : 0,
      entry_time_seconds: proposal ? 10 : 0,
      lossVirtual: userState
        ? {
          active: userState.lossVirtualActive,
          count: userState.lossVirtualCount,
          operation: userState.lossVirtualOperation,
        }
        : null,
    };
  }

  async triggerManualVelozOperation(
    userId: string,
    proposal: DigitParity,
  ): Promise<number> {
    const state = this.velozUsers.get(userId);
    if (!state) {
      throw new Error(
        'Usuário não está com o modo veloz ativo ou não possui configuração carregada',
      );
    }

    if (state.isOperationActive) {
      throw new Error('Já existe uma operação ativa para este usuário');
    }

    await this.ensureTickStreamReady();

    // executeVelozOperation cria o trade internamente e retorna DigitTradeResult
    // Precisamos buscar o tradeId do banco após a execução
    const stakeAmount = await this.calculateVelozStake(state, 1, proposal);
    const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';

    // Criar registro inicial do trade
    const insertResult = await this.dataSource.query(
      `INSERT INTO ai_trades 
       (user_id, symbol, contract_type, stake_amount, status, strategy, started_at)
       VALUES (?, ?, ?, ?, 'PENDING', 'VELOZ', NOW())`,
      [state.userId, this.symbol, contractType, stakeAmount],
    );
    const tradeId = insertResult.insertId;

    // Executar a operação (que irá atualizar o trade criado acima)
    try {
      await this.executeDigitTradeOnDeriv({
        tradeId,
        derivToken: state.derivToken,
        currency: state.currency || 'USD', // ZENIX v3.5
        stakeAmount,
        contractType,
      });

      return tradeId;
    } catch (error) {
      // Atualizar status do trade para ERROR
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error.message || 'Erro ao executar operação', tradeId],
      );
      throw error;
    }
  }

  async getSessionStats(userId: string) {
    // Buscar todas as trades do usuário do dia atual (timezone America/Sao_Paulo)
    this.logger.log(`[GetSessionStats] 📊 Buscando estatísticas do dia para userId=${userId}`);

    // Pegar data atual no timezone do Brasil
    const now = new Date();
    const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const startOfDay = new Date(brazilTime.getFullYear(), brazilTime.getMonth(), brazilTime.getDate(), 0, 0, 0);
    const endOfDay = new Date(brazilTime.getFullYear(), brazilTime.getMonth(), brazilTime.getDate(), 23, 59, 59);

    this.logger.log(`[GetSessionStats] 🕐 Filtrando trades do dia: ${startOfDay.toISOString()} até ${endOfDay.toISOString()}`);

    const query = `
      SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(profit_loss, 0)) as totalProfitLoss,
        SUM(COALESCE(stake_amount, 0)) as totalVolume
      FROM ai_trades
      WHERE user_id = ? 
        AND created_at >= ?
        AND created_at <= ?
        AND status IN ('WON', 'LOST')
    `;

    const result = await this.dataSource.query(query, [userId, startOfDay, endOfDay]);
    const stats = result[0];

    const totalTrades = parseInt(stats.totalTrades) || 0;
    const wins = parseInt(stats.wins) || 0;
    const losses = parseInt(stats.losses) || 0;
    const profitLoss = parseFloat(stats.totalProfitLoss) || 0;
    const totalVolume = parseFloat(stats.totalVolume) || 0;
    const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    // Buscar saldo da sessão ativa
    // Buscar a sessão mais recente do dia; se não houver, pegar a última sessão registrada
    const sessionQueryToday = `
      SELECT 
        COALESCE(session_balance, 0) as sessionBalance,
        created_at as sessionCreatedAt
      FROM ai_user_config
      WHERE user_id = ? 
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const sessionQueryAny = `
      SELECT 
        COALESCE(session_balance, 0) as sessionBalance,
        created_at as sessionCreatedAt
      FROM ai_user_config
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;

    let sessionResult = await this.dataSource.query(sessionQueryToday, [userId, startOfDay]);
    if (sessionResult.length === 0) {
      sessionResult = await this.dataSource.query(sessionQueryAny, [userId]);
    }

    const sessionBalance = sessionResult.length > 0 ? parseFloat(sessionResult[0].sessionBalance) || 0 : 0;
    const sessionCreatedAt = sessionResult.length > 0 ? sessionResult[0].sessionCreatedAt : null;

    // Calcular estatísticas da sessão (trades desde o início da sessão)
    let sessionProfitLoss = 0;
    let sessionTrades = 0;
    let sessionWins = 0;
    let sessionLosses = 0;
    let sessionWinrate = 0;

    if (sessionCreatedAt) {
      const sessionTradesQuery = `
        SELECT 
          COUNT(*) as sessionTrades,
          SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as sessionWins,
          SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as sessionLosses,
          SUM(COALESCE(profit_loss, 0)) as sessionProfitLoss
        FROM ai_trades
        WHERE user_id = ? 
          AND created_at >= ?
          AND status IN ('WON', 'LOST')
      `;
      const sessionTradesResult = await this.dataSource.query(sessionTradesQuery, [userId, sessionCreatedAt]);
      sessionTrades = parseInt(sessionTradesResult[0]?.sessionTrades) || 0;
      sessionWins = parseInt(sessionTradesResult[0]?.sessionWins) || 0;
      sessionLosses = parseInt(sessionTradesResult[0]?.sessionLosses) || 0;
      sessionProfitLoss = parseFloat(sessionTradesResult[0]?.sessionProfitLoss) || 0;
      sessionWinrate = sessionTrades > 0 ? (sessionWins / sessionTrades) * 100 : 0;
    }

    // Fallback: se não houver sessão aberta/registrada hoje, usar o resultado do dia
    if (!sessionCreatedAt) {
      sessionProfitLoss = profitLoss;
      sessionTrades = totalTrades;
      sessionWins = wins;
      sessionLosses = losses;
      sessionWinrate = winrate;
    }

    this.logger.log(`[GetSessionStats] ✅ Stats: trades=${totalTrades}, wins=${wins}, losses=${losses}, P&L=${profitLoss}, volume=${totalVolume}, winrate=${winrate.toFixed(2)}%, sessionBalance=${sessionBalance}, sessionProfit=${sessionProfitLoss}, sessionTrades=${sessionTrades}, sessionWinrate=${sessionWinrate.toFixed(2)}%`);

    return {
      totalTrades,
      wins,
      losses,
      profitLoss,
      totalVolume,
      winrate: parseFloat(winrate.toFixed(2)),
      sessionBalance,
      sessionProfitLoss,
      sessionTrades,
      sessionWins,
      sessionLosses,
      sessionWinrate: parseFloat(sessionWinrate.toFixed(2)),
    };
  }

  async getTradeHistory(userId: string, limit?: number) {
    // Buscar histórico de trades do usuário (sem limite, apenas da sessão atual)
    this.logger.log(`[GetTradeHistory] 🔍 Buscando histórico para userId=${userId}${limit ? `, limit=${limit}` : ' (sem limite)'}`);

    // ✅ CORREÇÃO: Buscar data de criação da ÚLTIMA sessão (ativa ou não) para filtrar apenas operações recentes
    // Isso evita carregar o histórico completo quando a sessão para (is_active = false)
    const sessionQuery = `
      SELECT created_at as sessionCreatedAt
      FROM ai_user_config
      WHERE user_id = ? 
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const sessionResult = await this.dataSource.query(sessionQuery, [userId]);
    const sessionCreatedAt = sessionResult.length > 0 ? sessionResult[0].sessionCreatedAt : null;

    if (sessionCreatedAt) {
      this.logger.log(`[GetTradeHistory] 📅 Filtrando operações da sessão atual (desde ${sessionCreatedAt})`);
    } else {
      this.logger.warn(`[GetTradeHistory] ⚠️ Nenhuma sessão ativa encontrada, retornando todas as operações`);
    }

    // ✅ Tentar buscar com symbol, se falhar, buscar sem symbol (campo pode não existir ainda)
    // ✅ EXCLUIR operações com status ERROR do histórico
    let query = `
      SELECT 
        id,
        gemini_signal as \`signal\`,
        contract_type as contractType,
        entry_price as entryPrice,
        exit_price as exitPrice,
        stake_amount as stakeAmount,
        profit_loss as profitLoss,
        gemini_duration as duration,
        gemini_reasoning as reasoning,
        status,
        symbol,
        created_at as createdAt,
        closed_at as closedAt
      FROM ai_trades
      WHERE user_id = ? 
      AND status != 'ERROR'
      ${sessionCreatedAt ? 'AND created_at >= ?' : ''}
      ORDER BY COALESCE(closed_at, created_at) DESC
      ${limit ? 'LIMIT ?' : ''}
    `;

    let result;
    const queryParams = limit
      ? (sessionCreatedAt ? [userId, sessionCreatedAt, limit] : [userId, limit])
      : (sessionCreatedAt ? [userId, sessionCreatedAt] : [userId]);

    try {
      result = await this.dataSource.query(query, queryParams);
      this.logger.debug(`[GetTradeHistory] 📝 Query executada com symbol${sessionCreatedAt ? ' e filtro de sessão' : ''}`);
    } catch (error: any) {
      // Se o campo symbol não existir, buscar sem ele
      if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
        this.logger.warn(`[GetTradeHistory] Campo 'symbol' não existe, buscando sem ele. Execute o script SQL: backend/db/add_symbol_to_ai_trades.sql`);
        query = `
          SELECT 
            id,
            gemini_signal as \`signal\`,
            contract_type as contractType,
            entry_price as entryPrice,
            exit_price as exitPrice,
            stake_amount as stakeAmount,
            profit_loss as profitLoss,
            gemini_duration as duration,
            gemini_reasoning as reasoning,
            status,
            created_at as createdAt,
            closed_at as closedAt
          FROM ai_trades
          WHERE user_id = ? 
          AND status != 'ERROR'
          ${sessionCreatedAt ? 'AND created_at >= ?' : ''}
          ORDER BY COALESCE(closed_at, created_at) DESC
          ${limit ? 'LIMIT ?' : ''}
        `;
        result = await this.dataSource.query(query, queryParams);
        this.logger.debug(`[GetTradeHistory] 📝 Query executada sem symbol${sessionCreatedAt ? ' e filtro de sessão' : ''}`);
      } else {
        throw error;
      }
    }

    this.logger.log(`[GetTradeHistory] ✅ Query executada, ${result.length} registros encontrados`);

    const mapped = result.map((trade: any) => {
      // ✅ Converter DECIMAL do MySQL corretamente (pode vir como string ou number)
      let entryPrice: number | null = null;
      if (trade.entryPrice != null && trade.entryPrice !== undefined) {
        const entryValue = typeof trade.entryPrice === 'string'
          ? parseFloat(trade.entryPrice)
          : Number(trade.entryPrice);
        entryPrice = !isNaN(entryValue) && entryValue > 0 ? entryValue : null;
      }

      let exitPrice: number | null = null;
      if (trade.exitPrice != null && trade.exitPrice !== undefined) {
        const exitValue = typeof trade.exitPrice === 'string'
          ? parseFloat(trade.exitPrice)
          : Number(trade.exitPrice);
        exitPrice = !isNaN(exitValue) && exitValue > 0 ? exitValue : null;
      }

      // ✅ DEBUG: Logar valores para verificar (apenas primeiros 3)
      const tradeIndex = result.indexOf(trade);
      if (tradeIndex < 3) {
        this.logger.debug(
          `[GetTradeHistory] Trade ${tradeIndex + 1} (id=${trade.id}): ` +
          `entryPrice=${entryPrice} (raw: ${trade.entryPrice}, type: ${typeof trade.entryPrice}), ` +
          `exitPrice=${exitPrice} (raw: ${trade.exitPrice}, type: ${typeof trade.exitPrice}), ` +
          `status=${trade.status}`
        );
      }

      return {
        id: trade.id,
        signal: trade.signal,
        contractType: trade.contractType,
        entryPrice: entryPrice,
        exitPrice: exitPrice,
        stakeAmount: parseFloat(trade.stakeAmount || 0),
        profitLoss: trade.profitLoss != null ? parseFloat(trade.profitLoss) : null,
        duration: trade.duration,
        reasoning: trade.reasoning,
        status: trade.status,
        symbol: trade.symbol || 'R_10', // ✅ Usar 'R_10' como padrão se symbol não existir
        createdAt: trade.createdAt,
        closedAt: trade.closedAt,
      };
    });

    return mapped;
  }

  // ========== MÉTODOS PARA IA EM BACKGROUND ==========

  /**
   * Ativa a IA para um usuário (salva configuração no banco)
   */
  /**
   * Calcula o tempo de espera entre operações baseado no modo
   * @param mode - fast (1 min), moderate (5 min), slow (10 min)
   * @returns Tempo em milissegundos
   */
  private getWaitTimeByMode(mode: string): number {
    switch (mode) {
      case 'veloz':
        return 0;
      case 'fast':
        return 60000; // 1 minuto
      case 'slow':
        return 600000; // 10 minutos
      case 'moderate':
      default:
        return 300000; // 5 minutos (padrão)
    }
  }

  async initializeTables(): Promise<void> {
    this.logger.log('Inicializando tabelas da IA...');

    // Criar tabela ai_user_config
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS ai_user_config (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário',
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        stake_amount DECIMAL(10, 2) NOT NULL DEFAULT 10.00,
        deriv_token TEXT NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        mode VARCHAR(20) NOT NULL DEFAULT 'veloz' COMMENT 'Modo de operação: veloz, fast, moderate, slow',
        profit_target DECIMAL(10, 2) NULL COMMENT 'Meta de lucro diária',
        loss_limit DECIMAL(10, 2) NULL COMMENT 'Limite de perda diária',
        
        last_trade_at TIMESTAMP NULL,
        next_trade_at TIMESTAMP NULL,
        
        total_trades INT UNSIGNED DEFAULT 0,
        total_wins INT UNSIGNED DEFAULT 0,
        total_losses INT UNSIGNED DEFAULT 0,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deactivation_reason TEXT NULL COMMENT 'Motivo da desativação',
        deactivated_at TIMESTAMP NULL COMMENT 'Data/hora da desativação',
        
        INDEX idx_user_id (user_id),
        INDEX idx_is_active (is_active),
        INDEX idx_next_trade_at (next_trade_at),
        INDEX idx_mode (mode),
        INDEX idx_user_active (user_id, is_active, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Configuração de IA de trading por usuário - múltiplas sessões permitidas'
    `);

    // Verificar tipo da coluna user_id
    const userIdColumn = await this.dataSource.query(`
      SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'ai_user_config'
      AND COLUMN_NAME = 'user_id'
    `);

    // Se user_id for INT, migrar para VARCHAR
    if (userIdColumn.length > 0 && userIdColumn[0].DATA_TYPE !== 'varchar') {
      this.logger.warn('🔄 Migrando user_id de INT para VARCHAR(36)...');

      try {
        // Remover índice temporariamente
        await this.dataSource.query(`ALTER TABLE ai_user_config DROP INDEX idx_user_id`);
      } catch (error) {
        // Índice pode não existir, continuar
      }

      // Alterar tipo da coluna
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário'
      `);

      // Recriar índice (não-unique para permitir múltiplas sessões)
      await this.dataSource.query(`ALTER TABLE ai_user_config ADD INDEX idx_user_id (user_id)`);

      this.logger.log('✅ Migração concluída: user_id agora é VARCHAR(36)');
    }

    // Verificar se as colunas profit_target e loss_limit existem antes de adicionar
    // (Compatível com MySQL 5.7+)
    const columns = await this.dataSource.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'ai_user_config'
    `);

    const columnNames = columns.map((col: any) => col.COLUMN_NAME);

    // ✅ Adicionar entry_value se não existir
    if (!columnNames.includes('entry_value')) {
      this.logger.log('🔄 Adicionando coluna entry_value...');
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN entry_value DECIMAL(10, 2) NULL DEFAULT 0.35 
        COMMENT 'Valor de entrada por operação (separado do capital total)'
        AFTER stake_amount
      `);
      this.logger.log('✅ Coluna entry_value adicionada');
    }

    // Adicionar profit_target se não existir
    if (!columnNames.includes('profit_target')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN profit_target DECIMAL(10, 2) NULL COMMENT 'Meta de lucro diária' AFTER mode
      `);
      this.logger.log('✅ Coluna profit_target adicionada');
    }

    // Adicionar loss_limit se não existir
    if (!columnNames.includes('loss_limit')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN loss_limit DECIMAL(10, 2) NULL COMMENT 'Limite de perda diária' AFTER profit_target
      `);
      this.logger.log('✅ Coluna loss_limit adicionada');
    }

    // Adicionar deactivation_reason se não existir
    if (!columnNames.includes('deactivation_reason')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN deactivation_reason TEXT NULL COMMENT 'Motivo da desativação' AFTER updated_at
      `);
      this.logger.log('✅ Coluna deactivation_reason adicionada');
    }

    // Adicionar deactivated_at se não existir
    if (!columnNames.includes('deactivated_at')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN deactivated_at TIMESTAMP NULL COMMENT 'Data/hora da desativação' AFTER deactivation_reason
      `);
      this.logger.log('✅ Coluna deactivated_at adicionada');
    }

    // Adicionar modo_martingale se não existir
    if (!columnNames.includes('modo_martingale')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN modo_martingale VARCHAR(20) NOT NULL DEFAULT 'conservador' 
        COMMENT 'Modo de martingale: conservador, moderado, agressivo' 
        AFTER mode
      `);
      this.logger.log('✅ Coluna modo_martingale adicionada');
    }

    // Adicionar strategy se não existir
    if (!columnNames.includes('strategy')) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD COLUMN strategy VARCHAR(20) NOT NULL DEFAULT 'orion' 
        COMMENT 'Estratégia IA: orion, trinity' 
        AFTER modo_martingale
      `);
      this.logger.log('✅ Coluna strategy adicionada');
    }

    // ✅ Criar tabela para salvar estado do WebSocket
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS ai_websocket_state (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL DEFAULT 'R_10',
        subscription_id VARCHAR(255) NULL,
        ticks_data JSON NULL COMMENT 'Últimos ticks recebidos (serializados)',
        total_ticks INT UNSIGNED DEFAULT 0,
        last_tick_received_at TIMESTAMP NULL COMMENT 'Timestamp do último tick recebido',
        websocket_url VARCHAR(500) NULL COMMENT 'URL do WebSocket',
        is_connected BOOLEAN DEFAULT FALSE,
        connection_created_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_symbol (symbol),
        INDEX idx_last_tick (last_tick_received_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Estado do WebSocket para recuperação após reconexão'
    `);
    this.logger.log('✅ Tabela ai_websocket_state criada/verificada');

    // 🔄 Remover constraint UNIQUE de user_id se existir (para permitir múltiplas sessões)
    const indexesResult = await this.dataSource.query(`
      SELECT INDEX_NAME, NON_UNIQUE
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ai_user_config'
      AND INDEX_NAME = 'idx_user_id'
    `);

    if (indexesResult.length > 0 && indexesResult[0].NON_UNIQUE === 0) {
      this.logger.warn('🔄 Removendo constraint UNIQUE de idx_user_id para permitir múltiplas sessões...');

      // Remover índice UNIQUE
      await this.dataSource.query(`ALTER TABLE ai_user_config DROP INDEX idx_user_id`);

      // Recriar como índice normal
      await this.dataSource.query(`ALTER TABLE ai_user_config ADD INDEX idx_user_id (user_id)`);

      this.logger.log('✅ Índice idx_user_id convertido de UNIQUE para normal');
    }

    // Adicionar índice composto se não existir
    const compositeIndexResult = await this.dataSource.query(`
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ai_user_config'
      AND INDEX_NAME = 'idx_user_active'
    `);

    if (compositeIndexResult.length === 0) {
      await this.dataSource.query(`
        ALTER TABLE ai_user_config 
        ADD INDEX idx_user_active (user_id, is_active, created_at)
      `);
      this.logger.log('✅ Índice composto idx_user_active adicionado');
    }

    // Verificar e migrar tabela ai_trades também
    const aiTradesUserIdColumn = await this.dataSource.query(`
      SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'ai_trades'
      AND COLUMN_NAME = 'user_id'
    `);

    // Se user_id em ai_trades for INT, migrar para VARCHAR
    if (aiTradesUserIdColumn.length > 0 && aiTradesUserIdColumn[0].DATA_TYPE !== 'varchar') {
      this.logger.warn('🔄 Migrando user_id na tabela ai_trades de INT para VARCHAR(36)...');

      // Alterar tipo da coluna em ai_trades
      await this.dataSource.query(`
        ALTER TABLE ai_trades 
        MODIFY COLUMN user_id VARCHAR(36) NOT NULL COMMENT 'UUID do usuário'
      `);

      this.logger.log('✅ Migração concluída: ai_trades.user_id agora é VARCHAR(36)');
    }

    this.logger.log('✅ Tabelas da IA inicializadas com sucesso');
  }

  /**
   * ✅ ZENIX v2.0: Resolve Conta Deriv (Prioriza Demo se Real zerada)
   * Busca deriv_raw do banco e decide qual conta usar baseada no saldo E nas configurações do usuário
   */
  private async resolveDerivAccount(
    userId: string,
    providedToken: string,
    requestedCurrency: string
  ): Promise<{ token: string; currency: string; loginid: string, isVirtual: boolean }> {
    this.logger.log(`[ResolveDeriv] ====== INÍCIO DA RESOLUÇÃO ======`);
    this.logger.log(`[ResolveDeriv] 📥 Parâmetros: userId=${userId}, providedToken=${providedToken.substring(0, 10)}..., requestedCurrency=${requestedCurrency}`);

    try {
      // 1. Buscar configurações do usuário (trade_currency) E dados raw E tokens dedicados
      const userResult = await this.dataSource.query(
        `SELECT u.deriv_raw, u.token_demo, u.token_real, s.trade_currency 
         FROM users u
         LEFT JOIN user_settings s ON u.id = s.user_id
         WHERE u.id = ?`,
        [userId]
      );

      this.logger.log(`[ResolveDeriv] 📊 Resultado da query: ${userResult?.length || 0} registros`);

      if (!userResult || userResult.length === 0) {
        this.logger.warn(`[ResolveDeriv] ⚠️ Usuário não encontrado: ${userId}`);
        return { token: providedToken, currency: requestedCurrency, loginid: 'UNKNOWN', isVirtual: false };
      }

      const row = userResult[0];
      const userPreferredCurrency = (row.trade_currency || 'USD').toUpperCase();
      const dbTokenDemo = row.token_demo;
      const dbTokenReal = row.token_real;
      const derivRaw = typeof row.deriv_raw === 'string' ? JSON.parse(row.deriv_raw) : row.deriv_raw;

      this.logger.log(`[ResolveDeriv] 📊 trade_currency: "${userPreferredCurrency}"`);
      this.logger.log(`[ResolveDeriv] 📊 Tokens DB: Demo=${!!dbTokenDemo}, Real=${!!dbTokenReal}`);

      // 🚨 Mapear tokens para moedas se deriv_raw estiver disponível
      const tokens = derivRaw?.tokensByLoginId || {};
      const accountList = derivRaw?.authorize?.account_list || [];
      const tokenToAccount = new Map();
      const currencyToAccounts = new Map();

      accountList.forEach((acc: any) => {
        const loginid = acc.loginid;
        const cur = (acc.currency || '').toUpperCase();
        const tk = tokens[loginid];
        const info = { loginid, currency: cur, token: tk, isDemo: !!acc.is_virtual, balance: parseFloat(acc.balance || 0) };

        tokenToAccount.set(loginid, info);
        if (cur) {
          if (!currencyToAccounts.has(cur)) currencyToAccounts.set(cur, []);
          currencyToAccounts.get(cur).push(info);
        }
      });

      let wantsDemo = userPreferredCurrency === 'DEMO';
      if (userPreferredCurrency === 'USD' && derivRaw?.loginid?.toString().toUpperCase().startsWith('VRTC')) {
        wantsDemo = true;
      }
      this.logger.log(`[ResolveDeriv] 🎯 Usuário quer DEMO? ${wantsDemo}`);

      if (wantsDemo) {
        // --- MODO DEMO ---
        // 1. Tentar encontrar qualquer conta Demo com token
        const demoAccounts = Array.from(tokenToAccount.values()).filter(a => a.isDemo && a.token);
        if (demoAccounts.length > 0) {
          // Priorizar USD na Demo se disponível
          const usdDemo = demoAccounts.find(a => a.currency === 'USD') || demoAccounts[0];
          this.logger.log(`[ResolveDeriv] ✅ Usando TOKEN DEMO (${usdDemo.loginid} | ${usdDemo.currency})`);
          return { token: usdDemo.token, currency: usdDemo.currency, loginid: usdDemo.loginid, isVirtual: true };
        }

        if (dbTokenDemo) {
          return { token: dbTokenDemo, currency: 'USD', loginid: 'DEMO_USER', isVirtual: true };
        }
      } else {
        // --- MODO REAL ---
        const realAccounts = Array.from(tokenToAccount.values()).filter(a => !a.isDemo && a.token);

        if (realAccounts.length > 0) {
          // 1. Priorizar conta que combine com userPreferredCurrency
          const preferredMatch = realAccounts.find(a => a.currency === userPreferredCurrency);
          if (preferredMatch) {
            this.logger.log(`[ResolveDeriv] ✅ Usando TOKEN REAL correspondente à preferência (${preferredMatch.loginid} | ${preferredMatch.currency})`);
            return { token: preferredMatch.token, currency: preferredMatch.currency, loginid: preferredMatch.loginid, isVirtual: false };
          }

          // 2. Priorizar qualquer conta que tenha SALDO
          const withBalance = realAccounts.find(a => a.balance > 0);
          if (withBalance) {
            this.logger.log(`[ResolveDeriv] ✅ Usando TOKEN REAL com saldo (${withBalance.loginid} | ${withBalance.currency})`);
            return { token: withBalance.token, currency: withBalance.currency, loginid: withBalance.loginid, isVirtual: false };
          }

          // 3. Fallback para a primeira conta real com token
          const firstReal = realAccounts[0];
          this.logger.log(`[ResolveDeriv] ✅ Usando TOKEN REAL fallback (${firstReal.loginid} | ${firstReal.currency})`);
          return { token: firstReal.token, currency: firstReal.currency, loginid: firstReal.loginid, isVirtual: false };
        }

        if (dbTokenReal) {
          return { token: dbTokenReal, currency: userPreferredCurrency, loginid: 'REAL_USER', isVirtual: false };
        }
      }

      return { token: providedToken, currency: requestedCurrency, loginid: 'UNKNOWN', isVirtual: false };
    } catch (error) {
      this.logger.error(`[ResolveDeriv] ❌ Erro crítico na resolução:`, error);
      return { token: providedToken, currency: requestedCurrency, loginid: 'UNKNOWN', isVirtual: false };
    }
  }

  async activateUserAI(
    userId: string,
    stakeAmount: number, // Capital total da conta
    derivToken: string,
    currency: string,
    mode: string = 'veloz',
    profitTarget?: number,
    lossLimit?: number,
    modoMartingale: ModoMartingale = 'conservador',
    strategy: string = 'orion',
    entryValue?: number, // ✅ Valor de entrada por operação (opcional)
    stopLossBlindado?: boolean, // ✅ ZENIX v2.0: Stop-Loss Blindado (true = ativado com 50%, false/null = desativado)
    symbol?: string, // ✅ ZENIX v2.0: Símbolo/Ativo (opcional)
  ): Promise<void> {

    // ✅ PASSO 0: RESOLVER CONTA (Evitar Insufficient Balance)
    const resolvedAccount = await this.resolveDerivAccount(userId, derivToken, currency);

    // Atualizar variáveis com valores resolvidos
    const finalToken = resolvedAccount.token;
    // ✅ [ZENIX v3.4] Usar a moeda resolvida (pode ser BTC, ETH, etc) em vez de forçar USD
    const finalCurrency = resolvedAccount.currency || 'USD';
    // Nota: O 'currency' gravado no banco costuma ser 'USD' mesmo para demo, mas vamos manter coerência.

    // Se houve troca forçada, logar aviso claro
    if (resolvedAccount.token !== derivToken) {
      this.logger.warn(`[ActivateAI] 🔄 Token substituído! (Front: ${derivToken.substring(0, 8)}... -> Banco: ${finalToken.substring(0, 8)}...)`);
    }

    // ✅ Normalizar moeda (DEMO não é uma moeda válida para a Deriv, usar USD como padrão para contas virtuais)
    const normalizedCurrency = finalCurrency;

    this.logger.log(
      `[ActivateAI] userId=${userId} | stake=${stakeAmount} | currency=${normalizedCurrency} (original: ${currency}) | mode=${mode} | martingale=${modoMartingale} | strategy=${strategy} | symbol=${symbol}`,
    );

    // 🗑️ PRIMEIRA AÇÃO: DELETAR TODOS OS LOGS DO USUÁRIO ANTES DE INICIAR NOVA SESSÃO
    try {
      await this.deleteUserLogs(userId);
      this.logger.log(
        `[ActivateAI] 🗑️ Logs anteriores deletados para userId=${userId}`,
      );
    } catch (error) {
      this.logger.error(
        `[ActivateAI] ⚠️ Erro ao deletar logs do usuário ${userId}:`,
        error,
      );
      // Não bloquear a criação da sessão se houver erro ao deletar logs
    }

    // 🔄 NOVA LÓGICA: Sempre criar nova sessão (INSERT)
    // 1. Desativar todas as sessões anteriores deste usuário
    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET is_active = FALSE,
           deactivation_reason = 'Nova sessão iniciada',
           deactivated_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [userId],
    );

    this.logger.log(
      `[ActivateAI] 🔄 Sessões anteriores desativadas para userId=${userId}`,
    );

    // ✅ Para modo veloz com Orion, definir next_trade_at como NULL para permitir processamento imediato
    // O Orion processa em tempo real via ticks, não depende de next_trade_at
    // Para outros modos, usar 1 minuto no futuro
    const nextTradeAt = (mode || '').toLowerCase() === 'veloz' && (strategy || 'orion').toLowerCase() === 'orion'
      ? null // Orion processa em tempo real, não precisa de agendamento
      : new Date(Date.now() + 60000); // Outros modos: 1 minuto a partir de agora

    // 2. Criar nova sessão (sempre INSERT)
    // ✅ ZENIX v2.0: Stop-Loss Blindado - se ativado, usar 50% (padrão da documentação)
    const stopBlindadoPercent = stopLossBlindado === true ? 50.00 : null; // null = desativado, 50.00 = ativado

    // ✅ Adicionar entry_value e stop_blindado_percent se as colunas existirem
    try {
      await this.dataSource.query(
        `INSERT INTO ai_user_config 
         (user_id, is_active, session_status, session_balance, stake_amount, entry_value, deriv_token, currency, mode, modo_martingale, strategy, profit_target, loss_limit, stop_blindado_percent, next_trade_at, created_at, updated_at) 
         VALUES (?, TRUE, 'active', 0.00, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURRENT_TIMESTAMP)`,
        [userId, stakeAmount, entryValue || getMinStakeByCurrency(normalizedCurrency), finalToken, normalizedCurrency, mode, modoMartingale, strategy, profitTarget || null, lossLimit || null, stopBlindadoPercent, nextTradeAt],
      );
    } catch (error: any) {
      // Se alguma coluna não existir, tentar inserir sem ela
      if (error.code === 'ER_BAD_FIELD_ERROR') {
        const missingField = error.sqlMessage?.match(/Unknown column '([^']+)'/)?.[1];
        this.logger.warn(`[ActivateAI] Campo '${missingField}' não existe, tentando inserir sem ele`);

        // Tentar inserir sem stop_blindado_percent
        if (missingField === 'stop_blindado_percent') {
          try {
            await this.dataSource.query(
              `INSERT INTO ai_user_config 
               (user_id, is_active, session_status, session_balance, stake_amount, entry_value, deriv_token, currency, mode, modo_martingale, strategy, profit_target, loss_limit, next_trade_at, created_at, updated_at) 
               VALUES (?, TRUE, 'active', 0.00, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURRENT_TIMESTAMP)`,
              [userId, stakeAmount, entryValue || getMinStakeByCurrency(normalizedCurrency), finalToken, normalizedCurrency, mode, modoMartingale, strategy, profitTarget || null, lossLimit || null, nextTradeAt],
            );
          } catch (error2: any) {
            // Se entry_value também não existir
            if (error2.code === 'ER_BAD_FIELD_ERROR' && error2.sqlMessage?.includes('entry_value')) {
              await this.dataSource.query(
                `INSERT INTO ai_user_config 
                 (user_id, is_active, session_status, session_balance, stake_amount, deriv_token, currency, mode, modo_martingale, strategy, profit_target, loss_limit, next_trade_at, created_at, updated_at) 
                 VALUES (?, TRUE, 'active', 0.00, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURRENT_TIMESTAMP)`,
                [userId, stakeAmount, finalToken, normalizedCurrency, mode, modoMartingale, strategy, profitTarget || null, lossLimit || null, nextTradeAt],
              );
            } else {
              throw error2;
            }
          }
        } else if (missingField === 'entry_value') {
          // Tentar inserir sem entry_value mas com stop_blindado_percent
          try {
            await this.dataSource.query(
              `INSERT INTO ai_user_config 
               (user_id, is_active, session_status, session_balance, stake_amount, deriv_token, currency, mode, modo_martingale, strategy, profit_target, loss_limit, stop_blindado_percent, next_trade_at, created_at, updated_at) 
               VALUES (?, TRUE, 'active', 0.00, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURRENT_TIMESTAMP)`,
              [userId, stakeAmount, finalToken, normalizedCurrency, mode, modoMartingale, strategy, profitTarget || null, lossLimit || null, stopBlindadoPercent, nextTradeAt],
            );
          } catch (error2: any) {
            // Se stop_blindado_percent também não existir
            if (error2.code === 'ER_BAD_FIELD_ERROR' && error2.sqlMessage?.includes('stop_blindado_percent')) {
              await this.dataSource.query(
                `INSERT INTO ai_user_config 
                 (user_id, is_active, session_status, session_balance, stake_amount, deriv_token, currency, mode, modo_martingale, strategy, profit_target, loss_limit, next_trade_at, created_at, updated_at) 
                 VALUES (?, TRUE, 'active', 0.00, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURRENT_TIMESTAMP)`,
                [userId, stakeAmount, finalToken, normalizedCurrency, mode, modoMartingale, strategy, profitTarget || null, lossLimit || null, nextTradeAt],
              );
            } else {
              throw error2;
            }
          }
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    this.logger.log(
      `[ActivateAI] ✅ Nova sessão criada | userId=${userId} | stake=${stakeAmount} | currency=${normalizedCurrency}`,
    );

    if ((mode || '').toLowerCase() === 'veloz') {
      this.logger.log(
        `[ActivateAI] Sincronizando estado Veloz | stake=${stakeAmount} | entryValue=${entryValue || getMinStakeByCurrency(normalizedCurrency)}`,
      );
      this.upsertVelozUserState({
        userId,
        stakeAmount,
        entryValue: entryValue || getMinStakeByCurrency(normalizedCurrency), // ✅ Moeda dinâmica
        derivToken: finalToken,
        currency: normalizedCurrency,
      });
      this.removeModeradoUserState(userId);
      this.removePrecisoUserState(userId);
    } else if ((mode || '').toLowerCase() === 'moderado') {
      this.logger.log(
        `[ActivateAI] Sincronizando estado Moderado | stake=${stakeAmount} | entryValue=${entryValue || getMinStakeByCurrency(normalizedCurrency)}`,
      );
      this.upsertModeradoUserState({
        userId,
        stakeAmount,
        entryValue: entryValue || getMinStakeByCurrency(normalizedCurrency), // ✅ Moeda dinâmica
        derivToken: finalToken,
        currency: normalizedCurrency,
      });
      this.removeVelozUserState(userId);
      this.removePrecisoUserState(userId);
    } else if ((mode || '').toLowerCase() === 'preciso') {
      this.logger.log(
        `[ActivateAI] Sincronizando estado Preciso | stake=${stakeAmount} | entryValue=${entryValue || getMinStakeByCurrency(normalizedCurrency)}`,
      );
      this.upsertPrecisoUserState({
        userId,
        stakeAmount,
        entryValue: entryValue || getMinStakeByCurrency(normalizedCurrency), // ✅ Moeda dinâmica
        derivToken: finalToken,
        currency: normalizedCurrency,
      });
      this.removeVelozUserState(userId);
      this.removeModeradoUserState(userId);
    } else {
      this.removeVelozUserState(userId);
      this.removeModeradoUserState(userId);
      this.removePrecisoUserState(userId);
    }

    // ✅ Usar StrategyManager para ativar usuário na estratégia correta
    if (this.strategyManager) {
      try {
        this.logger.log(`[ActivateAI] 🔵 Ativando usuário ${userId} na estratégia ${strategy} via StrategyManager...`);
        await this.strategyManager.activateUser(userId, strategy, {
          mode: mode || 'veloz',
          stakeAmount, // Capital total da conta
          entryValue: entryValue || getMinStakeByCurrency(normalizedCurrency), // ✅ Moeda dinâmica
          derivToken: finalToken, // ✅ USAR TOKEN RESOLVIDO (finalToken) e não o argumento (derivToken)
          currency: normalizedCurrency,
          modoMartingale: modoMartingale || 'conservador',
          profitTarget: profitTarget || null,
          lossLimit: lossLimit || null,
          stopLossBlindado: stopLossBlindado, // ✅ ZENIX v2.0: Stop-Loss Blindado
          symbol: symbol, // ✅ ZENIX v2.0: Passar símbolo
        });
        this.logger.log(`[ActivateAI] ✅ Usuário ${userId} ativado na estratégia ${strategy}`);

        // ✅ Se for Trinity, sincronizar imediatamente para garantir que está carregado
        // TRINITY REMOVIDO

        if (strategy && strategy.toLowerCase() === 'atlas') {
          this.logger.log(`[ActivateAI] 🔄 Sincronizando Atlas imediatamente após ativação...`);
          await this.syncAtlasUsersFromDb();
        }
      } catch (error) {
        this.logger.error(`[ActivateAI] Erro ao ativar usuário na estratégia ${strategy}:`, error);
      }
    } else {
      // Fallback para código legado (manter compatibilidade)
      this.logger.warn('[ActivateAI] StrategyManager não disponível, usando código legado');
    }
  }

  /**
   * Desativa a IA para um usuário (desativa apenas a sessão ativa)
   */
  async deactivateUserAI(userId: string): Promise<void> {
    this.logger.log(`Desativando IA para usuário ${userId}`);

    // Desativar apenas a sessão ativa (is_active = TRUE)
    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET is_active = FALSE, 
           deactivation_reason = 'Desativação manual pelo usuário',
           deactivated_at = NOW(),
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND is_active = TRUE`,
      [userId],
    );

    this.logger.log(`IA desativada para usuário ${userId}`);

    // ✅ Usar StrategyManager para desativar usuário de todas as estratégias
    if (this.strategyManager) {
      await this.strategyManager.deactivateUser(userId);
    } else {
      // Fallback para código legado
      this.removeVelozUserState(userId);
      this.removeModeradoUserState(userId);
      this.removePrecisoUserState(userId);
      // TRINITY REMOVIDO
    }
  }

  /**
   * Atualiza configuração da IA de um usuário
   * ⚠️ ZENIX v2.0: BLOQUEIA mudanças durante sessão ativa!
   */
  async updateUserAIConfig(
    userId: string,
    stakeAmount?: number,
  ): Promise<void> {
    this.logger.log(`Atualizando configuração da IA para usuário ${userId}`);

    // ✅ VERIFICAR SE HÁ SESSÃO ATIVA
    const activeSession = await this.dataSource.query(
      `SELECT is_active, session_status 
       FROM ai_user_config 
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );

    if (activeSession && activeSession.length > 0) {
      throw new Error(
        '❌ Não é possível alterar configurações durante uma sessão ativa! ' +
        'Desative a IA primeiro para fazer mudanças.'
      );
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (stakeAmount !== undefined) {
      // Permite valores menores para cripto (BTC, etc)
      if (stakeAmount <= 0) {
        throw new Error('Valor de entrada deve ser maior que zero');
      }
      updates.push('stake_amount = ?');
      values.push(stakeAmount);
    }

    if (updates.length === 0) {
      throw new Error('Nenhuma configuração fornecida para atualizar');
    }

    values.push(userId);

    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND is_active = FALSE`,  // ✅ Só atualiza se NÃO ativa
      values,
    );

    // Se a IA está ativa e em modo veloz, atualizar o estado em memória
    const config = await this.getUserAIConfig(userId);
    if (config.isActive && (config.mode || '').toLowerCase() === 'veloz') {
      const state = this.velozUsers.get(userId);
      if (state && stakeAmount !== undefined) {
        state.capital = stakeAmount;
        if (state.virtualCapital <= 0) {
          state.virtualCapital = stakeAmount;
        }
        this.logger.log(
          `Estado em memória atualizado para usuário ${userId}: capital=${stakeAmount}`,
        );
      }
    }

    this.logger.log(`Configuração da IA atualizada para usuário ${userId}`);
  }

  /**
   * Busca configuração da IA de um usuário (apenas sessão ativa)
   */
  async getUserAIConfig(userId: string): Promise<any> {
    // ✅ Tentar buscar com entry_value primeiro, se não existir, buscar sem ele
    let result: any[];
    try {
      result = await this.dataSource.query(
        `SELECT 
          id,
          user_id as userId,
          is_active as isActive,
          session_status as sessionStatus,
          session_balance as sessionBalance,
          stake_amount as stakeAmount,
          entry_value as entryValue,
          currency,
          mode,
          modo_martingale as modoMartingale,
          strategy,
          profit_target as profitTarget,
          loss_limit as lossLimit,
          stop_blindado_percent as stopBlindadoPercent,
          last_trade_at as lastTradeAt,
          next_trade_at as nextTradeAt,
          total_trades as totalTrades,
          total_wins as totalWins,
          total_losses as totalLosses,
          deactivation_reason as deactivationReason,
          deactivated_at as deactivatedAt,
          created_at as createdAt,
          updated_at as updatedAt
         FROM ai_user_config 
         WHERE user_id = ? 
           AND (is_active = TRUE 
                OR session_status IN ('stopped_loss', 'stopped_profit'))
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId],
      );
    } catch (error: any) {
      // Se a coluna entry_value não existir, buscar sem ela
      if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('entry_value')) {
        this.logger.warn(`[GetUserAIConfig] Campo 'entry_value' não existe, buscando sem ele`);
        result = await this.dataSource.query(
          `SELECT 
            id,
            user_id as userId,
            is_active as isActive,
            session_status as sessionStatus,
            session_balance as sessionBalance,
            stake_amount as stakeAmount,
            currency,
            mode,
            modo_martingale as modoMartingale,
            strategy,
            profit_target as profitTarget,
            loss_limit as lossLimit,
            last_trade_at as lastTradeAt,
            next_trade_at as nextTradeAt,
            total_trades as totalTrades,
            total_wins as totalWins,
            total_losses as totalLosses,
            deactivation_reason as deactivationReason,
            deactivated_at as deactivatedAt,
            created_at as createdAt,
            updated_at as updatedAt
           FROM ai_user_config 
           WHERE user_id = ? 
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId],
        );
      } else {
        throw error;
      }
    }

    if (result.length === 0) {
      return {
        userId,
        isActive: false,
        stakeAmount: 10,
        entryValue: getMinStakeByCurrency('USD'), // ✅ Moeda dinâmica (padrão USD)
        currency: 'USD',
        mode: 'veloz',
        strategy: 'orion', // ✅ Estratégia padrão
        modoMartingale: 'conservador',
        profitTarget: null,
        lossLimit: null,
        sessionBalance: 0,
        sessionStatus: null,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        deactivationReason: null,
        deactivatedAt: null,
      };
    }

    const config = result[0];
    // ✅ Garantir que entryValue tenha um valor padrão se não existir
    if (config && (config.entryValue === null || config.entryValue === undefined)) {
      const currency = config.currency || 'USD';
      config.entryValue = getMinStakeByCurrency(currency);
    }
    // ✅ Garantir que strategy tenha um valor padrão se não existir
    if (config && (!config.strategy || config.strategy === null)) {
      config.strategy = 'orion';
    }
    return config;
  }

  /**
   * Conta quantos usuários têm IA ativa
   */
  async getActiveUsersCount(): Promise<number> {
    const result = await this.dataSource.query(
      'SELECT COUNT(*) as count FROM ai_user_config WHERE is_active = TRUE',
    );
    return result[0]?.count || 0;
  }

  /**
   * Processa apenas usuários em modo fast (chamado a cada 5 segundos para operação contínua)
   */
  async processFastModeUsers(): Promise<void> {
    try {
      this.logger.debug('🔍 [Fast Mode] Buscando usuários ativos...');
      const fastModeUsers = await this.dataSource.query(
        `SELECT 
                user_id as userId,
                stake_amount as stakeAmount,
                deriv_token as derivToken,
                currency,
                mode
             FROM ai_user_config 
             WHERE is_active = TRUE 
             AND LOWER(mode) = 'fast'`
      );

      this.logger.debug(`[Fast Mode] Encontrados ${fastModeUsers.length} usuários ativos`);

      if (fastModeUsers.length > 0) {
        for (const user of fastModeUsers) {
          try {
            this.logger.debug(`[Fast Mode] Processando usuário ${user.userId}...`);
            await this.processFastMode(user);
          } catch (error) {
            this.logger.error(
              `[Fast Mode] Erro ao processar usuário ${user.userId}:`,
              error,
            );
          }
        }
      } else {
        this.logger.debug('[Fast Mode] Nenhum usuário ativo encontrado');
      }
    } catch (error) {
      this.logger.error('[Fast Mode] Erro no processamento:', error);
    }
  }

  /**
   * Processa IAs em background (chamado pelo scheduler)
   * Verifica todos os usuários com IA ativa e executa operações quando necessário
   */
  async processBackgroundAIs(): Promise<void> {
    try {
      // Sincronizar usuários dos modos em tempo real
      await this.syncVelozUsersFromDb();
      await this.syncModeradoUsersFromDb();
      await this.syncPrecisoUsersFromDb();
      await this.syncAtlasUsersFromDb();

      // Process other users with trade timing logic (fast/moderado/preciso modes are handled separately)
      const usersToProcess = await this.dataSource.query(
        `SELECT 
                user_id as userId,
                stake_amount as stakeAmount,
                deriv_token as derivToken,
                currency,
                mode,
                next_trade_at as nextTradeAt
             FROM ai_user_config 
             WHERE is_active = TRUE 
             AND LOWER(mode) != 'fast'
             AND (next_trade_at IS NULL OR next_trade_at <= NOW())
             LIMIT 10`
      );

      if (usersToProcess.length > 0) {
        this.logger.log(
          `[Background AI] Processando ${usersToProcess.length} usuários agendados`
        );

        for (const user of usersToProcess) {
          try {
            await this.processUserAI(user);
          } catch (error) {
            this.logger.error(
              `[Background AI] Erro ao processar usuário ${user.userId}:`,
              error,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error('[Background AI] Erro no processamento:', error);
    }
  }
  /**
   * Processa a IA de um único usuário
   */
  private async processUserAI(user: any): Promise<void> {
    const { userId, stakeAmount, derivToken, currency, mode } = user;
    const normalizedMode = (mode || 'moderate').toLowerCase();

    this.logger.log(
      `[Background AI] Processando usuário ${userId} (modo: ${normalizedMode})`,
    );

    if (normalizedMode === 'veloz') {
      await this.prepareVelozUser(user);
      return;
    }

    if (normalizedMode === 'fast') {
      await this.processFastMode(user);
      return;
    }

    if (normalizedMode === 'lento' || normalizedMode === 'lenta') {
      // ✅ ORION: O modo lento é processado diretamente pelo OrionStrategy através de ticks em tempo real.
      // O background scheduler apenas mantém o estado ativo para o sincronizador.
      this.logger.debug(`[Background AI] Usuário ${userId} em modo LENTO ignorado pelo scheduler (processado em tempo real por orion.strategy)`);
      return;
    }

    this.logger.warn(
      `[Background AI] Modo ${normalizedMode} não suportado`,
    );

    await this.dataSource.query(
      'UPDATE ai_user_config SET next_trade_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE user_id = ?',
      [userId],
    );
  }
  private async processFastMode(user: any): Promise<void> {
    const { userId, stakeAmount, derivToken, currency } = user;

    try {
      this.logger.debug(`[Fast][${userId}] Iniciando processamento...`);
      this.logger.debug(`[Fast][${userId}] WebSocket conectado: ${this.isConnected}, Ticks disponíveis: ${this.ticks.length}`);

      // Garantir que temos dados suficientes
      await this.ensureTickStreamReady(FAST_MODE_CONFIG.window);

      this.logger.debug(`[Fast][${userId}] Ticks após ensureTickStreamReady: ${this.ticks.length}`);

      // Obter os últimos ticks
      const windowTicks = this.ticks.slice(-FAST_MODE_CONFIG.window);

      // Verificar se temos ticks suficientes
      if (windowTicks.length < FAST_MODE_CONFIG.window) {
        this.logger.warn(`[Fast][${userId}] Aguardando mais ticks (${windowTicks.length}/${FAST_MODE_CONFIG.window})`);
        return;
      }

      // Contar pares e ímpares na janela
      const evenCount = windowTicks.filter(t => t.parity === 'PAR').length;
      const oddCount = FAST_MODE_CONFIG.window - evenCount;

      // Determinar operação proposta baseada na maioria
      let proposedOperation: DigitParity | null = null;

      // Se há mais pares, propõe ímpar e vice-versa
      if (evenCount > oddCount) {
        proposedOperation = 'IMPAR';
      } else if (oddCount > evenCount) {
        proposedOperation = 'PAR';
      }

      // Se estiver equilibrado, não faz nada
      if (!proposedOperation) {
        this.logger.debug(`[Fast] Janela equilibrada: ${windowTicks.map(t => t.parity).join('-')} - aguardando desequilíbrio`);
        return;
      }

      // Calcular DVX
      const dvx = this.calculateDVX(this.ticks);
      if (dvx > FAST_MODE_CONFIG.dvxMax) {
        this.logger.warn(`[Fast] DVX alto (${dvx}) - operação bloqueada`);
        return;
      }

      // Executar operação
      this.logger.log(`[Fast] Executando operação: ${proposedOperation} | DVX: ${dvx} | Janela: ${windowTicks.map(t => t.parity).join('-')}`);

      // Calcular valor da aposta: usar stakeAmount diretamente ou calcular percentual, garantindo mínimo
      let betAmount = Number(stakeAmount);

      // Se stakeAmount parece ser capital (valor alto), calcular percentual
      if (betAmount > 10) {
        betAmount = betAmount * FAST_MODE_CONFIG.betPercent;
      }

      // Garantir valor mínimo da Deriv
      if (betAmount < FAST_MODE_CONFIG.minStake) {
        betAmount = FAST_MODE_CONFIG.minStake;
        this.logger.warn(`[Fast] Valor da aposta ajustado para o mínimo: ${betAmount}`);
      }

      const contractType = proposedOperation === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';

      const result = await this.executeTrade(userId, {
        contract_type: contractType,
        amount: betAmount,
        symbol: 'R_10',
        duration: 1,
        duration_unit: 't',
        currency: currency || 'USD',
        token: derivToken
      });

      if (!result.success) {
        this.logger.error(`[Fast] Falha ao executar trade: ${result.error}`);
        return;
      }

      this.logger.log(`[Fast] Operação executada com sucesso: ${result.tradeId}`);
    } catch (error) {
      this.logger.error(`[Fast] Erro ao processar modo rápido: ${error.message}`, error.stack);
    } finally {
      // Removido o atraso para processamento contínuo
      await this.dataSource.query(
        `UPDATE ai_user_config 
             SET next_trade_at = NOW(), updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?`,
        [userId],
      );
    }
  }

  private async executeTrade(userId: string, params: any): Promise<{ success: boolean; tradeId?: string; error?: string }> {
    const tradeStartTime = Date.now();
    const tradeId = `trade_${userId}_${tradeStartTime}`;

    try {
      this.logger.log(`[${tradeId}] Iniciando execução de trade`, {
        userId,
        contractType: params.contract_type,
        amount: params.amount,
        symbol: params.symbol,
        timestamp: new Date().toISOString()
      });

      // Use WebSocket to execute the trade
      const result = await this.executeTradeViaWebSocket(params.token, {
        price: params.amount,
        currency: params.currency || 'USD',
        symbol: params.symbol,
        contract_type: params.contract_type,
        duration: params.duration || 1,
        duration_unit: params.duration_unit || 't',
      }, tradeId);

      if (result.error) {
        throw new Error(result.error);
      }

      // Registrar a operação no banco de dados
      const tradeRecordId = await this.recordTrade({
        userId,
        contractType: params.contract_type,
        amount: params.amount,
        symbol: params.symbol,
        status: 'PENDING',
        entryPrice: this.ticks[this.ticks.length - 1]?.value || 0,
        duration: params.duration || 1,
        durationUnit: params.duration_unit || 't',
        contractId: result.contract_id
      });

      // Iniciar monitoramento do contrato
      if (result.contract_id && tradeRecordId) {
        this.monitorContract(result.contract_id, tradeRecordId, params.token).catch(error => {
          this.logger.error(`[${tradeId}] Erro ao iniciar monitoramento do contrato: ${error.message}`);
        });
      }

      return {
        success: true,
        tradeId: result.contract_id || tradeId
      };
    } catch (error) {
      const errorMessage = error.message || 'Erro desconhecido';
      this.logger.error(`[${tradeId}] Falha na execução do trade: ${errorMessage}`, error.stack);

      try {
        await this.recordTrade({
          userId,
          contractType: params.contract_type,
          amount: params.amount,
          symbol: params.symbol,
          status: 'ERROR',
          entryPrice: this.ticks[this.ticks.length - 1]?.value || 0,
          error: errorMessage.substring(0, 255),
          duration: params.duration || 1,
          durationUnit: params.duration_unit || 't'
        });
      } catch (dbError) {
        this.logger.error(`[${tradeId}] Falha ao registrar erro no banco de dados: ${dbError.message}`);
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  private async executeTradeViaWebSocket(token: string, contractParams: any, tradeId: string): Promise<{ contract_id?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket.WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      let authorized = false;
      let proposalReceived = false;
      let proposalId: string | null = null;
      let proposalPrice: number | null = null;
      let proposalSubscriptionId: string | null = null;

      const timeout = setTimeout(() => {
        if (proposalSubscriptionId) {
          try {
            ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
          } catch (e) {
            // Ignore
          }
        }
        ws.close();
        reject(new Error('Timeout ao executar trade'));
      }, 30000); // 30 seconds timeout

      ws.on('open', () => {
        this.logger.debug(`[${tradeId}] WebSocket conectado, autorizando...`);
        ws.send(JSON.stringify({ authorize: token }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.authorize) {
            if (msg.authorize.error) {
              clearTimeout(timeout);
              ws.close();
              reject(new Error(`Autorização falhou: ${msg.authorize.error.message || 'Erro desconhecido'}`));
              return;
            }
            authorized = true;
            this.logger.debug(`[${tradeId}] Autorizado, subscrevendo proposta...`);

            // Subscribe to proposal
            const proposalPayload = {
              proposal: 1,
              amount: contractParams.price,
              basis: 'stake',
              contract_type: contractParams.contract_type,
              currency: contractParams.currency || 'USD',
              duration: contractParams.duration || 1,
              duration_unit: contractParams.duration_unit || 't',
              symbol: contractParams.symbol,
              subscribe: 1,
            };

            ws.send(JSON.stringify(proposalPayload));
            return;
          }

          if (msg.proposal) {
            const proposal = msg.proposal;
            if (proposal.error) {
              clearTimeout(timeout);
              if (proposalSubscriptionId) {
                try {
                  ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
                } catch (e) {
                  // Ignore
                }
              }
              ws.close();
              reject(new Error(proposal.error.message || 'Erro ao obter proposta'));
              return;
            }

            proposalId = proposal.id;
            proposalPrice = Number(proposal.ask_price);
            proposalReceived = true;

            if (msg.subscription?.id) {
              proposalSubscriptionId = msg.subscription.id;
            }

            this.logger.debug(`[${tradeId}] Proposta recebida`, {
              proposal_id: proposalId,
              price: proposalPrice
            });

            // Now send buy request
            const buyPayload = {
              buy: proposalId,
              price: proposalPrice,
            };

            this.logger.debug(`[${tradeId}] Enviando buy request...`);
            ws.send(JSON.stringify(buyPayload));
            return;
          }

          if (msg.buy) {
            clearTimeout(timeout);

            // Unsubscribe from proposal
            if (proposalSubscriptionId) {
              try {
                ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
              } catch (e) {
                // Ignore
              }
            }

            ws.close();

            if (msg.buy.error) {
              reject(new Error(msg.buy.error.message || 'Erro ao executar trade'));
              return;
            }

            this.logger.debug(`[${tradeId}] Trade executado com sucesso`, {
              contract_id: msg.buy.contract_id,
              buy_price: msg.buy.buy_price
            });

            resolve({ contract_id: msg.buy.contract_id });
            return;
          }

          if (msg.error) {
            clearTimeout(timeout);
            if (proposalSubscriptionId) {
              try {
                ws.send(JSON.stringify({ forget: proposalSubscriptionId }));
              } catch (e) {
                // Ignore
              }
            }
            ws.close();
            reject(new Error(msg.error.message || 'Erro desconhecido'));
            return;
          }
        } catch (error) {
          this.logger.error(`[${tradeId}] Erro ao processar mensagem: ${error.message}`);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error(`[${tradeId}] Erro no WebSocket: ${error.message}`);
        reject(new Error(`Erro de conexão: ${error.message}`));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (!authorized) {
          reject(new Error('Conexão fechada antes da autorização'));
        }
      });
    });
  }

  private async recordTrade(trade: any): Promise<number | null> {
    // ✅ Tentar inserir com symbol, se falhar, inserir sem symbol (campo pode não existir ainda)
    let insertResult: any;
    try {
      insertResult = await this.dataSource.query(
        `INSERT INTO ai_trades 
           (user_id, gemini_signal, entry_price, stake_amount, status, 
            gemini_duration, contract_type, contract_id, created_at, analysis_data, symbol)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          trade.userId,
          trade.contractType,
          trade.entryPrice,
          trade.amount,
          trade.status,
          trade.duration || 1,
          trade.contractType,
          trade.contractId || null,
          JSON.stringify({
            mode: 'fast',
            timestamp: new Date().toISOString(),
            dvx: this.calculateDVX(this.ticks),
            duration_unit: trade.durationUnit || 't',
            ...(trade.error && { error: trade.error })
          }),
          this.symbol,
        ]
      );
    } catch (error: any) {
      // Se o campo symbol não existir, inserir sem ele
      if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
        this.logger.warn(`[RecordTrade] Campo 'symbol' não existe, inserindo sem ele. Execute o script SQL: backend/db/add_symbol_to_ai_trades.sql`);
        insertResult = await this.dataSource.query(
          `INSERT INTO ai_trades 
             (user_id, gemini_signal, entry_price, stake_amount, status, 
              gemini_duration, contract_type, contract_id, created_at, analysis_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
          [
            trade.userId,
            trade.contractType,
            trade.entryPrice,
            trade.amount,
            trade.status,
            trade.duration || 1,
            trade.contractType,
            trade.contractId || null,
            JSON.stringify({
              mode: 'fast',
              timestamp: new Date().toISOString(),
              dvx: this.calculateDVX(this.ticks),
              duration_unit: trade.durationUnit || 't',
              ...(trade.error && { error: trade.error })
            }),
          ]
        );
      } else {
        throw error;
      }
    }

    // TypeORM pode retornar array ou objeto direto
    const result = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    return result?.insertId || null;
  }

  private async monitorContract(contractId: string, tradeId: number, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket.WebSocket(endpoint, {
        headers: {
          Origin: 'https://app.deriv.com',
        },
      });

      let authorized = false;
      let contractSubscriptionId: string | null = null;
      const timeout = setTimeout(() => {
        if (contractSubscriptionId) {
          try {
            ws.send(JSON.stringify({ forget: contractSubscriptionId }));
          } catch (e) {
            // Ignore
          }
        }
        ws.close();
        reject(new Error('Timeout ao monitorar contrato'));
      }, 120000); // 2 minutes timeout (contratos de 1 tick duram pouco)

      ws.on('open', () => {
        this.logger.debug(`[Monitor] Conectando para monitorar contrato ${contractId}...`);
        ws.send(JSON.stringify({ authorize: token }));
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.authorize) {
            if (msg.authorize.error) {
              clearTimeout(timeout);
              ws.close();
              reject(new Error(`Autorização falhou: ${msg.authorize.error.message || 'Erro desconhecido'}`));
              return;
            }
            authorized = true;
            this.logger.debug(`[Monitor] Autorizado, subscrevendo contrato ${contractId}...`);

            // Subscribe to contract
            ws.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: contractId,
              subscribe: 1,
            }));
            return;
          }

          if (msg.proposal_open_contract) {
            const contract = msg.proposal_open_contract;

            if (msg.subscription?.id) {
              contractSubscriptionId = msg.subscription.id;
            }

            // Check if contract is sold
            if (contract.is_sold === 1) {
              clearTimeout(timeout);

              const profit = Number(contract.profit || 0);
              const exitPrice = Number(contract.exit_spot || contract.current_spot || 0);
              const status = profit >= 0 ? 'WON' : 'LOST';

              this.logger.log(`[Monitor] Contrato ${contractId} fechado | tradeId=${tradeId} | exitPrice=${exitPrice} | profit=${profit} | status=${status}`);

              // Update database
              // Update database with authoritative entry/exit prices
              const entryPrice = Number(contract.entry_tick || contract.entry_spot || 0);

              const updateQuery = `
                UPDATE ai_trades
                SET 
                  exit_price = ?, 
                  entry_price = CASE WHEN ? > 0 THEN ? ELSE entry_price END,
                  profit_loss = ?, 
                  status = ?, 
                  closed_at = NOW()
                WHERE id = ?
              `;

              await this.dataSource.query(updateQuery, [
                exitPrice,
                entryPrice, entryPrice, // Only update entry_price if we have a valid value
                profit,
                status,
                tradeId
              ]);

              this.logger.log(`[Monitor] ✅ exit_price atualizado no banco | tradeId=${tradeId} | exitPrice=${exitPrice}`);

              // Buscar dados da operação para replicação
              const tradeData = await this.dataSource.query(
                `SELECT user_id, contract_type, stake_amount, created_at 
                             FROM ai_trades WHERE id = ?`,
                [tradeId],
              );



              // Unsubscribe
              if (contractSubscriptionId) {
                try {
                  ws.send(JSON.stringify({ forget: contractSubscriptionId }));
                } catch (e) {
                  // Ignore
                }
              }

              ws.close();
              resolve();
              return;
            }
          }

          if (msg.error) {
            clearTimeout(timeout);
            if (contractSubscriptionId) {
              try {
                ws.send(JSON.stringify({ forget: contractSubscriptionId }));
              } catch (e) {
                // Ignore
              }
            }
            ws.close();
            reject(new Error(msg.error.message || 'Erro desconhecido'));
            return;
          }
        } catch (error) {
          this.logger.error(`[Monitor] Erro ao processar mensagem: ${error.message}`);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error(`[Monitor] Erro no WebSocket: ${error.message}`);
        reject(new Error(`Erro de conexão: ${error.message}`));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (!authorized) {
          reject(new Error('Conexão fechada antes da autorização'));
        }
      });
    });
  }

  private async prepareVelozUser(user: any): Promise<void> {
    const { userId, stakeAmount, derivToken, currency } = user;

    try {
      // ✅ Usar apenas o mínimo necessário (VELOZ_CONFIG.window) para validação inicial
      // A análise precisa apenas de VELOZ_CONFIG.window ticks (~10 ticks)
      await this.ensureTickStreamReady(VELOZ_CONFIG.window);
    } catch (error) {
      this.logger.warn(
        `[Veloz] Não foi possível garantir histórico completo para usuário ${userId}: ${error.message}`,
      );
    }

    this.upsertVelozUserState({
      userId,
      stakeAmount: Number(stakeAmount) || 0,
      derivToken,
      currency: currency || 'USD',
    });

    const nextTradeAt = new Date(Date.now() + 15000); // Reprocessar em 15s

    await this.dataSource.query(
      `UPDATE ai_user_config 
       SET next_trade_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [nextTradeAt, userId],
    );

    this.logger.log(
      `[Veloz] Usuário ${userId} sincronizado | capital=${stakeAmount} | acompanhados=${this.velozUsers.size}`,
    );
  }

  /**
   * Obtém estatísticas do StatsIAs (com fallback para estatísticas locais)
   */
  async getStatsIAsData() {
    try {
      // Tentar buscar da API externa primeiro
      const externalStats = await this.statsIAsService.fetchStats();

      if (externalStats) {
        return {
          source: 'external',
          data: externalStats,
        };
      }

      // Fallback para estatísticas locais
      const localStats = await this.statsIAsService.getLocalAggregatedStats(
        this.dataSource,
      );

      return {
        source: 'local',
        data: localStats,
      };
    } catch (error) {
      this.logger.error('Erro ao buscar estatísticas do StatsIAs:', error);

      // Último recurso: estatísticas locais
      try {
        const localStats = await this.statsIAsService.getLocalAggregatedStats(
          this.dataSource,
        );
        return {
          source: 'local',
          data: localStats,
        };
      } catch (localError) {
        this.logger.error('Erro ao buscar estatísticas locais:', localError);
        return {
          source: 'error',
          data: null,
          error: 'Não foi possível obter estatísticas',
        };
      }
    }
  }

  /**
   * Busca saldo da conta Deriv via WebSocket
   */
  async getDerivBalance(derivToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
      const ws = new WebSocket.WebSocket(endpoint);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout ao buscar saldo da Deriv'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: derivToken }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.error.message || 'Erro ao buscar saldo'));
            return;
          }

          if (msg.authorize) {
            ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
            return;
          }

          if (msg.balance) {
            clearTimeout(timeout);
            ws.close();
            resolve({
              balance: Number(msg.balance.balance),
              currency: msg.balance.currency,
              loginid: msg.balance.loginid,
            });
            return;
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Busca estatísticas do dashboard do usuário
   */
  async getUserDashboardStats(userId: string): Promise<any> {
    const config = await this.getUserAIConfig(userId);
    const sessionStats = await this.getSessionStats(userId);

    // Buscar total de operações (não só do dia)
    const totalStats = await this.dataSource.query(
      `SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as totalWins,
        SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as totalLosses,
        SUM(COALESCE(profit_loss, 0)) as totalProfitLoss
      FROM ai_trades
      WHERE user_id = ? 
        AND status IN ('WON', 'LOST')`,
      [userId],
    );

    const stats = totalStats[0];

    return {
      isActive: config.isActive || false,
      stakeAmount: config.stakeAmount || 0,
      mode: config.mode || 'veloz',
      profitTarget: config.profitTarget,
      lossLimit: config.lossLimit,

      // Estatísticas do dia
      today: {
        trades: sessionStats.totalTrades,
        profitLoss: sessionStats.profitLoss,
        wins: sessionStats.wins,
        losses: sessionStats.losses,
      },

      // Estatísticas totais
      total: {
        trades: parseInt(stats.totalTrades) || 0,
        wins: parseInt(stats.totalWins) || 0,
        losses: parseInt(stats.totalLosses) || 0,
        profitLoss: parseFloat(stats.totalProfitLoss) || 0,
      },
    };
  }

  /**
   * Busca histórico de sessões do usuário
   */
  async getUserSessions(userId: string, limit: number = 10): Promise<any[]> {
    this.logger.log(`[GetUserSessions] 📊 Buscando histórico de sessões para userId=${userId}`);

    // Buscar todas as sessões (ativas e inativas)
    const sessions = await this.dataSource.query(
      `SELECT 
        id,
        is_active as isActive,
        session_status as sessionStatus,
        session_balance as sessionBalance,
        stake_amount as stakeAmount,
        currency,
        mode,
        profit_target as profitTarget,
        loss_limit as lossLimit,
        total_trades as totalTrades,
        total_wins as totalWins,
        total_losses as totalLosses,
        deactivation_reason as deactivationReason,
        deactivated_at as deactivatedAt,
        created_at as createdAt,
        updated_at as updatedAt
       FROM ai_user_config 
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit],
    );

    // Para cada sessão, buscar estatísticas de trades
    const sessionsWithStats = await Promise.all(
      sessions.map(async (session) => {
        const tradeStats = await this.dataSource.query(
          `SELECT 
            COUNT(*) as totalTrades,
            SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
            SUM(COALESCE(profit_loss, 0)) as profitLoss,
            SUM(COALESCE(stake_amount, 0)) as volume,
            MIN(created_at) as firstTrade,
            MAX(COALESCE(closed_at, created_at)) as lastTrade
           FROM ai_trades
           WHERE user_id = ?
             AND created_at >= ?
             AND (? IS NULL OR created_at <= ?)
             AND status IN ('WON', 'LOST')`,
          [
            userId,
            session.createdAt,
            session.deactivatedAt || null,
            session.deactivatedAt || null,
          ],
        );

        const stats = tradeStats[0];
        const totalTrades = parseInt(stats.totalTrades) || 0;
        const wins = parseInt(stats.wins) || 0;
        const losses = parseInt(stats.losses) || 0;
        const profitLoss = parseFloat(stats.profitLoss) || 0;
        const volume = parseFloat(stats.volume) || 0;
        const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        // Calcular duração da sessão
        const startTime = new Date(session.createdAt);
        const endTime = session.deactivatedAt
          ? new Date(session.deactivatedAt)
          : new Date();
        const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000);

        return {
          sessionId: session.id,
          isActive: Boolean(session.isActive),
          sessionStatus: session.sessionStatus || 'active',
          sessionBalance: session.sessionBalance ? parseFloat(session.sessionBalance) : profitLoss, // Usar saldo do banco ou calcular
          stakeAmount: parseFloat(session.stakeAmount),
          currency: session.currency,
          mode: session.mode,
          profitTarget: session.profitTarget ? parseFloat(session.profitTarget) : null,
          lossLimit: session.lossLimit ? parseFloat(session.lossLimit) : null,

          // Estatísticas
          stats: {
            totalTrades,
            wins,
            losses,
            profitLoss,
            volume,
            winrate: parseFloat(winrate.toFixed(2)),
          },

          // Datas
          createdAt: session.createdAt,
          deactivatedAt: session.deactivatedAt,
          durationMinutes,

          // Motivo de desativação
          deactivationReason: session.deactivationReason,
        };
      }),
    );

    this.logger.log(`[GetUserSessions] ✅ ${sessionsWithStats.length} sessões processadas`);

    return sessionsWithStats;
  }

  /**
   * Usa estatísticas do StatsIAs para ajustar parâmetros de trading
   * (pode ser usado para ajustar dinamicamente DVX, window, etc.)
   */
  async getAdjustedTradingParams(): Promise<{
    dvxMax: number;
    window: number;
    betPercent: number;
  }> {
    try {
      const stats = await this.statsIAsService.fetchStats();

      if (!stats || !stats.winRate) {
        // Retornar valores padrão se não houver estatísticas
        return {
          dvxMax: VELOZ_CONFIG.dvxMax,
          window: VELOZ_CONFIG.window,
          betPercent: VELOZ_CONFIG.betPercent,
        };
      }

      // Ajustar parâmetros baseado no win rate
      // Se win rate está alto (>60%), podemos ser mais agressivos
      // Se win rate está baixo (<50%), ser mais conservador
      let dvxMax = VELOZ_CONFIG.dvxMax;
      let betPercent = VELOZ_CONFIG.betPercent;

      if (stats.winRate > 60) {
        // Win rate alto: ser mais agressivo
        dvxMax = Math.min(80, VELOZ_CONFIG.dvxMax + 10);
        betPercent = Math.min(0.01, VELOZ_CONFIG.betPercent * 1.5);
      } else if (stats.winRate < 50) {
        // Win rate baixo: ser mais conservador
        dvxMax = Math.max(50, VELOZ_CONFIG.dvxMax - 10);
        betPercent = Math.max(0.003, VELOZ_CONFIG.betPercent * 0.7);
      }

      this.logger.debug(
        `Parâmetros ajustados baseados em win rate ${stats.winRate}%: DVX=${dvxMax}, Bet=${betPercent}`,
      );

      return {
        dvxMax,
        window: VELOZ_CONFIG.window,
        betPercent,
      };
    } catch (error) {
      this.logger.error('Erro ao ajustar parâmetros de trading:', error);
      return {
        dvxMax: VELOZ_CONFIG.dvxMax,
        window: VELOZ_CONFIG.window,
        betPercent: VELOZ_CONFIG.betPercent,
      };
    }
  }

  // ======================== MODO MODERADO ========================

  /**
   * Processa estratégias do modo MODERADO para todos os usuários ativos
   */
  /**
   * ZENIX v2.0: Processamento de estratégia Moderado
   * - Amostra inicial: 20 ticks
   * - Intervalo entre operações: 17 segundos
   * - Desequilíbrio mínimo: 60%
   * - Confiança mínima: 60%
   */
  private async processModeradoStrategies(latestTick: Tick): Promise<void> {
    if (this.moderadoUsers.size === 0) {
      return;
    }

    // ✅ DEBUG: Logar quantos usuários estão sendo processados
    this.logger.debug(`[Moderado] Processando ${this.moderadoUsers.size} usuário(s) ativo(s)`);

    // ✅ ZENIX v2.0: Verificar amostra mínima
    if (this.ticks.length < MODERADO_CONFIG.amostraInicial) {
      this.logger.debug(
        `[Moderado][ZENIX] Coletando amostra inicial (${this.ticks.length}/${MODERADO_CONFIG.amostraInicial})`,
      );
      return;
    }

    // Processar cada usuário
    for (const [userId, state] of this.moderadoUsers.entries()) {
      // Pular se já tem operação ativa (martingale)
      if (state.isOperationActive) {
        continue;
      }

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        // Verificar se pode continuar com martingale
        const canProcess = await this.canProcessModeradoState(state);
        if (!canProcess) {
          continue;
        }

        // Verificar intervalo entre operações (15-20 segundos)
        if (state.lastOperationTimestamp) {
          const segundosDesdeUltimaOp = (Date.now() - state.lastOperationTimestamp.getTime()) / 1000;
          if (segundosDesdeUltimaOp < MODERADO_CONFIG.intervaloSegundos) {
            this.logger.debug(
              `[Moderado][${userId}] ⏱️ Aguardando intervalo (martingale): ${segundosDesdeUltimaOp.toFixed(1)}/${MODERADO_CONFIG.intervaloSegundos}s`,
            );
            continue;
          }
        }

        // Continuar com martingale usando a mesma direção
        const proximaEntrada = state.martingaleStep + 1;
        this.logger.log(
          `[Moderado][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );

        await this.executeModeradoOperation(state, state.ultimaDirecaoMartingale, proximaEntrada);
        continue;
      }

      // Verificar se pode processar
      const canProcess = await this.canProcessModeradoState(state);
      if (!canProcess) {
        continue;
      }

      // ✅ ZENIX v2.0: Verificar intervalo entre operações (15-20 segundos)
      if (state.lastOperationTimestamp) {
        const segundosDesdeUltimaOp = (Date.now() - state.lastOperationTimestamp.getTime()) / 1000;
        if (segundosDesdeUltimaOp < MODERADO_CONFIG.intervaloSegundos) {
          this.logger.debug(
            `[Moderado][${userId}] ⏱️ Aguardando intervalo: ${segundosDesdeUltimaOp.toFixed(1)}/${MODERADO_CONFIG.intervaloSegundos}s`,
          );
          continue;
        }
      }

      // ✅ ZENIX v2.0: Gerar sinal usando análise completa
      const sinal = gerarSinalZenix(this.ticks, MODERADO_CONFIG, 'MODERADO');

      if (!sinal || !sinal.sinal) {
        continue; // Sem sinal válido
      }

      this.logger.log(
        `[Moderado][ZENIX] 🎯 SINAL GERADO | User: ${userId} | ` +
        `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%\n` +
        `  └─ ${sinal.motivo}`,
      );

      // 📋 SALVAR LOGS DETALHADOS DA ANÁLISE (4 ANÁLISES COMPLETAS)
      this.saveLogAsync(userId, 'analise', '🔍 ANÁLISE ZENIX v2.0');

      // Formatar distribuição
      const deseq = sinal.detalhes?.desequilibrio;
      if (deseq) {
        const percPar = (deseq.percentualPar * 100).toFixed(1);
        const percImpar = (deseq.percentualImpar * 100).toFixed(1);
        this.saveLogAsync(userId, 'analise', `Distribuição: PAR ${percPar}% | ÍMPAR ${percImpar}%`);
        this.saveLogAsync(userId, 'analise', `Desequilíbrio: ${(deseq.desequilibrio * 100).toFixed(1)}% ${deseq.percentualPar > deseq.percentualImpar ? 'PAR' : 'ÍMPAR'}`);
      }


      // ANÁLISE 1: Desequilíbrio Base
      this.saveLogAsync(userId, 'analise', `🔢 ANÁLISE 1: Desequilíbrio Base`);
      this.saveLogAsync(userId, 'analise', `├─ ${deseq?.percentualPar > deseq?.percentualImpar ? 'PAR' : 'ÍMPAR'}: ${(Math.max(deseq?.percentualPar || 0, deseq?.percentualImpar || 0) * 100).toFixed(1)}% → Operar ${sinal.sinal}`);
      this.saveLogAsync(userId, 'analise', `└─ Confiança base: ${sinal.detalhes?.confiancaBase?.toFixed(1) || sinal.confianca.toFixed(1)}%`);


      // ANÁLISE 2: Sequências Repetidas
      const seqInfo = sinal.detalhes?.sequencias;
      const bonusSeq = seqInfo?.bonus || 0;
      this.saveLogAsync(userId, 'analise', `🔁 ANÁLISE 2: Sequências Repetidas`);
      if (seqInfo && seqInfo.tamanho >= 5) {
        this.saveLogAsync(userId, 'analise', `├─ Sequência detectada: ${seqInfo.tamanho} ticks ${seqInfo.paridade}`);
        this.saveLogAsync(userId, 'analise', `└─ Bônus: +${bonusSeq}% ✅`);
      } else {
        this.saveLogAsync(userId, 'analise', `├─ Nenhuma sequência longa (< 5 ticks)`);
        this.saveLogAsync(userId, 'analise', `└─ Bônus: +0%`);
      }


      // ANÁLISE 3: Micro-Tendências
      const microInfo = sinal.detalhes?.microTendencias;
      const bonusMicro = microInfo?.bonus || 0;
      this.saveLogAsync(userId, 'analise', `📈 ANÁLISE 3: Micro-Tendências`);
      if (microInfo && microInfo.aceleracao > 0.10) {
        this.saveLogAsync(userId, 'analise', `├─ Aceleração: ${(microInfo.aceleracao * 100).toFixed(1)}%`);
        this.saveLogAsync(userId, 'analise', `└─ Bônus: +${bonusMicro}% ✅`);
      } else {
        this.saveLogAsync(userId, 'analise', `├─ Aceleração baixa (< 10%)`);
        this.saveLogAsync(userId, 'analise', `└─ Bônus: +0%`);
      }


      // ANÁLISE 4: Força do Desequilíbrio
      const forcaInfo = sinal.detalhes?.forca;
      const bonusForca = forcaInfo?.bonus || 0;
      this.saveLogAsync(userId, 'analise', `⚡ ANÁLISE 4: Força do Desequilíbrio`);
      if (forcaInfo && forcaInfo.velocidade > 0.05) {
        this.saveLogAsync(userId, 'analise', `├─ Velocidade: ${(forcaInfo.velocidade * 100).toFixed(1)}%`);
        this.saveLogAsync(userId, 'analise', `└─ Bônus: +${bonusForca}% ✅`);
      } else {
        this.saveLogAsync(userId, 'analise', `├─ Velocidade baixa (< 5%)`);
        this.saveLogAsync(userId, 'analise', `└─ Bônus: +0%`);
      }

      this.saveLogAsync(userId, 'analise', `🎯 CONFIANÇA FINAL: ${sinal.confianca.toFixed(1)}%`);
      this.saveLogAsync(userId, 'analise', `└─ Base ${sinal.detalhes?.confiancaBase?.toFixed(1) || 0}% + Bônus ${bonusSeq + bonusMicro + bonusForca}% = ${sinal.confianca.toFixed(1)}%`);

      this.saveLogAsync(userId, 'sinal', `✅ SINAL GERADO: ${sinal.sinal}`);
      this.saveLogAsync(userId, 'sinal', `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%`);

      // Executar operação
      await this.executeModeradoOperation(state, sinal.sinal, 1);
    }
  }

  /**
   * Detecta anomalias nos últimos N ticks
   */
  private detectAnomalies(recentTicks: Tick[]): boolean {
    if (recentTicks.length < MODERADO_CONFIG.anomalyWindow) {
      return false;
    }

    // 1. Verificar alternância perfeita (P-I-P-I-P-I...)
    let alternations = 0;
    for (let i = 1; i < recentTicks.length; i++) {
      if (recentTicks[i].parity !== recentTicks[i - 1].parity) {
        alternations++;
      }
    }
    if (alternations >= MODERADO_CONFIG.anomalyAlternationMin) {
      this.logger.warn(`[Moderado][Anomalia] Alternância perfeita detectada: ${alternations} alternâncias`);
      return true;
    }

    // 2. Verificar repetição excessiva do mesmo dígito
    const digitCounts = new Map<number, number>();
    for (const tick of recentTicks) {
      digitCounts.set(tick.digit, (digitCounts.get(tick.digit) || 0) + 1);
    }
    for (const [digit, count] of digitCounts.entries()) {
      if (count >= MODERADO_CONFIG.anomalyRepetitionMin) {
        this.logger.warn(`[Moderado][Anomalia] Repetição excessiva: dígito ${digit} apareceu ${count} vezes`);
        return true;
      }
    }

    // 3. Verificar homogeneidade (todos PAR ou todos ÍMPAR)
    const parCount = recentTicks.filter(t => t.parity === 'PAR').length;
    const imparCount = recentTicks.filter(t => t.parity === 'IMPAR').length;
    if (parCount >= MODERADO_CONFIG.anomalyHomogeneityMin ||
      imparCount >= MODERADO_CONFIG.anomalyHomogeneityMin) {
      this.logger.warn(`[Moderado][Anomalia] Homogeneidade detectada: PAR=${parCount}, IMPAR=${imparCount}`);
      return true;
    }

    return false;
  }

  /**
   * Valida tendência geral nos últimos N ticks
   */
  private validateTrend(proposal: DigitParity, trendTicks: Tick[]): boolean {
    if (trendTicks.length < MODERADO_CONFIG.trendWindow) {
      return false;
    }

    const parCount = trendTicks.filter(t => t.parity === 'PAR').length;
    const imparCount = trendTicks.filter(t => t.parity === 'IMPAR').length;
    const total = trendTicks.length;

    const parPercent = parCount / total;
    const imparPercent = imparCount / total;

    // Se vai entrar em ÍMPAR, precisa ter 60%+ de PAR na tendência
    if (proposal === 'IMPAR') {
      if (parPercent >= MODERADO_CONFIG.trendPercent) {
        this.logger.debug(`[Moderado][Tendência] OK para IMPAR: ${(parPercent * 100).toFixed(0)}% PAR nos últimos ${total} ticks`);
        return true;
      }
      this.logger.warn(`[Moderado][Tendência] Insuficiente para IMPAR: apenas ${(parPercent * 100).toFixed(0)}% PAR`);
      return false;
    }

    // Se vai entrar em PAR, precisa ter 60%+ de ÍMPAR na tendência
    if (proposal === 'PAR') {
      if (imparPercent >= MODERADO_CONFIG.trendPercent) {
        this.logger.debug(`[Moderado][Tendência] OK para PAR: ${(imparPercent * 100).toFixed(0)}% IMPAR nos últimos ${total} ticks`);
        return true;
      }
      this.logger.warn(`[Moderado][Tendência] Insuficiente para PAR: apenas ${(imparPercent * 100).toFixed(0)}% IMPAR`);
      return false;
    }

    return false;
  }

  /**
   * Verifica se pode processar o estado do usuário no modo moderado
   * ✅ ZENIX v2.0: Verifica limites ANTES de executar operação
   */
  private async canProcessModeradoState(state: ModeradoUserState): Promise<boolean> {
    if (state.isOperationActive) {
      this.logger.debug(
        `[Moderado][${state.userId}] Operação em andamento - aguardando finalização`,
      );
      return false;
    }
    if (!state.derivToken) {
      this.logger.warn(
        `[Moderado][${state.userId}] Usuário sem token Deriv configurado - ignorando`,
      );
      return false;
    }
    if ((state.virtualCapital || state.capital) <= 0) {
      this.logger.warn(
        `[Moderado][${state.userId}] Usuário sem capital configurado - ignorando`,
      );
      return false;
    }

    // ✅ ZENIX v2.0: Verificar limites ANTES de executar operação
    try {
      const configResult = await this.dataSource.query(
        `SELECT 
          session_status, 
          is_active,
          profit_target,
          loss_limit,
          COALESCE(session_balance, 0) as sessionBalance
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [state.userId],
      );

      if (!configResult || configResult.length === 0) {
        // Não há sessão ativa
        this.logger.warn(
          `[Moderado][${state.userId}] Nenhuma sessão ativa encontrada - não executando novos trades`,
        );
        return false;
      }

      const config = configResult[0];

      // Verificar se já foi parada
      if (config.session_status === 'stopped_profit' || config.session_status === 'stopped_loss' || config.session_status === 'stopped_blindado') {
        this.logger.warn(
          `[Moderado][${state.userId}] Sessão parada (${config.session_status}) - não executando novos trades`,
        );
        return false;
      }

      // ✅ VERIFICAR LIMITES ANTES DE OPERAR
      const sessionBalance = parseFloat(config.sessionBalance) || 0;
      const profitTarget = parseFloat(config.profit_target) || null;
      const lossLimit = parseFloat(config.loss_limit) || null;

      // Se atingiu take profit (stop win)
      if (profitTarget && sessionBalance >= profitTarget) {
        this.logger.warn(
          `[Moderado][${state.userId}] 🎯 STOP WIN ATINGIDO! Saldo: $${sessionBalance.toFixed(2)} >= Meta: $${profitTarget} - PARANDO IMEDIATAMENTE`,
        );
        // Desativar imediatamente
        await this.checkAndEnforceLimits(state.userId);
        return false;
      }

      // Se atingiu stop loss
      if (lossLimit && sessionBalance <= -lossLimit) {
        this.logger.warn(
          `[Moderado][${state.userId}] 🛑 STOP LOSS ATINGIDO! Saldo: -$${Math.abs(sessionBalance).toFixed(2)} >= Limite: $${lossLimit} - PARANDO IMEDIATAMENTE`,
        );
        // Desativar imediatamente
        await this.checkAndEnforceLimits(state.userId);
        return false;
      }

    } catch (error) {
      this.logger.error(`[Moderado][${state.userId}] Erro ao verificar status da sessão:`, error);
      return false;
    }

    return true;
  }

  /**
   * Gerencia o sistema de loss virtual do modo moderado (3 perdas)
   */
  private async handleModeradoLossVirtual(
    state: ModeradoUserState,
    proposal: DigitParity,
    tick: Tick,
    dvx: number,
  ): Promise<void> {
    // Se ainda não iniciou o ciclo de loss virtual, iniciar agora
    if (!state.lossVirtualActive) {
      state.lossVirtualActive = true;
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Moderado][${state.userId}] Iniciando ciclo de loss virtual para ${proposal}`,
      );
    }

    // Se mudou a proposta, resetar
    if (state.lossVirtualOperation !== proposal) {
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Moderado][${state.userId}] Proposta mudou, resetando loss virtual`,
      );
    }

    // Verificar resultado do tick atual contra a proposta
    const tickResult = tick.parity;
    const wouldWin = tickResult === proposal;

    if (wouldWin) {
      // Se venceria, resetar contador
      this.logger.log(
        `[Moderado][${state.userId}] Vitória virtual | tick=${tick.value} (${tickResult}) | proposta=${proposal} | resetando contador`,
      );
      state.lossVirtualCount = 0;
      return;
    }

    // Perdeu virtualmente, incrementar contador
    state.lossVirtualCount++;
    this.logger.log(
      `[Moderado][${state.userId}] Loss virtual ${state.lossVirtualCount}/${MODERADO_CONFIG.lossVirtualTarget} | tick=${tick.value} (${tickResult}) | proposta=${proposal} | DVX: ${dvx}`,
    );

    // Se atingiu 3 perdas virtuais, executar operação real
    if (state.lossVirtualCount >= MODERADO_CONFIG.lossVirtualTarget) {
      this.logger.log(
        `[Moderado][${state.userId}] ✅ Loss virtual completo -> executando operação ${proposal}`,
      );

      // Resetar contadores antes de executar
      state.lossVirtualCount = 0;
      state.lossVirtualActive = false;
      state.lossVirtualOperation = null;

      // Executar operação real (async)
      this.executeModeradoOperation(state, proposal).catch((error) => {
        this.logger.error(
          `[Moderado] Erro ao executar operação para usuário ${state.userId}:`,
          error,
        );
      });
    }
  }

  /**
   * Executa operação real no modo moderado
   */
  private async executeModeradoOperation(
    state: ModeradoUserState,
    proposal: DigitParity,
    entry: number = 1,
  ): Promise<number> {
    if (entry === 1 && state.isOperationActive) {
      this.logger.warn(`[Moderado] Usuário ${state.userId} já possui operação ativa`);
      return -1;
    }

    state.isOperationActive = true;
    state.martingaleStep = entry;

    const stakeAmount = await this.calculateModeradoStake(state, proposal);
    const currentPrice = this.getCurrentPrice() || 0;

    // 📋 LOG: Operação sendo executada
    if (entry === 1) {
      this.saveLogAsync(state.userId, 'operacao', `🎯 EXECUTANDO OPERAÇÃO #${entry}`);
      this.saveLogAsync(state.userId, 'operacao', `Ativo: R_10`);
      this.saveLogAsync(state.userId, 'operacao', `Direção: ${proposal}`);
      this.saveLogAsync(state.userId, 'operacao', `Valor: $${stakeAmount.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'operacao', `Payout: 0.95 (95%)`);
      this.saveLogAsync(state.userId, 'operacao', `Lucro esperado: $${(stakeAmount * 0.95).toFixed(2)}`);
      // Verificar se está no Soros (pode ter sido ativado na entrada anterior)
      if (state.vitoriasConsecutivas > 0 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL && state.perdaAcumulada === 0) {
        this.saveLogAsync(state.userId, 'operacao', `Martingale: NÃO (Soros Nível ${state.vitoriasConsecutivas})`);
      } else {
        this.saveLogAsync(state.userId, 'operacao', `Martingale: NÃO (operação normal)`);
      }
    } else {
      // ✅ Verificar se é Soros ou Martingale ANTES de fazer os logs
      const isSoros = entry <= 3 && state.vitoriasConsecutivas > 0 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL && state.perdaAcumulada === 0;

      if (isSoros) {
        // 📋 LOG: Operação Soros
        this.saveLogAsync(state.userId, 'operacao', `🎯 EXECUTANDO OPERAÇÃO #${entry} (SOROS NÍVEL ${state.vitoriasConsecutivas})`);
        this.saveLogAsync(state.userId, 'operacao', `Direção: ${proposal}`);
        this.saveLogAsync(state.userId, 'operacao', `Valor: $${stakeAmount.toFixed(2)}`);
        this.saveLogAsync(state.userId, 'operacao', `Martingale: NÃO (Soros Nível ${state.vitoriasConsecutivas})`);
        if (state.ultimoLucro > 0) {
          this.saveLogAsync(state.userId, 'operacao', `Fórmula: $${(state.apostaInicial || state.apostaBase).toFixed(2)} + $${state.ultimoLucro.toFixed(2)} = $${stakeAmount.toFixed(2)}`);
        }
      } else {
        // 📋 LOG: Operação martingale
        this.saveLogAsync(state.userId, 'operacao', `🎯 EXECUTANDO OPERAÇÃO #${entry} (MARTINGALE)`);
        this.saveLogAsync(state.userId, 'operacao', `Direção: ${proposal}`);
        this.saveLogAsync(state.userId, 'operacao', `Valor: $${stakeAmount.toFixed(2)}`);
        this.saveLogAsync(state.userId, 'operacao', `Martingale: SIM (entrada ${entry})`);
        this.saveLogAsync(state.userId, 'operacao', `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)}`);
      }
    }

    const tradeId = await this.createModeradoTradeRecord(
      state.userId,
      proposal,
      stakeAmount,
      currentPrice,
    );

    this.logger.log(
      `[Moderado][${state.userId}] Enviando operação ${proposal} | stake=${stakeAmount} | entrada=${entry}`,
    );

    try {
      const result = await this.executeDigitTradeOnDeriv({
        tradeId,
        derivToken: state.derivToken,
        currency: state.currency || 'USD',
        stakeAmount,
        contractType: proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
      });

      await this.handleModeradoTradeOutcome(
        state,
        proposal,
        tradeId,
        stakeAmount,
        result,
        entry,
      );

      // ✅ ZENIX v2.0: Atualizar timestamp da última operação
      state.lastOperationTimestamp = new Date();

      return tradeId;
    } catch (error: any) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error.message || 'Unknown error', tradeId],
      );
      throw error;
    }
  }

  /**
   * Cria registro de trade do modo moderado no banco
   */
  private async createModeradoTradeRecord(
    userId: string,
    proposal: DigitParity,
    stakeAmount: number,
    entryPrice: number,
  ): Promise<number> {
    const analysisData = {
      strategy: 'modo_moderado',
      dvx: this.calculateDVX(this.ticks),
      window: MODERADO_CONFIG.window,
      ticks: this.ticks.slice(-MODERADO_CONFIG.window).map(t => ({
        value: t.value,
        epoch: t.epoch,
        timestamp: t.timestamp,
        digit: t.digit,
        parity: t.parity,
      })),
    };

    // ✅ Tentar inserir com symbol, se falhar, inserir sem symbol (campo pode não existir ainda)
    let result;
    try {
      result = await this.dataSource.query(
        `INSERT INTO ai_trades (
          user_id,
          analysis_data,
          gemini_signal,
          gemini_duration,
          gemini_reasoning,
          entry_price,
          stake_amount,
          contract_type,
          status,
          symbol
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          JSON.stringify(analysisData),
          proposal,
          1,
          'Modo Moderado - desequilíbrio de paridade + validações',
          entryPrice,
          stakeAmount,
          proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
          'PENDING',
          this.symbol,
        ],
      );
    } catch (error: any) {
      // Se o campo symbol não existir, inserir sem ele
      if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
        this.logger.warn(`[CreateModeradoTradeRecord] Campo 'symbol' não existe, inserindo sem ele. Execute o script SQL: backend/db/add_symbol_to_ai_trades.sql`);
        result = await this.dataSource.query(
          `INSERT INTO ai_trades (
            user_id,
            analysis_data,
            gemini_signal,
            gemini_duration,
            gemini_reasoning,
            entry_price,
            stake_amount,
            contract_type,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            JSON.stringify(analysisData),
            proposal,
            1,
            'Modo Moderado - desequilíbrio de paridade + validações',
            entryPrice,
            stakeAmount,
            proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
            'PENDING',
          ],
        );
      } else {
        throw error;
      }
    }

    return result.insertId;
  }

  /**
   * Trata o resultado de um trade do modo moderado
   */
  private async handleModeradoTradeOutcome(
    state: ModeradoUserState,
    proposal: DigitParity,
    tradeId: number,
    stakeAmount: number,
    result: DigitTradeResult,
    entry: number,
  ): Promise<void> {
    const won = result.status === 'WON';
    const config = CONFIGS_MARTINGALE[state.modoMartingale];

    await this.incrementModeradoStats(state.userId, won, result.profitLoss);

    if (won) {
      // ✅ VITÓRIA
      state.virtualCapital += result.profitLoss;
      const lucroLiquido = result.profitLoss - state.perdaAcumulada;

      // ✅ VALIDAÇÃO: Verificar se recuperou toda a perda acumulada (se estava em martingale)
      if (entry > 1 && state.perdaAcumulada > 0) {
        const recuperacaoEsperada = state.perdaAcumulada;
        const recuperacaoReal = result.profitLoss;

        if (recuperacaoReal < recuperacaoEsperada) {
          this.logger.warn(
            `[Moderado][Martingale] ⚠️ Recuperação incompleta: esperado $${recuperacaoEsperada.toFixed(2)}, obtido $${recuperacaoReal.toFixed(2)}`,
          );
        } else {
          this.logger.log(
            `[Moderado][Martingale] ✅ Recuperação completa: $${recuperacaoEsperada.toFixed(2)} recuperado`,
          );
        }
      }

      // ✅ ZENIX v2.0: ESTRATÉGIA SOROS CORRIGIDA
      // Soros funciona apenas até a entrada 3 (níveis 0, 1, 2)
      // Entrada 1: vitoriasConsecutivas = 0 → após vitória, vira 1
      // Entrada 2: vitoriasConsecutivas = 1 (Soros nível 1) → após vitória, vira 2
      // Entrada 3: vitoriasConsecutivas = 2 (Soros nível 2) → após vitória, reinicia tudo

      if (entry <= 3 && state.perdaAcumulada === 0) {
        // Está no Soros (entradas 1, 2 ou 3 sem perda acumulada)
        if (entry === 1) {
          // Vitória na entrada 1: ativar Soros nível 1
          state.vitoriasConsecutivas = 1;
          state.ultimoLucro = result.profitLoss;
          this.logger.log(
            `[Moderado][Soros] ✅ Entrada 1 vitoriosa | Ativando Soros Nível 1 | ` +
            `Próxima: $${stakeAmount.toFixed(2)} + $${result.profitLoss.toFixed(2)} = $${(stakeAmount + result.profitLoss).toFixed(2)}`,
          );
        } else if (entry === 2 && state.vitoriasConsecutivas === 1) {
          // Vitória no Soros nível 1: ativar Soros nível 2
          state.vitoriasConsecutivas = 2;
          state.ultimoLucro = result.profitLoss;
          this.logger.log(
            `[Moderado][Soros] ✅ Soros Nível 1 vitorioso | Ativando Soros Nível 2 | ` +
            `Próxima: $${stakeAmount.toFixed(2)} + $${result.profitLoss.toFixed(2)} = $${(stakeAmount + result.profitLoss).toFixed(2)}`,
          );
        } else if (entry === 3 && state.vitoriasConsecutivas === 2) {
          // Vitória no Soros nível 2: ciclo perfeito, reiniciar tudo
          this.logger.log(
            `[Moderado][Soros] 🎉 CICLO PERFEITO! Soros Nível 2 completo | Reiniciando tudo`,
          );
          state.vitoriasConsecutivas = 0;
          state.ultimoLucro = 0;
          // Reiniciar para valor inicial
        }
      } else {
        // Vitória em martingale: resetar Soros
        state.vitoriasConsecutivas = 0;
        state.ultimoLucro = 0;
        this.logger.log(`[Moderado][Soros] 🔄 Resetado (vitória em martingale não conta para Soros)`);
      }

      this.logger.log(
        `[Moderado][${state.modoMartingale.toUpperCase()}] ✅ VITÓRIA na ${entry}ª entrada! | ` +
        `Ganho: $${result.profitLoss.toFixed(2)} | ` +
        `Perda recuperada: $${state.perdaAcumulada.toFixed(2)} | ` +
        `Lucro líquido: $${lucroLiquido.toFixed(2)} | ` +
        `Capital: $${state.virtualCapital.toFixed(2)} | ` +
        `Vitórias consecutivas: ${state.vitoriasConsecutivas}`,
      );

      // 📋 LOG: Resultado - VITÓRIA

      this.saveLogAsync(state.userId, 'resultado', `Operação #${tradeId}: ${proposal}`);
      this.saveLogAsync(state.userId, 'resultado', `Resultado: ${Math.floor(result.exitPrice) % 10} ✅`);
      this.saveLogAsync(state.userId, 'resultado', `Investido: -$${stakeAmount.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'resultado', `Retorno: +$${(stakeAmount + result.profitLoss).toFixed(2)}`);
      this.saveLogAsync(state.userId, 'resultado', `Lucro: +$${result.profitLoss.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'resultado', `Capital: $${(state.virtualCapital - result.profitLoss).toFixed(2)} → $${state.virtualCapital.toFixed(2)}`);

      if (entry > 1) {
        this.saveLogAsync(state.userId, 'resultado', `🔄 MARTINGALE RESETADO`);
        this.saveLogAsync(state.userId, 'resultado', `Perda recuperada: +$${state.perdaAcumulada.toFixed(2)}`);
      }

      // ✅ CORREÇÃO: Manter apostaBase e apostaInicial (não resetar para 0)
      // Se completou Soros nível 2, reiniciar tudo
      if (entry === 3 && state.vitoriasConsecutivas === 2) {
        this.saveLogAsync(state.userId, 'resultado', `🎉 SOROS CICLO PERFEITO! Reiniciando para entrada inicial`);
        state.isOperationActive = false;
        state.martingaleStep = 0;
        state.perdaAcumulada = 0;
        state.vitoriasConsecutivas = 0;
        state.ultimoLucro = 0;
        // Próxima entrada será o valor inicial
        this.saveLogAsync(state.userId, 'resultado', `Próxima aposta: $${state.apostaBase.toFixed(2)} (entrada inicial)`);
        this.saveLogAsync(state.userId, 'info', '📡 Aguardando próximo sinal...');
        return;
      }

      // Se ainda está no Soros, calcular próxima aposta
      if (state.vitoriasConsecutivas > 0 && state.vitoriasConsecutivas <= SOROS_MAX_NIVEL) {
        const proximaApostaComSoros = calcularApostaComSoros(
          stakeAmount,
          result.profitLoss,
          state.vitoriasConsecutivas,
        );
        if (proximaApostaComSoros !== null) {
          this.saveLogAsync(state.userId, 'resultado', `Próxima aposta: $${proximaApostaComSoros.toFixed(2)} (Soros Nível ${state.vitoriasConsecutivas})`);
        }
      } else {
        this.saveLogAsync(state.userId, 'resultado', `Próxima aposta: $${state.apostaBase.toFixed(2)} (entrada inicial)`);
      }

      this.saveLogAsync(state.userId, 'info', '📡 Aguardando próximo sinal...');

      // Resetar martingale (mas manter apostaBase e vitoriasConsecutivas se ainda no Soros)
      state.isOperationActive = false;
      state.martingaleStep = 0;
      state.perdaAcumulada = 0;
      state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale
      // ✅ CORREÇÃO: Não resetar apostaInicial para 0, manter com valor atual
      return;
    }

    // ❌ PERDA
    state.virtualCapital += result.profitLoss;
    state.perdaAcumulada += stakeAmount;
    // ✅ CORREÇÃO: Salvar direção da operação para continuar martingale
    state.ultimaDirecaoMartingale = proposal;

    // ✅ ZENIX v2.0: ESTRATÉGIA SOROS CORRIGIDA
    // Se perder em qualquer entrada do Soros (1, 2 ou 3), entrar em recuperação
    if (entry <= 3 && state.perdaAcumulada === stakeAmount) {
      // Perdeu no Soros: resetar Soros e entrar em recuperação
      if (state.vitoriasConsecutivas > 0) {
        this.logger.log(
          `[Moderado][Soros] ❌ Soros Nível ${state.vitoriasConsecutivas} falhou! Entrando em recuperação`,
        );
      } else {
        this.logger.log(
          `[Moderado][Soros] ❌ Entrada 1 falhou! Entrando em recuperação`,
        );
      }
      state.vitoriasConsecutivas = 0;
      state.ultimoLucro = 0;
      // perdaAcumulada já foi incrementada acima, então entrará em martingale
    } else if (entry === 1) {
      // Perda na primeira entrada (não estava no Soros)
      state.vitoriasConsecutivas = 0;
      state.ultimoLucro = 0;
    }

    this.logger.warn(
      `[Moderado][${state.modoMartingale.toUpperCase()}] ❌ PERDA na ${entry}ª entrada: -$${stakeAmount.toFixed(2)} | ` +
      `Perda acumulada: $${state.perdaAcumulada.toFixed(2)} | ` +
      `Vitórias consecutivas: ${state.vitoriasConsecutivas}`,
    );

    // 📋 LOG: Resultado - DERROTA (✅ OTIMIZADO: sem await para não bloquear)
    this.saveLog(state.userId, 'resultado', '❌ DERROTA');
    this.saveLog(state.userId, 'resultado', `Operação #${tradeId}: ${proposal}`);
    this.saveLog(state.userId, 'resultado', `Resultado: ${Math.floor(result.exitPrice) % 10} ❌`);
    this.saveLog(state.userId, 'resultado', `Investido: -$${stakeAmount.toFixed(2)}`);
    this.saveLog(state.userId, 'resultado', `Perda: $${result.profitLoss.toFixed(2)}`);
    this.saveLog(state.userId, 'resultado', `Perda acumulada: -$${state.perdaAcumulada.toFixed(2)}`);

    // ✅ ZENIX v2.0: Verificar limite ANTES de incrementar e calcular próxima aposta
    // Conservador: máximo 5 entradas (entry 1-5, reseta quando chegar em 5)
    // Moderado/Agressivo: infinito (maxEntradas = Infinity)
    // ✅ Verificar se a PRÓXIMA entrada (entry + 1) ainda está dentro do limite
    if (config.maxEntradas === Infinity || (entry + 1) <= config.maxEntradas) {
      // Consultar payout via API antes de calcular
      const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
      let payoutCliente = 92; // Valor padrão caso falhe a consulta (95 - 3)

      try {
        payoutCliente = await this.consultarPayoutCliente(
          state.derivToken,
          state.currency || 'USD',
          contractType,
        );
      } catch (error) {
        this.logger.warn(
          `[Moderado][Martingale] Erro ao consultar payout, usando padrão (92%): ${error.message}`,
        );
      }

      let proximaAposta = calcularProximaAposta(
        state.perdaAcumulada,
        state.modoMartingale,
        payoutCliente,
      );

      // ✅ STOP-LOSS NORMAL - ZENIX v2.0
      // Protege durante martingale: evita que próxima aposta ultrapasse limite disponível
      try {
        const limitsResult = await this.dataSource.query(
          `SELECT 
            stake_amount as initialCapital,
            COALESCE(session_balance, 0) as sessionBalance,
            COALESCE(loss_limit, 0) as lossLimit
           FROM ai_user_config 
           WHERE user_id = ? AND is_active = TRUE
           LIMIT 1`,
          [state.userId],
        );

        if (limitsResult && limitsResult.length > 0) {
          const initialCapital = parseFloat(limitsResult[0].initialCapital) || 0;
          const sessionBalance = parseFloat(limitsResult[0].sessionBalance) || 0;
          const lossLimit = parseFloat(limitsResult[0].lossLimit) || 0;

          if (lossLimit > 0) {
            // Capital disponível = capital inicial + saldo da sessão
            const capitalDisponivel = initialCapital + sessionBalance;

            // Stop-loss disponível = quanto ainda pode perder
            const stopLossDisponivel = capitalDisponivel - (initialCapital - lossLimit);

            // Se próxima aposta + perda acumulada ultrapassar limite disponível
            if (state.perdaAcumulada + proximaAposta > stopLossDisponivel) {
              this.logger.warn(
                `[Moderado][StopNormal][${state.userId}] ⚠️ Próxima aposta ($${proximaAposta.toFixed(2)}) ultrapassaria stop-loss! ` +
                `Reduzindo para valor inicial ($${state.capital.toFixed(2)}) e resetando martingale.`,
              );

              // Reduzir para valor inicial
              proximaAposta = state.capital;

              // Resetar martingale (mas continuar operando)
              state.isOperationActive = false;
              state.martingaleStep = 0;
              state.perdaAcumulada = 0;
              state.apostaInicial = 0;
              state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale

              this.logger.log(
                `[Moderado][StopNormal][${state.userId}] 🔄 Martingale resetado. Continuando com valor inicial.`,
              );
              return;
            }
          }
        }
      } catch (error) {
        this.logger.error(`[Moderado][StopNormal][${state.userId}] Erro ao verificar stop-loss normal:`, error);
      }

      // Calcular lucro esperado baseado no modo
      const multiplicadorLucro = state.modoMartingale === 'conservador' ? 0 :
        state.modoMartingale === 'moderado' ? 0.25 : 0.50;
      const lucroEsperado = state.perdaAcumulada * multiplicadorLucro;

      this.logger.log(
        `[Moderado][${state.modoMartingale.toUpperCase()}] 🔁 Próxima entrada: $${proximaAposta.toFixed(2)} | ` +
        (lucroEsperado > 0
          ? `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} + Lucro $${lucroEsperado.toFixed(2)}`
          : `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} (break-even)`),
      );

      // 📋 LOG: Martingale ativado
      this.saveLogAsync(state.userId, 'alerta', `🔄 MARTINGALE ATIVADO (${state.modoMartingale.toUpperCase()})`);
      this.saveLogAsync(state.userId, 'alerta', `Próxima aposta: $${proximaAposta.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'alerta', `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)}`);

      // Executar próxima entrada
      await this.executeModeradoOperation(state, proposal, entry + 1);
      return;
    }

    // 🛑 STOP-LOSS DE MARTINGALE (CONSERVADOR: máx 5 entradas)
    const prejuizoAceito = state.perdaAcumulada;

    this.logger.warn(
      `[Moderado][${state.modoMartingale.toUpperCase()}] 🛑 Limite de entradas atingido: ${entry}/${config.maxEntradas} | ` +
      `Perda total: -$${prejuizoAceito.toFixed(2)} | ` +
      `Resetando para valor inicial`,
    );

    // 📋 LOG: Martingale atingiu limite (CONSERVADOR específico)
    if (state.modoMartingale === 'conservador') {
      this.saveLogAsync(state.userId, 'alerta', `🛑 LIMITE MARTINGALE CONSERVADOR`);
      this.saveLogAsync(state.userId, 'alerta', `Atingiu ${entry}ª entrada (máximo: 5)`);
      this.saveLogAsync(state.userId, 'alerta', `Prejuízo aceito: -$${prejuizoAceito.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'alerta', `Resetando para valor inicial: $${state.capital.toFixed(2)}`);
      this.saveLogAsync(state.userId, 'info', '🔄 Continuando operação com aposta normal...');
    } else {
      // Outros modos (não deveria chegar aqui pois moderado/agressivo são infinitos)
      this.saveLogAsync(state.userId, 'alerta', `🛑 MARTINGALE RESETADO`);
      this.saveLogAsync(state.userId, 'alerta', `Perda acumulada: -$${prejuizoAceito.toFixed(2)}`);
    }

    // Resetar martingale
    state.isOperationActive = false;
    state.martingaleStep = 0;
    state.perdaAcumulada = 0;
    state.apostaInicial = 0;
    state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale
  }

  /**
   * Incrementa estatísticas do modo moderado
   */
  private async incrementModeradoStats(
    userId: string,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins' : 'total_losses';

    // Buscar saldo atual da sessão
    const currentBalanceResult = await this.dataSource.query(
      `SELECT COALESCE(session_balance, 0) as currentBalance
       FROM ai_user_config
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );

    const currentBalance = parseFloat(currentBalanceResult[0]?.currentBalance) || 0;
    const newBalance = currentBalance + profitLoss;

    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column} = ${column} + 1,
           session_balance = ?,
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [newBalance, userId],
    );

    this.logger.debug(`[IncrementModeradoStats][${userId}] Saldo atualizado: $${currentBalance.toFixed(2)} + $${profitLoss.toFixed(2)} = $${newBalance.toFixed(2)}`);

    // Verificar e enforçar limites após cada trade
    await this.checkAndEnforceLimits(userId);

    // ✅ ZENIX v2.0: Verificar Stop Blindado (proteção de lucros)
    await this.checkStopBlindado(userId);
  }

  /**
   * Calcula stake para o modo moderado (valor configurado + martingale unificado)
   * ZENIX v2.0: Usa valor configurado diretamente (não porcentagem)
   */
  private async calculateModeradoStake(state: ModeradoUserState, proposal?: DigitParity): Promise<number> {
    // ✅ ZENIX v2.0: Soros funciona apenas até a entrada 3 (níveis 0, 1, 2)
    const entry = state.martingaleStep || 1;

    if (entry === 1) {
      // Primeira entrada: usar valor inicial
      if (state.apostaBase <= 0) {
        state.apostaBase = state.capital || MODERADO_CONFIG.minStake;
      }
      return Math.max(MODERADO_CONFIG.minStake, state.apostaBase);
    }

    if (entry === 2) {
      // Entrada 2: Soros Nível 1 (se entrada 1 foi vitoriosa)
      if (state.vitoriasConsecutivas === 1 && state.ultimoLucro > 0 && state.perdaAcumulada === 0) {
        const apostaComSoros = calcularApostaComSoros(
          state.apostaInicial || state.apostaBase,
          state.ultimoLucro,
          1, // Soros nível 1
        );

        if (apostaComSoros !== null) {
          return Math.max(MODERADO_CONFIG.minStake, apostaComSoros);
        }
      }
    }

    if (entry === 3) {
      // Entrada 3: Soros Nível 2 (se entrada 2 foi vitoriosa)
      if (state.vitoriasConsecutivas === 2 && state.ultimoLucro > 0 && state.perdaAcumulada === 0) {
        const apostaComSoros = calcularApostaComSoros(
          state.apostaInicial || state.apostaBase,
          state.ultimoLucro,
          2, // Soros nível 2
        );

        if (apostaComSoros !== null) {
          return Math.max(MODERADO_CONFIG.minStake, apostaComSoros);
        }
      }
    }

    // SISTEMA UNIFICADO DE MARTINGALE (para entradas > 1)
    // Consultar payout via API antes de calcular
    const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
    let payoutCliente = 92; // Valor padrão caso falhe a consulta (95 - 3)

    try {
      payoutCliente = await this.consultarPayoutCliente(
        state.derivToken,
        state.currency || 'USD',
        contractType,
      );
    } catch (error) {
      this.logger.warn(
        `[Moderado][Martingale] Erro ao consultar payout, usando padrão (92%): ${error.message}`,
      );
    }

    const proximaAposta = calcularProximaAposta(
      state.perdaAcumulada,
      state.modoMartingale,
      payoutCliente,
    );

    this.logger.debug(
      `[Moderado][Martingale ${state.modoMartingale.toUpperCase()}] ` +
      `Perdas totais: $${state.perdaAcumulada.toFixed(2)} | ` +
      `Payout cliente: ${payoutCliente.toFixed(2)}% | ` +
      `Próxima aposta: $${proximaAposta.toFixed(2)}`,
    );

    return Math.max(MODERADO_CONFIG.minStake, proximaAposta);
  }

  /**
   * Sincroniza usuários do modo moderado do banco de dados
   */
  async syncModeradoUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT 
          user_id as userId,
          stake_amount as stakeAmount,
          deriv_token as derivToken,
          currency,
          modo_martingale as modoMartingale
         FROM ai_user_config
         WHERE is_active = TRUE
           AND LOWER(mode) = 'moderado'`,
      );

      this.logger.log(`[SyncModerado] Sincronizando ${activeUsers.length} usuários do banco`);

      const activeIds = new Set(activeUsers.map((u: any) => u.userId));

      // Remover usuários que não estão mais ativos
      for (const existingId of this.moderadoUsers.keys()) {
        if (!activeIds.has(existingId)) {
          this.moderadoUsers.delete(existingId);
          this.logger.log(`[SyncModerado] Removido usuário ${existingId} (não mais ativo)`);
        }
      }

      // Adicionar/atualizar usuários ativos
      for (const user of activeUsers) {
        this.logger.debug(
          `[SyncModerado] Lido do banco: userId=${user.userId} | stake=${user.stakeAmount} | martingale=${user.modoMartingale}`,
        );

        // ✅ [ZENIX v3.4] Resolver conta para garantir moeda correta (BTC, etc)
        const resolved = await this.resolveDerivAccount(user.userId, user.derivToken, user.currency);

        this.upsertModeradoUserState({
          userId: user.userId,
          stakeAmount: parseFloat(user.stakeAmount),
          derivToken: resolved.token,
          currency: resolved.currency || 'USD',
          modoMartingale: user.modoMartingale || 'conservador',
        });
      }
    } catch (error) {
      this.logger.error('[SyncModerado] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Adiciona ou atualiza estado de usuário no modo moderado
   */
  private upsertModeradoUserState(params: {
    userId: string;
    stakeAmount: number;
    entryValue?: number; // ✅ Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const modoMartingale = params.modoMartingale || 'conservador';
    const apostaInicial = params.entryValue || getMinStakeByCurrency(params.currency); // ✅ Moeda dinâmica

    this.logger.log(
      `[UpsertModeradoState] userId=${params.userId} | capital=${params.stakeAmount} | currency=${params.currency} | martingale=${modoMartingale}`,
    );

    const existing = this.moderadoUsers.get(params.userId);

    if (existing) {
      // Atualizar existente
      this.logger.debug(
        `[UpsertModeradoState] Atualizando usuário existente | capital antigo=${existing.capital} | capital novo=${params.stakeAmount} | martingale=${modoMartingale}`,
      );

      existing.capital = params.stakeAmount;
      existing.derivToken = params.derivToken;
      existing.currency = params.currency;
      existing.modoMartingale = modoMartingale;

      // Resetar capital virtual se necessário
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = params.stakeAmount;
      }
      // ✅ Atualizar apostaBase e apostaInicial se entryValue foi fornecido
      if (params.entryValue !== undefined) {
        existing.apostaBase = apostaInicial;
        existing.apostaInicial = apostaInicial;
      } else if (existing.apostaBase <= 0) {
        existing.apostaBase = apostaInicial;
        existing.apostaInicial = apostaInicial;
      }
    } else {
      // Criar novo
      this.logger.debug(`[UpsertModeradoState] Criando novo usuário | capital=${params.stakeAmount} | martingale=${modoMartingale}`);

      this.moderadoUsers.set(params.userId, {
        userId: params.userId,
        derivToken: params.derivToken,
        currency: params.currency,
        capital: params.stakeAmount,
        virtualCapital: params.stakeAmount,
        lossVirtualActive: false,
        lossVirtualCount: 0,
        lossVirtualOperation: null,
        isOperationActive: false,
        martingaleStep: 0,
        modoMartingale: modoMartingale,
        perdaAcumulada: 0,
        apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
        lastOperationTimestamp: null, // ✅ ZENIX v2.0: Inicializar controle de intervalo
        vitoriasConsecutivas: 0, // ✅ ZENIX v2.0: Estratégia Soros - inicializar contador
        ultimoLucro: 0, // ✅ ZENIX v2.0: Lucro da última entrada (para calcular Soros)
        apostaBase: apostaInicial, // ✅ ZENIX v2.0: Inicializar aposta base com entryValue
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
      });
    }
  }

  /**
   * Remove usuário do modo moderado
   */
  private removeModeradoUserState(userId: string): void {
    if (this.moderadoUsers.has(userId)) {
      this.moderadoUsers.delete(userId);
      this.logger.log(`[Moderado] Estado removido para usuário ${userId}`);
    }
  }

  // ======================== MODO PRECISO ========================

  /**
   * Processa estratégias do modo PRECISO para todos os usuários ativos
   */
  /**
   * ZENIX v2.0: Processamento de estratégia Preciso
   * - Amostra inicial: 50 ticks
   * - Intervalo entre operações: Baseado em qualidade (sem intervalo fixo)
   * - Desequilíbrio mínimo: 70%
   * - Confiança mínima: 70%
   */
  private async processPrecisoStrategies(latestTick: Tick): Promise<void> {
    if (this.precisoUsers.size === 0) {
      return;
    }

    // ✅ ZENIX v2.0: Verificar amostra mínima
    if (this.ticks.length < PRECISO_CONFIG.amostraInicial) {
      this.logger.debug(
        `[Preciso][ZENIX] Coletando amostra inicial (${this.ticks.length}/${PRECISO_CONFIG.amostraInicial})`,
      );
      return;
    }

    // Processar cada usuário
    for (const [userId, state] of this.precisoUsers.entries()) {
      // Pular se já tem operação ativa (martingale)
      if (state.isOperationActive) {
        continue;
      }

      // ✅ CORREÇÃO MARTINGALE: Se há perda acumulada, continuar com martingale em vez de gerar novo sinal
      if (state.perdaAcumulada > 0 && state.ultimaDirecaoMartingale) {
        // Verificar se pode continuar com martingale
        const canProcess = await this.canProcessPrecisoState(state);
        if (!canProcess) {
          continue;
        }

        // Continuar com martingale usando a mesma direção (PRECISO não tem intervalo fixo)
        const proximaEntrada = state.martingaleStep + 1;
        this.logger.log(
          `[Preciso][${userId}] 🔄 Continuando MARTINGALE | Entrada: ${proximaEntrada} | Direção: ${state.ultimaDirecaoMartingale} | Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
        );

        await this.executePrecisoOperation(state, state.ultimaDirecaoMartingale, proximaEntrada);
        continue;
      }

      // Verificar se pode processar
      const canProcess = await this.canProcessPrecisoState(state);
      if (!canProcess) {
        continue;
      }

      // ✅ ZENIX v2.0: Gerar sinal usando análise completa
      const sinal = gerarSinalZenix(this.ticks, PRECISO_CONFIG, 'PRECISO');

      if (!sinal || !sinal.sinal) {
        continue; // Sem sinal válido
      }

      this.logger.log(
        `[Preciso][ZENIX] 🎯 SINAL GERADO | User: ${userId} | ` +
        `Operação: ${sinal.sinal} | Confiança: ${sinal.confianca.toFixed(1)}%\n` +
        `  └─ ${sinal.motivo}`,
      );

      // Executar operação
      await this.executePrecisoOperation(state, sinal.sinal, 1);
    }
  }

  /**
   * Verifica se pode processar o estado do usuário no modo preciso
   * ✅ ZENIX v2.0: Verifica limites ANTES de executar operação
   */
  private async canProcessPrecisoState(state: PrecisoUserState): Promise<boolean> {
    if (state.isOperationActive) {
      this.logger.debug(
        `[Preciso][${state.userId}] Operação em andamento - aguardando finalização`,
      );
      return false;
    }
    if (!state.derivToken) {
      this.logger.warn(
        `[Preciso][${state.userId}] Usuário sem token Deriv configurado - ignorando`,
      );
      return false;
    }
    if ((state.virtualCapital || state.capital) <= 0) {
      this.logger.warn(
        `[Preciso][${state.userId}] Usuário sem capital configurado - ignorando`,
      );
      return false;
    }

    // ✅ ZENIX v2.0: Verificar limites ANTES de executar operação
    try {
      const configResult = await this.dataSource.query(
        `SELECT 
          session_status, 
          is_active,
          profit_target,
          loss_limit,
          COALESCE(session_balance, 0) as sessionBalance
         FROM ai_user_config 
         WHERE user_id = ? AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [state.userId],
      );

      if (!configResult || configResult.length === 0) {
        // Não há sessão ativa
        this.logger.warn(
          `[Preciso][${state.userId}] Nenhuma sessão ativa encontrada - não executando novos trades`,
        );
        return false;
      }

      const config = configResult[0];

      // Verificar se já foi parada
      if (config.session_status === 'stopped_profit' || config.session_status === 'stopped_loss' || config.session_status === 'stopped_blindado') {
        this.logger.warn(
          `[Preciso][${state.userId}] Sessão parada (${config.session_status}) - não executando novos trades`,
        );
        return false;
      }

      // ✅ VERIFICAR LIMITES ANTES DE OPERAR
      const sessionBalance = parseFloat(config.sessionBalance) || 0;
      const profitTarget = parseFloat(config.profit_target) || null;
      const lossLimit = parseFloat(config.loss_limit) || null;

      // Se atingiu take profit (stop win)
      if (profitTarget && sessionBalance >= profitTarget) {
        this.logger.warn(
          `[Preciso][${state.userId}] 🎯 STOP WIN ATINGIDO! Saldo: $${sessionBalance.toFixed(2)} >= Meta: $${profitTarget} - PARANDO IMEDIATAMENTE`,
        );
        // Desativar imediatamente
        await this.checkAndEnforceLimits(state.userId);
        return false;
      }

      // Se atingiu stop loss
      if (lossLimit && sessionBalance <= -lossLimit) {
        this.logger.warn(
          `[Preciso][${state.userId}] 🛑 STOP LOSS ATINGIDO! Saldo: -$${Math.abs(sessionBalance).toFixed(2)} >= Limite: $${lossLimit} - PARANDO IMEDIATAMENTE`,
        );
        // Desativar imediatamente
        await this.checkAndEnforceLimits(state.userId);
        return false;
      }

    } catch (error) {
      this.logger.error(`[Preciso][${state.userId}] Erro ao verificar status da sessão:`, error);
      return false;
    }

    return true;
  }

  /**
   * Gerencia o sistema de loss virtual do modo preciso (4 perdas)
   */
  private async handlePrecisoLossVirtual(
    state: PrecisoUserState,
    proposal: DigitParity,
    tick: Tick,
    dvx: number,
  ): Promise<void> {
    // Se ainda não iniciou o ciclo de loss virtual, iniciar agora
    if (!state.lossVirtualActive) {
      state.lossVirtualActive = true;
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Preciso][${state.userId}] Iniciando ciclo de loss virtual para ${proposal}`,
      );
    }

    // Se mudou a proposta, resetar
    if (state.lossVirtualOperation !== proposal) {
      state.lossVirtualCount = 0;
      state.lossVirtualOperation = proposal;
      this.logger.debug(
        `[Preciso][${state.userId}] Proposta mudou, resetando loss virtual`,
      );
    }

    // Verificar resultado do tick atual contra a proposta
    const tickResult = tick.parity;
    const wouldWin = tickResult === proposal;

    if (wouldWin) {
      // Se venceria, resetar contador
      this.logger.log(
        `[Preciso][${state.userId}] Vitória virtual | tick=${tick.value} (${tickResult}) | proposta=${proposal} | resetando contador`,
      );
      state.lossVirtualCount = 0;
      return;
    }

    // Perdeu virtualmente, incrementar contador
    state.lossVirtualCount++;
    this.logger.log(
      `[Preciso][${state.userId}] Loss virtual ${state.lossVirtualCount}/${PRECISO_CONFIG.lossVirtualTarget} | tick=${tick.value} (${tickResult}) | proposta=${proposal} | DVX: ${dvx}`,
    );

    // Se atingiu 4 perdas virtuais, executar operação real
    if (state.lossVirtualCount >= PRECISO_CONFIG.lossVirtualTarget) {
      this.logger.log(
        `[Preciso][${state.userId}] ✅ Loss virtual completo (4/4) -> executando operação ${proposal}`,
      );

      // Resetar contadores antes de executar
      state.lossVirtualCount = 0;
      state.lossVirtualActive = false;
      state.lossVirtualOperation = null;

      // Executar operação real (async)
      this.executePrecisoOperation(state, proposal).catch((error) => {
        this.logger.error(
          `[Preciso] Erro ao executar operação para usuário ${state.userId}:`,
          error,
        );
      });
    }
  }

  /**
   * Executa operação real no modo preciso
   */
  private async executePrecisoOperation(
    state: PrecisoUserState,
    proposal: DigitParity,
    entry: number = 1,
  ): Promise<number> {
    if (entry === 1 && state.isOperationActive) {
      this.logger.warn(`[Preciso] Usuário ${state.userId} já possui operação ativa`);
      return -1;
    }

    state.isOperationActive = true;
    state.martingaleStep = entry;

    const stakeAmount = await this.calculatePrecisoStake(state, proposal);
    const currentPrice = this.getCurrentPrice() || 0;

    const tradeId = await this.createPrecisoTradeRecord(
      state.userId,
      proposal,
      stakeAmount,
      currentPrice,
    );

    this.logger.log(
      `[Preciso][${state.userId}] Enviando operação ${proposal} | stake=${stakeAmount} | entrada=${entry}`,
    );

    try {
      const result = await this.executeDigitTradeOnDeriv({
        tradeId,
        derivToken: state.derivToken,
        currency: state.currency || 'USD',
        stakeAmount,
        contractType: proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
      });

      await this.handlePrecisoTradeOutcome(
        state,
        proposal,
        tradeId,
        stakeAmount,
        result,
        entry,
      );

      return tradeId;
    } catch (error: any) {
      state.isOperationActive = false;
      state.martingaleStep = 0;
      await this.dataSource.query(
        'UPDATE ai_trades SET status = ?, error_message = ? WHERE id = ?',
        ['ERROR', error.message || 'Unknown error', tradeId],
      );
      throw error;
    }
  }

  /**
   * Cria registro de trade do modo preciso no banco
   */
  private async createPrecisoTradeRecord(
    userId: string,
    proposal: DigitParity,
    stakeAmount: number,
    entryPrice: number,
  ): Promise<number> {
    const analysisData = {
      strategy: 'modo_preciso',
      dvx: this.calculateDVX(this.ticks),
      window: PRECISO_CONFIG.window,
      ticks: this.ticks.slice(-PRECISO_CONFIG.window).map(t => ({
        value: t.value,
        epoch: t.epoch,
        timestamp: t.timestamp,
        digit: t.digit,
        parity: t.parity,
      })),
    };

    // ✅ Tentar inserir com symbol, se falhar, inserir sem symbol (campo pode não existir ainda)
    let result;
    try {
      result = await this.dataSource.query(
        `INSERT INTO ai_trades (
          user_id,
          analysis_data,
          gemini_signal,
          gemini_duration,
          gemini_reasoning,
          entry_price,
          stake_amount,
          contract_type,
          status,
          symbol
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          JSON.stringify(analysisData),
          proposal,
          1,
          'Modo Preciso - desequilíbrio rigoroso + validações múltiplas',
          entryPrice,
          stakeAmount,
          proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
          'PENDING',
          this.symbol,
        ],
      );
    } catch (error: any) {
      // Se o campo symbol não existir, inserir sem ele
      if (error.code === 'ER_BAD_FIELD_ERROR' && error.sqlMessage?.includes('symbol')) {
        this.logger.warn(`[CreatePrecisoTradeRecord] Campo 'symbol' não existe, inserindo sem ele. Execute o script SQL: backend/db/add_symbol_to_ai_trades.sql`);
        result = await this.dataSource.query(
          `INSERT INTO ai_trades (
            user_id,
            analysis_data,
            gemini_signal,
            gemini_duration,
            gemini_reasoning,
            entry_price,
            stake_amount,
            contract_type,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            JSON.stringify(analysisData),
            proposal,
            1,
            'Modo Preciso - desequilíbrio rigoroso + validações múltiplas',
            entryPrice,
            stakeAmount,
            proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD',
            'PENDING',
          ],
        );
      } else {
        throw error;
      }
    }

    return result.insertId;
  }

  /**
   * Trata o resultado de um trade do modo preciso
   */
  private async handlePrecisoTradeOutcome(
    state: PrecisoUserState,
    proposal: DigitParity,
    tradeId: number,
    stakeAmount: number,
    result: DigitTradeResult,
    entry: number,
  ): Promise<void> {
    const won = result.status === 'WON';
    const config = CONFIGS_MARTINGALE[state.modoMartingale];

    await this.incrementPrecisoStats(state.userId, won, result.profitLoss);

    if (won) {
      // ✅ VITÓRIA
      state.virtualCapital += result.profitLoss;
      const lucroLiquido = result.profitLoss - state.perdaAcumulada;

      this.logger.log(
        `[Preciso][${state.modoMartingale.toUpperCase()}] ✅ VITÓRIA na ${entry}ª entrada! | ` +
        `Ganho: $${result.profitLoss.toFixed(2)} | ` +
        `Perda recuperada: $${state.perdaAcumulada.toFixed(2)} | ` +
        `Lucro líquido: $${lucroLiquido.toFixed(2)} | ` +
        `Capital: $${state.virtualCapital.toFixed(2)}`,
      );

      // Resetar martingale
      state.isOperationActive = false;
      state.martingaleStep = 0;
      state.perdaAcumulada = 0;
      state.apostaInicial = 0;
      return;
    }

    // ❌ PERDA
    state.virtualCapital += result.profitLoss;
    state.perdaAcumulada += stakeAmount;

    this.logger.warn(
      `[Preciso][${state.modoMartingale.toUpperCase()}] ❌ PERDA na ${entry}ª entrada: -$${stakeAmount.toFixed(2)} | ` +
      `Perda acumulada: $${state.perdaAcumulada.toFixed(2)}`,
    );

    // ✅ ZENIX v2.0: Verificar limite ANTES de incrementar e calcular próxima aposta
    // Conservador: máximo 5 entradas (entry 1-5, reseta quando chegar em 5)
    // Moderado/Agressivo: infinito (maxEntradas = Infinity)
    // ✅ Verificar se a PRÓXIMA entrada (entry + 1) ainda está dentro do limite
    if (config.maxEntradas === Infinity || (entry + 1) <= config.maxEntradas) {
      // Consultar payout via API antes de calcular
      const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
      let payoutCliente = 92; // Valor padrão caso falhe a consulta (95 - 3)

      try {
        payoutCliente = await this.consultarPayoutCliente(
          state.derivToken,
          state.currency || 'USD',
          contractType,
        );
      } catch (error) {
        this.logger.warn(
          `[Preciso][Martingale] Erro ao consultar payout, usando padrão (92%): ${error.message}`,
        );
      }

      let proximaAposta = calcularProximaAposta(
        state.perdaAcumulada,
        state.modoMartingale,
        payoutCliente,
      );

      // ✅ STOP-LOSS NORMAL - ZENIX v2.0
      // Protege durante martingale: evita que próxima aposta ultrapasse limite disponível
      try {
        const limitsResult = await this.dataSource.query(
          `SELECT 
            stake_amount as initialCapital,
            COALESCE(session_balance, 0) as sessionBalance,
            COALESCE(loss_limit, 0) as lossLimit
           FROM ai_user_config 
           WHERE user_id = ? AND is_active = TRUE
           LIMIT 1`,
          [state.userId],
        );

        if (limitsResult && limitsResult.length > 0) {
          const initialCapital = parseFloat(limitsResult[0].initialCapital) || 0;
          const sessionBalance = parseFloat(limitsResult[0].sessionBalance) || 0;
          const lossLimit = parseFloat(limitsResult[0].lossLimit) || 0;

          if (lossLimit > 0) {
            // Capital disponível = capital inicial + saldo da sessão
            const capitalDisponivel = initialCapital + sessionBalance;

            // Stop-loss disponível = quanto ainda pode perder
            const stopLossDisponivel = capitalDisponivel - (initialCapital - lossLimit);

            // Se próxima aposta + perda acumulada ultrapassar limite disponível
            if (state.perdaAcumulada + proximaAposta > stopLossDisponivel) {
              this.logger.warn(
                `[Preciso][StopNormal][${state.userId}] ⚠️ Próxima aposta ($${proximaAposta.toFixed(2)}) ultrapassaria stop-loss! ` +
                `Reduzindo para valor inicial ($${state.capital.toFixed(2)}) e resetando martingale.`,
              );

              // Reduzir para valor inicial
              proximaAposta = state.capital;

              // Resetar martingale (mas continuar operando)
              state.isOperationActive = false;
              state.martingaleStep = 0;
              state.perdaAcumulada = 0;
              state.apostaInicial = 0;
              state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale

              this.logger.log(
                `[Preciso][StopNormal][${state.userId}] 🔄 Martingale resetado. Continuando com valor inicial.`,
              );
              return;
            }
          }
        }
      } catch (error) {
        this.logger.error(`[Preciso][StopNormal][${state.userId}] Erro ao verificar stop-loss normal:`, error);
      }

      // Calcular lucro esperado baseado no modo
      const multiplicadorLucro = state.modoMartingale === 'conservador' ? 0 :
        state.modoMartingale === 'moderado' ? 0.25 : 0.50;
      const lucroEsperado = state.perdaAcumulada * multiplicadorLucro;

      this.logger.log(
        `[Preciso][${state.modoMartingale.toUpperCase()}] 🔁 Próxima entrada: $${proximaAposta.toFixed(2)} | ` +
        (lucroEsperado > 0
          ? `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} + Lucro $${lucroEsperado.toFixed(2)}`
          : `Objetivo: Recuperar $${state.perdaAcumulada.toFixed(2)} (break-even)`),
      );

      // Executar próxima entrada
      await this.executePrecisoOperation(state, proposal, entry + 1);
      return;
    }

    // 🛑 STOP-LOSS DE MARTINGALE
    this.logger.warn(
      `[Preciso][${state.modoMartingale.toUpperCase()}] 🛑 Stop-loss: ${entry} entradas | ` +
      `Perda total: -$${state.perdaAcumulada.toFixed(2)}`,
    );

    // Resetar martingale
    state.isOperationActive = false;
    state.martingaleStep = 0;
    state.perdaAcumulada = 0;
    state.apostaInicial = 0;
    state.ultimaDirecaoMartingale = null; // ✅ CORREÇÃO: Limpar direção do martingale
  }

  /**
   * Incrementa estatísticas do modo preciso
   */
  private async incrementPrecisoStats(
    userId: string,
    won: boolean,
    profitLoss: number,
  ): Promise<void> {
    const column = won ? 'total_wins' : 'total_losses';

    // Buscar saldo atual da sessão
    const currentBalanceResult = await this.dataSource.query(
      `SELECT COALESCE(session_balance, 0) as currentBalance
       FROM ai_user_config
       WHERE user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [userId],
    );

    const currentBalance = parseFloat(currentBalanceResult[0]?.currentBalance) || 0;
    const newBalance = currentBalance + profitLoss;

    await this.dataSource.query(
      `UPDATE ai_user_config
       SET total_trades = total_trades + 1,
           ${column} = ${column} + 1,
           session_balance = ?,
           last_trade_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND is_active = TRUE`,
      [newBalance, userId],
    );

    this.logger.debug(`[IncrementPrecisoStats][${userId}] Saldo atualizado: $${currentBalance.toFixed(2)} + $${profitLoss.toFixed(2)} = $${newBalance.toFixed(2)}`);

    // Verificar e enforçar limites após cada trade
    await this.checkAndEnforceLimits(userId);

    // ✅ ZENIX v2.0: Verificar Stop Blindado (proteção de lucros)
    await this.checkStopBlindado(userId);
  }

  /**
   * Calcula stake para o modo preciso (valor configurado + martingale unificado)
   * ZENIX v2.0: Usa valor configurado diretamente (não porcentagem)
   */
  private async calculatePrecisoStake(state: PrecisoUserState, proposal?: DigitParity): Promise<number> {
    // ✅ ZENIX v2.0: Soros funciona apenas até a entrada 3 (níveis 0, 1, 2)
    const entry = state.martingaleStep || 1;

    if (entry === 1) {
      // Primeira entrada: usar valor inicial
      if (state.apostaBase <= 0) {
        state.apostaBase = state.capital || PRECISO_CONFIG.minStake;
      }
      return Math.max(PRECISO_CONFIG.minStake, state.apostaBase);
    }

    if (entry === 2) {
      // Entrada 2: Soros Nível 1 (se entrada 1 foi vitoriosa)
      if (state.vitoriasConsecutivas === 1 && state.ultimoLucro > 0 && state.perdaAcumulada === 0) {
        const apostaComSoros = calcularApostaComSoros(
          state.apostaInicial || state.apostaBase,
          state.ultimoLucro,
          1, // Soros nível 1
        );

        if (apostaComSoros !== null) {
          return Math.max(PRECISO_CONFIG.minStake, apostaComSoros);
        }
      }
    }

    if (entry === 3) {
      // Entrada 3: Soros Nível 2 (se entrada 2 foi vitoriosa)
      if (state.vitoriasConsecutivas === 2 && state.ultimoLucro > 0 && state.perdaAcumulada === 0) {
        const apostaComSoros = calcularApostaComSoros(
          state.apostaInicial || state.apostaBase,
          state.ultimoLucro,
          2, // Soros nível 2
        );

        if (apostaComSoros !== null) {
          return Math.max(PRECISO_CONFIG.minStake, apostaComSoros);
        }
      }
    }

    // SISTEMA UNIFICADO DE MARTINGALE (para entradas > 1)
    // Consultar payout via API antes de calcular
    const contractType: 'DIGITEVEN' | 'DIGITODD' = proposal === 'PAR' ? 'DIGITEVEN' : 'DIGITODD';
    let payoutCliente = 92; // Valor padrão caso falhe a consulta (95 - 3)

    try {
      payoutCliente = await this.consultarPayoutCliente(
        state.derivToken,
        state.currency || 'USD',
        contractType,
      );
    } catch (error) {
      this.logger.warn(
        `[Preciso][Martingale] Erro ao consultar payout, usando padrão (92%): ${error.message}`,
      );
    }

    const proximaAposta = calcularProximaAposta(
      state.perdaAcumulada,
      state.modoMartingale,
      payoutCliente,
    );

    // Calcular lucro esperado baseado no modo
    const multiplicadorLucro = state.modoMartingale === 'conservador' ? 0 :
      state.modoMartingale === 'moderado' ? 0.25 : 0.50;
    const lucroDesejado = state.perdaAcumulada * multiplicadorLucro;

    this.logger.debug(
      `[Preciso][Martingale ${state.modoMartingale.toUpperCase()}] ` +
      `Perdas totais: $${state.perdaAcumulada.toFixed(2)} | ` +
      `Payout cliente: ${payoutCliente.toFixed(2)}% | ` +
      `Lucro desejado: $${lucroDesejado.toFixed(2)} | ` +
      `Próxima aposta: $${proximaAposta.toFixed(2)}`,
    );

    return Math.max(PRECISO_CONFIG.minStake, proximaAposta);
  }

  /**
   * Sincroniza usuários do modo preciso do banco de dados
   */
  async syncPrecisoUsersFromDb(): Promise<void> {
    try {
      const activeUsers = await this.dataSource.query(
        `SELECT 
          user_id as userId,
          stake_amount as stakeAmount,
          deriv_token as derivToken,
          currency,
          modo_martingale as modoMartingale
         FROM ai_user_config
         WHERE is_active = TRUE
           AND LOWER(mode) = 'preciso'`,
      );

      this.logger.log(`[SyncPreciso] Sincronizando ${activeUsers.length} usuários do banco`);

      const activeIds = new Set(activeUsers.map((u: any) => u.userId));

      // Remover usuários que não estão mais ativos
      for (const existingId of this.precisoUsers.keys()) {
        if (!activeIds.has(existingId)) {
          this.precisoUsers.delete(existingId);
          this.logger.log(`[SyncPreciso] Removido usuário ${existingId} (não mais ativo)`);
        }
      }

      // Adicionar/atualizar usuários ativos
      for (const user of activeUsers) {
        this.logger.debug(
          `[SyncPreciso] Lido do banco: userId=${user.userId} | stake=${user.stakeAmount} | martingale=${user.modoMartingale}`,
        );

        // ✅ [ZENIX v3.4] Resolver conta para garantir moeda correta (BTC, etc)
        const resolved = await this.resolveDerivAccount(user.userId, user.derivToken, user.currency);

        this.upsertPrecisoUserState({
          userId: user.userId,
          stakeAmount: parseFloat(user.stakeAmount),
          derivToken: resolved.token,
          currency: resolved.currency || 'USD',
          modoMartingale: user.modoMartingale || 'conservador',
        });
      }
    } catch (error) {
      this.logger.error('[SyncPreciso] Erro ao sincronizar usuários:', error);
    }
  }

  /**
   * Adiciona ou atualiza estado de usuário no modo preciso
   */
  private upsertPrecisoUserState(params: {
    userId: string;
    stakeAmount: number;
    entryValue?: number; // ✅ Valor de entrada por operação (opcional)
    derivToken: string;
    currency: string;
    modoMartingale?: ModoMartingale;
  }): void {
    const modoMartingale = params.modoMartingale || 'conservador';
    const apostaInicial = params.entryValue || getMinStakeByCurrency(params.currency); // ✅ Moeda dinâmica

    this.logger.log(
      `[UpsertPrecisoState] userId=${params.userId} | capital=${params.stakeAmount} | currency=${params.currency} | martingale=${modoMartingale}`,
    );

    const existing = this.precisoUsers.get(params.userId);

    if (existing) {
      // Atualizar existente
      this.logger.debug(
        `[UpsertPrecisoState] Atualizando usuário existente | capital antigo=${existing.capital} | capital novo=${params.stakeAmount} | martingale=${modoMartingale}`,
      );

      existing.capital = params.stakeAmount;
      existing.derivToken = params.derivToken;
      existing.currency = params.currency;
      existing.modoMartingale = modoMartingale;

      // Resetar capital virtual se necessário
      if (existing.virtualCapital <= 0) {
        existing.virtualCapital = params.stakeAmount;
      }

      // ✅ ZENIX v2.0: Atualizar apostaBase e apostaInicial se entryValue foi fornecido
      if (params.entryValue !== undefined) {
        existing.apostaBase = apostaInicial;
        existing.apostaInicial = apostaInicial;
      } else if (existing.apostaBase <= 0) {
        existing.apostaBase = apostaInicial;
        existing.apostaInicial = apostaInicial;
      }
    } else {
      // Criar novo
      this.logger.debug(`[UpsertPrecisoState] Criando novo usuário | capital=${params.stakeAmount} | martingale=${modoMartingale}`);

      this.precisoUsers.set(params.userId, {
        userId: params.userId,
        derivToken: params.derivToken,
        currency: params.currency,
        capital: params.stakeAmount,
        virtualCapital: params.stakeAmount,
        lossVirtualActive: false,
        lossVirtualCount: 0,
        lossVirtualOperation: null,
        isOperationActive: false,
        martingaleStep: 0,
        modoMartingale: modoMartingale,
        perdaAcumulada: 0,
        apostaInicial: apostaInicial, // ✅ Valor de entrada por operação
        vitoriasConsecutivas: 0, // ✅ ZENIX v2.0: Estratégia Soros - inicializar contador
        ultimoLucro: 0, // ✅ ZENIX v2.0: Lucro da última entrada (para calcular Soros)
        apostaBase: apostaInicial, // ✅ ZENIX v2.0: Inicializar aposta base com entryValue
        ultimaDirecaoMartingale: null, // ✅ CORREÇÃO: Direção da última operação quando em martingale
        totalProfitLoss: 0, // Lucro/prejuízo total acumulado
      });
    }
  }

  /**
   * Remove usuário do modo preciso
   */
  private removePrecisoUserState(userId: string): void {
    if (this.precisoUsers.has(userId)) {
      this.precisoUsers.delete(userId);
      this.logger.log(`[Preciso] Estado removido para usuário ${userId}`);
    }
  }

  // ======================== TRINITY REMOVIDO ========================
}

