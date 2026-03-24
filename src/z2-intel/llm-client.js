/**
 * Z2 LLM Client — Python LLM 서버 HTTP 클라이언트
 */

import { config } from '../shared/config.js';

const BASE_URL = config.llm.pythonUrl || 'http://localhost:2002';

async function callLLM(endpoint, body, timeoutMs = 30000) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM ${endpoint} HTTP ${res.status}`);
  return res.json();
}

export async function analyzeSentiment(newsItems) {
  return callLLM('/api/sentiment', { news_items: newsItems });
}

export async function getBriefing(symbol) {
  return callLLM('/api/briefing', { symbol }, 60000);
}

export async function getScenario(symbol, eventCalendar = null, fearGreed = null, stablecoin = null) {
  return callLLM('/api/scenario', {
    symbol,
    event_calendar: eventCalendar,
    fear_greed: fearGreed,
    stablecoin: stablecoin,
  }, 90000);
}

export async function getUnifiedPlan(symbols, eventCalendar = null, fearGreed = null, stablecoin = null, provider = 'auto') {
  return callLLM('/api/unified-plan', {
    symbols,
    event_calendar: eventCalendar,
    fear_greed: fearGreed,
    stablecoin: stablecoin,
    provider,
  }, 120000);
}

export async function interpretEvent(symbol, eventText) {
  return callLLM('/api/interpret-event', { symbol, event_text: eventText }, 15000);
}

export async function embed(text) {
  const result = await callLLM('/api/embed', { text });
  return result.vector;
}

/** 스윙 포지션 논리 검증 (10분 주기) — HOLD / PARTIAL_EXIT / FULL_EXIT 반환 */
export async function validatePosition(symbol, entryReasoning) {
  return callLLM('/api/validate-position', {
    symbol,
    entry_reasoning: entryReasoning,
  }, 30000);
}
