/**
 * @module LLM 클라이언트
 * @description Python LLM 서버(FastAPI)와 통신하여 시장 분석, 브리핑, 시나리오 및 매매 계획을 생성한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Node.js      │ ───→ │ Python       │ ───→ │ LLM API      │
 * │ (llm-client) │      │ (FastAPI)    │      │ (OpenAI/etc) │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *        ↑                      ↓
 *  Z2 Scheduler           trade_plans /
 *  event-monitor          analysis_results
 *
 * @zone z2-intel
 * @dependencies config.js, fetch (AbortSignal)
 */

import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

const BASE_URL = config.llm?.pythonUrl || 'http://localhost:2002';

/**
 * Python LLM 서버 API 호출 공통 함수
 */
async function callLLM(endpoint, body, timeoutMs = 60000) {
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errorMsg = `LLM ${endpoint} HTTP ${res.status}`;
      logger.error(`[Z2-LLM] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'TimeoutError') {
      logger.error(`[Z2-LLM] Timeout calling ${endpoint} (${timeoutMs}ms)`);
    } else {
      logger.error(`[Z2-LLM] Error calling ${endpoint}:`, err.message);
    }
    throw err;
  }
}

export async function analyzeSentiment(newsItems) {
  try {
    return await callLLM('/api/sentiment', { news_items: newsItems }, 90000);
  } catch (err) {
    return null;
  }
}

export async function getBriefing(symbol) {
  try {
    return await callLLM('/api/briefing', { symbol }, 180000);
  } catch (err) {
    return null;
  }
}

export async function getScenario(symbol, eventCalendar = null, fearGreed = null, stablecoin = null) {
  try {
    return await callLLM('/api/scenario', {
      symbol,
      event_calendar: eventCalendar,
      fear_greed: fearGreed,
      stablecoin: stablecoin,
    }, 240000);
  } catch (err) {
    return null;
  }
}

export async function getUnifiedPlan(symbols, eventCalendar = null, fearGreed = null, stablecoin = null, provider = 'auto') {
  try {
    return await callLLM('/api/unified-plan', {
      symbols,
      event_calendar: eventCalendar,
      fear_greed: fearGreed,
      stablecoin: stablecoin,
      provider,
    }, 300000);
  } catch (err) {
    return null;
  }
}

export async function interpretEvent(symbol, eventText) {
  try {
    return await callLLM('/api/interpret-event', { symbol, event_text: eventText }, 120000);
  } catch (err) {
    return null;
  }
}

export async function embed(text) {
  try {
    const result = await callLLM('/api/embed', { text });
    return result?.vector || null;
  } catch (err) {
    return null;
  }
}

/** 포지션 논리 검증 (10분 주기) — HOLD / PARTIAL_EXIT / FULL_EXIT 반환 */
export async function validatePosition(symbol, entryReasoning) {
  try {
    return await callLLM('/api/validate-position', {
      symbol,
      entry_reasoning: entryReasoning,
    }, 120000);
  } catch (err) {
    return null;
  }
}
