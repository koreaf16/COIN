/**
 * @module System Routes
 * @description 시스템 상태, 설정, 로그, 매크로, 대시보드 요약 관련 API 엔드포인트를 정의한다.
 *
 * @zone api
 * @dependencies db.js, query-loader.js, api-utils.js, config.js
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';
import { toRow, extractCurrentStructure } from './api-utils.js';
import { logger } from '../shared/logger.js';
import { config } from '../shared/config.js';

const queries = loadQueries('api/system');

export default async function systemRoutes(fastify, options) {
  const { server } = options;

  // ── Dashboard (메인 대시보드 데이터) ──
  fastify.get('/api/dashboard', async (req, reply) => {
    try {
      const symbols = [];
      for (const s of config.tradingSymbols) {
        const price = server.ringBuffer?.getLastPrice(s);
        if (price) {
          const kline = server.ringBuffer.getLastKline(s, '1h');
          const structure = server.ruleEngine?._buildSwingContext?.(s, price) || {};
          symbols.push({
            symbol: s,
            price,
            change24h: kline ? ((price - kline.open) / kline.open) * 100 : 0,
            high24h: kline?.high || price,
            low24h: kline?.low || price,
            structure: extractCurrentStructure(structure),
          });
        }
      }
      return {
        symbols,
        stats: server.ruleEngine?.getStats() || { checkCount: 0, signalCount: 0, activePlans: 0 },
        execution: server.executor?.getStats() || { signals: 0, entries: 0, exits: 0, balance: 10000, mode: 'SIM' },
        macro: server.macroCollector?.getData() || {},
        macroRegime: server.macroCollector?.getRegime() || 'neutral',
        uptime: process.uptime(),
      };
    } catch (err) {
      logger.error(`[API] Dashboard error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // ── Health ──
  fastify.get('/api/health', async () => ({
    status: 'ok',
    version: 'v2-5zone',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // ── Performance ──
  fastify.get('/api/performance', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getPerformance, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Performance fetch error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Macro Data ──
  fastify.get('/api/macro', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const indicators = ['DXY', 'VIX', 'US10Y', 'NQ_FUTURE', 'COINBASE_PREMIUM'];
      const data = {};
      for (const ind of indicators) {
        const result = await conn.execute(queries.getLatestMacro, { ind });
        if (result.rows?.length) {
          data[ind] = { value: result.rows[0][0], ts: result.rows[0][1] };
        }
      }
      data.regime = server.macroCollector?.getRegime() || 'neutral';
      return data;
    } catch (err) {
      logger.error(`[API] Macro fetch error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Economic Calendar ──
  fastify.get('/api/economic-calendar', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getEconomicCalendar, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Economic calendar error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Fear & Greed ──
  fastify.get('/api/fear-greed', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getFearGreed, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Fear-Greed error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Stablecoin Supply ──
  fastify.get('/api/stablecoin', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getStablecoinSupply, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Stablecoin fetch error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Settings CRUD ──
  fastify.get('/api/settings', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getSettings, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Settings fetch error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  fastify.put('/api/settings/:key', async (req, reply) => {
    const { key } = req.params;
    const { value } = req.body;
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.updateSetting, { val: String(value), key }, { autoCommit: true });
      return { ok: true, key, value };
    } catch (err) {
      logger.error(`[API] Settings update error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Realtime Data Monitor ──
  fastify.get('/api/realtime/z0-summary', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      const summary = {};
      const targetQueries = [
        { key: 'ohlcv', q: queries.getZ0SummaryOhlcv },
        { key: 'derivatives', q: queries.getZ0SummaryDerivatives },
        { key: 'liquidations', q: queries.getZ0SummaryLiquidations },
        { key: 'macro', q: queries.getZ0SummaryMacro },
        { key: 'news', q: queries.getZ0SummaryNews },
      ];
      for (const t of targetQueries) {
        try {
          const r = await conn.execute(t.q, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
          const row = r.rows?.[0] || {};
          summary[t.key] = { count: row.CNT || 0, latest: row.LATEST, oldest: row.OLDEST };
        } catch { summary[t.key] = { count: 0, latest: null, oldest: null }; }
      }
      summary.ringBuffer = {
        tradeCount: server.ringBuffer?.stats?.tradeCount || 0,
        klineCount: server.ringBuffer?.stats?.klineCount || 0,
        depthCount: server.ringBuffer?.stats?.depthCount || 0,
      };
      return summary;
    } finally { await conn.close(); }
  });

  fastify.get('/api/realtime/z0-recent', async (req, reply) => {
    const { table = 'ohlcv', symbol, limit = '20' } = req.query;
    const lim = Math.min(parseInt(limit) || 20, 100);
    const conn = await getPool().getConnection();
    try {
      let sql, params = { lim };
      if (table === 'ohlcv') {
        sql = symbol ? queries.getZ0RecentOhlcvBySymbol : queries.getZ0RecentOhlcv;
        if (symbol) params.sym = symbol;
      } else if (table === 'derivatives') {
        sql = symbol ? queries.getZ0RecentDerivativesBySymbol : queries.getZ0RecentDerivatives;
        if (symbol) params.sym = symbol;
      } else if (table === 'liquidations') {
        sql = symbol ? queries.getZ0RecentLiquidationsBySymbol : queries.getZ0RecentLiquidations;
        if (symbol) params.sym = symbol;
      } else if (table === 'macro') {
        sql = queries.getZ0RecentMacro;
      } else if (table === 'news') {
        sql = queries.getZ0RecentNews;
      } else { return []; }

      const result = await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Realtime Z0 recent error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally { await conn.close(); }
  });

  fastify.get('/api/realtime/z2-recent', async (req, reply) => {
    const { type, limit = '20' } = req.query;
    const lim = Math.min(parseInt(limit) || 20, 100);
    const conn = await getPool().getConnection();
    try {
      const sql = type ? queries.getZ2RecentLlmAnalysisByType : queries.getZ2RecentLlmAnalysis;
      const params = type ? { type, lim } : { lim };
      const result = await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Realtime Z2 recent error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally { await conn.close(); }
  });

  fastify.get('/api/realtime/z2-detail/:id', async (req, reply) => {
    const { id } = req.params;
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getZ2LlmAnalysisDetail, { id: parseInt(id) }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (!result.rows?.length) return reply.status(404).send({ error: 'Not found' });
      return await toRow(result.rows[0]);
    } catch (err) {
      logger.error(`[API] Realtime Z2 detail error: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally { await conn.close(); }
  });

  // ── System Status ──
  fastify.get('/api/system-status', async () => ({
    oracleDb: 'connected',
    binanceWs: server.ringBuffer?.stats?.tradeCount > 0 ? 'connected' : 'disconnected',
    symbolCount: config.tradingSymbols.length,
    symbolsCore: config.tradingSymbolsCore,
    symbolsFlex: config.tradingSymbolsFlex,
    tradeCount: server.ringBuffer?.stats?.tradeCount || 0,
    macroRegime: server.macroCollector?.getRegime() || 'neutral',
    ruleEngine: server.ruleEngine?.getStats() || {},
    executor: server.executor?.getStats() || {},
    symbolRotator: global._symbolRotator?.getStatus() || null,
    uptime: process.uptime(),
    mode: server.executor?.getStats()?.mode || 'SIM',
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  }));

  // ── Logs ──
  fastify.get('/api/logs', async (req) => {
    const { level, limit = '100' } = req.query;
    let logs = server._logBuffer || [];
    if (level && level !== 'all') logs = logs.filter(l => l.level === level);
    return logs.slice(-parseInt(limit));
  });

  // ── LLM 테스트 (Python 프록시) ──
  const LLM_URL = config.llm.pythonUrl;
  fastify.get('/api/llm-status', async () => {
    try {
      const res = await fetch(`${LLM_URL}/api/llm-status`, { signal: AbortSignal.timeout(5000) });
      return res.ok ? res.json() : { error: `LLM server ${res.status}` };
    } catch (err) { return { error: 'LLM server not running', detail: err.message }; }
  });

  fastify.get('/api/llm-active', async () => {
    try {
      const res = await fetch(`${LLM_URL}/api/llm-active`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? res.json() : { calls: [] };
    } catch { return { calls: [] }; }
  });

  fastify.post('/api/test-llm', async (req, reply) => {
    try {
      const res = await fetch(`${LLM_URL}/api/test-llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(310000),
      });
      return res.ok ? res.json() : { error: `LLM server ${res.status}` };
    } catch (err) { return { error: 'LLM test failed', detail: err.message }; }
  });
}
