/**
 * @module Market Routes
 * @description 차트 데이터, 시장 지표, LLM 분석, 시장 상태 관련 API 엔드포인트를 정의한다.
 *
 * @zone api
 * @dependencies db.js, query-loader.js, api-utils.js
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';
import { toRow } from './api-utils.js';
import { logger } from '../shared/logger.js';

const queries = loadQueries('api/market');

export default async function marketRoutes(fastify, options) {
  const { server } = options;

  // ── Klines (차트용) ──
  fastify.get('/api/klines/:symbol', async (req, reply) => {
    const { symbol } = req.params;
    const { timeframe = '1m', limit = '120' } = req.query;
    const lim = Math.min(parseInt(limit) || 120, 500);
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(
        queries.getKlines,
        { symbol, tf: timeframe, lim },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const rows = await Promise.all(result.rows.map(toRow));
      return rows.reverse();
    } catch (err) {
      logger.error(`[API] Failed to fetch klines for ${symbol}: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── 1초봉 (RingBuffer raw trades → 1s OHLCV 집계) ──
  fastify.get('/api/candles-1s/:symbol', async (req, reply) => {
    try {
      const { symbol } = req.params;
      const seconds = Math.min(parseInt(req.query.seconds) || 300, 3600);
      const trades = server.ringBuffer?.getTradesWindow(symbol, seconds) || [];
      const currentPrice = server.ringBuffer?.getLastPrice(symbol) || null;

      if (!trades.length) return { symbol, currentPrice, candles: [] };

      const buckets = new Map();
      for (const t of trades) {
        const sec = Math.floor(t.ts);
        let b = buckets.get(sec);
        if (!b) {
          b = { time: sec, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 };
          buckets.set(sec, b);
        }
        if (t.price > b.high) b.high = t.price;
        if (t.price < b.low) b.low = t.price;
        b.close = t.price;
        b.volume += t.qty;
      }

      const keys = [...buckets.keys()].sort((a, b) => a - b);
      const candles = [];
      let prevClose = buckets.get(keys[0]).open;

      for (let sec = keys[0]; sec <= keys[keys.length - 1]; sec++) {
        const b = buckets.get(sec);
        if (b) {
          candles.push(b);
          prevClose = b.close;
        } else {
          candles.push({ time: sec, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
        }
      }
      return { symbol, currentPrice, candles };
    } catch (err) {
      logger.error(`[API] Failed to fetch 1s candles: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // ── Derivatives (파생상품 데이터) ──
  fastify.get('/api/derivatives/:symbol', async (req, reply) => {
    const { symbol } = req.params;
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(
        queries.getDerivatives,
        { symbol },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Failed to fetch derivatives for ${symbol}: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── LLM Analysis (브리핑/센티먼트) ──
  fastify.get('/api/llm-analysis/:symbol', async (req, reply) => {
    const { symbol } = req.params;
    const { type = 'briefing', limit = '10' } = req.query;
    const lim = Math.min(parseInt(limit) || 10, 50);
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(
        queries.getLlmAnalysis,
        { symbol, type, lim },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Failed to fetch LLM analysis for ${symbol}: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Market States (벡터 검색) ──
  fastify.get('/api/market-states/:symbol', async (req, reply) => {
    const { symbol } = req.params;
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(
        queries.getMarketStates,
        { symbol },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return await Promise.all(result.rows.map(toRow));
    } catch (err) {
      logger.error(`[API] Failed to fetch market states for ${symbol}: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });
}
