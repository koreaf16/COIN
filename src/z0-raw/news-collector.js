/**
 * @module News Collector
 * @description Tiingo API에서 암호화폐 및 매크로 경제 뉴스 기사를 수집하여 Oracle DB에 저장한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Tiingo   │ ──→ │ News     │ ──→ │ Oracle   │
 * │ API      │     │ Collector│     │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↓
 *              state-vector-builder
 *             (Z1에서 벡터 합산 시 참조)
 *
 * @zone z0-raw
 * @dependencies config.js, db.js, query-loader.js, logger.js
 */

import crypto from 'crypto';
import { logger } from "../shared/logger.js";
import { config } from '../shared/config.js';
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const TIINGO_BASE = config.tiingo.baseUrl || 'https://api.tiingo.com';
const API_KEY = config.tiingo.apiKey;
const queries = loadQueries('z0-raw/news-collector');

// 크립토 티커 및 태그
const CRYPTO_TICKERS = (config.tiingo.tickers || []).join(',');
const CRYPTO_TAGS = config.tiingo.tags || 'crypto,cryptocurrency';

// 매크로 뉴스 키워드
const MACRO_TAGS = 'federal reserve,fomc,cpi,inflation,interest rate,employment,gdp,treasury,bitcoin etf';

export class NewsCollector {
  constructor(opts = {}) {
    this.cryptoIntervalMs = (opts.cryptoIntervalSec || 15) * 1000;
    this.macroIntervalMs = (opts.macroIntervalSec || 60) * 1000;
    this.seenHashes = new Set();
    this.maxSeen = 10000;
    this._cryptoTimer = null;
    this._macroTimer = null;
    this.stats = { fetched: 0, inserted: 0, duplicates: 0, errors: 0, macroFetched: 0 };

    this.recentNews = [];
    this.maxRecentNews = 100;
    this.recentMacroNews = [];
    this.onNewArticle = null;
  }

  /**
   * 서비스 시작: 뉴스 폴링 타이머 설정
   */
  start() {
    if (!API_KEY) {
      logger.info('[Z0-News] Tiingo API key not set, skipping');
      return;
    }

    this._pollCrypto();
    this._cryptoTimer = setInterval(() => this._pollCrypto(), this.cryptoIntervalMs);

    this._pollMacro();
    this._macroTimer = setInterval(() => this._pollMacro(), this.macroIntervalMs);

    logger.info(`[Z0-News] Tiingo Pro started (crypto=${this.cryptoIntervalMs / 1000}s, macro=${this.macroIntervalMs / 1000}s)`);
  }

  /**
   * 서비스 종료: 타이머 해제
   */
  stop() {
    if (this._cryptoTimer) clearInterval(this._cryptoTimer);
    if (this._macroTimer) clearInterval(this._macroTimer);
    logger.info(`[Z0-News] Stopped (fetched=${this.stats.fetched} inserted=${this.stats.inserted})`);
  }

  getRecentNews(count = 30) {
    return this.recentNews.slice(0, count);
  }

  getRecentMacroNews(count = 10) {
    return this.recentMacroNews.slice(0, count);
  }

  /**
   * 크립토 관련 뉴스를 폴링한다.
   */
  async _pollCrypto() {
    try {
      const now = new Date();
      const startDate = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
      const url = `${TIINGO_BASE}/tiingo/news?tickers=${CRYPTO_TICKERS}&tags=${CRYPTO_TAGS}&limit=50&startDate=${startDate}&sortBy=publishedDate&token=${API_KEY}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { this.stats.errors++; return; }

      const articles = await res.json();
      this.stats.fetched += articles.length;

      let hasNew = false;
      for (const article of articles) {
        if (await this._processArticle(article, 'crypto')) hasNew = true;
      }
      if (hasNew) this.onNewArticle?.();
    } catch (err) {
      this.stats.errors++;
      logger.warn('[Z0-News] Crypto poll error:', err.message);
    }
  }

  /**
   * 매크로 경제 관련 뉴스를 폴링한다.
   */
  async _pollMacro() {
    try {
      const now = new Date();
      const startDate = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
      const url = `${TIINGO_BASE}/tiingo/news?tags=${encodeURIComponent(MACRO_TAGS)}&limit=30&startDate=${startDate}&sortBy=publishedDate&token=${API_KEY}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;

      const articles = await res.json();
      this.stats.macroFetched += articles.length;

      let hasNew = false;
      for (const article of articles) {
        if (await this._processArticle(article, 'macro')) hasNew = true;
      }
      if (hasNew) this.onNewArticle?.();
    } catch (err) {
      this.stats.errors++;
    }
  }

  /**
   * 개별 기사를 처리(중복 확인, DB 저장, 캐시 업데이트)한다.
   * @param {Object} article
   * @param {string} category
   */
  async _processArticle(article, category) {
    try {
      const hash = crypto.createHash('md5').update(article.title || '').digest('hex');
      if (this.seenHashes.has(hash)) { this.stats.duplicates++; return false; }

      this._updateSeenHashes(hash);

      const success = await this._saveToDb(article, category);
      if (success) {
        this._updateCache(article, category);
        this.stats.inserted++;
      }
      return success;
    } catch (err) {
      this.stats.errors++;
      return false;
    }
  }

  _updateSeenHashes(hash) {
    this.seenHashes.add(hash);
    if (this.seenHashes.size > this.maxSeen) {
      const first = this.seenHashes.values().next().value;
      this.seenHashes.delete(first);
    }
  }

  async _saveToDb(article, category) {
    try {
      const conn = await getPool().getConnection();
      try {
        await conn.execute(queries.insertNews, {
          ts: new Date(article.publishedDate || Date.now()),
          source: `${article.source || 'tiingo'}/${category}`,
          title: (article.title || '').substring(0, 500),
          content: (article.description || '').substring(0, 4000),
          tickers: (article.tickers || []).map(t => t.toUpperCase()).join(','),
          url: (article.url || '').substring(0, 500),
        }, { autoCommit: true });
        return true;
      } finally {
        await conn.close();
      }
    } catch (err) {
      return false;
    }
  }

  _updateCache(article, category) {
    const ts = new Date(article.publishedDate || Date.now());
    const newsItem = {
      title: (article.title || '').substring(0, 500),
      content: article.description || '',
      tickers: (article.tickers || []).map(t => t.toUpperCase()).join(','),
      source: article.source || 'tiingo',
      category,
      ts: ts.getTime() / 1000
    };

    this.recentNews.unshift(newsItem);
    if (this.recentNews.length > this.maxRecentNews) this.recentNews.length = this.maxRecentNews;

    if (category === 'macro') {
      this.recentMacroNews.unshift(newsItem);
      if (this.recentMacroNews.length > 30) this.recentMacroNews.length = 30;
    }
  }
}
