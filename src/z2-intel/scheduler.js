/**
 * Z2 LLM Scheduler — 최적 주기
 *
 * 매 1분: 센티먼트 (로컬 Qwen)
 * 매 10분: [브리핑 → 즉시 시나리오] 연쇄 세트 (Claude CLI)
 * 이벤트 시: 긴급 [브리핑 → 시나리오] 즉시 재생성 (Claude CLI)
 * 매 1분: 포지션 논리 검증 (로컬 Qwen) — SmartExit에서 처리
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { analyzeSentiment, getBriefing, getScenario, embed } from './llm-client.js';

export class LLMScheduler {
  constructor(newsCollector, symbols, opts = {}) {
    this.newsCollector = newsCollector;
    this.symbols = symbols;
    this.economicCalendar = opts.economicCalendar || null;
    this.fearGreedCollector = opts.fearGreedCollector || null;
    this.stablecoinCollector = opts.stablecoinCollector || null;
    this.sentimentIntervalMs = (opts.sentimentIntervalMin || 1) * 60 * 1000;    // 1분
    this.briefingScenarioIntervalMs = (opts.chainIntervalMin || 10) * 60 * 1000; // 10분
    this.topSymbolsForScenario = opts.topSymbolsForScenario || 10;

    this._sentTimer = null;
    this._chainTimer = null;
    this._running = false;
    this.stats = { sentiments: 0, briefings: 0, scenarios: 0, chains: 0, urgentChains: 0, errors: 0 };
  }

  start() {
    this._running = true;

    // 센티먼트: 15초 후 시작, 매 1분
    setTimeout(() => {
      this._runSentiment();
      this._sentTimer = setInterval(() => this._runSentiment(), this.sentimentIntervalMs);
    }, 15 * 1000);

    // 브리핑+시나리오 연쇄: 30초 후 즉시 첫 실행, 이후 매 10분
    setTimeout(() => {
      this._runChain();
      this._chainTimer = setInterval(() => this._runChain(), this.briefingScenarioIntervalMs);
    }, 30 * 1000);

    console.log(`[Z2-Sched] Started (sent=${this.sentimentIntervalMs / 60000}m, chain=${this.briefingScenarioIntervalMs / 60000}m)`);
  }

  stop() {
    this._running = false;
    if (this._sentTimer) clearInterval(this._sentTimer);
    if (this._chainTimer) clearInterval(this._chainTimer);
    console.log(`[Z2-Sched] Stopped (S=${this.stats.sentiments} chains=${this.stats.chains} urgent=${this.stats.urgentChains} E=${this.stats.errors})`);
  }

  /** 이벤트 모니터에서 호출 — 긴급 브리핑+시나리오 재생성 */
  async triggerUrgentChain(symbol) {
    console.log(`[Z2-Sched] URGENT chain triggered for ${symbol}`);
    this.stats.urgentChains++;
    try {
      await this._runChainForSymbol(symbol);
    } catch (err) {
      this.stats.errors++;
      console.error(`[Z2-Sched] Urgent chain error ${symbol}:`, err.message);
    }
  }

  // ── 센티먼트 (1분, 로컬) ──
  async _runSentiment() {
    try {
      const news = this.newsCollector?.getRecentNews(30) || [];
      if (news.length === 0) return;

      const result = await analyzeSentiment(news);
      if (!result || result.confidence < 0.3) return;

      await this._saveAnalysis(null, 'sentiment', result, 'local');
      this.stats.sentiments++;
    } catch (err) {
      this.stats.errors++;
    }
  }

  // ── 브리핑+시나리오 연쇄 (10분, Claude CLI) ──
  async _runChain() {
    if (!this._running) return;
    this.stats.chains++;

    // 상위 심볼 순차 처리
    const targetSymbols = this.symbols.slice(0, this.topSymbolsForScenario);

    for (const symbol of targetSymbols) {
      if (!this._running) break;
      try {
        await this._runChainForSymbol(symbol);
      } catch (err) {
        this.stats.errors++;
        console.error(`[Z2-Sched] Chain error ${symbol}:`, err.message);
      }
    }
  }

  /** 단일 심볼: 브리핑 → 즉시 시나리오 (연쇄) */
  async _runChainForSymbol(symbol) {
    // 1. 브리핑 (Claude CLI ~10초)
    const briefing = await getBriefing(symbol);
    if (!briefing || briefing.confidence < 0.4) return;

    const summaryText = briefing.summary || JSON.stringify(briefing);
    let embedding = null;
    try { embedding = await embed(summaryText); } catch (_) {}

    await this._saveAnalysis(symbol, 'briefing', briefing, 'cloud', embedding);
    this.stats.briefings++;
    console.log(`[Z2-Sched] Briefing ${symbol}: ${briefing.direction_bias || 'neutral'} (conf=${briefing.confidence})`);

    // 2. 즉시 시나리오 (브리핑 + 경제캘린더 + FnG + 스테이블코인)
    const eventCalendar = this.economicCalendar?.getNext24h() || [];
    const fearGreed = this.fearGreedCollector?.getData() || {};
    const stablecoin = this.stablecoinCollector?.getData() || {};
    const scenario = await getScenario(symbol, eventCalendar, fearGreed, stablecoin);
    if (!scenario || scenario.confidence < 0.5) return;

    await this._saveAnalysis(symbol, 'scenario', scenario, 'cloud');

    // 시나리오별 execution_plan 저장
    const scenarios = scenario.scenarios || [];
    let planCount = 0;
    for (const s of scenarios) {
      if (s.probability < 0.2) continue;
      await this._savePlan(symbol, s, scenario.confidence);
      planCount++;
    }

    this.stats.scenarios++;
    console.log(`[Z2-Sched] Scenario ${symbol}: ${planCount} plans created (conf=${scenario.confidence})`);
  }

  // ── DB 저장 ──
  async _saveAnalysis(symbol, type, result, llmSource, embedding = null) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z2_llm_analysis (symbol, ts, analysis_type, llm_source, result, confidence, embedding)
         VALUES (:sym, SYSTIMESTAMP, :type, :src, :result, :conf, :emb)`,
        {
          sym: symbol,
          type,
          src: llmSource,
          result: { type: oracledb.DB_TYPE_JSON, val: result },
          conf: result.confidence || 0,
          emb: embedding
            ? { type: oracledb.DB_TYPE_VECTOR, val: new Float64Array(embedding) }
            : null,
        },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
  }

  async _savePlan(symbol, scenario, overallConfidence) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z2_execution_plan
         (symbol, valid_until, direction, entry_conditions, target_price, stop_price,
          stop_conditions, time_stop_min, confidence, reasoning, scenario_id, status)
         VALUES (:sym, SYSTIMESTAMP + INTERVAL '30' MINUTE, :dir, :entry, :target, :stopPrice,
                 :stop, :timeStop, :conf, :reasoning, :scenId, 'ACTIVE')`,
        {
          sym: symbol,
          dir: scenario.direction || 'LONG',
          entry: { type: oracledb.DB_TYPE_JSON, val: scenario.entry_conditions || {} },
          target: scenario.target_price || null,
          stopPrice: scenario.stop_price || null,
          stop: { type: oracledb.DB_TYPE_JSON, val: scenario.stop_conditions || {} },
          timeStop: scenario.time_stop_min || 15,
          conf: Math.min(scenario.probability || 0, overallConfidence),
          reasoning: scenario.reasoning || '',
          scenId: scenario.id || null,
        },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
  }
}
