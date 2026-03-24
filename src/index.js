/**
 * COIN v2 — 5-Zone Architecture Main Orchestrator
 *
 * Z0(Raw) → Z1(Processed) → Z2(Intelligence) → Z3(Execution) → Z4(Results)
 * 타임존: DB=UTC, 표시=ET(America/New_York)
 * Windows에서 process.env.TZ는 작동하지 않으므로 Oracle 세션 UTC + UI에서 ET 변환
 */

import { spawn } from 'child_process';
import net from 'net';
import { initDb, closeDb, getPool } from './shared/db.js';
import { config } from './shared/config.js';
import { ApiServer } from './api/index.js';

// Python LLM 서버 자동 시작 (포트 충돌 시 스킵 — 재시도 안 함)
let llmProcess = null;
function startLLMServer() {
  const probe = net.createConnection({ port: 2002, host: '127.0.0.1' });
  probe.on('connect', () => {
    probe.destroy();
    console.log('[LLM-PY] Port 2002 already active — skipping auto-start');
  });
  probe.on('error', () => {
    // 포트 비어있음 → Python 서버 시작
    const cwd = new URL('../python-llm', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    llmProcess = spawn('python', ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '2002'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    llmProcess.stdout?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[LLM-PY] ${msg}`);
    });
    llmProcess.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg.includes('10048') || msg.includes('EADDRINUSE')) return; // 포트 충돌 무시
      if (msg && !msg.includes('INFO:')) console.error(`[LLM-PY] ${msg}`);
    });
    llmProcess.on('exit', (code) => {
      llmProcess = null;
      // 포트 충돌(code=1,3)이면 재시작 안 함, 그 외만 재시도
      if (code && code !== 1 && code !== 3) {
        setTimeout(() => startLLMServer(), 10000);
      }
    });
    console.log('[LLM-PY] Python LLM server starting on port 2002');
  });
}

// Zone 0: Raw Data
import { RingBuffer } from './z0-raw/ring-buffer.js';
import { FuturesWsConnector } from './z0-raw/futures-ws-connector.js';
import { FuturesRestCollector } from './z0-raw/futures-rest-collector.js';
import { FuturesRawWriter } from './z0-raw/futures-raw-writer.js';
import { MacroCollector } from './z0-raw/macro-collector.js';
import { NewsCollector } from './z0-raw/news-collector.js';
import { TiingoCryptoWs } from './z0-raw/tiingo-crypto-ws.js';
import { OnchainCollector } from './z0-raw/onchain-collector.js';
import { CoinglassCollector } from './z0-raw/coinglass-collector.js';
import { EconomicCalendar } from './z0-raw/economic-calendar.js';
import { FearGreedCollector } from './z0-raw/fear-greed-collector.js';
import { StablecoinCollector } from './z0-raw/stablecoin-collector.js';

// Zone 1: Processed
import { StateVectorBuilder } from './z1-processed/state-vector-builder.js';

// Zone 2: Intelligence
import { LLMScheduler } from './z2-intel/scheduler.js';
import { EventMonitor } from './z2-intel/event-monitor.js';

// Zone 3: Execution
import { RuleEngine } from './z3-exec/rule-engine.js';
import { Executor } from './z3-exec/executor.js';

// Zone 4: Results
import { TradeRecorder } from './z4-results/trade-recorder.js';
import { PerformanceTracker } from './z4-results/performance-tracker.js';

// Symbol Rotation
import { SymbolRotator } from './z0-raw/symbol-rotator.js';

const symbols = config.tradingSymbols;

// ── 컴포넌트 ──
// 1초봉 차트에서 진입 전 5분 포함 최대 1시간(3600초)까지 표시할 수 있도록
// tradeSize를 넉넉하게 50000(초당 10번 거래 가정 시 약 1.3시간 분량)으로 확장합니다.
const ringBuffer = new RingBuffer(50000);
const rawWriter = new FuturesRawWriter();
const macroCollector = new MacroCollector();
const newsCollector = new NewsCollector();
const tiingoCryptoWs = new TiingoCryptoWs(symbols);
const onchainCollector = new OnchainCollector();
const coinglassCollector = new CoinglassCollector(symbols);
const economicCalendar = new EconomicCalendar();
const fearGreedCollector = new FearGreedCollector();
const stablecoinCollector = new StablecoinCollector();
const tradeRecorder = new TradeRecorder();
tradeRecorder.ringBuffer = ringBuffer; // 1초봉 캡처용
const perfTracker = new PerformanceTracker();

const wsConnector = new FuturesWsConnector(symbols, {
  onTrade: (t) => { ringBuffer.pushTrade(t.symbol, t); rawWriter.onTrade(t); },
  onKline: (k) => { ringBuffer.pushKline(k.symbol, k); if (k.isClosed) rawWriter.onKlineClosed(k); },
  onDepth: (d) => { ringBuffer.pushDepth(d.symbol, d); },
  onMarkPrice: (m) => { ringBuffer.pushMarkPrice(m.symbol, m); rawWriter.onMarkPrice(m); },
  onLiquidation: (l) => { rawWriter.onLiquidation(l); },
  onStatus: (s, d) => { console.log(`[WS] ${s}`, d || ''); },
});

const restCollector = new FuturesRestCollector(symbols);
const stateVectorBuilder = new StateVectorBuilder(ringBuffer, macroCollector, { symbols });
const llmScheduler = new LLMScheduler(newsCollector, symbols, {
  economicCalendar,
  fearGreedCollector,
  stablecoinCollector,
});
const eventMonitor = new EventMonitor(newsCollector, ringBuffer, { symbols });
const ruleEngine = new RuleEngine(ringBuffer, macroCollector, symbols);

const executor = new Executor(ringBuffer, {
  testnetMode: config.binance.testnet,
  apiKey: config.binance.apiKey,
  apiSecret: config.binance.apiSecret,
  ...config.trading,
});

// ── 심볼 로테이터 ──
const symbolRotator = new SymbolRotator(config, {
  getOpenPositionSymbols: () => [...executor.activePositions.values()].map(p => p.symbol),
  onRotation: (allSymbols, { added, removed }) => {
    // 전 컴포넌트 심볼 리스트 갱신
    wsConnector.updateSymbols(allSymbols);
    restCollector.symbols = allSymbols;
    tiingoCryptoWs.symbols = allSymbols;
    coinglassCollector.symbols = allSymbols.slice(0, 10);
    stateVectorBuilder.symbols = allSymbols;
    llmScheduler.symbols = allSymbols;
    eventMonitor.symbols = allSymbols;
    ruleEngine.symbols = allSymbols;
  },
});

// ── 배선 ──
ruleEngine.onSignal = (signal) => executor.onSignal(signal);
executor.onTrade = (trade) => tradeRecorder.record(trade);
eventMonitor.llmScheduler = llmScheduler;  // 이벤트 → 긴급 브리핑+시나리오 연쇄
llmScheduler.planCache = ruleEngine.planCache; // 플랜 연장 시 인메모리 캐시 즉시 동기화

// ── 시작 ──
async function start() {
  console.log('=== COIN v2 — 5-Zone Architecture ===');
  console.log(`Symbols: Core ${config.tradingSymbolsCore.length} + Flex auto-rotation`);

  await initDb();

  startLLMServer();

  // Z0
  rawWriter.start();
  await wsConnector.start();
  restCollector.start();
  macroCollector.start();
  newsCollector.start();
  tiingoCryptoWs.start();
  // onchainCollector.start();  // CryptoQuant 무료 = 데이터 접근 불가 (403)
  coinglassCollector.start();
  economicCalendar.start();
  fearGreedCollector.start();
  stablecoinCollector.start();
  symbolRotator.start();  // 시작 30초 후 첫 로테이션
  global._symbolRotator = symbolRotator;

  // Z1 (PL/SQL 트리거 자동)
  stateVectorBuilder.start();

  // Z2
  llmScheduler.start();
  eventMonitor.start();

  // Z3
  ruleEngine.start();
  executor.start();

  // Z4
  tradeRecorder.startPostExitPoller();
  perfTracker.start();

  // API Server (글로벌 참조 — shutdown에서 close)
  global._apiServer = new ApiServer({
    port: 2001,
    ringBuffer,
    ruleEngine,
    executor,
    macroCollector,
  });
  await global._apiServer.start();

  // 30초마다 통계
  setInterval(() => {
    const re = ruleEngine.getStats();
    const ex = executor.getStats();
    const prices = symbols.slice(0, 3).map(s => {
      const p = ringBuffer.getLastPrice(s);
      return p ? `${s}=$${p.toFixed(2)}` : `${s}=--`;
    }).join(' | ');

    console.log(
      `[STATS] ${prices} | plans=${re.activePlans} signals=${re.signalCount} | ` +
      `entries=${ex.entries} exits=${ex.exits} bal=$${ex.balance.toFixed(2)}`
    );
  }, 30000);

  console.log('[COIN] All 5 zones started');
}

let shuttingDown = false;
async function shutdown(reason = 'SIGINT') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[COIN] Shutting down (reason=${reason})...`);

  // 데이터 수집 중단 (새 시그널 차단)
  ruleEngine.stop();
  llmScheduler.stop();
  eventMonitor.stop();
  wsConnector.stop();

  // 오픈 포지션 전체 청산
  try {
    const openCount = executor.activePositions?.size || 0;
    if (openCount > 0) {
      console.log(`[COIN] Closing ${openCount} open positions before shutdown...`);
      await executor.closeAllPositions(`SHUTDOWN_${reason}`);
    }
  } catch (err) {
    console.error('[COIN] Position cleanup error:', err.message);
  }

  // Python LLM 프로세스 종료
  if (llmProcess) { try { llmProcess.kill(); } catch {} llmProcess = null; }

  // API 서버 (포트 2001 해제)
  try { await global._apiServer?.app?.close(); } catch {}

  // 나머지 컴포넌트 중지
  tiingoCryptoWs.stop();
  onchainCollector.stop();
  coinglassCollector.stop();
  economicCalendar.stop();
  fearGreedCollector.stop();
  stablecoinCollector.stop();
  restCollector.stop();
  rawWriter.stop();
  macroCollector.stop();
  newsCollector.stop();
  stateVectorBuilder.stop();
  executor.stop();
  perfTracker.stop();
  tradeRecorder.stop();
  await closeDb();

  console.log('[COIN] Shutdown complete — all ports released');
  process.exit(0);
}

// Windows + Unix 종료 시그널 모두 처리
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));
process.on('uncaughtException', async (err) => {
  console.error('[COIN] uncaughtException:', err);
  await shutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1));
});
process.on('unhandledRejection', async (reason) => {
  console.error('[COIN] unhandledRejection:', reason);
  await shutdown('UNHANDLED_REJECTION').catch(() => process.exit(1));
});
process.on('exit', () => {
  if (llmProcess) { try { llmProcess.kill(); } catch {} }
});

start().catch(err => {
  console.error('[COIN] Fatal:', err);
  process.exit(1);
});
