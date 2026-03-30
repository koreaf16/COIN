/**
 * @module LLM 스케줄러
 * @description 시장 상황에 따라 LLM 분석 및 매매 계획 생성을 주기적으로 실행한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Collectors   │ ───→ │ LLM          │ ───→ │ Oracle       │
 * │ (Z0 Raw)     │      │ Scheduler    │      │ DB (Z2/Z3)   │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *                               │
 *                        llm-client.js
 *                        (Python API)
 *
 * @zone z2-intel
 * @dependencies llm-client.js, scheduler-db.js, logger.js, hot-reload.js
 */

import { logger } from "../shared/logger.js";
import { hotReloader } from '../shared/hot-reload.js';
import { computeSwingFeatures } from '../shared/swing-features.js';
import { analyzeSentiment, getBriefing, getScenario, getUnifiedPlan, embed } from './llm-client.js';
import * as db from './scheduler-db.js';

const HIGHER_TIMEFRAME_FIELDS = new Set([
  'daily_bias',
  'trend_bias_4h',
  'btc_daily_bias',
]);

const TRIGGER_FIELDS = new Set([
  'trigger_bias_1h',
  'pullback_long_setup',
  'pullback_short_setup',
  'breakout_long_setup',
  'breakout_short_setup',
  'retest_support_ready',
  'retest_resistance_ready',
  'support_distance_pct',
  'resistance_distance_pct',
  'range_position_20',
  'donchian_break_20',
  'relative_strength_btc_12h',
  'pullback_atr_ratio',
  'ema_gap_4h',
  'ema_gap_1d',
  'ema_fast_above_slow_4h',
  'ema_fast_above_slow_1d',
]);

const LONG_ONLY_SETUP_FIELDS = new Set([
  'pullback_long_setup',
  'breakout_long_setup',
  'retest_support_ready',
]);

const SHORT_ONLY_SETUP_FIELDS = new Set([
  'pullback_short_setup',
  'breakout_short_setup',
  'retest_resistance_ready',
]);

export class LLMScheduler {
  constructor(newsCollector, symbols, opts = {}) {
    this.newsCollector = newsCollector;
    this.symbols = symbols;
    this.economicCalendar = opts.economicCalendar || null;
    this.fearGreedCollector = opts.fearGreedCollector || null;
    this.stablecoinCollector = opts.stablecoinCollector || null;
    this.unifiedMode = opts.unifiedMode !== false;
    this.unifiedIntervalMs = (opts.unifiedIntervalMin || 2) * 60 * 1000;
    this.unifiedProvider = opts.unifiedProvider || 'auto';
    this.unifiedPlanValidMin = opts.unifiedPlanValidMin || 240;
    this.ringBuffer = opts.ringBuffer || null;
    this._sentDebounceMs = (opts.sentimentDebounceMs || 10) * 1000;
    this._sentDebounceTimer = null;
    this._unifiedTimer = null;
    this._running = false;
    this._unifiedRunning = false;
    this._urgentSymbols = new Set();
    this._lastSnapshots = new Map();
    this.planCache = null;
    this.stats = { sentiments: 0, unifiedPlans: 0, skippedPlans: 0, errors: 0, urgentChains: 0 };
  }

  start() {
    this._running = true;
    if (this.newsCollector) {
      this.newsCollector.onNewArticle = () => this._debounceSentiment();
    }
    if (this.unifiedMode) {
      setTimeout(() => {
        this._runUnifiedChain();
        this._unifiedTimer = setInterval(() => this._runUnifiedChain(), this.unifiedIntervalMs);
      }, 30 * 1000);
      logger.info(`[Z2-Sched] Started (interval=${this.unifiedIntervalMs / 1000}s, provider=${this.unifiedProvider})`);
    }
  }

  stop() {
    this._running = false;
    if (this._sentDebounceTimer) clearTimeout(this._sentDebounceTimer);
    if (this._unifiedTimer) clearInterval(this._unifiedTimer);
    logger.info(`[Z2-Sched] Stopped (S=${this.stats.sentiments} U=${this.stats.unifiedPlans} E=${this.stats.errors})`);
  }

  _debounceSentiment() {
    if (this._sentDebounceTimer) clearTimeout(this._sentDebounceTimer);
    this._sentDebounceTimer = setTimeout(() => this._runSentiment(), this._sentDebounceMs);
  }

