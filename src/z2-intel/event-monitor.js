/**
 * Z2 Event Monitor — 실시간 이벤트 감지 → LLM 긴급 해석
 * 뉴스 임팩트 높은 기사, 대형 청산, 급격한 가격 변동 감지
 */

import { interpretEvent } from './llm-client.js';

export class EventMonitor {
  constructor(newsCollector, ringBuffer, opts = {}) {
    this.newsCollector = newsCollector;
    this.ringBuffer = ringBuffer;
    this.symbols = opts.symbols || [];
    this.checkIntervalMs = (opts.checkIntervalSec || 10) * 1000;
    this._timer = null;
    this._lastNewsCount = 0;
    this._lastPrices = new Map();
    this.stats = { eventsDetected: 0, errors: 0 };

    this.onSignal = null;        // 콜백: (signal) => void
    this.llmScheduler = null;    // 긴급 연쇄 트리거용
  }

  start() {
    this._timer = setInterval(() => this._check(), this.checkIntervalMs);
    console.log(`[Z2-Event] Monitor started (interval=${this.checkIntervalMs/1000}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async _check() {
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
            `${symbol} moved ${changePct.toFixed(1)}% in ~${this.checkIntervalMs/1000}s (${lastPrice} → ${price})`,
            symbol
          );
        }
      }
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
      console.log(`[Z2-Event] Detected: ${type} — ${text.substring(0, 80)}`);
      const result = await interpretEvent(symbol, text);
      this.stats.eventsDetected++;

      if (result?.activate_plan && result.confidence >= 0.6) {
        console.log(`[Z2-Event] HIGH IMPACT: ${symbol} ${result.affected_direction} (conf=${result.confidence})`);
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
