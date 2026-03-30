function getOpen(kline) {
  return Number(kline?.open ?? kline?.o ?? 0);
}

function getHigh(kline) {
  return Number(kline?.high ?? kline?.h ?? 0);
}

function getLow(kline) {
  return Number(kline?.low ?? kline?.l ?? 0);
}

function getClose(kline) {
  return Number(kline?.close ?? kline?.c ?? 0);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
  }
  return value;
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const recent = candles.slice(-Math.max(period + 1, 2));
  const trs = [];
  for (let i = 1; i < recent.length; i++) {
    const high = getHigh(recent[i]);
    const low = getLow(recent[i]);
    const prevClose = getClose(recent[i - 1]);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length === 0) return null;
  const window = trs.slice(-period);
  return window.reduce((sum, tr) => sum + tr, 0) / window.length;
}

function bollinger(closes, period = 20, stdMult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((sum, value) => sum + value, 0) / period;
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + std * stdMult,
    lower: mean - std * stdMult,
  };
}

function dmiAdx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) {
    return { adx_1h: null, plus_di_1h: null, minus_di_1h: null };
  }

  const trs = [];
  const plusDms = [];
  const minusDms = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const upMove = getHigh(current) - getHigh(previous);
    const downMove = getLow(previous) - getLow(current);
    plusDms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDms.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      getHigh(current) - getLow(current),
      Math.abs(getHigh(current) - getClose(previous)),
      Math.abs(getLow(current) - getClose(previous)),
    ));
  }

  if (trs.length < period) {
    return { adx_1h: null, plus_di_1h: null, minus_di_1h: null };
  }

  let atrSum = trs.slice(0, period).reduce((sum, value) => sum + value, 0);
  let plusSum = plusDms.slice(0, period).reduce((sum, value) => sum + value, 0);
  let minusSum = minusDms.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dxValues = [];
  let plusDi = 0;
  let minusDi = 0;

  for (let i = period - 1; i < trs.length; i++) {
    if (i > period - 1) {
      atrSum = atrSum - atrSum / period + trs[i];
      plusSum = plusSum - plusSum / period + plusDms[i];
      minusSum = minusSum - minusSum / period + minusDms[i];
    }
    if (atrSum <= 0) continue;
    plusDi = 100 * (plusSum / atrSum);
    minusDi = 100 * (minusSum / atrSum);
    const denom = plusDi + minusDi;
    const dx = denom <= 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / denom;
    dxValues.push(dx);
  }

  if (dxValues.length === 0) {
    return { adx_1h: null, plus_di_1h: null, minus_di_1h: null };
  }

  let adx = dxValues.slice(0, Math.min(period, dxValues.length)).reduce((sum, value) => sum + value, 0) / Math.min(period, dxValues.length);
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
  }

  return {
    adx_1h: round(adx, 2),
    plus_di_1h: round(plusDi, 2),
    minus_di_1h: round(minusDi, 2),
  };
}

function pivotLevels(candles, currentPrice, lookback = 40) {
  const recent = candles.slice(-lookback);
  if (recent.length < 5 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { support: null, resistance: null };
  }

  const highs = [];
  const lows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const high = getHigh(recent[i]);
    const low = getLow(recent[i]);
    const neighborHighs = [recent[i - 2], recent[i - 1], recent[i + 1], recent[i + 2]].map(getHigh);
    const neighborLows = [recent[i - 2], recent[i - 1], recent[i + 1], recent[i + 2]].map(getLow);
    if (high >= Math.max(...neighborHighs)) highs.push(high);
    if (low <= Math.min(...neighborLows)) lows.push(low);
  }

  const fallbackHigh = recent.reduce((max, candle) => Math.max(max, getHigh(candle)), 0);
  const fallbackLow = recent.reduce((min, candle) => Math.min(min, getLow(candle)), Number.POSITIVE_INFINITY);
  const supportCandidates = lows.filter(level => level <= currentPrice);
  const resistanceCandidates = highs.filter(level => level >= currentPrice);

  return {
    support: supportCandidates.length ? Math.max(...supportCandidates) : (Number.isFinite(fallbackLow) ? fallbackLow : null),
    resistance: resistanceCandidates.length ? Math.min(...resistanceCandidates) : (fallbackHigh > 0 ? fallbackHigh : null),
  };
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function classifyBias(currentPrice, emaFast, emaSlow, gapThresholdPct = 0.15) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(emaFast) || !Number.isFinite(emaSlow) || emaSlow === 0) {
    return 'NEUTRAL';
  }
  const gapPct = ((emaFast - emaSlow) / emaSlow) * 100;
  if (gapPct >= gapThresholdPct && currentPrice >= emaFast) return 'BULLISH';
  if (gapPct <= -gapThresholdPct && currentPrice <= emaFast) return 'BEARISH';
  return 'NEUTRAL';
}

