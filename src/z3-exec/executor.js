/**
 * Z3 Executor — 룰엔진 시그널 → 실제 거래소 주문 실행
 *
 * 모드:
 *   - Testnet (기본): Binance Futures Testnet API로 실제 주문
 *   - Mainnet: API 키만 교체하면 실전 투입
 *   - Sim: API 키 없으면 내부 시뮬레이션 (가격 기반 PnL 계산)
 *
 * 주문 흐름:
 *   1. 리스크 게이트 통과
 *   2. 심볼 설정 (격리마진 + 레버리지)
 *   3. 시장가 진입 + 스탑마켓 안전망 설정
 *   4. 모니터링 (타겟/무효화/시간 손절)
 *   5. 시장가 청산 + 미체결 취소
 */

import { BinanceFuturesClient } from './binance-futures-client.js';
import { RiskGate } from './risk-gate.js';
import { SmartExit } from './smart-exit.js';

export class Executor {
  constructor(ringBuffer, opts = {}) {
    this.ringBuffer = ringBuffer;

    this.binance = new BinanceFuturesClient({
      apiKey: opts.apiKey || '',
      apiSecret: opts.apiSecret || '',
      testnet: opts.testnetMode !== false,
    });

    this.riskGate = new RiskGate({
      maxPositionPct: opts.maxPositionPct || 2.0,
      safetyStopPct: opts.safetyStopPct || 2.0,
      maxDailyLossPct: opts.maxDailyLossPct || 10.0,
      maxOpenTrades: opts.maxOpenTrades || 20,
      cooldownSec: opts.cooldownSec || 10,
      maxLeverage: opts.maxLeverage || 3,
    });

    this.smartExit = new SmartExit({
      validateIntervalSec: opts.validateIntervalSec || 30,
      ringBuffer: this.ringBuffer,
    });

    this.leverage = opts.maxLeverage || 3;
    this.balance = opts.initialCapital || 10000;   // available (가용 증거금)
    this.walletBalance = opts.initialCapital || 10000; // wallet (가용 + 사용 중 증거금)
    this.liveMode = false;  // init() 후 true (API 키 있을 때)
    this.activePositions = new Map(); // id → position
    this._pendingSymbols = new Set(); // [Bug#5] 동시 진입 race condition 방지
    this._exchangePositionsCache = null;   // Binance 포지션 캐시
    this._exchangePositionsCacheTs = 0;    // 캐시 시간
    this._monitorTimer = null;
    this._syncTimer = null;
    this.stats = { signals: 0, entries: 0, exits: 0, rejected: 0 };

    this.onTrade = null; // 콜백: Z4 기록용
  }

  async start() {
    // Binance 클라이언트 초기화
    await this.binance.init();
    this.liveMode = this.binance.isReady();

    if (this.liveMode) {
      // 실제 잔고 조회
      try {
        const bal = await this.binance.getBalance();
        this.balance = bal.available;
        this.walletBalance = bal.total;
        console.log(`[Z3-Exec] LIVE mode (${this.binance.testnet ? 'TESTNET' : 'MAINNET'}) balance=$${this.balance.toFixed(2)} wallet=$${this.walletBalance.toFixed(2)}`);
      } catch (err) {
        console.warn(`[Z3-Exec] Balance fetch failed, using config: $${this.balance}`);
      }

      // 서버 재시작 시 DB OPEN 포지션 복구 → 즉시 거래소 동기화
      await this._recoverPositions();
      await this._syncPositions();

      // 10초마다 포지션 동기화
      this._syncTimer = setInterval(() => this._syncPositions(), 10000);
    } else {
      console.log(`[Z3-Exec] SIM mode (no API key) balance=$${this.balance.toFixed(2)}`);
    }

    // 100ms마다 가격 기반 청산 체크
    this._monitorTimer = setInterval(() => this._monitorPositions(), 100);

    // [Bug#4] 자정마다 dailyPnl 리셋
    this._scheduleDailyReset();

    console.log(`[Z3-Exec] Started (mode=${this.liveMode ? 'LIVE' : 'SIM'})`);
  }

  stop() {
    if (this._monitorTimer) clearInterval(this._monitorTimer);
    if (this._syncTimer) clearInterval(this._syncTimer);
    if (this._dailyResetTimer) clearTimeout(this._dailyResetTimer);
    this.smartExit.stopAll();
    console.log(`[Z3-Exec] Stopped (entries=${this.stats.entries}, exits=${this.stats.exits})`);
  }

