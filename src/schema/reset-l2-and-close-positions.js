/**
 * +---------------------------------------------------------+
 * | MODULE: reset-l2-and-close-positions.js                  |
 * +---------------------------------------------------------+
 */
import { logger } from "../shared/logger.js";
/**
 * 포트폴리오 전체 청산 + L2(Zone 2) 이후 데이터 초기화
 *
 * 1단계: 바이낸스 거래소 OPEN 포지션 전부 시장가 청산
 * 2단계: 미체결 주문 전부 취소
 * 3단계: DB z2 ~ z4 테이블 TRUNCATE
 */
import oracledb from 'oracledb';
import crypto from 'crypto';
import { config } from '../shared/config.js';

// ── Oracle 초기화 ──
if (config.oracle.instantClientPath) {
  oracledb.initOracleClient({ libDir: config.oracle.instantClientPath });
}

const apiKey = config.binance?.apiKey || process.env.BINANCE_API_KEY || '';
const apiSecret = config.binance?.apiSecret || process.env.BINANCE_API_SECRET || '';
const testnet = config.binance?.testnet !== false;
const baseUrl = testnet
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

logger.info(`\n${'='.repeat(60)}`);
logger.info(`  COIN 포트폴리오 청산 + L2 이후 데이터 초기화`);
logger.info(`  모드: ${testnet ? 'TESTNET' : '⚠️  MAINNET (실전)'}`);
logger.info(`${'='.repeat(60)}\n`);

// ── Binance API Helper ──
async function signedRequest(method, path, params = {}) {
  if (!apiKey) throw new Error('Binance API key not configured');
  const timestamp = Date.now();
  const queryParams = { ...params, timestamp, recvWindow: 5000 };
  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', apiSecret)
    .update(queryString).digest('hex');
  const url = `${baseUrl}${path}?${queryString}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance ${method} ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

// ══════════════════════════════════════════
// 1단계: 거래소 포지션 청산
// ══════════════════════════════════════════
logger.info('[1/3] 거래소 포지션 확인 중...');

if (apiKey) {
  try {
    const positions = await signedRequest('GET', '/fapi/v2/positionRisk');
    const openPositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);

    if (openPositions.length === 0) {
      logger.info('  → 열린 포지션 없음 ✓');
    } else {
      logger.info(`  → ${openPositions.length}개 포지션 청산 시작...`);

      for (const pos of openPositions) {
        const symbol = pos.symbol;
        const amt = parseFloat(pos.positionAmt);
        const side = amt > 0 ? 'LONG' : 'SHORT';
        const qty = Math.abs(amt);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        try {
          // 미체결 주문 먼저 취소
          try {
            await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
          } catch (_) {}

          // 시장가 청산
          const result = await signedRequest('POST', '/fapi/v1/order', {
            symbol,
            side: closeSide,
            type: 'MARKET',
            quantity: qty,
            reduceOnly: 'true',
          });
          logger.info(`  ✓ ${side} ${symbol} qty=${qty} 청산 완료 (orderId=${result.orderId})`);
        } catch (err) {
          logger.error(`  ✗ ${symbol} 청산 실패: ${err.message}`);
        }
      }
    }

    // 잔여 미체결 주문 확인 및 취소
    const openOrders = await signedRequest('GET', '/fapi/v1/openOrders');
    if (openOrders.length > 0) {
      logger.info(`\n[2/3] 미체결 주문 ${openOrders.length}개 취소 중...`);
      const symbols = [...new Set(openOrders.map(o => o.symbol))];
      for (const sym of symbols) {
        try {
          await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: sym });
          logger.info(`  ✓ ${sym} 주문 취소 완료`);
        } catch (err) {
          logger.error(`  ✗ ${sym} 주문 취소 실패: ${err.message}`);
        }
      }
    } else {
      logger.info('\n[2/3] 미체결 주문 없음 ✓');
    }

    // 잔고 확인
    const balances = await signedRequest('GET', '/fapi/v2/balance');
    const usdt = balances.find(b => b.asset === 'USDT');
    if (usdt) {
      logger.info(`\n  잔고: ${parseFloat(usdt.balance).toFixed(2)} USDT (가용: ${parseFloat(usdt.availableBalance).toFixed(2)} USDT)`);
    }

  } catch (err) {
    logger.error(`  거래소 접근 실패: ${err.message}`);
    logger.info('  → DB 초기화만 진행합니다.');
  }
} else {
  logger.info('  → Binance API key 없음 — 거래소 작업 건너뜀');
  logger.info('\n[2/3] 건너뜀');
}

// ══════════════════════════════════════════
// 3단계: DB 초기화 (L2 이후 = z2, z3, z4)
// ══════════════════════════════════════════
logger.info('\n[3/3] DB 초기화 (Z2 Intelligence + Z3 Execution + Z4 Results)...');

const conn = await oracledb.getConnection({
  user: config.oracle.user,
  password: config.oracle.password,
  connectString: config.oracle.connectString,
});

const tables = [
  // Z2: Intelligence
  'z2_llm_analysis',
  'z2_execution_plan',
  // Z3: Execution
  'z3_logic_checks',
  // Z4: Results
  'z4_trade_log',
  'z4_positions',
  'z4_performance',
];

for (const t of tables) {
  try {
    await conn.execute(`TRUNCATE TABLE ${t}`);
    logger.info(`  ✓ TRUNCATED ${t}`);
  } catch (err) {
    logger.warn(`  ✗ SKIP ${t}: ${err.message.split('\n')[0]}`);
  }
}

await conn.close();

logger.info(`\n${'='.repeat(60)}`);
logger.info('  완료! 포트폴리오 청산 + L2 이후 데이터 초기화됨');
logger.info('  Z0 (Raw Data) / Z1 (Processed) 데이터는 유지됩니다.');
logger.info(`${'='.repeat(60)}\n`);
