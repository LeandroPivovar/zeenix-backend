/**
 * Utility functions for currency handling (USD, BTC, etc.)
 */

/**
 * Returns the minimum stake allowed by Deriv for a given currency.
 * @param currency The currency code (e.g., 'USD', 'BTC')
 */
export function getMinStakeByCurrency(currency: string): number {
    const curr = (currency || 'USD').toUpperCase();
    switch (curr) {
        case 'BTC': return 0.00001; // Safe minimum for BTC
        case 'ETH': return 0.0001;
        case 'LTC': return 0.01;
        case 'USDT': return 1.0;
        case 'DEMO': return 0.35;
        default: return 0.35;
    }
}

/**
 * Formats a currency amount with the appropriate symbol and decimal places.
 * @param amount The numerical amount
 * @param currency The currency code
 */
export function formatCurrency(amount: number, currency: string): string {
    const curr = (currency || 'USD').toUpperCase();
    const symbol = curr === 'BTC' ? '₿' : (curr === 'ETH' ? 'Ξ' : (curr === 'LTC' ? 'Ł' : '$'));

    // For crypto, use up to 8 decimals if needed
    const isCrypto = ['BTC', 'ETH'].includes(curr);
    const decimals = isCrypto ? 8 : 2;

    // Clean up trailing zeros for crypto but keep at least 2 for fiat
    let formatted = amount.toFixed(decimals);
    if (isCrypto) {
        formatted = parseFloat(formatted).toString();
        if (!formatted.includes('.')) formatted += '.00';
        else if (formatted.split('.')[1].length < 2) formatted += '0';
    }

    return `${symbol}${formatted} ${curr}`;
}

/**
 * Returns the number of decimal places for a currency.
 */
export function getCurrencyDecimals(currency: string): number {
    const curr = (currency || 'USD').toUpperCase();
    return ['BTC', 'ETH'].includes(curr) ? 8 : 2;
}