function flag(value) {
  return value ? 1 : 0;
}

export function computeSwingFeatures({ currentPrice, klines1h = [], klines4h = [], klines1d = [], btcKlines1h = [], btcKlines1d = [] } = {}) {
  const closes1h = klines1h.map(getClose).filter(Number.isFinite);
  const closes4h = klines4h.map(getClose).filter(Number.isFinite);
  const closes1d = klines1d.map(getClose).filter(Number.isFinite);
  const current = Number.isFinite(currentPrice) ? currentPrice : closes1h.at(-1);

  const ema20_1h = ema(closes1h, 20);
  const ema50_1h = ema(closes1h, 50);
  const ema20_4h = ema(closes4h, 20);
  const ema50_4h = ema(closes4h, 50);
  const ema20_1d = ema(closes1d, 20);
  const ema50_1d = ema(closes1d, 50);
  const atr1h = atr(klines1h, 14);
  const bb = bollinger(closes1h, 20);
  const pivots = pivotLevels(klines1h, current);
  const trendCurrent = closes1h.at(-1);

  let donchianUpper20 = null;
  let donchianLower20 = null;
  let donchianBreak20 = 'NONE';
  if (klines1h.length >= 21) {
    const previousWindow = klines1h.slice(-21, -1);
    donchianUpper20 = previousWindow.reduce((max, candle) => Math.max(max, getHigh(candle)), 0);
    donchianLower20 = previousWindow.reduce((min, candle) => Math.min(min, getLow(candle)), Number.POSITIVE_INFINITY);
    if (Number.isFinite(trendCurrent) && Number.isFinite(donchianUpper20) && trendCurrent > donchianUpper20) {
      donchianBreak20 = 'UP';
    } else if (Number.isFinite(trendCurrent) && Number.isFinite(donchianLower20) && trendCurrent < donchianLower20) {
      donchianBreak20 = 'DOWN';
    }
  }

  let rangePosition20 = null;
  if (klines1h.length >= 20) {
    const rangeWindow = klines1h.slice(-20);
    const rangeHigh = rangeWindow.reduce((max, candle) => Math.max(max, getHigh(candle)), 0);
    const rangeLow = rangeWindow.reduce((min, candle) => Math.min(min, getLow(candle)), Number.POSITIVE_INFINITY);
    const span = rangeHigh - rangeLow;
    rangePosition20 = span > 0 ? (current - rangeLow) / span : 0.5;
  }

  const own12h = closes1h.length >= 13 ? pctChange(closes1h.at(-1), closes1h.at(-13)) : null;
  const btcCloses = btcKlines1h.map(getClose).filter(Number.isFinite);
  const btcCloses1d = btcKlines1d.map(getClose).filter(Number.isFinite);
  const btc12h = btcCloses.length >= 13 ? pctChange(btcCloses.at(-1), btcCloses.at(-13)) : (btcKlines1h === klines1h ? own12h : null);
  const btcCurrent1d = btcCloses1d.at(-1) ?? btcCloses.at(-1);
  const btcEma20_1d = ema(btcCloses1d, 20);
  const btcEma50_1d = ema(btcCloses1d, 50);

  const emaGap1h = ema20_1h && ema50_1h ? ((ema20_1h - ema50_1h) / ema50_1h) * 100 : null;
  const emaGap4h = ema20_4h && ema50_4h ? ((ema20_4h - ema50_4h) / ema50_4h) * 100 : null;
  const emaGap1d = ema20_1d && ema50_1d ? ((ema20_1d - ema50_1d) / ema50_1d) * 100 : null;
  const pullbackAtrRatio = atr1h && ema20_1h ? Math.abs(current - ema20_1h) / atr1h : null;
  const supportDistancePct = pivots.support ? ((current - pivots.support) / current) * 100 : null;
  const resistanceDistancePct = pivots.resistance ? ((pivots.resistance - current) / current) * 100 : null;
  const dailyBias = classifyBias(current, ema20_1d, ema50_1d, 0.2);
  const trendBias4h = classifyBias(current, ema20_4h, ema50_4h, 0.1);
  const triggerBias1h = classifyBias(current, ema20_1h, ema50_1h, 0.05);
  const btcDailyBias = classifyBias(btcCurrent1d, btcEma20_1d, btcEma50_1d, 0.2);
  const retestSupportReady = Number.isFinite(supportDistancePct) && supportDistancePct <= 1.0;
  const retestResistanceReady = Number.isFinite(resistanceDistancePct) && resistanceDistancePct <= 1.0;
  const breakoutLongSetup = trendBias4h === 'BULLISH' && donchianBreak20 === 'UP' && Number.isFinite(rangePosition20) && rangePosition20 >= 0.75;
  const breakoutShortSetup = trendBias4h === 'BEARISH' && donchianBreak20 === 'DOWN' && Number.isFinite(rangePosition20) && rangePosition20 <= 0.25;
  const pullbackLongSetup =
    dailyBias === 'BULLISH' &&
    trendBias4h === 'BULLISH' &&
    Number.isFinite(supportDistancePct) &&
    supportDistancePct <= 1.5 &&
    Number.isFinite(pullbackAtrRatio) &&
    pullbackAtrRatio <= 1.75;
  const pullbackShortSetup =
    dailyBias === 'BEARISH' &&
    trendBias4h === 'BEARISH' &&
    Number.isFinite(resistanceDistancePct) &&
    resistanceDistancePct <= 1.5 &&
    Number.isFinite(pullbackAtrRatio) &&
    pullbackAtrRatio <= 1.75;

  return {
    ema20_1h: round(ema20_1h, 5),
    ema50_1h: round(ema50_1h, 5),
    ema20_4h: round(ema20_4h, 5),
    ema50_4h: round(ema50_4h, 5),
    ema20_1d: round(ema20_1d, 5),
    ema50_1d: round(ema50_1d, 5),
    ema_gap_1h: round(emaGap1h, 3),
    ema_gap_4h: round(emaGap4h, 3),
    ema_gap_1d: round(emaGap1d, 3),
    ema_fast_above_slow_1h: ema20_1h && ema50_1h ? (ema20_1h >= ema50_1h ? 1 : -1) : 0,
    ema_fast_above_slow_4h: ema20_4h && ema50_4h ? (ema20_4h >= ema50_4h ? 1 : -1) : 0,
    ema_fast_above_slow_1d: ema20_1d && ema50_1d ? (ema20_1d >= ema50_1d ? 1 : -1) : 0,
    daily_bias: dailyBias,
    trend_bias_4h: trendBias4h,
    trigger_bias_1h: triggerBias1h,
    btc_daily_bias: btcDailyBias,
    atr_1h: round(atr1h, 5),
    pullback_atr_ratio: round(pullbackAtrRatio, 3),
    bb_pos_1h: bb && (bb.upper - bb.lower) > 0 ? round((current - bb.lower) / (bb.upper - bb.lower), 3) : null,
    bb_width_1h: bb && bb.middle !== 0 ? round(((bb.upper - bb.lower) / bb.middle) * 100, 3) : null,
    donchian_upper_20: round(donchianUpper20, 5),
    donchian_lower_20: round(donchianLower20, 5),
    donchian_break_20: donchianBreak20,
    range_position_20: round(rangePosition20, 3),
    support_level_1h: round(pivots.support, 5),
    resistance_level_1h: round(pivots.resistance, 5),
    support_distance_pct: round(supportDistancePct, 3),
    resistance_distance_pct: round(resistanceDistancePct, 3),
    retest_support_ready: flag(retestSupportReady),
    retest_resistance_ready: flag(retestResistanceReady),
    pullback_long_setup: flag(pullbackLongSetup),
    pullback_short_setup: flag(pullbackShortSetup),
    breakout_long_setup: flag(breakoutLongSetup),
    breakout_short_setup: flag(breakoutShortSetup),
    price_change_12h_pct: round(own12h, 3),
    relative_strength_btc_12h: own12h != null && btc12h != null ? round(own12h - btc12h, 3) : null,
    ...dmiAdx(klines1h, 14),
  };
}
