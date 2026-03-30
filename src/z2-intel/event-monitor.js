/**
 * @module 이벤트 모니터
 * @description 실시간 뉴스 및 가격 변동을 감시하여 중요 이벤트 발생 시 LLM 해석을 트리거한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ News / Price │ ───→ │ Event        │ ───→ │ LLM          │
 * │ Data         │      │ Monitor      │      │ Interpretation│
 * └──────────────┘      └──────────────┘      └──────────────┘
 *                               ↓
 *                        Z2 Scheduler
 *                        (Urgent Chain)
 *
 * @zone z2-intel
 * @dependencies llm-client.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { interpretEvent } from './llm-client.js';

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

    this.onSignal = null;        // 콜백: (signal) => void
    this.llmScheduler = null;    // 긴급 연쇄 트리거용
  }

  start() {
    this._timer = setInterval(() => this._check(), this.checkIntervalMs);
    logger.info(`[Z2-Event] Monitor started (interval=${this.checkIntervalMs/1000}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _check() {
    try {
      // 1. 새 뉴스 중 고임팩트 감지
      const news = this.newsCollector?.getRecentNews(5) || [];
      if (news.length > this._lastNewsCount) {
        const newArticles = news.slice(0, news.length - this._lastNewsCount);
        this._lastNewsCount = news.length;

        for (const article of newArticles) {
          // 제목에 긴급 키워드 포함 시 LLM 해석
          if (this._isUrgentNews(article.title)) {
            await this._handleEvent('news', article.title, this.symbols[0] || 'BTCUSDT');
          }
        }
      }

      // 2. 급격한 가격 변동 감지 (5분 내 ±3% 이상)
      for (const symbol of this.symbols) {
        const price = this.ringBuffer.getLastPrice(symbol);
        if (!price) continue;

        const lastPrice = this._lastPrices.get(symbol);
        this._lastPrices.set(symbol, price);

        if (lastPrice && lastPrice > 0) {
          const changePct = ((price - lastPrice) / lastPrice) * 100;
          if (Math.abs(changePct) > 3) {
            await this._handleEvent(
              'price_shock',
              `${symbol} moved ${changePct.toFixed(1)}% in ~${this.checkIntervalMs / 1000}s (${lastPrice} → ${price})`,
              symbol
            );
          }
        }
      }
    } catch (err) {
      this.stats.errors++;
      logger.error(`[Z2-Event] Check error:`, err.message);
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
    return urgentKeywords.some(kw => lower.includes(kw));
  }

  async _handleEvent(type, text, symbol) {
    try {
      logger.info(`[Z2-Event] Detected: ${type} — ${text.substring(0, 80)}`);
      const result = await interpretEvent(symbol, text);
      this.stats.eventsDetected++;

      if (result?.activate_plan && result.confidence >= 0.6) {
        logger.info(`[Z2-Event] HIGH IMPACT: ${symbol} ${result.affected_direction} (conf=${result.confidence})`);
        // 긴급 브리핑+시나리오 연쇄 재생성
        if (this.llmScheduler) {
          this.llmScheduler.triggerUrgentChain(symbol);
        }
        if (this.onSignal) {
          this.onSignal({ type, symbol, result });
        }
      }
    } catch (err) {
      this.stats.errors++;
    }
  }
}
