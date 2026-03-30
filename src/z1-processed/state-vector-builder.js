/**
 * @module 시장 상태 벡터 빌더
 * @description 주기적으로 각 심볼의 9차원 시장 상태 벡터를 생성하고 Oracle DB에 저장한다.
 *
 * ┌──────────────┐     ┌──────────────┐     ┌──────────┐
 * │ Ring Buffer  │ ──→ │ State Vector │ ──→ │ Oracle   │
 * │ (Z0 Raw)     │     │ Builder      │     │ DB       │
 * └──────────────┘     └──────────────┘     └──────────┘
 *                            ↑
 *                     ┌──────────────┐
 *                     │ Vector       │
 *                     │ Calculators  │
 *                     └──────────────┘
 *
 * @zone z1-processed
 * @dependencies db.js, vector-calculators.js, logger.js, query-loader.js
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { loadQueries } from '../shared/query-loader.js';
import * as Calc from './vector-calculators.js';

const queries = loadQueries('z1-processed/state-vector-builder');

export class StateVectorBuilder {
  constructor(ringBuffer, macroCollector, opts = {}) {
    this.ringBuffer = ringBuffer;
    this.macroCollector = macroCollector;
    this.intervalMs = (opts.intervalMin || 60) * 60 * 1000;
    this._timer = null;
    this.symbols = opts.symbols || [];
    this.stats = { built: 0, errors: 0 };
  }

  start() {
    this._timer = setInterval(() => this._buildAll(), this.intervalMs);
    logger.info(`[Z1-Vec] State Vector Builder started (interval=${this.intervalMs / 60000}min, ${this.symbols.length} symbols)`);
    setTimeout(() => this._buildAll(), 60 * 1000);
    this._backfillTimer = setInterval(() => this._backfillReturns(), 5 * 60 * 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._backfillTimer) clearInterval(this._backfillTimer);
    logger.info(`[Z1-Vec] Stopped (built=${this.stats.built})`);
  }

  async _buildAll() {
    for (const symbol of this.symbols) {
      try {
        await this._buildForSymbol(symbol);
        this.stats.built++;
      } catch (err) {
        this.stats.errors++;
        logger.error(`[Z1-Vec] Build error ${symbol}: ${err.message}`);
      }
    }
  }

  async _buildForSymbol(symbol) {
    const conn = await getPool().getConnection();
    try {
      // 1. 파생 지표 계산 및 개별 테이블 저장
      const volData = await Calc.computeVolatilityRegime(conn, symbol);
      await this._saveVolatilityRegime(conn, symbol, volData);

      const oiData = await Calc.interpretOIMatrix(conn, symbol);
      if (oiData) await this._saveOIMatrix(conn, symbol, oiData);

      // 2. 9D 벡터 구성요소 수집
      const components = await this._collectVectorComponents(conn, symbol, volData);
      
      const vector = new Float64Array([
        components.volRegimeNum, components.trendStrength, components.fundingZscore, 
        components.oiChangePct, components.cvdDirection, components.macroRegimeVal, 
        components.sentimentScore, components.exchangeNetflow, components.liqAsymmetry
      ]);

      // 3. 메인 벡터 테이블 저장
      await conn.execute(queries.insertMarketState, {
        symbol,
        vec: { type: oracledb.DB_TYPE_VECTOR, val: vector },
        volReg: volData.regime,
        trend: components.trendStrength,
        fzs: components.fundingZscore,
        oiChg: components.oiChangePct,
        cvd: components.cvdDirection,
        macro: this.macroCollector?.getRegime() || 'neutral',
        sent: components.sentimentScore,
        netflow: components.exchangeNetflow,
        liqAsym: components.liqAsymmetry,
        volAcc: volData.volAcc
      }, { autoCommit: true });
    } catch (err) {
      throw new Error(`Failed to build vector for ${symbol}: ${err.message}`);
    } finally {
      await conn.close();
    }
  }

  async _collectVectorComponents(conn, symbol, volData) {
    const [trendStrength, fundingZscore, oiChangePct, cvdDirection, sentimentScore, exchangeNetflow, liqAsymmetry] = await Promise.all([
      Calc.getTrendStrength(conn, symbol),
      Calc.getFundingZscore(conn, symbol),
      this._getOIChange(conn, symbol),
      Calc.getCVDDirection(conn, symbol),
      this._getSentimentScore(conn, symbol),
      this._getExchangeNetflow(conn, symbol),
      Calc.getLiqAsymmetry(conn, symbol)
    ]);

    return {
      volRegimeNum: volData.regime === 'LOW' ? 0.0 : volData.regime === 'HIGH' ? 1.0 : 0.5,
      trendStrength,
      fundingZscore,
      oiChangePct,
      cvdDirection,
      macroRegimeVal: this._getMacroRegimeValue(),
      sentimentScore,
      exchangeNetflow,
      liqAsymmetry
    };
  }

  async _saveVolatilityRegime(conn, symbol, data) {
    try {
      await conn.execute(queries.saveVolatilityRegime,
        { sym: symbol, reg: data.regime, atr: data.atr, bbw: data.bbw },
        { autoCommit: true }
      );
    } catch (err) {
      if (!err.message?.includes('ORA-00001')) {
        logger.error(`[Z1-Vec] Save VolRegime error ${symbol}: ${err.message}`);
      }
    }
  }

  async _saveOIMatrix(conn, symbol, data) {
    try {
      await conn.execute(queries.saveOIMatrix,
        { sym: symbol, pd: data.price_dir, od: data.oi_dir, interp: data.interpretation },
        { autoCommit: true }
      );
    } catch (err) {
      if (!err.message?.includes('ORA-00001')) {
        logger.error(`[Z1-Vec] Save OIMatrix error ${symbol}: ${err.message}`);
      }
    }
  }

  async _getOIChange(conn, symbol) {
    try {
      const result = await conn.execute(queries.getOIChange, { sym: symbol });
      return result.rows?.[0]?.[0] || 0;
    } catch (err) {
      logger.warn(`[Z1-Vec] getOIChange error ${symbol}: ${err.message}`);
      return 0;
    }
  }

  _getMacroRegimeValue() {
    const regime = this.macroCollector?.getRegime() || 'neutral';
    return regime === 'risk_on' ? 1.0 : regime === 'risk_off' ? 0.0 : 0.5;
  }

  async _getSentimentScore(conn, symbol) {
    try {
      const result = await conn.execute(queries.getSentimentScore, {});
      return result.rows?.[0]?.[0] || 0;
    } catch (err) {
      logger.warn(`[Z1-Vec] getSentimentScore error: ${err.message}`);
      return 0;
    }
  }

  async _getExchangeNetflow(conn, symbol) {
    try {
      const result = await conn.execute(queries.getExchangeNetflow, { sym: symbol });
      const rawFlow = result.rows?.[0]?.[0] || 0;
      if (rawFlow === 0) return 0;
      return (rawFlow > 0 ? 1 : -1) * Math.min(1, Math.log10(Math.abs(rawFlow) + 1) / 4);
    } catch (err) {
      logger.warn(`[Z1-Vec] getExchangeNetflow error ${symbol}: ${err.message}`);
      return 0;
    }
  }

  async _backfillReturns() {
    const conn = await getPool().getConnection();
    try {
      const rows = await conn.execute(queries.findBackfillTargets, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      for (const row of (rows.rows || [])) {
        await this._processBackfillRow(conn, row);
      }
    } catch (err) {
      logger.warn(`[Z1-Vec] Backfill error: ${err.message}`);
    } finally {
      await conn.close();
    }
  }

  async _processBackfillRow(conn, row) {
    try {
      const [r1h, r4h, r24h] = await Promise.all([
        this._getPriceReturn(conn, row.SYMBOL, row.TS, 1),
        this._getPriceReturn(conn, row.SYMBOL, row.TS, 4),
        this._getPriceReturn(conn, row.SYMBOL, row.TS, 24),
      ]);
      if (r1h !== null || r4h !== null || r24h !== null) {
        await conn.execute(queries.updateMarketStateReturns, 
          { rid: row.ROWID, r1h, r4h, r24h }, 
          { autoCommit: true }
        );
      }
    } catch (err) {
      // Silent error for individual rows
    }
  }

  async _getPriceReturn(conn, symbol, baseTs, hours) {
    try {
      const targetTs = new Date(new Date(baseTs).getTime() + hours * 3600 * 1000);
      const getPrice = async (ts) => {
        const r = await conn.execute(queries.getPriceForReturn, { sym: symbol, ts });
        return r.rows?.[0]?.[0];
      };
      const [basePrice, futurePrice] = await Promise.all([getPrice(baseTs), getPrice(targetTs)]);
      return (basePrice && futurePrice) ? ((futurePrice - basePrice) / basePrice) * 100 : null;
    } catch (err) {
      return null;
    }
  }

  static async findSimilarStates(conn, symbol, currentVector, topK = 50) {
    try {
      const result = await conn.execute(queries.findSimilarStates,
        { sym: symbol, vec: { type: oracledb.DB_TYPE_VECTOR, val: currentVector }, k: topK },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const rows = result.rows || [];
      if (rows.length === 0) return null;
      
      return StateVectorBuilder._calculateSimilarityStats(rows);
    } catch (err) {
      logger.error(`[Z1-Vec] findSimilarStates error: ${err.message}`);
      return null;
    }
  }

  static _calculateSimilarityStats(rows) {
    const calc = (vals) => {
      if (vals.length === 0) return null;
      const sorted = [...vals].sort((a, b) => a - b);
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      return { 
        avg, 
        median: sorted[Math.floor(sorted.length / 2)], 
        winRate: vals.filter(v => v > 0).length / vals.length, 
        count: vals.length 
      };
    };
    return {
      sampleCount: rows.length,
      stats1h: calc(rows.filter(r => r.NEXT_1H_RETURN != null).map(r => r.NEXT_1H_RETURN)),
      stats4h: calc(rows.filter(r => r.NEXT_4H_RETURN != null).map(r => r.NEXT_4H_RETURN)),
      stats24h: calc(rows.filter(r => r.NEXT_24H_RETURN != null).map(r => r.NEXT_24H_RETURN)),
      avgSimilarity: rows.reduce((s, r) => s + r.SIMILARITY, 0) / rows.length
    };
  }
}