  /** [Bug#4] 다음 자정(ET)까지 대기 후 dailyPnl 리셋, 이후 매 24시간 반복 */
  _scheduleDailyReset() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0); // 다음 자정 (로컬 기준)
    const msUntilMidnight = nextMidnight - now;

    this._dailyResetTimer = setTimeout(() => {
      this.riskGate.resetDaily();
      console.log('[Z3-Exec] Daily PnL reset');
      // 이후 매 24시간 반복
      this._dailyResetTimer = setInterval(() => {
        this.riskGate.resetDaily();
        console.log('[Z3-Exec] Daily PnL reset');
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  /** 룰엔진 시그널 수신 → 진입 */
  async onSignal(signal) {
    this.stats.signals++;
    const currentPrice = this.ringBuffer.getLastPrice(signal.symbol);
    if (!currentPrice) return;

    // [Bug#5] 같은 심볼 동시 진입 방지 (race condition)
    if (this._pendingSymbols.has(signal.symbol)) {
      this.stats.rejected++;
      console.log(`[Z3-Exec] REJECTED: ${signal.symbol} 진입 진행 중 (중복 방지)`);
      return;
    }
    this._pendingSymbols.add(signal.symbol);

    try {
      await this._doSignal(signal, currentPrice);
    } finally {
      this._pendingSymbols.delete(signal.symbol);
    }
  }

  async _doSignal(signal, currentPrice) {
    // 리스크 게이트
    const check = this.riskGate.check(signal, this.balance, currentPrice);
    if (!check.allowed) {
      this.stats.rejected++;
      console.log(`[Z3-Exec] REJECTED: ${check.reason}`);
      return;
    }

    try {
      let entryPrice = currentPrice;
      let executedQty = check.positionSize;
      let orderId = null;
      let stopOrderId = null;

      if (this.liveMode) {
        // ── 실제 거래소 주문 ──

        // 1. 심볼 설정 (격리마진 + 레버리지)
        await this.binance.setupSymbol(signal.symbol, this.leverage);

        // 2. 시장가 진입
        const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
        const entryOrder = await this.binance.marketOrder(signal.symbol, side, check.positionSize);
        orderId = entryOrder.orderId;
        entryPrice = entryOrder.avgPrice || currentPrice;
        executedQty = entryOrder.executedQty || check.positionSize;

        console.log(`[Z3-Exec] ORDER FILLED: ${side} ${signal.symbol} orderId=${orderId} avg=$${entryPrice} qty=${executedQty}`);

        // 3. 스탑마켓 안전망 (반대 방향) — LLM 손절가 또는 고정 2%
        const stopSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
        try {
          const stopOrder = await this.binance.stopMarketOrder(
            signal.symbol, stopSide, executedQty, effectiveStop
          );
          stopOrderId = stopOrder.orderId;
          console.log(`[Z3-Exec] STOP SET: ${signal.symbol} @ $${effectiveStop.toFixed(2)} orderId=${stopOrderId}${signal.stopPrice ? ' (LLM)' : ' (fixed)'}`);
        } catch (err) {
          console.error(`[Z3-Exec] Stop order failed: ${err.message}`);
        }

        // 4. 타겟 TP (있으면)
        if (signal.targetPrice) {
          try {
            await this.binance.takeProfitMarketOrder(
              signal.symbol, stopSide, executedQty, signal.targetPrice
            );
          } catch (err) {
            // TP 실패는 비치명적 — smart-exit가 대체
          }
        }

        // 잔고 갱신
        try {
          const bal = await this.binance.getBalance();
          this.balance = bal.available;
          this.walletBalance = bal.total;
        } catch (_) {}

      } else {
        // ── 시뮬레이션 모드 ──
        orderId = `sim_${Date.now()}`;

        // 슬리피지 추정: 포지션 크기 기반 adverse slippage (2~8 bps)
        const notionalValue = check.positionSize * currentPrice;
        const slippageBps = Math.min(2 + notionalValue / 50000, 8);
        const slippageDir = signal.direction === 'LONG' ? 1 : -1;
        entryPrice = currentPrice * (1 + slippageDir * slippageBps / 10000);
        console.log(`[Z3-Exec] SIM slippage ${slippageBps.toFixed(2)}bps → entry=$${entryPrice.toFixed(4)} (market=$${currentPrice})`);
      }

      // LLM 손절가가 있으면 사용, 없으면 RiskGate 고정 2% 사용
      // 단, LLM 손절가가 고정 2%보다 넓으면 고정 2%로 제한 (안전망)
      let effectiveStop = check.safetyStop;
      if (signal.stopPrice) {
        const isLong = signal.direction === 'LONG';
        const llmStopValid = isLong
          ? signal.stopPrice < entryPrice  // LONG: 손절가 < 진입가
          : signal.stopPrice > entryPrice; // SHORT: 손절가 > 진입가
        if (llmStopValid) {
          // LLM 손절가가 safetyStop보다 가까우면 LLM것 사용 (더 타이트)
          const llmStopDist = Math.abs(entryPrice - signal.stopPrice);
          const safetyStopDist = Math.abs(entryPrice - check.safetyStop);
          effectiveStop = llmStopDist <= safetyStopDist ? signal.stopPrice : check.safetyStop;
        }
      }

      // 포지션 등록 (SIM 모드 orderId는 문자열이므로 DB에 저장 가능한 숫자 ID 별도 생성)
      const posId = this.liveMode ? (orderId || Date.now()) : Date.now();
      const position = {
        id: posId,
        planId: signal.planId,
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice,
        entryTime: Date.now(),
        entryReasoning: {
          planId: signal.planId,
          details: signal.evaluationDetails,
          reasoning: signal.reasoning,
        },
        qty: executedQty,
        targetPrice: signal.targetPrice,
        safetyStop: effectiveStop,
        timeStopMin: signal.timeStopMin || 15,
        stopConditions: signal.stopConditions,
        confidence: signal.confidence,
        orderId,
        stopOrderId,
      };

      this.activePositions.set(posId, position);
      this.riskGate.addTrade(position);
      this.stats.entries++;

      // 지능형 청산 모니터링
      this.smartExit.startValidation(position, (reason, details) => {
        this._exitPosition(posId, this.ringBuffer.getLastPrice(position.symbol), reason, details);
      });

      console.log(
        `[Z3-Exec] ENTRY ${signal.direction} ${signal.symbol} @ $${entryPrice.toFixed(2)} ` +
        `qty=${executedQty.toFixed(6)} target=$${signal.targetPrice || '?'} stop=$${effectiveStop.toFixed(2)}` +
        `${signal.stopPrice ? '(LLM)' : '(fixed)'} [${this.liveMode ? 'LIVE' : 'SIM'}]`
      );

      if (this.onTrade) {
        this.onTrade({ action: 'ENTRY', positionId: posId, ...position });
      }

    } catch (err) {
      console.error(`[Z3-Exec] Entry failed ${signal.symbol}: ${err.message}`);
      // 플랜 상태를 FAILED로 업데이트
      if (signal.planId) {
        try {
          const { getPool: getDbPool } = await import('../shared/db.js');
          const conn = await getDbPool().getConnection();
          try {
            await conn.execute(
              `UPDATE z2_execution_plan SET status = 'FAILED' WHERE id = :id`,
              { id: signal.planId },
              { autoCommit: true }
            );
            console.log(`[Z3-Exec] Plan #${signal.planId} marked FAILED: ${err.message}`);
          } finally { await conn.close(); }
        } catch {}
      }
    }
  }

  /** 100ms 루프: 가격 기반 청산 체크 */
  _monitorPositions() {
    for (const [posId, position] of this.activePositions) {
      const currentPrice = this.ringBuffer.getLastPrice(position.symbol);
      if (!currentPrice) continue;

      const exitReason = this.smartExit.checkPriceExit(position, currentPrice);
      if (exitReason) {
        this._exitPosition(posId, currentPrice, exitReason);
      }
    }
  }

  /** 포지션 청산 */
  async _exitPosition(posId, exitPrice, exitReason, exitDetails = null) {
    const position = this.activePositions.get(posId);
    if (!position) return;

    // [Bug#1,2,3] 즉시 메모리에서 제거 — async race condition 방지 + cleanup 보장
    this.activePositions.delete(posId);
    this.smartExit.stopValidation(posId);
    this.riskGate.removeTrade(posId);

    try {
      if (this.liveMode) {
        // ── 거래소 청산 ──

        // 미체결 주문 취소 (SL/TP)
        try {
          await this.binance.cancelAllOrders(position.symbol);
        } catch (_) {}

        // [Bug#3] EXCHANGE_CLOSED = 거래소에서 이미 청산됨 → 재청산 시도 불필요
        if (exitReason !== 'EXCHANGE_CLOSED') {
          const closeOrder = await this.binance.closePosition(
            position.symbol, position.direction, position.qty
          );
          exitPrice = closeOrder.avgPrice || exitPrice;
          console.log(`[Z3-Exec] CLOSE ORDER: ${position.symbol} orderId=${closeOrder.orderId} avg=$${exitPrice}`);
        }

        // 잔고 갱신
        try {
          const bal = await this.binance.getBalance();
          this.balance = bal.available;
          this.walletBalance = bal.total;
        } catch (_) {}
      }

      // PnL 계산
      const isLong = position.direction === 'LONG';
      const dir = isLong ? 1 : -1;
      const pnlPct = dir * ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
      const feeRate = 0.0008; // 왕복 0.08%
      const feeTotal = position.qty * position.entryPrice * feeRate;
      const pnlGross = dir * (exitPrice - position.entryPrice) * position.qty;
      const pnlNet = pnlGross - feeTotal;
      const holdTimeSec = (Date.now() - position.entryTime) / 1000;

      console.log(
        `[Z3-Exec] EXIT ${exitReason} ${position.symbol} @ $${exitPrice.toFixed(2)} ` +
        `PnL=${pnlNet >= 0 ? '+' : ''}${pnlNet.toFixed(2)} USDT (${pnlPct.toFixed(3)}%) ` +
        `hold=${holdTimeSec.toFixed(1)}s [${this.liveMode ? 'LIVE' : 'SIM'}]`
      );

      this.riskGate.recordExit(pnlNet);
      if (!this.liveMode) this.balance += pnlNet;
      this.stats.exits++;

      if (this.onTrade) {
        this.onTrade({
          action: 'EXIT', positionId: posId,
          symbol: position.symbol, direction: position.direction,
          entryPrice: position.entryPrice, exitPrice, exitReason, exitDetails,
          qty: position.qty, pnlPct, pnlNet, feeTotal, holdTimeSec,
          planId: position.planId, entryReasoning: position.entryReasoning,
        });
      }

    } catch (err) {
      console.error(`[Z3-Exec] Exit failed ${position.symbol}: ${err.message}`);
    }
  }

  /** 서버 재시작 시 DB OPEN 포지션 → Binance 대조 후 복구 */
  async _recoverPositions() {
    try {
      const { getPool: getDbPool } = await import('../shared/db.js');
      const oracledb = (await import('oracledb')).default;
      const conn = await getDbPool().getConnection();
      let dbPositions = [];
      try {
        const result = await conn.execute(
          `SELECT id, symbol, direction, entry_price, target_price, safety_stop, time_stop_min, entry_time, plan_id
           FROM z4_positions WHERE status = 'OPEN'`,
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        dbPositions = result.rows || [];
      } finally { await conn.close(); }

      if (!dbPositions.length) return;

      const exchangePositions = await this.getCachedPositions();

      for (const row of dbPositions) {
        const posId = row.ID;
        if (this.activePositions.has(posId)) continue; // 이미 메모리에 있음

        const exPos = exchangePositions.find(p => p.symbol === row.SYMBOL);
        if (!exPos) {
          // 거래소에 없음 → DB도 CLOSED 처리
          const conn2 = await getDbPool().getConnection();
          try {
            await conn2.execute(
              `UPDATE z4_positions SET status = 'CLOSED', exit_time = SYSTIMESTAMP,
               exit_reason = 'ORPHANED', exit_price = entry_price, pnl_amount = 0, pnl_pct = 0
               WHERE id = :id`,
              { id: posId }, { autoCommit: true }
            );
          } finally { await conn2.close(); }
          console.log(`[Z3-Exec] RECOVER: ${row.SYMBOL} not on exchange → marked CLOSED`);
          continue;
        }

        // 거래소에 있음 → 메모리 복구
        const entryPrice = parseFloat(row.ENTRY_PRICE);
        // 안전망: 현재가 기준 2% 손절로 재설정
        const safetyStopDir = row.DIRECTION === 'LONG' ? -1 : 1;
        const safetyStop = entryPrice * (1 + safetyStopDir * this.riskGate.safetyStopPct / 100);

        const position = {
          id: posId,
          planId: row.PLAN_ID,
          symbol: row.SYMBOL,
          direction: row.DIRECTION,
          entryPrice,
          entryTime: row.ENTRY_TIME instanceof Date ? row.ENTRY_TIME.getTime() : Date.now(),
          qty: exPos.qty, // 거래소 실제 수량 우선
          targetPrice: row.TARGET_PRICE ? parseFloat(row.TARGET_PRICE) : null,
          safetyStop: row.SAFETY_STOP ? parseFloat(row.SAFETY_STOP) : safetyStop,
          timeStopMin: row.TIME_STOP_MIN ? parseFloat(row.TIME_STOP_MIN) : 15,
          confidence: 0.5,
          entryReasoning: {},
        };

        this.activePositions.set(posId, position);
        this.riskGate.addTrade(position);
        this.smartExit.startValidation(position, (reason, details) => {
          this._exitPosition(posId, this.ringBuffer.getLastPrice(position.symbol), reason, details);
        });

        console.log(`[Z3-Exec] RECOVER: ${row.DIRECTION} ${row.SYMBOL} @ $${position.entryPrice} qty=${position.qty} restored`);
      }
    } catch (err) {
      console.warn(`[Z3-Exec] Position recovery failed: ${err.message}`);
    }
  }

  /** 거래소 포지션과 내부 상태 동기화 */
  async _syncPositions() {
    if (!this.liveMode) return;
    try {
      const exchangePositions = await this.getCachedPositions();

      // 거래소에서 닫힌 포지션 감지 (SL/TP 체결)
      for (const [posId, pos] of this.activePositions) {
        const exPos = exchangePositions.find(p => p.symbol === pos.symbol);
        if (!exPos) {
          const currentPrice = this.ringBuffer.getLastPrice(pos.symbol) || pos.entryPrice;
          console.log(`[Z3-Exec] SYNC: ${pos.symbol} closed externally (SL/TP hit)`);
          await this._exitPosition(posId, currentPrice, 'EXCHANGE_CLOSED');
        }
      }

      // 거래소에 있지만 메모리에 없는 포지션 → 자동 등록 (재시작 복구)
      for (const exPos of exchangePositions) {
        const alreadyTracked = [...this.activePositions.values()].some(p => p.symbol === exPos.symbol);
        if (alreadyTracked) continue;

        const entryPrice = parseFloat(exPos.entryPrice);
        const direction = exPos.side === 'LONG' ? 'LONG' : 'SHORT';
        const safetyDir = direction === 'LONG' ? -1 : 1;
        const safetyStop = entryPrice * (1 + safetyDir * this.riskGate.safetyStopPct / 100);
        const posId = Date.now() + Math.floor(Math.random() * 1000);

        const position = {
          id: posId,
          symbol: exPos.symbol,
          direction,
          entryPrice,
          entryTime: Date.now(),
          qty: exPos.qty,
          targetPrice: null,
          safetyStop,
          timeStopMin: 15,
          confidence: 0.5,
          entryReasoning: { note: 'auto-recovered from exchange' },
        };

        this.activePositions.set(posId, position);
        this.riskGate.addTrade(position);
        this.smartExit.startValidation(position, (reason, details) => {
          this._exitPosition(posId, this.ringBuffer.getLastPrice(position.symbol), reason, details);
        });

        console.log(`[Z3-Exec] SYNC-ADOPT: ${direction} ${exPos.symbol} @ $${entryPrice} qty=${exPos.qty} — registered from exchange`);
      }
    } catch (err) {
      // 동기화 실패는 비치명적
    }
  }

  /** 캐시된 Binance 포지션 (5초 TTL — rate limit 방지) */
  async getCachedPositions() {
    if (Date.now() - this._exchangePositionsCacheTs < 5000 && this._exchangePositionsCache) {
      return this._exchangePositionsCache;
    }
    try {
      this._exchangePositionsCache = await this.binance.getPositions();
      this._exchangePositionsCacheTs = Date.now();
    } catch (err) {
      console.warn(`[Z3-Exec] Position cache refresh failed: ${err.message}`);
      // 캐시 실패 시 기존 캐시 유지
    }
    return this._exchangePositionsCache || [];
  }

  getStats() {
    return {
      ...this.stats,
      mode: this.liveMode ? 'LIVE' : 'SIM',
      testnet: this.binance.testnet,
      balance: this.balance,
      walletBalance: this.walletBalance,
      activePositions: this.activePositions.size,
    };
  }
}
