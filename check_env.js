import { config } from './src/shared/config.js';

console.log("Coinglass API Key present:", !!config.coinglass.apiKey);
console.log("CryptoQuant API Key present:", !!config.cryptoquant.apiKey);
