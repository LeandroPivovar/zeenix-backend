import { Injectable } from '@nestjs/common';

@Injectable()
export class GeminiService {
  private readonly GEMINI_API_KEY = 'AIzaSyDEe-kanGsyCuwau8hYCog6-Z5cR_OXnqE';
  private readonly GEMINI_API_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  async getTradingRecommendation(
    ticks: Array<{ value: number; epoch: number }>,
  ): Promise<{
    action: 'CALL' | 'PUT';
    confidence: number;
    reasoning?: string;
  }> {
    try {
      const ticksData = ticks.map((t) => ({
        value: t.value,
        timestamp: new Date(t.epoch * 1000).toISOString(),
      }));

      const prompt = `Você é um especialista em day trading, considere o método abaixo para dar uma dica de ação (por enquanto operar somente no método call e put).

Os últimos 10 dados recebidos foram estes:
${JSON.stringify(ticksData, null, 2)}

Nos dê um retorno no formato JSON com a seguinte estrutura:
{
  "action": "CALL" ou "PUT",
  "confidence": número de 0 a 100 (porcentagem de confiabilidade),
  "reasoning": "breve explicação do motivo da recomendação"
}

Analise a tendência dos preços e forneça uma recomendação baseada em análise técnica.`;

      const response = await fetch(
        `${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt,
                  },
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GeminiService] Erro da API Gemini:', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(
          `Gemini API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const data = await response.json();
      const textResponse =
        data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Extrair JSON da resposta
      const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Resposta do Gemini não contém JSON válido');
      }

      const recommendation = JSON.parse(jsonMatch[0]);

      // Validar e normalizar a resposta
      const action =
        recommendation.action?.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
      const confidence = Math.max(
        0,
        Math.min(100, Number(recommendation.confidence) || 50),
      );

      return {
        action,
        confidence,
        reasoning:
          recommendation.reasoning || 'Análise baseada nos últimos 10 ticks',
      };
    } catch (error) {
      console.error('[GeminiService] Erro ao obter recomendação:', error);

      // Retornar recomendação padrão em caso de erro
      return {
        action: 'CALL',
        confidence: 50,
        reasoning: 'Erro ao processar recomendação da IA',
      };
    }
  }
}
