import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GeminiService {
  private readonly GEMINI_API_KEY: string;
  private readonly GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  constructor(private configService: ConfigService) {
    this.GEMINI_API_KEY = this.configService.get<string>('GEMINI_API_KEY') || '';
  }

  async getTradingRecommendation(
    ticks: Array<{ value: number; epoch: number }>,
    symbol?: string,
    tradeType?: string,
    duration?: number,
    durationUnit?: string,
    amount?: number,
    multiplier?: number
  ): Promise<{
    action: string;
    confidence: number;
    reasoning?: string;
    entry_time?: number;
    barrier?: number;
  }> {
    try {
      const ticksData = ticks.slice(-50).map(t => ({
        value: t.value,
        epoch: t.epoch
      }));

      const contextInfo = `
Contexto da Operação:
- Mercado: ${symbol || 'Não informado'}
- Tipo de Negociação: ${tradeType || 'Não informado'}
- Duração: ${duration || 'Não informado'} ${durationUnit || ''}
- Valor de Entrada: ${amount || 'Não informado'}
${multiplier ? `- Multiplicador: ${multiplier}` : ''}
`;

      const prompt = `Você é um analista de trading de elite especializado em mercados da Deriv/Binary.
Sua missão é dar um sinal de entrada com alta probabilidade de acerto.

${contextInfo}

Dados dos últimos 50 ticks:
${JSON.stringify(ticksData)}

Instruções para a decisão:
1. ANALISE A TENDÊNCIA: O mercado está em tendência de alta, baixa ou lateral?
2. PADRÕES DE DÍGITOS: Se o tipo de negociação for de dígitos (DIGIT...), analise o último dígito de cada tick.
3. CONTEXTO: Considere a duração da operação (${duration} ${durationUnit}) ao definir o tempo de entrada.

RETORNE EXCLUSIVAMENTE UM JSON com:
{
  "action": "A ação correspondente (ex: CALL, PUT, DIGITEVEN, DIGITODD, DIGITMATCH, DIGITDIFF, DIGITOVER, DIGITUNDER, CALLE, PUTE)",
  "confidence": 0-100,
  "entry_time_seconds": 0-59 (segundos para o usuário clicar no botão),
  "barrier": número (se o contrato exigir uma barreira/previsão de dígito, ex: para DIGITMATCH ou DIGITOVER),
  "reasoning": "explicação técnica objetiva em português"
}

Observação crucial: A action deve ser compatível com o tradeType informado. Se for um contrato de subida/queda, retorne CALL ou PUT. Se for par/ímpar, retorne DIGITEVEN ou DIGITODD.`;

      const response = await fetch(`${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GeminiService] Erro da API Gemini:', {
          status: response.status,
          statusText: response.statusText,
          body: errorText
        });
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Extrair JSON da resposta
      const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Resposta do Gemini não contém JSON válido');
      }

      const recommendation = JSON.parse(jsonMatch[0]);

      // Validar e normalizar a resposta
      const action = recommendation.action?.toUpperCase() || 'CALL';
      const confidence = Math.max(0, Math.min(100, Number(recommendation.confidence) || 50));
      const entryTime = Math.max(0, Number(recommendation.entry_time_seconds) || 0);
      const barrier = recommendation.barrier !== undefined ? Number(recommendation.barrier) : undefined;

      return {
        action,
        confidence,
        entry_time: entryTime,
        barrier,
        reasoning: recommendation.reasoning || 'Análise baseada nos últimos 50 ticks'
      };
    } catch (error) {
      console.error('[GeminiService] Erro ao obter recomendação - Detalhes:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data || error.response || 'No response data'
      });

      // Retornar recomendação padrão em caso de erro
      return {
        action: 'CALL',
        confidence: 50,
        reasoning: `Erro ao processar recomendação da IA: ${error.message}`
      };
    }
  }
}