  async triggerUrgentChain(symbol) {
    try {
      logger.info(`[Z2-Sched] URGENT chain triggered for ${symbol}`);
      this.stats.urgentChains++;
      if (!this._running || !symbol || this._urgentSymbols.has(symbol)) return;
      this._urgentSymbols.add(symbol);
      const context = this._getChainContext();
      const saved = await this._processBatch([symbol], context);
      if (saved > 0) {
        this.stats.unifiedPlans++;
        logger.info(`[Z2-Sched] Urgent cycle: saved=${saved} symbol=${symbol}`);
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z2-Sched] Urgent chain error ${symbol}:`, err.message);
    } finally {
      this._urgentSymbols.delete(symbol);
    }
  }

  async _runSentiment() {
    try {
      const news = this.newsCollector?.getRecentNews(30) || [];
      if (news.length === 0) return;
      const result = await analyzeSentiment(news);
      if (result && result.confidence >= 0.3) {
        await db.saveAnalysis(null, 'sentiment', result, 'local');
        this.stats.sentiments++;
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z2-Sched] Sentiment error:`, err.message);
    }
  }

  async _runUnifiedChain() {
    if (!this._running || this._unifiedRunning) return;
    this._unifiedRunning = true;
    try {
      const context = this._getChainContext();
      const sortedSymbols = this._getSortedSymbols();
      let totalSaved = 0;
      let totalSkipped = 0;

      const BATCH_SIZE = 5;
      for (let i = 0; i < sortedSymbols.length; i += BATCH_SIZE) {
        if (!this._running) break;
        const batch = sortedSymbols.slice(i, i + BATCH_SIZE);
        const { filtered, skipped } = await this._filterBatch(batch);
        totalSkipped += skipped;

        if (filtered.length > 0) {
          totalSaved += await this._processBatch(filtered, context);
        }
      }
      this.stats.skippedPlans += totalSkipped;
      if (totalSaved > 0 || totalSkipped > 0) {
        this.stats.unifiedPlans++;
        logger.info(`[Z2-Sched] Unified cycle: saved=${totalSaved}, skipped=${totalSkipped}`);
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z2-Sched] Unified chain error:`, err.message);
    } finally {
      this._unifiedRunning = false;
    }
  }

  _getChainContext() {
    return {
      eventCalendar: this.economicCalendar?.getNext24h() || [],
      fearGreed: this.fearGreedCollector?.getData() || {},
      stablecoin: this.stablecoinCollector?.getData() || {}
    };
  }

  _getSortedSymbols() {
    return [...this.symbols].sort((a, b) => {
      const snapA = this.ringBuffer?.getLastKline?.(a, '1h');
      const snapB = this.ringBuffer?.getLastKline?.(b, '1h');
      return (snapB?.volume || 0) - (snapA?.volume || 0);
    });
  }

  async _filterBatch(batch) {
    const filtered = [];
    let skipped = 0;
    for (const sym of batch) {
      if (this._shouldSkipSymbol(sym)) {
        await this._extendExistingPlan(sym);
        skipped++;
      } else {
        filtered.push(sym);
        this._updateSnapshot(sym);
      }
    }
    return { filtered, skipped };
  }

  _shouldSkipSymbol(sym) {
    const current = this.ringBuffer?.getSnapshot(sym);
    const last = this._lastSnapshots.get(sym);
    if (!last || !current || !current.price || !current.derivatives) return false;
    const priceChange = Math.abs(current.price - last.price) / last.price;
    const oiChange = Math.abs((current.derivatives.open_interest || 0) - last.oi) / (last.oi || 1e-9);
    return priceChange < 0.003 && oiChange < 0.01;
  }

  async _extendExistingPlan(sym) {
    try {
      const success = await db.extendPlanForSymbol(sym, this.unifiedPlanValidMin);
      if (success && this.planCache) {
        this.planCache.extendPlans(sym, Date.now() + this.unifiedPlanValidMin * 60 * 1000);
      }
    } catch (err) {
      logger.error(`[Z2-Sched] Failed to extend plan for ${sym}:`, err.message);
    }
  }

  _updateSnapshot(sym) {
    const current = this.ringBuffer?.getSnapshot(sym);
    if (current && current.derivatives) {
      this._lastSnapshots.set(sym, { price: current.price, oi: current.derivatives.open_interest || 0 });
    }
  }

  async _processBatch(batch, context) {
    try {
      const result = await getUnifiedPlan(batch, context.eventCalendar, context.fearGreed, context.stablecoin, this.unifiedProvider);
      const selectedPlan = result?.plan || null;
      let saved = 0;
      if (selectedPlan && this._normalizeAndValidatePlan(selectedPlan)) {
        await db.expireAndSavePlan(selectedPlan, this.unifiedPlanValidMin, selectedPlan.confidence ?? 0);
        saved = 1;
      }
      return saved;
    } catch (err) {
      logger.error(`[Z2-Sched] Batch error [${batch.join(',')}]:`, err.message);
      return 0;
    }
  }

  _normalizeAndValidatePlan(p) {
    const { normalizeConditions, hasValidConditions } = this._getNormalizer();
    if (!p || !p.symbol || !['LONG', 'SHORT'].includes(p.direction)) return false;

    p.entry_conditions = normalizeConditions(p.entry_conditions);
    p.stop_conditions = normalizeConditions(p.stop_conditions);
    if (!hasValidConditions(p.entry_conditions)) return false;

    const confidence = Number(p.confidence ?? p.probability ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0.55) return false;
    p.confidence = confidence;

    const targetPrice = p.target_price == null ? null : Number(p.target_price);
    const stopPrice = p.stop_price == null ? null : Number(p.stop_price);
    if (!Number.isFinite(targetPrice) || !Number.isFinite(stopPrice)) return false;
    p.target_price = targetPrice;
    p.stop_price = stopPrice;

    const timeStopMin = Number(p.time_stop_min ?? 480);
    if (!Number.isFinite(timeStopMin) || timeStopMin < 240 || timeStopMin > 2880) return false;
    p.time_stop_min = Math.round(timeStopMin);

    if (!hasValidConditions(p.stop_conditions) && p.stop_price != null) {
      p.stop_conditions = p.direction === 'LONG'
        ? { price: { op: '<=', value: p.stop_price } }
        : { price: { op: '>=', value: p.stop_price } };
    }
    if (!hasValidConditions(p.stop_conditions)) return false;

    const priceCondition = p.entry_conditions?.price;
    const currentPrice = this.ringBuffer?.getLastPrice(p.symbol)
      ?? this.ringBuffer?.getLastKline?.(p.symbol, '1m')?.close
      ?? this.ringBuffer?.getLastKline?.(p.symbol, '1h')?.close;
    const entryPrice = typeof priceCondition?.value === 'number'
      ? priceCondition.value
      : currentPrice;
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      logger.warn(`[Z2-Sched] Plan drop ${p.symbol}: no valid entry price (currentPrice=${currentPrice})`);
      return false;
    }

    const structureContext = this._buildStructureValidationContext(p.symbol, entryPrice);
    if (!this._validateStructurePlan(p, p.entry_conditions, structureContext)) {
      logger.warn(`[Z2-Sched] Plan drop ${p.symbol}: structure validation failed`);
      return false;
    }

    const stopDistPct = Math.abs(entryPrice - p.stop_price) / entryPrice * 100;
    if (stopDistPct < 1.0) {
      logger.warn(`[Z2-Sched] Plan drop ${p.symbol}: stop too tight (${stopDistPct.toFixed(2)}% < 1.0%, entry=${entryPrice}, stop=${p.stop_price})`);
      return false;
    }

    const targetDistPct = Math.abs(p.target_price - entryPrice) / entryPrice * 100;
    if (targetDistPct > 10.0) {
      logger.warn(`[Z2-Sched] Plan drop ${p.symbol}: target too far (${targetDistPct.toFixed(2)}% > 10%, entry=${entryPrice})`);
      return false;
    }

    const reward = Math.abs(p.target_price - entryPrice);
    const risk = Math.abs(entryPrice - p.stop_price);
    if (risk <= 0) return false;
    const rr = reward / risk;
    if (rr < 2.0) {
      logger.warn(`[Z2-Sched] Plan drop ${p.symbol}: R:R too low (${rr.toFixed(2)} < 2.0, entry=${entryPrice}, target=${p.target_price}, stop=${p.stop_price})`);
      return false;
    }

    return true;
  }

  _buildStructureValidationContext(symbol, currentPrice) {
    if (!this.ringBuffer?.getKlines || !Number.isFinite(currentPrice) || currentPrice <= 0) return {};
    return computeSwingFeatures({
      currentPrice,
      klines1h: this.ringBuffer.getKlines(symbol, '1h'),
      klines4h: this.ringBuffer.getKlines(symbol, '4h'),
      klines1d: this.ringBuffer.getKlines(symbol, '1d'),
      btcKlines1h: this.ringBuffer.getKlines('BTCUSDT', '1h'),
      btcKlines1d: this.ringBuffer.getKlines('BTCUSDT', '1d'),
    });
  }

  _validateStructurePlan(plan, entryConditions, structureContext = {}) {
    if (!this._hasAnyConditionField(entryConditions, HIGHER_TIMEFRAME_FIELDS)) return false;
    if (!this._hasAnyConditionField(entryConditions, TRIGGER_FIELDS)) return false;

    if (plan.direction === 'LONG' && this._hasAnyConditionField(entryConditions, SHORT_ONLY_SETUP_FIELDS)) return false;
    if (plan.direction === 'SHORT' && this._hasAnyConditionField(entryConditions, LONG_ONLY_SETUP_FIELDS)) return false;

    const opposingBias = plan.direction === 'LONG' ? 'BEARISH' : 'BULLISH';
    for (const field of ['daily_bias', 'trend_bias_4h', 'trigger_bias_1h', 'btc_daily_bias']) {
      if (this._conditionIncludesValue(entryConditions[field], opposingBias)) return false;
    }

    const allowAggressiveCounterTrend = plan.confidence >= 0.9;
    if (plan.direction === 'LONG') {
      if (structureContext.daily_bias === 'BEARISH' && !allowAggressiveCounterTrend) return false;
      if (structureContext.trend_bias_4h === 'BEARISH' && !allowAggressiveCounterTrend) return false;
    }
    if (plan.direction === 'SHORT') {
      if (structureContext.daily_bias === 'BULLISH' && !allowAggressiveCounterTrend) return false;
      if (structureContext.trend_bias_4h === 'BULLISH' && !allowAggressiveCounterTrend) return false;
    }

    return true;
  }

  _hasAnyConditionField(conditions, fieldSet) {
    if (!conditions || typeof conditions !== 'object') return false;
    return Object.keys(conditions).some((field) => fieldSet.has(field));
  }

  _conditionIncludesValue(condition, expectedValue) {
    if (!condition || typeof condition !== 'object') return false;
    const op = condition.op;
    const value = condition.value;
    if (op === 'in' && Array.isArray(value)) {
      return value.some((item) => String(item).toUpperCase() === expectedValue);
    }
    if ((op === '==' || op === '>=' || op === '<=') && typeof value === 'string') {
      return value.toUpperCase() === expectedValue;
    }
    return false;
  }

  _getNormalizer() {
    try {
      return hotReloader.get('condition-evaluator') || this._getFallbackNormalizer();
    } catch {
      return this._getFallbackNormalizer();
    }
  }

  _getFallbackNormalizer() {
    return {
      normalizeConditions: (c) => {
        if (!c || typeof c !== 'object') return {};
        if (Array.isArray(c)) {
          const result = {};
          for (const item of c) {
            if (item && typeof item === 'object' && item.field && item.op && 'value' in item && typeof item.field === 'string') {
              result[item.field] = { op: item.op, value: item.value };
            }
          }
          return result;
        }
        const keys = Object.keys(c);
        if (keys.length === 1 && keys[0] === 'field') {
          const nested = c.field;
          if (nested && typeof nested === 'object' && 'op' in nested && 'value' in nested) return {};
        }
        if (keys.includes('field') && keys.includes('op') && 'value' in c && typeof c.field === 'string') {
          return { [c.field]: { op: c.op, value: c.value } };
        }
        return c;
      },
      hasValidConditions: (c) => c && typeof c === 'object' && Object.values(c).some(v => v && typeof v === 'object' && 'op' in v && 'value' in v),
    };
  }
}
