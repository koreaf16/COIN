import { logger } from "../shared/logger.js";
import { interpretEvent } from './llm-client.js';
import { saveAnalysis } from './scheduler-db.js';

export class EventMonitor {
  constructor(newsCollector, ringBuffer, opts = {}) {
    this.newsCollector = newsCollector;
    this.ringBuffer = ringBuffer;
    this.symbols = opts.symbols || [];
    this.checkIntervalMs = (opts.checkIntervalSec || 10) * 1000;
    this.priceShockLookbackSec = opts.priceShockLookbackSec || 300;
    this.priceShockCooldownMs = (opts.priceShockCooldownSec || 300) * 1000;
    this._timer = null;
    this._seenNewsKeys = new Set();
    this._seenNewsOrder = [];
    this._priceShockCooldown = new Map();
    this.stats = { eventsDetected: 0, errors: 0 };

    this.onSignal = null;
    this.llmScheduler = null;
  }

  start() {
    this._timer = setInterval(() => this._check(), this.checkIntervalMs);
    logger.info(`[Z2-Event] Monitor started (interval=${this.checkIntervalMs / 1000}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _check() {
    try {
      const news = this.newsCollector?.getRecentNews(20) || [];
      for (const article of [...news].reverse()) {
        if (!this._rememberNews(article)) continue;
        if (this._isUrgentNews(article.title)) {
          await this._handleEvent('news', article.title, this._pickNewsSymbol(article));
        }
      }

      for (const symbol of this.symbols) {
        await this._checkPriceShock(symbol);
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z2-Event] Check error: ${err.message}`);
    }
  }

  _isUrgentNews(title) {
    if (!title) return false;
    const urgentKeywords = [
      'hack', 'exploit', 'breach', 'ban', 'regulate', 'sec ',
      'emergency', 'crash', 'bankrupt', 'insolvent', 'etf approved',
      'rate cut', 'rate hike', 'fed ', 'fomc',
    ];
    const lower = title.toLowerCase();
    return urgentKeywords.some(keyword => lower.includes(keyword));
  }

  async _handleEvent(type, text, symbol) {
    try {
      logger.info(`[Z2-Event] Detected: ${type} -> ${text.substring(0, 80)}`);
      const result = await interpretEvent(symbol, text);
      this.stats.eventsDetected++;

      if (result) {
        await saveAnalysis(
          symbol,
          'event',
          { ...result, trigger_type: type, input_text: text },
          'local',
        );
      }

      if (result?.activate_plan && result.confidence >= 0.6) {
        logger.info(`[Z2-Event] HIGH IMPACT: ${symbol} ${result.affected_direction} (conf=${result.confidence})`);
        if (this.llmScheduler) {
          await this.llmScheduler.triggerUrgentChain(symbol);
        }
        if (this.onSignal) {
          this.onSignal({ type, symbol, result });
        }
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z2-Event] Handle error: ${err.message}`);
    }
  }

  _rememberNews(article) {
    const key = `${article?.ts || 0}:${article?.title || ''}`;
    if (!key.trim() || this._seenNewsKeys.has(key)) return false;

    this._seenNewsKeys.add(key);
    this._seenNewsOrder.push(key);
    while (this._seenNewsOrder.length > 200) {
      const stale = this._seenNewsOrder.shift();
      if (stale) this._seenNewsKeys.delete(stale);
    }
    return true;
  }

  _pickNewsSymbol(article) {
    const tickers = String(article?.tickers || '')
      .split(',')
      .map(value => value.trim().toUpperCase())
      .filter(Boolean);

    for (const ticker of tickers) {
      if (this.symbols.includes(ticker)) return ticker;
      if (this.symbols.includes(`${ticker}USDT`)) return `${ticker}USDT`;
    }
    if (tickers.includes('BTC') || tickers.includes('BTCUSDT')) return 'BTCUSDT';
    return this.symbols[0] || 'BTCUSDT';
  }

  async _checkPriceShock(symbol) {
    const trades = this.ringBuffer.getTradesWindow(symbol, this.priceShockLookbackSec);
    if (trades.length < 2) return;

    const baseline = trades[0]?.price;
    const current = trades[trades.length - 1]?.price || this.ringBuffer.getLastPrice(symbol);
    if (!baseline || !current) return;

    const changePct = ((current - baseline) / baseline) * 100;
    if (Math.abs(changePct) < 3.0) return;

    const lastTriggered = this._priceShockCooldown.get(symbol) || 0;
    if (Date.now() - lastTriggered < this.priceShockCooldownMs) return;

    this._priceShockCooldown.set(symbol, Date.now());
    await this._handleEvent(
      'price_shock',
      `${symbol} moved ${changePct.toFixed(1)}% in ~${Math.round(this.priceShockLookbackSec / 60)}m (${baseline} -> ${current})`,
      symbol
    );
  }
}
