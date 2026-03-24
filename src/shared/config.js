/**
 * COIN v2 Config — 5-Zone Architecture
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(__dirname, '../../.env.local');
  const content = readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

const env = loadEnv();

export const config = {
  // Oracle
  oracle: {
    user: env.ORACLE_USER,
    password: env.ORACLE_PASSWORD,
    connectString: env.ORACLE_CONNECT_STRING,
    instantClientPath: env.ORACLE_INSTANT_CLIENT_PATH,
  },

  // Trading symbols (Core = 고정, Flex = 자동 로테이션)
  tradingSymbolsCore: (env.TRADING_SYMBOLS_CORE || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim()).filter(Boolean),
  tradingSymbolsFlex: (env.TRADING_SYMBOLS_FLEX || '').split(',').map(s => s.trim()).filter(Boolean),
  get tradingSymbols() {
    return [...this.tradingSymbolsCore, ...this.tradingSymbolsFlex];
  },
  /** Flex 심볼 동적 교체 (SymbolRotator에서 호출) */
  updateFlexSymbols(newFlex) {
    const prev = [...this.tradingSymbolsFlex];
    this.tradingSymbolsFlex = newFlex;
    const added = newFlex.filter(s => !prev.includes(s));
    const removed = prev.filter(s => !newFlex.includes(s));
    if (added.length || removed.length) {
      console.log(`[Config] Flex 심볼 변경: +${added.length} -${removed.length} → 총 ${this.tradingSymbols.length}개`);
      if (added.length) console.log(`[Config]   추가: ${added.join(', ')}`);
      if (removed.length) console.log(`[Config]   제거: ${removed.join(', ')}`);
    }
    return { added, removed, total: this.tradingSymbols };
  },

  // Trading
  trading: {
    exchange: 'BINANCE_FUTURES',
    marginMode: 'ISOLATED',
    maxLeverage: parseInt(env.MAX_LEVERAGE || '2'),          // 스윙: 레버리지 하향
    feeRateTaker: parseFloat(env.FEE_RATE_TAKER || '0.04'),
    feeRoundtrip: parseFloat(env.FEE_ROUNDTRIP || '0.08'),
    maxPositionPct: parseFloat(env.MAX_POSITION_PCT || '10'),
    safetyStopPct: parseFloat(env.SAFETY_STOP_PCT || '4'),  // 스윙: 손절폭 4%
    maxSlippagePct: parseFloat(env.MAX_SLIPPAGE_PCT || '0.3'),  // 진입 전 호가창 슬리피지 한도
    maxDailyLossPct: parseFloat(env.MAX_DAILY_LOSS_PCT || '5'),
    maxOpenTrades: parseInt(env.MAX_OPEN_TRADES || '5'),    // 스윙: 동시 5개
    initialCapital: parseFloat(env.INITIAL_CAPITAL || '10000'),
    directions: ['LONG', 'SHORT'],
  },

  // Binance Futures Testnet
  binance: {
    apiKey: env.BINANCE_FUTURES_API_KEY || '',
    apiSecret: env.BINANCE_FUTURES_API_SECRET || '',
    testnet: env.BINANCE_TESTNET !== 'false',
  },

  // Tiingo (뉴스)
  tiingo: {
    apiKey: env.TIINGO_API_KEY,
    baseUrl: env.TIINGO_BASE_URL || 'https://api.tiingo.com',
    tickers: (env.TIINGO_NEWS_TICKERS || '').split(','),
    tags: env.TIINGO_NEWS_TAGS || 'crypto,cryptocurrency',
  },

  // FRED (매크로)
  fred: {
    apiKey: env.FRED_API_KEY,
    seriesIds: (env.FRED_SERIES_IDS || '').split(',').filter(Boolean),
  },

  // CryptoQuant (온체인)
  cryptoquant: {
    apiKey: env.CRYPTOQUANT_API_KEY || '',
  },

  // Coinglass (청산맵)
  coinglass: {
    apiKey: env.COINGLASS_API_KEY || '',
  },

  // LLM (하이브리드: 로컬 + 클라우드)
  llm: {
    pythonUrl: env.PYTHON_LLM_URL || 'http://localhost:2002',
  },

  // 타임존
  timezone: 'America/New_York',
};
