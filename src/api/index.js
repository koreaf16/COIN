/**
 * API Server — v2 5-Zone Architecture
 * REST endpoints for Dashboard UI
 */

import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { config } from '../shared/config.js';
import { evaluateConditions } from '../z3-exec/condition-evaluator.js';

const toRow = async (row) => {
  const entries = [];
  for (const [k, v] of Object.entries(row)) {
    let val = v;
    if (v instanceof Date) val = v.toISOString();
    // LOB/Stream 객체 → getData()로 실제 내용 읽기
    else if (v && typeof v === 'object' && typeof v.getData === 'function') {
      try { val = await v.getData(); } catch { val = null; }
    } else if (v && typeof v === 'object' && v._autoCloseLob !== undefined) {
      try { if (typeof v.getData === 'function') val = await v.getData(); else val = null; } catch { val = null; }
    }
    entries.push([k.toLowerCase(), val]);
  }
  return Object.fromEntries(entries);
};

export class ApiServer {
  constructor(opts = {}) {
    this.port = opts.port || 2001;
    this.ringBuffer = opts.ringBuffer;
    this.ruleEngine = opts.ruleEngine;
    this.executor = opts.executor;
    this.macroCollector = opts.macroCollector;

    this.app = Fastify({ logger: false });
    this.wsClients = new Set();
  }

