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
import { evaluateConditions } from './condition-evaluator.js';

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
    if (this._dailyResetTimer) {
      clearTimeout(this._dailyResetTimer);
      clearInterval(this._dailyResetTimer);
    }
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

      // [Bug#7 수정] liveMode 블록 진입 전에 effectiveStop 미리 계산 (ReferenceError 방지)
      let effectiveStop = check.safetyStop;
      if (signal.stopPrice) {
        const isLong = signal.direction === 'LONG';
        const llmStopValid = isLong
          ? signal.stopPrice < entryPrice  // LONG: 손절가 < 진입가
          : signal.stopPrice > entryPrice; // SHORT: 손절가 > 진입가
        if (llmStopValid) {
          const llmStopDist = Math.abs(entryPrice - signal.stopPrice);
          const safetyStopDist = Math.abs(entryPrice - check.safetyStop);
          effectiveStop = llmStopDist <= safetyStopDist ? signal.stopPrice : check.safetyStop;
        }
      }

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
        const price = this.ringBuffer.getLastPrice(position.symbol);
        if (reason === 'PARTIAL_EXIT') {
          this._partialExitPosition(posId, price, reason, details);
        } else {
          this._exitPosition(posId, price, reason, details);
        }
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

  /** 시장 데이터 스냅샷 (stop_conditions 평가용) */
  _buildMarketData(symbol) {
    const snapshot = this.ringBuffer.getSnapshot(symbol);
    const deriv = snapshot.derivatives || {};
    const mark = snapshot.markPrice || {};
    return {
      price: snapshot.price,
      funding_rate: mark.fundingRate || deriv.funding_rate || 0,
      oi_change_pct: deriv.oi_change_pct || 0,
      cvd_direction: 0,
      volume_surge: 1.0,
      macro_regime: 'neutral',
    };
  }

  /** 100ms 루프: 가격 기반 청산 체크 + stop_conditions 평가 */
  _monitorPositions() {
    for (const [posId, position] of this.activePositions) {
      const currentPrice = this.ringBuffer.getLastPrice(position.symbol);
      if (!currentPrice) continue;

      const exitReason = this.smartExit.checkPriceExit(position, currentPrice);
      if (exitReason) {
        this._exitPosition(posId, currentPrice, exitReason);
        continue;
      }

      // 경로 8: stop_conditions 평가 (5초 주기)
      if (position.stopConditions && Object.keys(position.stopConditions).length > 0) {
        const now = Date.now();
        if (!position._lastStopCondCheck || now - position._lastStopCondCheck >= 5000) {
          position._lastStopCondCheck = now;
          const marketData = this._buildMarketData(position.symbol);
          const result = evaluateConditions(position.stopConditions, marketData);
          if (result.met) {
            console.log(`[Z3-Exec] STOP_CONDITION met: ${position.symbol}`, result.details.map(d => `${d.field} ${d.operator} ${d.expected} (actual=${d.actual})`).join(', '));
            this._exitPosition(posId, currentPrice, 'STOP_CONDITION', result.details);
          }
        }
      }
    }
  }

  /** 포지션 청산 */
  async _exitPosition(posId, exitPrice, exitReason, exitDetails = null) {
    const position = this.activePositions.get(posId);
    if (!position || position._exiting) return;

    // [Bug#1,2,3 수정] 진행 중 플래그로 async race condition 방지 (실패 시 복구 가능하도록)
    position._exiting = true;
    this.smartExit.stopValidation(posId);

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

      // 청산 성공 시 메모리 정리
      this.activePositions.delete(posId);
      this.riskGate.removeTrade(posId);

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
          entryPrice: position.entryPrice, entryTime: position.entryTime,
          exitPrice, exitReason, exitDetails,
          targetPrice: position.targetPrice, safetyStop: position.safetyStop,
          qty: position.qty, pnlPct, pnlNet, feeTotal, holdTimeSec,
          planId: position.planId, entryReasoning: position.entryReasoning,
        });
      }

    } catch (err) {
      console.error(`[Z3-Exec] Exit failed ${position.symbol}: ${err.message}`);
      
      if (err.message.includes('ReduceOnly') || err.message.includes('already closed')) {
        // 이미 닫힌 거면 강제 완료 처리
        this.activePositions.delete(posId);
        this.riskGate.removeTrade(posId);
        if (this.onTrade) {
          this.onTrade({
            action: 'EXIT', positionId: posId, symbol: position.symbol, direction: position.direction,
            entryPrice: position.entryPrice, entryTime: position.entryTime, exitPrice, exitReason: 'EXCHANGE_CLOSED',
            qty: position.qty, pnlPct: 0, pnlNet: 0, feeTotal: 0, holdTimeSec: 0, planId: position.planId, entryReasoning: position.entryReasoning
          });
        }
      } else {
        // 일시적 네트워크 오류 등 -> 롤백
        position._exiting = false;
        this.smartExit.startValidation(position, (reason, details) => {
          this._exitPosition(posId, this.ringBuffer.getLastPrice(position.symbol), reason, details);
        });
      }
    }
  }

  /** 부분 청산 (50%) — LLM PARTIAL_EXIT 추천 시 */
  async _partialExitPosition(posId, exitPrice, reason, exitDetails = null) {
    const position = this.activePositions.get(posId);
    if (!position || position._partialExited) return;

    position._partialExited = true;
    
    // 거래소 최소 주문 단위에 맞게 수량 포맷팅 (반올림 오차 방지)
    const exactQty = position.qty;
    const partialQty = this.liveMode 
      ? this.binance._roundQty(position.symbol, exactQty / 2)
      : exactQty / 2;
    const remainQty = exactQty - partialQty;

    if (partialQty <= 0 || remainQty <= 0) {
       console.warn(`[Z3-Exec] PARTIAL_EXIT skipped ${position.symbol}: qty too small (${exactQty})`);
       position._partialExited = false;
       return;
    }

    try {
      if (this.liveMode) {
        // 기존 SL/TP 주문 취소
        try { await this.binance.cancelAllOrders(position.symbol); } catch (_) {}

        // 50% 청산
        const closeOrder = await this.binance.closePosition(position.symbol, position.direction, partialQty);
        exitPrice = closeOrder.avgPrice || exitPrice;

        // 잔여 수량에 대해 손익분기 스탑 재설정
        const stopSide = position.direction === 'LONG' ? 'SELL' : 'BUY';
        try {
          await this.binance.stopMarketOrder(position.symbol, stopSide, remainQty, position.entryPrice);
        } catch (err) {
          console.error(`[Z3-Exec] Breakeven stop failed: ${err.message}`);
        }

        // 잔고 갱신
        try {
          const bal = await this.binance.getBalance();
          this.balance = bal.available;
          this.walletBalance = bal.total;
        } catch (_) {}
      }

      // 포지션 업데이트: 수량 절반, 손절 → 진입가 (손익분기)
      position.qty = remainQty;
      position.safetyStop = position.entryPrice;

      const isLong = position.direction === 'LONG';
      const dir = isLong ? 1 : -1;
      const pnlPct = dir * ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
      const feeRate = 0.0008;
      const feeTotal = partialQty * position.entryPrice * feeRate;
      const pnlNet = dir * (exitPrice - position.entryPrice) * partialQty - feeTotal;

      if (!this.liveMode) this.balance += pnlNet;

      console.log(
        `[Z3-Exec] PARTIAL_EXIT (50%) ${position.symbol} @ $${exitPrice.toFixed(2)} ` +
        `PnL=${pnlNet >= 0 ? '+' : ''}${pnlNet.toFixed(2)} USDT remain=${remainQty.toFixed(6)}`
      );

      if (this.onTrade) {
        this.onTrade({
          action: 'PARTIAL_EXIT', positionId: posId,
          symbol: position.symbol, direction: position.direction,
          entryPrice: position.entryPrice, exitPrice,
          exitReason: reason, qty: partialQty, remainQty,
          pnlPct, pnlNet, feeTotal, planId: position.planId,
        });
      }
    } catch (err) {
      console.error(`[Z3-Exec] Partial exit failed ${position.symbol}: ${err.message}`);
      position._partialExited = false; // 실패 시 재시도 가능
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
          `SELECT id, symbol, direction, entry_price, target_price, safety_stop, time_stop_min, entry_time, plan_id, entry_reasoning
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

        let parsedReasoning = {};
        if (row.ENTRY_REASONING) {
          try {
            parsedReasoning = typeof row.ENTRY_REASONING === 'string' ? JSON.parse(row.ENTRY_REASONING) : row.ENTRY_REASONING;
          } catch (e) {}
        }

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
          entryReasoning: parsedReasoning,
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
