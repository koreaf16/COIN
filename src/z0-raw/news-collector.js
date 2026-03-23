/**
 * Z0 News Collector — Tiingo Pro 뉴스 API 전체 활용
 *
 * Pro 기능:
 *   - 뉴스 API: 100건/호출, 3개월 히스토리, 고급 필터링
 *   - 크립토 뉴스 + 일반 금융 뉴스 (매크로 이벤트 감지용)
 *   - 소스 필터링: reuters, bloomberg, coindesk 등
 */

import crypto from 'crypto';
import { config } from '../shared/config.js';
import { getPool } from '../shared/db.js';

const TIINGO_BASE = config.tiingo.baseUrl || 'https://api.tiingo.com';
const API_KEY = config.tiingo.apiKey;

// 크립토 티커
const CRYPTO_TICKERS = (config.tiingo.tickers || []).join(',');
const CRYPTO_TAGS = config.tiingo.tags || 'crypto,cryptocurrency';

// 매크로 뉴스 키워드 (이벤트 단타용)
const MACRO_TAGS = 'federal reserve,fomc,cpi,inflation,interest rate,employment,gdp,treasury,bitcoin etf';

export class NewsCollector {
  constructor(opts = {}) {
    this.cryptoIntervalMs = (opts.cryptoIntervalSec || 15) * 1000;   // 크립토 뉴스 15초
    this.macroIntervalMs = (opts.macroIntervalSec || 60) * 1000;    // 매크로 뉴스 1분
    this.seenHashes = new Set();
    this.maxSeen = 10000;
    this._cryptoTimer = null;
    this._macroTimer = null;
    this.stats = { fetched: 0, inserted: 0, duplicates: 0, errors: 0, macroFetched: 0 };

    this.recentNews = [];       // Z2 LLM 분석용
    this.maxRecentNews = 100;   // Pro니까 넉넉하게
    this.recentMacroNews = [];  // 매크로 뉴스 별도
  }

  start() {
    if (!API_KEY) {
      console.log('[Z0-News] Tiingo API key not set, skipping');
      return;
    }

    // 크립토 뉴스
    this._pollCrypto();
    this._cryptoTimer = setInterval(() => this._pollCrypto(), this.cryptoIntervalMs);

    // 매크로 뉴스
    this._pollMacro();
    this._macroTimer = setInterval(() => this._pollMacro(), this.macroIntervalMs);

    console.log(`[Z0-News] Tiingo Pro started (crypto=${this.cryptoIntervalMs / 1000}s, macro=${this.macroIntervalMs / 1000}s)`);
  }

  stop() {
    if (this._cryptoTimer) clearInterval(this._cryptoTimer);
    if (this._macroTimer) clearInterval(this._macroTimer);
    console.log(`[Z0-News] Stopped (fetched=${this.stats.fetched} inserted=${this.stats.inserted} macro=${this.stats.macroFetched})`);
  }

  /** Z2 스케줄러용 — 최근 크립토+매크로 뉴스 */
  getRecentNews(count = 30) {
    return this.recentNews.slice(0, count);
  }

  /** 매크로 뉴스만 (이벤트 모니터용) */
  getRecentMacroNews(count = 10) {
    return this.recentMacroNews.slice(0, count);
  }

  // ── 크립토 뉴스 (30초마다) ──
  async _pollCrypto() {
    try {
      const now = new Date();
      const startDate = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';

      // Pro: limit=100, sortBy=publishedDate
      const url = `${TIINGO_BASE}/tiingo/news?tickers=${CRYPTO_TICKERS}&tags=${CRYPTO_TAGS}&limit=50&startDate=${startDate}&sortBy=publishedDate&token=${API_KEY}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { this.stats.errors++; return; }

      const articles = await res.json();
      this.stats.fetched += articles.length;

      for (const article of articles) {
        await this._processArticle(article, 'crypto');
      }
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 10 === 1) {
        console.warn('[Z0-News] Crypto poll error:', err.message);
      }
    }
  }

  // ── 매크로 뉴스 (2분마다) ──
  async _pollMacro() {
    try {
      const now = new Date();
      const startDate = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';

      // Pro: 매크로 키워드로 금융 뉴스 검색
      const url = `${TIINGO_BASE}/tiingo/news?tags=${encodeURIComponent(MACRO_TAGS)}&limit=30&startDate=${startDate}&sortBy=publishedDate&token=${API_KEY}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;

      const articles = await res.json();
      this.stats.macroFetched += articles.length;

      for (const article of articles) {
        await this._processArticle(article, 'macro');
      }
    } catch (err) {
      // 매크로 뉴스 실패는 경고만
    }
  }

  async _processArticle(article, category) {
    const hash = crypto.createHash('md5').update(article.title || '').digest('hex');
    if (this.seenHashes.has(hash)) { this.stats.duplicates++; return; }
    this.seenHashes.add(hash);
    if (this.seenHashes.size > this.maxSeen) {
      const first = this.seenHashes.values().next().value;
      this.seenHashes.delete(first);
    }

    const tickers = (article.tickers || []).map(t => t.toUpperCase()).join(',');
    const title = (article.title || '').substring(0, 500);
    const content = article.description || '';
    const source = article.source || 'tiingo';
    const ts = new Date(article.publishedDate || Date.now());

    // DB INSERT
    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(
          `INSERT INTO z0_news_raw (ts, source, title, content, tickers, url)
           VALUES (:ts, :source, :title, :content, :tickers, :url)`,
          {
            ts,
            source: `${source}/${category}`,
            title,
            content: content.substring(0, 4000),
            tickers,
            url: (article.url || '').substring(0, 500),
          },
          { autoCommit: true }
        );
        this.stats.inserted++;
      } finally {
        await conn.close();
      }
    } catch (err) {
      this.stats.errors++;
      return;
    }

    // 캐시 업데이트
    const newsItem = { title, content, tickers, source, category, ts: ts.getTime() / 1000 };

    this.recentNews.unshift(newsItem);
    if (this.recentNews.length > this.maxRecentNews) this.recentNews.length = this.maxRecentNews;

    if (category === 'macro') {
      this.recentMacroNews.unshift(newsItem);
      if (this.recentMacroNews.length > 30) this.recentMacroNews.length = 30;
    }
  }
}
