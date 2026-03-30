/**
 * @module 시간 유틸리티
 * @description 타임존 변환(UTC, ET) 및 날짜 포맷팅 기능을 제공한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ System   │ ──→ │ Time     │ ──→ │ Oracle/  │
 * │ Time     │     │ Utils    │     │ Dashboard│
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone shared
 * @dependencies none
 */

/**
 * 타임존 정책:
 *   - DB 저장은 UTC, UI 표시는 ET
 *   - Windows에서 process.env.TZ가 안 먹히므로 명시적 UTC 변환 사용
 */

/** UTC 기준 현재 Date 객체 (Oracle INSERT용) */
export function utcNow() {
  return new Date();
  // new Date()는 내부적으로 항상 UTC 밀리초 저장.
  // Oracle oracledb 드라이버는 세션 타임존(UTC)으로 해석하므로 그대로 사용 OK.
}

/** Unix timestamp (초) → UTC Date 객체 */
export function fromUnixSec(ts) {
  return new Date(ts * 1000);
}

/** Unix timestamp (밀리초) → UTC Date 객체 */
export function fromUnixMs(ms) {
  return new Date(ms);
}

/** ET(미국동부) 기준 오늘 날짜 문자열 (YYYY-MM-DD) */
export function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** UTC → ET 표시용 문자열 */
export function formatET(date) {
  if (!date) return '--';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString('ko-KR', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
