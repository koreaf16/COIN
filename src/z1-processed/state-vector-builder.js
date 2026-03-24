/**
 * Z1 State Vector Builder — 9D 시장상태 벡터 생성
 *
 * 매 시간 각 심볼에 대해 9차원 벡터를 생성하여 z1_market_states에 저장.
 * 유사 과거 검색 → top 50 → next_Xh_return 통계 → LLM 판단 근거.
 *
 * 벡터 구성:
 *   [0] 변동성 레짐      — 0.0(LOW) / 0.5(MED) / 1.0(HIGH)
 *   [1] 추세 강도        — -1.0(강한 하락) ~ +1.0(강한 상승)
 *   [2] 펀딩비 z-score   — 최근 30일 대비 z-score
 *   [3] OI 변화율        — 최근 1시간 OI 변화 (%)
 *   [4] CVD 방향         — -1.0(매도 우세) ~ +1.0(매수 우세)
 *   [5] 매크로 레짐      — 0.0(risk_off) / 0.5(neutral) / 1.0(risk_on)
 *   [6] 센티먼트 점수    — -1.0(극단 공포) ~ +1.0(극단 탐욕)
 *   [7] 거래소 순유출    — 0 (Phase 3에서 온체인 연동)
 *   [8] 청산 비대칭      — -1.0(하방 청산 우세) ~ +1.0(상방 청산 우세)
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';

export class StateVectorBuilder {
  constructor(ringBuffer, macroCollector, opts = {}) {
    this.ringBuffer = ringBuffer;
    this.macroCollector = macroCollector;
    this.intervalMs = (opts.intervalMin || 60) * 60 * 1000; // 스윙: 60분 주기 (15분 불필요)
    this._timer = null;
    this.symbols = opts.symbols || [];
    this.stats = { built: 0, errors: 0 };
  }

  start() {
    this._timer = setInterval(() => this._buildAll(), this.intervalMs);
    console.log(`[Z1-Vec] State Vector Builder started (interval=${this.intervalMs/60000}min, ${this.symbols.length} symbols)`);
    // 시작 1분 후 첫 빌드 + next_return 역산
    setTimeout(() => this._buildAll(), 60 * 1000);
    // 5분마다 next_return 역산 백필
    this._backfillTimer = setInterval(() => this._backfillReturns(), 5 * 60 * 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._backfillTimer) clearInterval(this._backfillTimer);
    console.log(`[Z1-Vec] Stopped (built=${this.stats.built})`);
  }

  async _buildAll() {
    for (const symbol of this.symbols) {
      try {
        await this._buildForSymbol(symbol);
        this.stats.built++;
      } catch (err) {
        this.stats.errors++;
        console.error(`[Z1-Vec] Build error ${symbol}:`, err.message);
      }
    }
  }

  async _buildForSymbol(symbol) {
    const conn = await getPool().getConnection();
    try {
      // Z1 파생 테이블 계산 + 저장 (oracle_reader가 읽을 수 있도록 먼저 수행)
      const volAcc = await this._computeAndSaveVolatilityRegime(conn, symbol);
      await this._computeAndSaveOIMatrix(conn, symbol);

      // [0] 변동성 레짐
      const volRegime = await this._getVolatilityRegime(conn, symbol);
      
      // [1] 추세 강도 (EMA 12/26 기반)
      const trendStrength = await this._getTrendStrength(conn, symbol);

      // [2] 펀딩비 z-score
      const fundingZscore = await this._getFundingZscore(conn, symbol);

      // [3] OI 변화율 (최근 1시간)
      const oiChangePct = await this._getOIChange(conn, symbol);

      // [4] CVD 방향
      const cvdDirection = await this._getCVDDirection(conn, symbol);

      // [5] 매크로 레짐
      const macroRegime = this._getMacroRegimeValue();

      // [6] 센티먼트 점수 (Z2 LLM 분석 결과에서 가져옴)
      const sentimentScore = await this._getSentimentScore(conn, symbol);

      // [7] 거래소 순유출 (Phase 3 — 현재 0)
      const exchangeNetflow = 0;

      // [8] 청산 비대칭
      const liqAsymmetry = await this._getLiqAsymmetry(conn, symbol);

      // 9D 벡터 조립
      const vector = new Float64Array([
        volRegime, trendStrength, fundingZscore, oiChangePct,
        cvdDirection, macroRegime, sentimentScore, exchangeNetflow, liqAsymmetry
      ]);

      // z1_market_states INSERT
      await conn.execute(
        `INSERT INTO z1_market_states
         (symbol, ts, state_vector, volatility_regime, trend_strength,
          funding_zscore, oi_change_pct, cvd_direction, macro_regime,
          sentiment_score, exchange_netflow, liq_asymmetry, volatility_acceleration)
         VALUES (:symbol, SYSTIMESTAMP, :vec,
                 :volReg, :trend, :fzs, :oiChg, :cvd, :macro, :sent, :netflow, :liqAsym, :volAcc)`,
        {
          symbol,
          vec: { type: oracledb.DB_TYPE_VECTOR, val: vector },
          volReg: volRegime === 0 ? 'LOW' : volRegime === 1 ? 'HIGH' : 'MED',
          trend: trendStrength,
          fzs: fundingZscore,
          oiChg: oiChangePct,
          cvd: cvdDirection,
          macro: this.macroCollector?.getRegime() || 'neutral',
          sent: sentimentScore,
          netflow: exchangeNetflow,
          liqAsym: liqAsymmetry,
          volAcc: volAcc || 0
        },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
  }

  // ── 헬퍼 함수들 ──

  /** ATR/BB 계산 → z1_volatility_regime INSERT */
  async _computeAndSaveVolatilityRegime(conn, symbol) {
    const result = await conn.execute(
      `SELECT high_price, low_price, close_price FROM (
         SELECT high_price, low_price, close_price FROM z0_price_ohlcv
         WHERE symbol = :sym AND timeframe = '4h'
         ORDER BY ts DESC FETCH FIRST 31 ROWS ONLY
       ) ORDER BY ROWNUM`,
      { sym: symbol }
    );
    const candles = result.rows || [];
    if (candles.length < 2) return 0;

    // ATR(14) 시계열 계산 (가속도 측정을 위해 최근 10개의 ATR 확보)
    const atrs = [];
    const closes = candles.map(c => c[2]);
    
    for (let j = 0; j <= Math.min(10, candles.length - 15); j++) {
      const slice = candles.slice(j, j + 15); // i-14 ~ i
      const trueRanges = [];
      for (let i = 1; i < slice.length; i++) {
        const [high, low] = slice[i];
        const prevClose = slice[i - 1][2];
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
      }
      atrs.push(trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length);
    }
    // atrs[last]가 가장 최신 ATR

    const atr14 = atrs[atrs.length - 1];
    
    // 변동성 가속도 (Volatility Acceleration): 현재 ATR / 최근 10개 ATR 평균
    let volAcc = 1.0;
    if (atrs.length > 1) {
      const avgAtr = atrs.slice(0, -1).reduce((s, v) => s + v, 0) / (atrs.length - 1);
      volAcc = avgAtr > 0 ? atr14 / avgAtr : 1.0;
    }

    // Bollinger Band width (20기간)
    const bbPeriod = Math.min(20, closes.length);
    const sma = closes.slice(-bbPeriod).reduce((s, v) => s + v, 0) / bbPeriod;
    const std = Math.sqrt(closes.slice(-bbPeriod).reduce((s, v) => s + (v - sma) ** 2, 0) / bbPeriod);
    const bbWidth = sma > 0 ? (4 * std / sma) * 100 : 0;

    // 레짐 결정 (ATR/close 비율 기준)
    const lastClose = closes[closes.length - 1];
    const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;
    const regime = atrPct > 2.0 ? 'HIGH' : atrPct < 0.8 ? 'LOW' : 'MED';

    try {
      await conn.execute(
        `INSERT INTO z1_volatility_regime (symbol, ts, regime, atr_14, bb_width)
         VALUES (:sym, SYSTIMESTAMP, :reg, :atr, :bbw)`,
        { sym: symbol, reg: regime, atr: atr14, bbw: bbWidth },
        { autoCommit: true }
      );
    } catch (err) {
      if (!err.message?.includes('ORA-00001')) throw err;
    }
    
    return volAcc;
  }

  /** OI 방향 + 가격 방향 → z1_oi_matrix INSERT */
  async _computeAndSaveOIMatrix(conn, symbol) {
    const priceResult = await conn.execute(
      `SELECT close_price FROM (
         SELECT close_price FROM z0_price_ohlcv
         WHERE symbol = :sym AND timeframe = '1h'
         ORDER BY ts DESC FETCH FIRST 2 ROWS ONLY
       ) ORDER BY ROWNUM`,
      { sym: symbol }
    );
    const prices = priceResult.rows?.map(r => r[0]) || [];
    if (prices.length < 2) return;

    const priceChangePct = ((prices[1] - prices[0]) / prices[0]) * 100;
    const price_dir = priceChangePct > 0.1 ? 'UP' : priceChangePct < -0.1 ? 'DOWN' : 'FLAT';

    const oiResult = await conn.execute(
      `SELECT oi_change_pct FROM z0_derivatives
       WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol }
    );
    const oiChangePct = oiResult.rows?.[0]?.[0] || 0;
    const oi_dir = oiChangePct > 0.5 ? 'UP' : oiChangePct < -0.5 ? 'DOWN' : 'FLAT';

    const interpretation =
      price_dir === 'UP' && oi_dir === 'UP' ? 'NEW_LONG' :
      price_dir === 'UP' && oi_dir === 'DOWN' ? 'SHORT_COVER' :
      price_dir === 'DOWN' && oi_dir === 'UP' ? 'NEW_SHORT' :
      price_dir === 'DOWN' && oi_dir === 'DOWN' ? 'LONG_LIQUIDATION' : 'FLAT';

    try {
      await conn.execute(
        `INSERT INTO z1_oi_matrix (symbol, ts, price_dir, oi_dir, interpretation)
         VALUES (:sym, SYSTIMESTAMP, :pd, :od, :interp)`,
        { sym: symbol, pd: price_dir, od: oi_dir, interp: interpretation },
        { autoCommit: true }
      );
    } catch (err) {
      if (!err.message?.includes('ORA-00001')) throw err;
    }
  }

  async _getVolatilityRegime(conn, symbol) {
    const result = await conn.execute(
      `SELECT regime FROM z1_volatility_regime
       WHERE symbol = :sym ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol }
    );
    const regime = result.rows?.[0]?.[0];
    return regime === 'LOW' ? 0.0 : regime === 'HIGH' ? 1.0 : 0.5;
  }

  async _getTrendStrength(conn, symbol) {
    // 4시간봉 우선 (스윙 추세파악), 부족 시 1시간봉, 15분봉 폴백
    for (const tf of ['4h', '1h', '15m']) {
      const result = await conn.execute(
        `SELECT close_price FROM (
           SELECT close_price FROM z0_price_ohlcv
           WHERE symbol = :sym AND timeframe = :tf
           ORDER BY ts DESC FETCH FIRST 26 ROWS ONLY
         ) ORDER BY ROWNUM`,
        { sym: symbol, tf }
      );
      const closes = (result.rows?.map(r => r[0]) || []).reverse();
      if (closes.length < 12) continue;

      const ema12 = this._ema(closes, 12);
      const ema26 = this._ema(closes, Math.min(26, closes.length));
      const diff = (ema12 - ema26) / ema26;
      return Math.max(-1, Math.min(1, diff / 0.05));
    }
    return 0;
  }

  _ema(values, period) {
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  async _getFundingZscore(conn, symbol) {
    // Oracle: 집계함수 + 스칼라 서브쿼리 혼용 불가(ORA-00937) → 쿼리 분리
    const statsResult = await conn.execute(
      `SELECT AVG(funding_rate), STDDEV(funding_rate)
       FROM z0_derivatives
       WHERE symbol = :sym
         AND funding_rate IS NOT NULL
         AND ts > CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '30' DAY`,
      { sym: symbol }
    );
    const statsRow = statsResult.rows?.[0];
    if (!statsRow) return 0;

    const currentResult = await conn.execute(
      `SELECT funding_rate FROM z0_derivatives
       WHERE symbol = :sym AND funding_rate IS NOT NULL
       ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol }
    );
    const current = currentResult.rows?.[0]?.[0];
    if (current == null) return 0;

    const [avg, std] = statsRow;
    if (!std || std === 0) return 0;
    const zscore = (current - avg) / std;
    return Math.max(-3, Math.min(3, zscore));
  }

  async _getOIChange(conn, symbol) {
    const result = await conn.execute(
      `SELECT oi_change_pct FROM z0_derivatives
       WHERE symbol = :sym AND oi_change_pct IS NOT NULL
       ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol }
    );
    return result.rows?.[0]?.[0] || 0;
  }

  async _getCVDDirection(conn, symbol) {
    // 최근 2개 1h kline CVD 비교
    const result = await conn.execute(
      `SELECT cvd FROM (
         SELECT cvd FROM z0_price_ohlcv
         WHERE symbol = :sym AND timeframe = '1h' AND cvd IS NOT NULL
         ORDER BY ts DESC FETCH FIRST 2 ROWS ONLY
       ) ORDER BY ROWNUM`,
      { sym: symbol }
    );
    const rows = result.rows?.map(r => r[0]) || [];
    if (rows.length < 2) return 0;

    // SQL 결과는 DESC 순 (rows[0]=최신, rows[1]=이전) → 최신 - 이전
    const diff = rows[0] - rows[1];
    // 정규화: 양수면 매수 우세, 음수면 매도 우세
    return diff > 0 ? Math.min(1, diff / Math.abs(rows[0] || 1)) :
           diff < 0 ? Math.max(-1, diff / Math.abs(rows[0] || 1)) : 0;
  }

  _getMacroRegimeValue() {
    const regime = this.macroCollector?.getRegime() || 'neutral';
    return regime === 'risk_on' ? 1.0 : regime === 'risk_off' ? 0.0 : 0.5;
  }

  async _getSentimentScore(conn, symbol) {
    // Z2 LLM 센티먼트 분석 결과
    // 센티먼트는 전체 뉴스 기반 (symbol=NULL로 저장됨) → symbol 필터 제거
    const result = await conn.execute(
      `SELECT j.result.sentiment
       FROM z2_llm_analysis j
       WHERE j.analysis_type = 'sentiment'
       ORDER BY j.ts DESC FETCH FIRST 1 ROW ONLY`,
      {}
    );
    return result.rows?.[0]?.[0] || 0;
  }

  async _getLiqAsymmetry(conn, symbol) {
    // 현재 가격 기준 상방/하방 청산 물량 비율
    const priceResult = await conn.execute(
      `SELECT close_price FROM z0_price_ohlcv
       WHERE symbol = :sym AND timeframe = '1m'
       ORDER BY ts DESC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol }
    );
    const price = priceResult.rows?.[0]?.[0];
    if (!price) return 0;

    const result = await conn.execute(
      `SELECT
         SUM(CASE WHEN price_level > :price THEN short_liq_usd ELSE 0 END) AS above,
         SUM(CASE WHEN price_level < :price THEN long_liq_usd ELSE 0 END) AS below
       FROM z1_liquidation_map
       WHERE symbol = :sym
         AND ts = (SELECT MAX(ts) FROM z1_liquidation_map WHERE symbol = :sym)`,
      { sym: symbol, price }
    );
    const [above, below] = result.rows?.[0] || [0, 0];
    const total = (above || 0) + (below || 0);
    if (total === 0) return 0;

    // +1 = 상방 청산 우세 (가격이 위로 끌림), -1 = 하방 청산 우세
    return ((above || 0) - (below || 0)) / total;
  }

  /** 과거 레코드 next_1h/4h/24h_return 역산 백필 */
  async _backfillReturns() {
    const conn = await getPool().getConnection();
    try {
      // next_1h_return이 null이고 ts가 1시간 이상 지난 레코드만
      const rows = await conn.execute(
        `SELECT symbol, ts FROM z1_market_states
         WHERE next_1h_return IS NULL AND ts < CAST(SYSTIMESTAMP AS TIMESTAMP) - INTERVAL '1' HOUR
         FETCH FIRST 200 ROWS ONLY`,
        {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const row of (rows.rows || [])) {
        try {
          const ts = row.TS instanceof Date ? row.TS : new Date(row.TS);
          const sym = row.SYMBOL;

          const [r1h, r4h, r24h] = await Promise.all([
            this._getPriceReturn(conn, sym, ts, 1),
            this._getPriceReturn(conn, sym, ts, 4),
            this._getPriceReturn(conn, sym, ts, 24),
          ]);

          if (r1h !== null) {
            await conn.execute(
              `UPDATE z1_market_states SET
                 next_1h_return  = :r1h,
                 next_4h_return  = CASE WHEN :r4h  IS NOT NULL THEN :r4h2  ELSE next_4h_return  END,
                 next_24h_return = CASE WHEN :r24h IS NOT NULL THEN :r24h2 ELSE next_24h_return END
               WHERE symbol = :sym AND ts = :ts`,
              { r1h, r4h, r4h2: r4h, r24h, r24h2: r24h, sym, ts },
              { autoCommit: true }
            );
          }
        } catch {}
      }
    } catch (err) {
      console.warn(`[Z1-Vec] Backfill error: ${err.message}`);
    } finally {
      await conn.close();
    }
  }

  async _getPriceReturn(conn, symbol, baseTs, hours) {
    const targetTs = new Date(baseTs.getTime() + hours * 3600 * 1000);
    // baseTs 이후 가장 가까운 1h 캔들 close
    const baseResult = await conn.execute(
      `SELECT close_price FROM z0_price_ohlcv
       WHERE symbol = :sym AND timeframe = '1h' AND ts >= :ts
       ORDER BY ts ASC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol, ts: baseTs }
    );
    const basePrice = baseResult.rows?.[0]?.[0];
    if (!basePrice) return null;

    const futureResult = await conn.execute(
      `SELECT close_price FROM z0_price_ohlcv
       WHERE symbol = :sym AND timeframe = '1h' AND ts >= :ts
       ORDER BY ts ASC FETCH FIRST 1 ROW ONLY`,
      { sym: symbol, ts: targetTs }
    );
    const futurePrice = futureResult.rows?.[0]?.[0];
    if (!futurePrice) return null;

    return ((futurePrice - basePrice) / basePrice) * 100;
  }

  /** 유사 과거 검색 — LLM 판단 근거용 */
  static async findSimilarStates(conn, symbol, currentVector, topK = 50) {
    const result = await conn.execute(
      `SELECT ts, next_1h_return, next_4h_return, next_24h_return,
              VECTOR_DISTANCE(state_vector, :vec, COSINE) AS similarity
       FROM z1_market_states
       WHERE symbol = :sym
         AND VECTOR_DISTANCE(state_vector, :vec, COSINE) < 0.3
       ORDER BY similarity
       FETCH FIRST :k ROWS ONLY`,
      {
        sym: symbol,
        vec: { type: oracledb.DB_TYPE_VECTOR, val: currentVector },
        k: topK,
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rows = result.rows || [];
    if (rows.length === 0) return null;

    // 통계 계산
    const returns24h = rows.filter(r => r.NEXT_24H_RETURN != null).map(r => r.NEXT_24H_RETURN);
    const returns4h = rows.filter(r => r.NEXT_4H_RETURN != null).map(r => r.NEXT_4H_RETURN);
    const returns1h = rows.filter(r => r.NEXT_1H_RETURN != null).map(r => r.NEXT_1H_RETURN);

    return {
      sampleCount: rows.length,
      stats24h: this._calcStats(returns24h),
      stats4h: this._calcStats(returns4h),
      stats1h: this._calcStats(returns1h),
      avgSimilarity: rows.reduce((s, r) => s + r.SIMILARITY, 0) / rows.length,
    };
  }

  static _calcStats(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const std = Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
    const winRate = values.filter(v => v > 0).length / values.length;

    return { avg, median, std, winRate, count: values.length };
  }
}
