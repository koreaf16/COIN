/**
 * Z2 LLM Scheduler — 하이브리드 모드
 *
 * [통합 모드 — 기본] 매 1분: 전체 심볼 통합 분석 → 최적 플랜만 생성 (로컬 Qwen)
 * [레거시 모드]       매 10분: 심볼별 [브리핑 → 시나리오] 연쇄 (Claude CLI)
 *
 * 매 1분: 센티먼트 (로컬 Qwen)
 * 이벤트 시: 긴급 [브리핑 → 시나리오] 즉시 재생성 (Claude CLI)
 * 매 1분: 포지션 논리 검증 (로컬 Qwen) — SmartExit에서 처리
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { analyzeSentiment, getBriefing, getScenario, getUnifiedPlan, embed } from './llm-client.js';

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

    // 통합 모드 설정
    this.unifiedMode = opts.unifiedMode !== false;  // 기본 ON
    this.unifiedIntervalMs = (opts.unifiedIntervalMin || 1) * 60 * 1000;  // 1분
    this.unifiedProvider = opts.unifiedProvider || 'auto';  // 'local', 'cloud', 'auto'
    this.unifiedPlanValidMin = opts.unifiedPlanValidMin || 5;  // 플랜 유효시간 5분

    this.ringBuffer = opts.ringBuffer || null;
    this._sentDebounceMs = (opts.sentimentDebounceMs || 10) * 1000;  // 10초 디바운스
    this._sentDebounceTimer = null;
    this._chainTimer = null;
    this._unifiedTimer = null;
    this._running = false;
    this._unifiedRunning = false;  // 중복 실행 방지
    this._lastSnapshots = new Map(); // symbol -> { price, oi } 캐시용
    this.planCache = null; // RuleEngine.planCache 참조 (index.js에서 주입)
    this.stats = { sentiments: 0, briefings: 0, scenarios: 0, chains: 0, urgentChains: 0, unifiedPlans: 0, skippedPlans: 0, errors: 0 };
  }

  start() {
    this._running = true;

    // 센티먼트: 새 뉴스 기사 도착 시 10초 디바운스 후 실행
    if (this.newsCollector) {
      this.newsCollector.onNewArticle = () => this._debounceSentiment();
    }

    if (this.unifiedMode) {
      // ── 통합 모드: 30초 후 즉시 첫 실행, 이후 매 1분 ──
      setTimeout(() => {
        this._runUnifiedChain();
        this._unifiedTimer = setInterval(() => this._runUnifiedChain(), this.unifiedIntervalMs);
      }, 30 * 1000);

      console.log(`[Z2-Sched] Started UNIFIED mode (interval=${this.unifiedIntervalMs / 1000}s, provider=${this.unifiedProvider}, validMin=${this.unifiedPlanValidMin})`);
    } else {
      // ── 레거시 모드: 심볼별 브리핑+시나리오 ──
      setTimeout(() => {
        this._runChain();
        this._chainTimer = setInterval(() => this._runChain(), this.briefingScenarioIntervalMs);
      }, 30 * 1000);

      console.log(`[Z2-Sched] Started LEGACY mode (sent=${this.sentimentIntervalMs / 60000}m, chain=${this.briefingScenarioIntervalMs / 60000}m)`);
    }
  }

  _debounceSentiment() {
    if (this._sentDebounceTimer) clearTimeout(this._sentDebounceTimer);
    this._sentDebounceTimer = setTimeout(() => this._runSentiment(), this._sentDebounceMs);
  }

  stop() {
    this._running = false;
    if (this._sentDebounceTimer) clearTimeout(this._sentDebounceTimer);
    if (this._chainTimer) clearInterval(this._chainTimer);
    if (this._unifiedTimer) clearInterval(this._unifiedTimer);
    console.log(`[Z2-Sched] Stopped (S=${this.stats.sentiments} unified=${this.stats.unifiedPlans} chains=${this.stats.chains} E=${this.stats.errors})`);
  }

  /** 이벤트 모니터에서 호출 — 긴급 브리핑+시나리오 즉시 재생성 */
  async triggerUrgentChain(symbol) {
    console.log(`[Z2-Sched] URGENT chain triggered for ${symbol}`);
    this.stats.urgentChains++;
    try {
      if (this.unifiedMode) {
        // 통합 모드에서도 긴급 시 즉시 전체 재분석
        await this._runUnifiedChain();
      } else {
        await this._runChainForSymbol(symbol);
      }
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

  // ── 통합 모드: 심볼을 배치로 나눠 순차 처리 → 전체 심볼 플랜 생성 ──
  async _runUnifiedChain() {
    if (!this._running || this._unifiedRunning) return;
    this._unifiedRunning = true;

    const BATCH_SIZE = 5;
    let totalSaved = 0;
    let totalSkipped = 0;

    try {
      const eventCalendar = this.economicCalendar?.getNext24h() || [];
      const fearGreed = this.fearGreedCollector?.getData() || {};
      const stablecoin = this.stablecoinCollector?.getData() || {};

      // [최적화 1] Symbol Pruning: 1시간 거래량 기준 정렬 (데이터 없는 종목 뒤로)
      const sortedSymbols = [...this.symbols].sort((a, b) => {
        const snapA = this.ringBuffer?.getLastKline?.(a, '1h');
        const snapB = this.ringBuffer?.getLastKline?.(b, '1h');
        return (snapB?.volume || 0) - (snapA?.volume || 0);
      });

      // 심볼을 BATCH_SIZE씩 나눠 순차 처리
      for (let i = 0; i < sortedSymbols.length; i += BATCH_SIZE) {
        if (!this._running) break;
        const batch = sortedSymbols.slice(i, i + BATCH_SIZE);

        // [최적화 2] Logical Caching: 핵심 데이터 변화가 미미한 심볼 제외
        const filteredBatch = [];
        for (const sym of batch) {
          const current = this.ringBuffer?.getSnapshot(sym);
          const last = this._lastSnapshots.get(sym);

          if (last && current && current.price && current.derivatives) {
            const priceChange = Math.abs(current.price - last.price) / last.price;
            const oiChange = Math.abs((current.derivatives.open_interest || 0) - (last.oi || 0)) / (last.oi || 1e-9);

            // 가격 0.1% 미만 & OI 1% 미만 변화 시 기존 플랜 연장 후 건너뜀
            if (priceChange < 0.001 && oiChange < 0.01) {
              await this._extendPlanForSymbol(sym);
              console.log(`[Z2-Sched] Skip LLM for ${sym} (Price Δ=${(priceChange * 100).toFixed(3)}%, OI Δ=${(oiChange * 100).toFixed(3)}%) - Plan extended`);
              totalSkipped++;
              continue;
            }
          }
          filteredBatch.push(sym);
          // 캐시 업데이트
          if (current && current.derivatives) {
            this._lastSnapshots.set(sym, {
              price: current.price,
              oi: current.derivatives.open_interest || 0
            });
          }
        }

        if (filteredBatch.length === 0) continue;

        // 심볼별 개별 LLM 호출 → 병렬 실행
        const batchResults = await Promise.allSettled(
          filteredBatch.map(sym => getUnifiedPlan([sym], eventCalendar, fearGreed, stablecoin, this.unifiedProvider))
        );

        for (let j = 0; j < batchResults.length; j++) {
          const sym = filteredBatch[j];
          const res = batchResults[j];

          if (res.status === 'rejected') {
            console.error(`[Z2-Sched] Plan error ${sym}:`, res.reason?.message);
            this.stats.errors++;
            continue;
          }

          const plans = (res.value?.plans || []).filter(p => p.symbol && p.direction && p.direction !== 'SKIP');
          if (!plans.length) {
            console.log(`[Z2-Sched] SKIP: ${sym}`);
            continue;
          }

          for (const plan of plans) {
            await this._expirePlanForSymbol(plan.symbol);
            try {
              await this._saveUnifiedPlan(plan, res.value.confidence);
              totalSaved++;
            } catch (err) {
              console.error(`[Z2-Sched] Failed to save plan for ${plan.symbol}:`, err.message);
              this.stats.errors++;
            }
          }
        }
      }

      this.stats.skippedPlans += totalSkipped;
      if (totalSaved > 0 || totalSkipped > 0) {
        this.stats.unifiedPlans++;
        console.log(`[Z2-Sched] Unified cycle: saved=${totalSaved}, cached_skip=${totalSkipped}`);
      }

    } catch (err) {
      this.stats.errors++;
      console.error(`[Z2-Sched] Unified chain error:`, err.message);
    } finally {
      this._unifiedRunning = false;
    }
  }

  /** 특정 종목의 ACTIVE 플랜 유효시간 연장 (데이터 변화 없을 때) */
  async _extendPlanForSymbol(symbol) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `UPDATE z2_execution_plan
         SET valid_until = SYSTIMESTAMP + NUMTODSINTERVAL(:validMin, 'MINUTE')
         WHERE symbol = :sym AND status = 'ACTIVE'`,
        { sym: symbol, validMin: this.unifiedPlanValidMin },
        { autoCommit: true }
      );
      // 인메모리 캐시도 즉시 동기화 (DB↔캐시 불일치 방지)
      if (this.planCache) {
        this.planCache.extendPlans(symbol, Date.now() + this.unifiedPlanValidMin * 60 * 1000);
      }
    } catch (err) {
      console.error(`[Z2-Sched] Failed to extend plan for ${symbol}:`, err.message);
    } finally {
      await conn.close();
    }
  }

  /** 특정 종목의 기존 ACTIVE 플랜만 만료 처리 (새 플랜 저장 전) */
  async _expirePlanForSymbol(symbol) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `UPDATE z2_execution_plan SET status = 'EXPIRED'
         WHERE symbol = :sym AND status = 'ACTIVE'`,
        { sym: symbol },
        { autoCommit: true }
      );
    } catch (err) {
      console.error(`[Z2-Sched] Failed to expire plan for ${symbol}:`, err.message);
    } finally {
      await conn.close();
    }
  }

  /** 통합 플랜 DB 저장 */

  async _saveUnifiedPlan(plan, overallConfidence) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z2_execution_plan
         (symbol, valid_until, direction, entry_conditions, target_price, stop_price,
          stop_conditions, time_stop_min, confidence, reasoning, scenario_id, status)
         VALUES (:sym, SYSTIMESTAMP + NUMTODSINTERVAL(:validMin, 'MINUTE'), :dir, :entry, :target, :stopPrice,
                 :stop, :timeStop, :conf, :reasoning, :scenId, 'ACTIVE')`,
        {
          validMin: this.unifiedPlanValidMin,
          sym: plan.symbol,
          dir: plan.direction || 'LONG',
          entry: { type: oracledb.DB_TYPE_JSON, val: plan.entry_conditions || {} },
          target: plan.target_price || null,
          stopPrice: plan.stop_price || null,
          stop: { type: oracledb.DB_TYPE_JSON, val: plan.stop_conditions || {} },
          timeStop: plan.time_stop_min || 15,
          conf: Math.min(plan.confidence ?? plan.probability ?? overallConfidence, overallConfidence),
          reasoning: plan.reasoning || '',
          scenId: plan.id || 'unified',
        },
        { autoCommit: true }
      );
    } finally {
      await conn.close();
    }
  }

  // ══════════════════════════════════════════════
  // 레거시 모드 (심볼별 분리 — unifiedMode=false 시)
  // ══════════════════════════════════════════════

  async _runChain() {
    if (!this._running) return;
    this.stats.chains++;

    const targetSymbols = this.symbols.slice(0, this.topSymbolsForScenario);
    const results = await Promise.allSettled(
      targetSymbols.map(symbol => this._runChainForSymbol(symbol))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.stats.errors++;
        console.error(`[Z2-Sched] Chain error ${targetSymbols[i]}:`, r.reason?.message);
      }
    });
  }

  async _runChainForSymbol(symbol) {
    if (!this._running) return;
    const briefing = await getBriefing(symbol);
    if (!briefing || briefing.confidence < 0.4) return;

    const summaryText = briefing.summary || JSON.stringify(briefing);
    let embedding = null;
    try { embedding = await embed(summaryText); } catch (_) {}

    await this._saveAnalysis(symbol, 'briefing', briefing, 'cloud', embedding);
    this.stats.briefings++;
    console.log(`[Z2-Sched] Briefing ${symbol}: ${briefing.direction_bias || 'neutral'} (conf=${briefing.confidence})`);

    const eventCalendar = this.economicCalendar?.getNext24h() || [];
    const fearGreed = this.fearGreedCollector?.getData() || {};
    const stablecoin = this.stablecoinCollector?.getData() || {};
    const scenario = await getScenario(symbol, eventCalendar, fearGreed, stablecoin);
    if (!scenario || scenario.confidence < 0.5) return;

    await this._saveAnalysis(symbol, 'scenario', scenario, 'cloud');

    const scenarios = scenario.scenarios || [];
    const recommended = scenario.recommended_scenario;
    let planCount = 0;
    for (const s of scenarios) {
      const isRecommended = s.id === recommended;
      if (isRecommended) {
        if (s.probability < 0.2) continue;
        await this._savePlan(symbol, s, scenario.confidence, 30);
      } else {
        if (s.probability < 0.4) continue;
        await this._savePlan(symbol, s, scenario.confidence * 0.5, 15);
      }
      planCount++;
    }

    this.stats.scenarios++;
    console.log(`[Z2-Sched] Scenario ${symbol}: ${planCount} plans created (conf=${scenario.confidence})`);
  }

  // ── DB 저장 (공용) ──
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

  async _savePlan(symbol, scenario, overallConfidence, validMinutes = 30) {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(
        `INSERT INTO z2_execution_plan
         (symbol, valid_until, direction, entry_conditions, target_price, stop_price,
          stop_conditions, time_stop_min, confidence, reasoning, scenario_id, status)
         VALUES (:sym, SYSTIMESTAMP + NUMTODSINTERVAL(:validMin, 'MINUTE'), :dir, :entry, :target, :stopPrice,
                 :stop, :timeStop, :conf, :reasoning, :scenId, 'ACTIVE')`,
        {
          validMin: validMinutes,
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