  async start() {
    await this.app.register(websocketPlugin);

    // ── Dashboard (메인 대시보드 데이터) ──
    this.app.get('/api/dashboard', async () => {
      const symbols = [];
      for (const s of config.tradingSymbols) {
        const price = this.ringBuffer?.getLastPrice(s);
        if (price) {
          const kline = this.ringBuffer.getLastKline(s, '1h');
          symbols.push({
            symbol: s,
            price,
            change24h: kline ? ((price - kline.open) / kline.open) * 100 : 0,
            high24h: kline?.high || price,
            low24h: kline?.low || price,
          });
        }
      }

      return {
        symbols,
        stats: this.ruleEngine?.getStats() || { checkCount: 0, signalCount: 0, activePlans: 0 },
        execution: this.executor?.getStats() || { signals: 0, entries: 0, exits: 0, balance: 10000, mode: 'SIM' },
        macro: this.macroCollector?.getData() || {},
        macroRegime: this.macroCollector?.getRegime() || 'neutral',
        uptime: process.uptime(),
      };
    });

    // ── Health ──
    this.app.get('/api/health', async () => ({
      status: 'ok',
      version: 'v2-5zone',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }));

    // ── Klines (차트용) ──
    this.app.get('/api/klines/:symbol', async (req) => {
      const { symbol } = req.params;
      const { timeframe = '1m', limit = '120' } = req.query;
      const lim = Math.min(parseInt(limit) || 120, 500);
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT ts, open_price, high_price, low_price, close_price, volume, trade_count, cvd
           FROM z0_price_ohlcv
           WHERE symbol = :symbol AND timeframe = :tf
           ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`,
          { symbol, tf: timeframe, lim },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return (await Promise.all(result.rows.map(toRow))).reverse();
      } finally { await conn.close(); }
    });

    // ── 1초봉 (RingBuffer raw trades → 1s OHLCV 집계) ──
    this.app.get('/api/candles-1s/:symbol', async (req) => {
      const { symbol } = req.params;
      const seconds = Math.min(parseInt(req.query.seconds) || 300, 3600);
      const trades = this.ringBuffer?.getTradesWindow(symbol, seconds) || [];
      const currentPrice = this.ringBuffer?.getLastPrice(symbol) || null;

      if (!trades.length) return { symbol, currentPrice, candles: [] };

      // 1초 버킷 집계
      const buckets = new Map();
      for (const t of trades) {
        const sec = Math.floor(t.ts);
        let b = buckets.get(sec);
        if (!b) {
          b = { time: sec, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 };
          buckets.set(sec, b);
        }
        if (t.price > b.high) b.high = t.price;
        if (t.price < b.low) b.low = t.price;
        b.close = t.price;
        b.volume += t.qty;
      }

      // 시간순 정렬 + gap-fill
      const keys = [...buckets.keys()].sort((a, b) => a - b);
      const candles = [];
      let prevClose = buckets.get(keys[0]).open;

      for (let sec = keys[0]; sec <= keys[keys.length - 1]; sec++) {
        const b = buckets.get(sec);
        if (b) {
          candles.push(b);
          prevClose = b.close;
        } else {
          candles.push({ time: sec, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
        }
      }

      return { symbol, currentPrice, candles };
    });

    // ── Derivatives (파생상품 데이터) ──
    this.app.get('/api/derivatives/:symbol', async (req) => {
      const { symbol } = req.params;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT ts, open_interest, oi_change_pct, funding_rate, predicted_rate, long_ratio, short_ratio
           FROM z0_derivatives WHERE symbol = :symbol
           ORDER BY ts DESC FETCH FIRST 50 ROWS ONLY`,
          { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Positions (오픈/클로즈) ──
    this.app.get('/api/positions', async (req) => {
      const { status = 'OPEN' } = req.query;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT id, symbol, direction, entry_price, entry_time, exit_price, exit_time,
                  exit_reason, pnl_pct, pnl_amount, status, plan_id
           FROM z4_positions WHERE status = :status
           ORDER BY COALESCE(exit_time, entry_time) DESC FETCH FIRST 100 ROWS ONLY`,
          { status }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Live Positions (Binance 우선 — executor 메타데이터로 보강) ──
    this.app.get('/api/positions/live', async () => {
      const positions = [];
      let totalPnl = 0;

      const isLive = this.executor?.liveMode;

      if (isLive && this.executor?.binance) {
        // LIVE 모드: Binance 실제 포지션이 진실의 원천
        try {
          const exchangePositions = await this.executor.getCachedPositions();

          for (const exPos of exchangePositions) {
            // 먼지 포지션 필터 ($0.01 미만 notional — 테스트넷 소량 포지션 허용)
            if (exPos.qty * exPos.markPrice < 0.01) continue;
            const currentPrice = this.ringBuffer?.getLastPrice(exPos.symbol) || exPos.markPrice;
            const dir = exPos.side === 'LONG' ? 1 : -1;
            const pnlPct = dir * ((currentPrice - exPos.entryPrice) / exPos.entryPrice) * 100;
            const pnlUsd = exPos.unrealizedPnl; // Binance 미실현 손익 직접 사용

            // executor 메모리에서 메타데이터 보강 (planId, target, stop 등)
            const meta = [...(this.executor.activePositions?.values() || [])]
              .find(p => p.symbol === exPos.symbol);

            // meta 없을 때 fallback (동기화 전 or 복구 전)
            const safetyDir = exPos.side === 'LONG' ? -1 : 1;
            const defaultSafety = exPos.entryPrice * (1 + safetyDir * 0.02);
            const holdMs = meta?.entryTime ? Date.now() - meta.entryTime : 0;
            const holdMin = +(holdMs / 60000).toFixed(1);
            const tsMin = meta?.timeStopMin ?? 15;

            totalPnl += pnlUsd;
            positions.push({
              id: meta?.id || exPos.symbol,
              planId: meta?.planId || null,
              symbol: exPos.symbol,
              direction: exPos.side,
              entryPrice: exPos.entryPrice,
              currentPrice,
              qty: exPos.qty,
              leverage: exPos.leverage,
              unrealizedPnlPct: +pnlPct.toFixed(3),
              unrealizedPnlUsd: +pnlUsd.toFixed(2),
              targetPrice: meta?.targetPrice || null,
              safetyStop: meta?.safetyStop || defaultSafety,
              timeStopMin: tsMin,
              holdTimeMin: holdMin,
              timeRemainingMin: +(tsMin - holdMin).toFixed(1),
              confidence: meta?.confidence || null,
              entryTime: meta ? new Date(meta.entryTime).toISOString() : null,
              liquidationPrice: exPos.liquidationPrice,
            });
          }
        } catch (err) {
          console.warn(`[API] Binance positions fetch failed: ${err.message}`);
        }
      } else if (this.executor?.activePositions) {
        // SIM 모드: executor 메모리 사용
        for (const [posId, pos] of this.executor.activePositions) {
          const currentPrice = this.ringBuffer?.getLastPrice(pos.symbol) || pos.entryPrice;
          const dir = pos.direction === 'LONG' ? 1 : -1;
          const pnlPct = dir * ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
          const pnlUsd = dir * (currentPrice - pos.entryPrice) * pos.qty;
          const holdTimeMin = (Date.now() - pos.entryTime) / 60000;

          totalPnl += pnlUsd;
          positions.push({
            id: posId,
            planId: pos.planId,
            symbol: pos.symbol,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            currentPrice,
            qty: pos.qty,
            unrealizedPnlPct: +pnlPct.toFixed(3),
            unrealizedPnlUsd: +pnlUsd.toFixed(2),
            targetPrice: pos.targetPrice,
            safetyStop: pos.safetyStop,
            timeStopMin: pos.timeStopMin,
            holdTimeMin: +holdTimeMin.toFixed(1),
            timeRemainingMin: pos.timeStopMin ? +(pos.timeStopMin - holdTimeMin).toFixed(1) : null,
            confidence: pos.confidence,
            entryTime: new Date(pos.entryTime).toISOString(),
          });
        }
      }

      return { positions, count: positions.length, totalUnrealizedPnl: +totalPnl.toFixed(2) };
    });

    // ── Plan Status (조건별 충족 여부) ──
    this.app.get('/api/plans/status', async () => {
      const conn = await getPool().getConnection();
      try {
        // 만료 플랜 즉시 DB 정리
        await conn.execute(
          `UPDATE z2_execution_plan SET status = 'EXPIRED'
           WHERE status = 'ACTIVE' AND valid_until < SYSTIMESTAMP`,
          {}, { autoCommit: true }
        );

        // 유효한 ACTIVE 플랜만 조회
        const result = await conn.execute(
          `SELECT id, symbol, direction, entry_conditions, target_price,
                  confidence, reasoning, created_at, valid_until
           FROM z2_execution_plan
           WHERE status = 'ACTIVE' AND valid_until > SYSTIMESTAMP
           ORDER BY valid_until DESC FETCH FIRST 100 ROWS ONLY`,
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const plans = [];
        for (const row of (result.rows || [])) {
          const symbol = row.SYMBOL;
          let entryConditions = row.ENTRY_CONDITIONS;
          if (typeof entryConditions === 'string') entryConditions = JSON.parse(entryConditions);

          const validUntil = row.VALID_UNTIL instanceof Date ? row.VALID_UNTIL : new Date(row.VALID_UNTIL);
          const timeRemainingMin = (validUntil.getTime() - Date.now()) / 60000;

          // 만료된 플랜 제외
          if (timeRemainingMin <= 0) continue;

          const currentData = this.ruleEngine?._getCurrentData(symbol) || { price: this.ringBuffer?.getLastPrice(symbol) };
          const evalResult = evaluateConditions(entryConditions, currentData);

          // 진입 조건가 추출 (entry_conditions.price.value)
          const entryPrice = entryConditions?.price?.value || null;
          const currentPrice = currentData?.price || this.ringBuffer?.getLastPrice(symbol) || null;

          plans.push({
            id: row.ID,
            symbol,
            direction: row.DIRECTION,
            entryPrice,
            currentPrice,
            targetPrice: row.TARGET_PRICE,
            confidence: row.CONFIDENCE,
            reasoning: row.REASONING || '',
            createdAt: row.CREATED_AT instanceof Date ? row.CREATED_AT.toISOString() : row.CREATED_AT,
            validUntil: validUntil.toISOString(),
            timeRemainingMin: +timeRemainingMin.toFixed(1),
            conditions: evalResult.details,
            conditionsMet: evalResult.details.filter(d => d.met).length,
            conditionsTotal: evalResult.details.length,
          });
        }

        // 조건 충족률 높은 순 정렬
        plans.sort((a, b) => (b.conditionsMet / (b.conditionsTotal || 1)) - (a.conditionsMet / (a.conditionsTotal || 1)));

        return { plans };
      } finally { await conn.close(); }
    });

    // ── LLM Analysis (브리핑/센티먼트) ──
    this.app.get('/api/llm-analysis/:symbol', async (req) => {
      const { symbol } = req.params;
      const { type = 'briefing', limit = '10' } = req.query;
      const lim = Math.min(parseInt(limit) || 10, 50);
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT id, symbol, ts, analysis_type, llm_source, result, confidence
           FROM z2_llm_analysis WHERE symbol = :symbol AND analysis_type = :type
           ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`,
          { symbol, type, lim }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Execution Plans ──
    this.app.get('/api/plans', async (req) => {
      const { status = 'ACTIVE' } = req.query;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT id, symbol, created_at, valid_until, direction, entry_conditions,
                  target_price, confidence, reasoning, status
           FROM z2_execution_plan WHERE status = :status
           ${status === 'ACTIVE' ? 'AND valid_until > SYSTIMESTAMP' : ''}
           ORDER BY created_at DESC FETCH FIRST 50 ROWS ONLY`,
          { status }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Plan 상세 조회 ──
    this.app.get('/api/plans/:id', async (req) => {
      const { id } = req.params;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT id, symbol, created_at, valid_until, direction, entry_conditions,
                  target_price, stop_price, stop_conditions, time_stop_min,
                  confidence, reasoning, scenario_id, status, triggered_at
           FROM z2_execution_plan WHERE id = :id`,
          { id: Number(id) }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (!result.rows?.length) return { error: 'Not found' };
        return (await Promise.all(result.rows.map(toRow)))[0];
      } finally { await conn.close(); }
    });

    // ── Market States (벡터 검색) ──
    this.app.get('/api/market-states/:symbol', async (req) => {
      const { symbol } = req.params;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT ts, volatility_regime, trend_strength, funding_zscore,
                  oi_change_pct, cvd_direction, macro_regime, sentiment_score,
                  liq_asymmetry, next_1h_return, next_4h_return, next_24h_return
           FROM z1_market_states WHERE symbol = :symbol
           ORDER BY ts DESC FETCH FIRST 50 ROWS ONLY`,
          { symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Performance ──
    this.app.get('/api/performance', async () => {
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT period_type, period_start, total_trades, winning_trades, losing_trades,
                  win_rate, total_pnl, avg_win_pct, avg_loss_pct, profit_factor, sharpe_ratio
           FROM z4_performance ORDER BY period_start DESC FETCH FIRST 30 ROWS ONLY`,
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Macro Data ──
    this.app.get('/api/macro', async () => {
      const conn = await getPool().getConnection();
      try {
        const indicators = ['DXY', 'VIX', 'US10Y', 'NQ_FUTURE'];
        const data = {};
        for (const ind of indicators) {
          const result = await conn.execute(
            `SELECT value, ts FROM z0_macro_data WHERE indicator = :ind
             ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
            { ind }
          );
          if (result.rows?.length) {
            data[ind] = { value: result.rows[0][0], ts: result.rows[0][1] };
          }
        }
        data.regime = this.macroCollector?.getRegime() || 'neutral';
        return data;
      } finally { await conn.close(); }
    });

    // ── Economic Calendar ──
    this.app.get('/api/economic-calendar', async () => {
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT id, event_date, event_name, importance, previous, forecast, actual
           FROM z0_economic_calendar WHERE event_date > SYSTIMESTAMP - INTERVAL '1' DAY
           ORDER BY event_date ASC FETCH FIRST 20 ROWS ONLY`,
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Fear & Greed ──
    this.app.get('/api/fear-greed', async () => {
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          'SELECT ts, value, classification FROM z0_fear_greed ORDER BY ts DESC FETCH FIRST 10 ROWS ONLY',
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Stablecoin Supply ──
    this.app.get('/api/stablecoin', async () => {
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          'SELECT ts, usdt_mcap, usdc_mcap, total_mcap, usdt_change_24h, usdc_change_24h FROM z0_stablecoin_supply ORDER BY ts DESC FETCH FIRST 10 ROWS ONLY',
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    // ── Settings CRUD ──
    this.app.get('/api/settings', async () => {
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          'SELECT key, value, description FROM sys_config ORDER BY key',
          {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    this.app.put('/api/settings/:key', async (req) => {
      const { key } = req.params;
      const { value } = req.body;
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          'UPDATE sys_config SET value = :val, updated_at = SYSTIMESTAMP WHERE key = :key',
          { val: String(value), key }, { autoCommit: true }
        );
        return { ok: true, key, value };
      } finally { await conn.close(); }
    });

    // ── Realtime Data Monitor (Z0 + Z2) ──
    this.app.get('/api/realtime/z0-summary', async () => {
      const conn = await getPool().getConnection();
      try {
        const tables = [
          { key: 'ohlcv', sql: `SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_price_ohlcv` },
          { key: 'derivatives', sql: `SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_derivatives` },
          { key: 'liquidations', sql: `SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_liquidation_raw` },
          { key: 'macro', sql: `SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_macro_data` },
          { key: 'news', sql: `SELECT COUNT(*) AS cnt, MAX(ts) AS latest, MIN(ts) AS oldest FROM z0_news_raw` },
        ];
        const summary = {};
        for (const t of tables) {
          try {
            const r = await conn.execute(t.sql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
            const row = r.rows?.[0] || {};
            summary[t.key] = { count: row.CNT || 0, latest: row.LATEST, oldest: row.OLDEST };
          } catch { summary[t.key] = { count: 0, latest: null, oldest: null }; }
        }
        // 링버퍼 실시간 통계
        summary.ringBuffer = {
          tradeCount: this.ringBuffer?.stats?.tradeCount || 0,
          klineCount: this.ringBuffer?.stats?.klineCount || 0,
          depthCount: this.ringBuffer?.stats?.depthCount || 0,
        };
        return summary;
      } finally { await conn.close(); }
    });

    this.app.get('/api/realtime/z0-recent', async (req) => {
      const { table = 'ohlcv', symbol, limit = '20' } = req.query;
      const lim = Math.min(parseInt(limit) || 20, 100);
      const conn = await getPool().getConnection();
      try {
        let sql, params;
        switch (table) {
          case 'ohlcv':
            sql = `SELECT symbol, timeframe, ts, open_price, high_price, low_price, close_price, volume, trade_count, buy_volume, sell_volume, cvd
                   FROM z0_price_ohlcv ${symbol ? 'WHERE symbol = :sym' : ''} ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
            params = symbol ? { sym: symbol, lim } : { lim };
            break;
          case 'derivatives':
            sql = `SELECT symbol, ts, open_interest, oi_change_pct, funding_rate, predicted_rate, long_ratio, short_ratio, liq_long_24h, liq_short_24h
                   FROM z0_derivatives ${symbol ? 'WHERE symbol = :sym' : ''} ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
            params = symbol ? { sym: symbol, lim } : { lim };
            break;
          case 'liquidations':
            sql = `SELECT symbol, ts, side, price, qty, usd_value
                   FROM z0_liquidation_raw ${symbol ? 'WHERE symbol = :sym' : ''} ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
            params = symbol ? { sym: symbol, lim } : { lim };
            break;
          case 'macro':
            sql = `SELECT indicator, ts, value, source FROM z0_macro_data ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
            params = { lim };
            break;
          case 'news':
            sql = `SELECT ts, source, title, tickers, url FROM z0_news_raw ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
            params = { lim };
            break;
          default:
            return [];
        }
        const result = await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    this.app.get('/api/realtime/z2-recent', async (req) => {
      const { type, limit = '20' } = req.query;
      const lim = Math.min(parseInt(limit) || 20, 100);
      const conn = await getPool().getConnection();
      try {
        let sql, params;
        if (type) {
          sql = `SELECT id, symbol, ts, analysis_type, llm_source, confidence, latency_ms, token_count
                 FROM z2_llm_analysis WHERE analysis_type = :type ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
          params = { type, lim };
        } else {
          sql = `SELECT id, symbol, ts, analysis_type, llm_source, confidence, latency_ms, token_count
                 FROM z2_llm_analysis ORDER BY ts DESC FETCH FIRST :lim ROWS ONLY`;
          params = { lim };
        }
        const result = await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return await Promise.all(result.rows.map(toRow));
      } finally { await conn.close(); }
    });

    this.app.get('/api/realtime/z2-detail/:id', async (req) => {
      const { id } = req.params;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `SELECT id, symbol, ts, analysis_type, llm_source, result, confidence, latency_ms, token_count
           FROM z2_llm_analysis WHERE id = :id`,
          { id: parseInt(id) }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (!result.rows?.length) return { error: 'Not found' };
        return toRow(result.rows[0]);
      } finally { await conn.close(); }
    });

    // ── System Status (실시간) ──
    this.app.get('/api/system-status', async () => {
      return {
        oracleDb: 'connected',
        binanceWs: this.ringBuffer?.stats?.tradeCount > 0 ? 'connected' : 'disconnected',
        symbolCount: config.tradingSymbols.length,
        symbolsCore: config.tradingSymbolsCore,
        symbolsFlex: config.tradingSymbolsFlex,
        tradeCount: this.ringBuffer?.stats?.tradeCount || 0,
        macroRegime: this.macroCollector?.getRegime() || 'neutral',
        ruleEngine: this.ruleEngine?.getStats() || {},
        executor: this.executor?.getStats() || {},
        symbolRotator: global._symbolRotator?.getStatus() || null,
        uptime: process.uptime(),
        mode: this.executor?.getStats()?.mode || 'SIM',
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      };
    });

    // ── Logs (최근 로그 조회) ──
    // 로그 버퍼에 최근 200줄 보관
    if (!this._logBuffer) {
      this._logBuffer = [];
      const origLog = console.log;
      const origErr = console.error;
      const origWarn = console.warn;
      const pushLog = (level, args) => {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        this._logBuffer.push({ ts: new Date().toISOString(), level, msg });
        if (this._logBuffer.length > 200) this._logBuffer.shift();
      };
      console.log = (...args) => { pushLog('info', args); origLog.apply(console, args); };
      console.error = (...args) => { pushLog('error', args); origErr.apply(console, args); };
      console.warn = (...args) => { pushLog('warn', args); origWarn.apply(console, args); };
    }

    this.app.get('/api/logs', async (req) => {
      const { level, limit = '100' } = req.query;
      let logs = this._logBuffer || [];
      if (level && level !== 'all') logs = logs.filter(l => l.level === level);
      return logs.slice(-parseInt(limit));
    });

    // ── LLM 테스트 (Python 프록시) ──
    const LLM_URL = config.llm.pythonUrl;

    this.app.get('/api/llm-status', async () => {
      try {
        const res = await fetch(`${LLM_URL}/api/llm-status`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: `LLM server ${res.status}` };
        return res.json();
      } catch (err) {
        return { error: 'LLM server not running', detail: err.message };
      }
    });

    this.app.post('/api/test-llm', async (req) => {
      try {
        const res = await fetch(`${LLM_URL}/api/test-llm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) return { error: `LLM server ${res.status}` };
        return res.json();
      } catch (err) {
        return { error: 'LLM test failed', detail: err.message };
      }
    });

    // ── Scenario 저장 API ──
    this.app.post('/api/scenarios', async (req) => {
      const { symbol, direction, entryConditions, targetPrice, stopConditions, timeStopMin, confidence, reasoning } = req.body;
      const conn = await getPool().getConnection();
      try {
        const result = await conn.execute(
          `INSERT INTO z2_execution_plan
           (symbol, valid_until, direction, entry_conditions, target_price,
            stop_conditions, time_stop_min, confidence, reasoning, status)
           VALUES (:sym, SYSTIMESTAMP + INTERVAL '4' HOUR, :dir, :entry, :target,
                   :stop, :ts, :conf, :reason, 'ACTIVE')
           RETURNING id INTO :id`,
          {
            sym: symbol, dir: direction,
            entry: { type: oracledb.DB_TYPE_JSON, val: entryConditions || {} },
            target: targetPrice || null,
            stop: { type: oracledb.DB_TYPE_JSON, val: stopConditions || {} },
            ts: timeStopMin || 30,
            conf: confidence || 0.5,
            reason: reasoning || '',
            id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
          },
          { autoCommit: true }
        );
        return { ok: true, id: result.outBinds.id[0] };
      } finally { await conn.close(); }
    });

    // ── Plan 상태 변경 / 삭제 ──
    this.app.post('/api/plans/:id/status', async (req) => {
      const { id } = req.params;
      const { status } = req.body;
      if (!['ACTIVE', 'EXPIRED', 'FAILED', 'CANCELLED', 'TRIGGERED'].includes(status)) {
        return { error: 'Invalid status' };
      }
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `UPDATE z2_execution_plan SET status = :status WHERE id = :id`,
          { id: parseInt(id), status },
          { autoCommit: true }
        );
        return { ok: true, id: parseInt(id), status };
      } finally { await conn.close(); }
    });

    this.app.post('/api/plans/:id/delete', async (req) => {
      const { id } = req.params;
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `DELETE FROM z2_execution_plan WHERE id = :id`,
          { id: parseInt(id) },
          { autoCommit: true }
        );
        return { ok: true, deleted: parseInt(id) };
      } finally { await conn.close(); }
    });

    // ── WebSocket ──
    this.app.get('/ws/live', { websocket: true }, (socket) => {
      this.wsClients.add(socket);
      socket.on('close', () => this.wsClients.delete(socket));
    });

    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    console.log(`[API] Server listening on http://0.0.0.0:${this.port}`);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.wsClients) {
      try { client.send(data); } catch {}
    }
  }

  async stop() {
    await this.app.close();
    console.log('[API] Server stopped');
  }
}
