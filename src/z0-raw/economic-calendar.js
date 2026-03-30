/**
 * @module 경제 캘린더 수집기
 * @description 주요 경제 지표(CPI, FOMC, NFP 등)의 발표 일정을 수집하여 Oracle DB에 저장한다.
 *
 * ┌───────────┐     ┌─────────────┐     ┌─────────────┐
 * │ Investing │ ──→ │ Economic    │ ──→ │ Oracle DB   │
 * │ Calendar  │     │ Calendar    │     │ (z0_econ)   │
 * └───────────┘     └─────────────┘     └─────────────┘
 *
 * @zone z0-raw
 * @dependencies db.js, query-loader.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const queries = loadQueries('z0-raw/economic-calendar');

const IMPORTANT_EVENTS = [
  'CPI', 'Consumer Price', 'FOMC', 'Federal Funds Rate', 'Interest Rate',
  'Non-Farm', 'NFP', 'Unemployment', 'GDP', 'PPI', 'Producer Price',
  'Retail Sales', 'Core PCE', 'PCE Price', 'Initial Jobless',
  'ISM Manufacturing', 'ISM Services', 'Trade Balance',
  'Housing Starts', 'Building Permits', 'Durable Goods',
];

export class EconomicCalendar {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 60) * 60 * 1000;
    this._timer = null;
    this.stats = { fetched: 0, saved: 0, errors: 0 };
    this.upcomingEvents = [];
  }

  start() {
    this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    logger.info(`[Z0-Calendar] Started (${this.intervalMs / 60000}min)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    logger.info(`[Z0-Calendar] Stopped: Saved=${this.stats.saved}`);
  }

  getUpcoming(count = 10) {
    const now = Date.now();
    return this.upcomingEvents
      .filter(e => new Date(e.date).getTime() > now)
      .slice(0, count);
  }

  getNext24h() {
    const now = Date.now();
    const in24h = now + 24 * 60 * 60 * 1000;
    return this.upcomingEvents.filter(e => {
      const t = new Date(e.date).getTime();
      return t > now && t < in24h;
    });
  }

  async _fetch() {
    try {
      const res = await fetch(CALENDAR_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { this.stats.errors++; return; }

      const events = await res.json();
      this.stats.fetched += events.length;
      const filtered = this._filterEvents(events);
      this.upcomingEvents = this._mapEvents(filtered);

      await this._saveEvents(filtered);
      this._logNextEvents(filtered);
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 5 === 1) {
        logger.warn(`[Z0-Calendar] Fetch error: ${err.message}`);
      }
    }
  }

  _filterEvents(events) {
    return events.filter(e => {
      if (e.country !== 'USD' || e.impact === 'Low') return false;
      const title = (e.title || '').toLowerCase();
      return IMPORTANT_EVENTS.some(kw => title.includes(kw.toLowerCase())) || e.impact === 'High';
    });
  }

  _mapEvents(events) {
    return events.map(e => ({
      date: e.date, name: e.title, country: e.country, importance: e.impact,
      previous: e.previous || null, forecast: e.forecast || null, actual: e.actual || null,
    }));
  }

  async _saveEvents(events) {
    const conn = await getPool().getConnection();
    try {
      for (const e of events) {
        try {
          await conn.execute(queries.mergeEconomicEvent, {
            name: (e.title || '').substring(0, 200),
            dt: (e.date || '').substring(0, 19),
            country: e.country || 'USD',
            imp: e.impact || 'Medium',
            prev: e.previous || null,
            fore: e.forecast || null,
            act: e.actual || null,
          }, { autoCommit: true });
          this.stats.saved++;
        } catch (err) { /* ignore */ }
      }
    } finally {
      await conn.close();
    }
  }

  _logNextEvents(filtered) {
    if (filtered.length > 0) {
      const next = this.getNext24h();
      if (next.length > 0) {
        logger.info(`[Z0-Calendar] ${filtered.length} events, next 24h: ${next.map(e => e.name).join(', ')}`);
      }
    }
  }
}
