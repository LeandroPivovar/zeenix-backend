import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';

/**
 * Valida um número de telefone brasileiro usando libphonenumber-js
 * @param phoneNumber - Número de telefone (com ou sem formatação)
 * @returns Objeto com isValid e phoneDigits (apenas dígitos)
 */
export function validateBrazilianPhone(phoneNumber: string): {
  isValid: boolean;
  phoneDigits: string | null;
  error?: string;
} {
  if (!phoneNumber || !phoneNumber.trim()) {
    return {
      isValid: false,
      phoneDigits: null,
      error: 'Telefone é obrigatório',
    };
  }

  // Remover caracteres não numéricos
  const phoneDigits = phoneNumber.replace(/\D/g, '');

  // Verificar se tem pelo menos 10 dígitos (DDD + número)
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    return {
      isValid: false,
      phoneDigits: null,
      error: 'Telefone inválido. Use o formato: (XX) XXXXX-XXXX ou (XX) XXXX-XXXX',
    };
  }

  try {
    // Tentar parsear como número brasileiro
    // Se começar com 0, remover (alguns formatos incluem 0 antes do DDD)
    let cleanPhone = phoneDigits.startsWith('0') ? phoneDigits.substring(1) : phoneDigits;
    
    // Se já tiver código do país (55), remover
    if (cleanPhone.startsWith('55') && cleanPhone.length > 11) {
      cleanPhone = cleanPhone.substring(2);
    }
    
    // Adicionar código do país para validação
    const phoneWithCountry = `+55${cleanPhone}`;

    // Validar usando libphonenumber-js
    const isValid = isValidPhoneNumber(phoneWithCountry, 'BR');
    
    if (!isValid) {
      return {
        isValid: false,
        phoneDigits: null,
        error: 'Telefone inválido. Verifique o DDD e o número',
      };
    }

    // Parsear para obter informações adicionais
    const parsed = parsePhoneNumber(phoneWithCountry, 'BR');
    
    // Verificar se é um número válido do Brasil
    if (parsed.country !== 'BR') {
      return {
        isValid: false,
        phoneDigits: null,
        error: 'Telefone deve ser do Brasil',
      };
    }

    // Retornar apenas os dígitos nacionais (sem código do país)
    // O formato será: DDD + número (10 ou 11 dígitos)
    const nationalNumber = parsed.nationalNumber;
    
    return {
      isValid: true,
      phoneDigits: nationalNumber,
    };
  } catch (error) {
    return {
      isValid: false,
      phoneDigits: null,
      error: 'Telefone inválido. Verifique o formato',
    };
  }
}

/**
 * Formata um número de telefone brasileiro
 * @param phoneDigits - Número apenas com dígitos
 * @returns Número formatado como (XX) XXXXX-XXXX ou (XX) XXXX-XXXX
 */
export function formatBrazilianPhone(phoneDigits: string): string {
  if (!phoneDigits) return '';
  
  const digits = phoneDigits.replace(/\D/g, '');
  
  if (digits.length === 10) {
    // Telefone fixo: (XX) XXXX-XXXX
    return digits.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  } else if (digits.length === 11) {
    // Celular: (XX) XXXXX-XXXX
    return digits.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  }
  
  return digits;
}

