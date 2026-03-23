/**
 * Z0 Economic Calendar — 경제 이벤트 캘린더 수집
 *
 * 이벤트 단타의 핵심: "언제 발표되는지" 사전 파악 → LLM 시나리오 사전 세팅
 * 소스: Investing.com 캘린더 크롤링 (무료)
 *
 * 수집 항목: CPI, FOMC, NFP, 실업률, GDP, PPI, 소매판매 등
 * 주기: 1시간마다 향후 7일 이벤트 수집
 */

import { getPool } from '../shared/db.js';

// Investing.com 경제 캘린더 API (비공식)
const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// 중요 이벤트 필터 키워드
const IMPORTANT_EVENTS = [
  'CPI', 'Consumer Price', 'FOMC', 'Federal Funds Rate', 'Interest Rate',
  'Non-Farm', 'NFP', 'Unemployment', 'GDP', 'PPI', 'Producer Price',
  'Retail Sales', 'Core PCE', 'PCE Price', 'Initial Jobless',
  'ISM Manufacturing', 'ISM Services', 'Trade Balance',
  'Housing Starts', 'Building Permits', 'Durable Goods',
];

export class EconomicCalendar {
  constructor(opts = {}) {
    this.intervalMs = (opts.intervalMin || 60) * 60 * 1000; // 1시간
    this._timer = null;
    this.stats = { fetched: 0, saved: 0, errors: 0 };
    this.upcomingEvents = []; // 메모리 캐시
  }

  start() {
    this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    console.log(`[Z0-Calendar] Started (interval=${this.intervalMs / 60000}min)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    console.log(`[Z0-Calendar] Stopped (fetched=${this.stats.fetched}, saved=${this.stats.saved})`);
  }

  /** 향후 이벤트 목록 (LLM 시나리오 입력용) */
  getUpcoming(count = 10) {
    const now = Date.now();
    return this.upcomingEvents
      .filter(e => new Date(e.date).getTime() > now)
      .slice(0, count);
  }

  /** 24시간 내 예정 이벤트 (긴급 시나리오 세팅용) */
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

      // 미국 + 고임팩트 이벤트만 필터
      const filtered = events.filter(e => {
        if (e.country !== 'USD') return false;
        if (e.impact === 'Low') return false;
        // 중요 이벤트 키워드 매칭
        const title = (e.title || '').toLowerCase();
        return IMPORTANT_EVENTS.some(kw => title.includes(kw.toLowerCase())) || e.impact === 'High';
      });

      // 메모리 캐시 업데이트
      this.upcomingEvents = filtered.map(e => ({
        date: e.date,
        name: e.title,
        country: e.country,
        importance: e.impact,
        previous: e.previous || null,
        forecast: e.forecast || null,
        actual: e.actual || null,
      }));

      // DB 저장
      const conn = await getPool().getConnection();
      try {
        for (const e of filtered) {
          try {
            await conn.execute(
              `MERGE INTO z0_economic_calendar c
               USING (SELECT :name AS event_name, TO_TIMESTAMP(:dt, 'YYYY-MM-DD"T"HH24:MI:SS') AS event_date FROM dual) s
               ON (c.event_name = s.event_name AND c.event_date = s.event_date)
               WHEN NOT MATCHED THEN INSERT (event_date, event_name, country, importance, previous, forecast, actual)
                                     VALUES (s.event_date, :name, :country, :imp, :prev, :fore, :act)
               WHEN MATCHED THEN UPDATE SET actual = :act`,
              {
                name: (e.title || '').substring(0, 200),
                dt: (e.date || '').substring(0, 19),
                country: e.country || 'USD',
                imp: e.impact || 'Medium',
                prev: e.previous || null,
                fore: e.forecast || null,
                act: e.actual || null,
              },
              { autoCommit: true }
            );
            this.stats.saved++;
          } catch (err) {
            // 중복/파싱 에러 무시
          }
        }
      } finally {
        await conn.close();
      }

      if (filtered.length > 0) {
        const next = this.getNext24h();
        if (next.length > 0) {
          console.log(`[Z0-Calendar] ${filtered.length} events, next 24h: ${next.map(e => e.name).join(', ')}`);
        }
      }
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 5 === 1) {
        console.warn('[Z0-Calendar] Fetch error:', err.message);
      }
    }
  }
}
