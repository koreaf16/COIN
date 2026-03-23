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

export async function validatePosition(symbol, positionId, entryReasoning) {
  // 가격 조건은 진입용이므로, 진입 후 논리 검증에서는 제외 (가격 변동으로 인한 오탐 방지)
  const filteredReasoning = { ...entryReasoning };
  if (Array.isArray(filteredReasoning.details)) {
    filteredReasoning.details = filteredReasoning.details.filter(d => d.field !== 'price');
  }

  return callLLM('/api/validate-position', {
    symbol, position_id: positionId, entry_reasoning: filteredReasoning,
  }, 30000);
}

export async function embed(text) {
  const result = await callLLM('/api/embed', { text });
  return result.vector;
}
