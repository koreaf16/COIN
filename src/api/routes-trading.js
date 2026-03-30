/**
 * @module Trading Routes
 * @description 포지션, 매매 계획, 시나리오 관련 API 엔드포인트를 정의한다.
 *
 * @zone api
 * @dependencies db.js, query-loader.js, api-utils.js
 */

import oracledb from 'oracledb';
import { getPool } from '../shared/db.js';
import { loadQueries } from '../shared/query-loader.js';
import { toRow, parseJsonField, buildStructureMonitor } from './api-utils.js';
import { logger } from '../shared/logger.js';
import { evaluateConditions, normalizeConditions, hasValidConditions } from '../z3-exec/condition-evaluator.js';

const queries = loadQueries('api/trading');

export default async function tradingRoutes(fastify, options) {
  const { server } = options;

  // ── Positions (오픈/클로즈) ──
  fastify.get('/api/positions', async (req, reply) => {
    const { status = 'OPEN' } = req.query;
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getPositions, { status }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rows = await Promise.all(result.rows.map(toRow));
      return rows.map(r => ({
        ...r,
        notional: r.qty != null && r.entry_price != null ? +(r.qty * r.entry_price).toFixed(2) : null,
      }));
    } catch (err) {
      logger.error(`[API] Failed to fetch positions: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Position Candles (거래 1초봉 데이터 조회) ──
  fastify.get('/api/positions/:id/candles', async (req, reply) => {
    const { id } = req.params;
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getPositionCandles, { id }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (!result.rows?.length) return reply.status(404).send({ error: 'Position not found' });

      const row = result.rows[0];
      let candles = [];
      if (row.CANDLE_DATA) {
        try {
          const rawData = typeof row.CANDLE_DATA === 'string' ? row.CANDLE_DATA : await row.CANDLE_DATA.getData();
          candles = JSON.parse(rawData);
        } catch (err) {
          logger.warn(`[API] Failed to parse candle data for position ${id}: ${err.message}`);
        }
      }

      return {
        id: row.ID,
        symbol: row.SYMBOL,
        direction: row.DIRECTION,
        entryPrice: row.ENTRY_PRICE ? parseFloat(row.ENTRY_PRICE) : null,
        entryTime: row.ENTRY_TIME instanceof Date ? Math.floor(row.ENTRY_TIME.getTime() / 1000) : null,
        exitPrice: row.EXIT_PRICE ? parseFloat(row.EXIT_PRICE) : null,
        exitTime: row.EXIT_TIME instanceof Date ? Math.floor(row.EXIT_TIME.getTime() / 1000) : null,
        targetPrice: row.TARGET_PRICE ? parseFloat(row.TARGET_PRICE) : null,
        safetyStop: row.SAFETY_STOP ? parseFloat(row.SAFETY_STOP) : null,
        candles,
      };
    } catch (err) {
      logger.error(`[API] Failed to fetch position candles: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Live Positions (Binance 우선 — executor 메타데이터로 보강) ──
  fastify.get('/api/positions/live', async (req, reply) => {
    try {
      const positions = [];
      let totalPnl = 0;
      const isLive = server.executor?.liveMode;

      if (isLive && server.executor?.binance) {
        const exchangePositions = await server.executor.getCachedPositions();
        for (const exPos of exchangePositions) {
          if (exPos.qty * exPos.markPrice < 0.01) continue;
          const currentPrice = server.ringBuffer?.getLastPrice(exPos.symbol) || exPos.markPrice;
          const currentData = server.ruleEngine ? await server.ruleEngine._getCurrentData(exPos.symbol) : { price: currentPrice };
          const pnlUsd = exPos.unrealizedPnl;
          const marginUsed = exPos.leverage ? exPos.qty * exPos.entryPrice / exPos.leverage : 0;
          const pnlPct = marginUsed > 0 ? (pnlUsd / marginUsed) * 100 : 0;

          const meta = [...(server.executor.activePositions?.values() || [])].find(p => p.symbol === exPos.symbol);
          const entryConditions = meta?.entryConditions || meta?.entryReasoning?.entryConditions || null;
          const safetyDir = exPos.side === 'LONG' ? -1 : 1;
          const defaultSafety = exPos.entryPrice * (1 + safetyDir * 0.04);
          const holdMs = meta?.entryTime ? Date.now() - meta.entryTime : 0;
          const holdMin = +(holdMs / 60000).toFixed(1);
          const tsMin = meta?.timeStopMin ?? 480;

          totalPnl += pnlUsd;
          positions.push({
            id: meta?.id || exPos.symbol,
            planId: meta?.planId || null,
            symbol: exPos.symbol,
            direction: exPos.side,
            entryPrice: exPos.entryPrice,
            currentPrice,
            qty: exPos.qty,
            leverage: exPos.leverage,
            notional: +(exPos.qty * exPos.entryPrice).toFixed(2),
            marginUsed: exPos.leverage ? +(exPos.qty * exPos.entryPrice / exPos.leverage).toFixed(2) : null,
            unrealizedPnlPct: +pnlPct.toFixed(3),
            unrealizedPnlUsd: +pnlUsd.toFixed(2),
            targetPrice: meta?.targetPrice ?? null,
            safetyStop: meta?.safetyStop ?? defaultSafety,
            timeStopMin: tsMin,
            holdTimeMin: holdMin,
            timeRemainingMin: +(tsMin - holdMin).toFixed(1),
            confidence: meta?.confidence ?? null,
            entryTime: meta ? new Date(meta.entryTime).toISOString() : null,
            liquidationPrice: exPos.liquidationPrice,
            structure: buildStructureMonitor({
              direction: exPos.side,
              confidence: meta?.confidence,
              entryConditions,
              currentData,
            }),
          });
        }
      } else if (server.executor?.activePositions) {
        for (const [posId, pos] of server.executor.activePositions) {
          const currentPrice = server.ringBuffer?.getLastPrice(pos.symbol) || pos.entryPrice;
          const currentData = server.ruleEngine ? await server.ruleEngine._getCurrentData(pos.symbol) : { price: currentPrice };
          const entryConditions = pos.entryConditions || pos.entryReasoning?.entryConditions || null;
          const dir = pos.direction === 'LONG' ? 1 : -1;
          const pnlUsd = dir * (currentPrice - pos.entryPrice) * pos.qty;
          const marginUsed = pos.qty * pos.entryPrice / (server.executor?.leverage || 5);
          const pnlPct = marginUsed > 0 ? (pnlUsd / marginUsed) * 100 : 0;
          const holdTimeMin = (Date.now() - pos.entryTime) / 60000;

          totalPnl += pnlUsd;
          positions.push({
            id: posId,
            planId: pos.planId,
            symbol: pos.symbol,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            currentPrice,
            qty: pos.qty,
            notional: pos.qty != null ? +(pos.qty * pos.entryPrice).toFixed(2) : null,
            unrealizedPnlPct: +pnlPct.toFixed(3),
            unrealizedPnlUsd: +pnlUsd.toFixed(2),
            targetPrice: pos.targetPrice,
            safetyStop: pos.safetyStop,
            timeStopMin: pos.timeStopMin,
            holdTimeMin: +holdTimeMin.toFixed(1),
            timeRemainingMin: pos.timeStopMin ? +(pos.timeStopMin - holdTimeMin).toFixed(1) : null,
            confidence: pos.confidence,
            entryTime: new Date(pos.entryTime).toISOString(),
            structure: buildStructureMonitor({
              direction: pos.direction,
              confidence: pos.confidence,
              entryConditions,
              currentData,
            }),
          });
        }
      }
      return { positions, count: positions.length, totalUnrealizedPnl: +totalPnl.toFixed(2) };
    } catch (err) {
      logger.error(`[API] Failed to fetch live positions: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // ── Plan Status (조건별 충족 여부) ──
  fastify.get('/api/plans/status', async (req, reply) => {
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.expirePlans, {}, { autoCommit: true });
      const result = await conn.execute(queries.getActivePlansForStatus, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

      const plans = [];
      for (const row of (result.rows || [])) {
        const symbol = row.SYMBOL;
        const entryConditions = parseJsonField(row.ENTRY_CONDITIONS);

        const validUntil = row.VALID_UNTIL instanceof Date ? row.VALID_UNTIL : new Date(row.VALID_UNTIL);
        const timeRemainingMin = (validUntil.getTime() - Date.now()) / 60000;
        if (timeRemainingMin <= 0) continue;

        const currentData = server.ruleEngine ? await server.ruleEngine._getCurrentData(symbol) : { price: server.ringBuffer?.getLastPrice(symbol) };
        const evalResult = evaluateConditions(entryConditions, currentData, row.DIRECTION);
        const entryPrice = entryConditions?.price?.value || null;
        const currentPrice = currentData?.price || server.ringBuffer?.getLastPrice(symbol) || null;

        plans.push({
          id: row.ID,
          symbol,
          direction: row.DIRECTION,
          entryPrice,
          currentPrice,
          targetPrice: row.TARGET_PRICE,
          confidence: row.CONFIDENCE,
          reasoning: row.REASONING || '',
          createdAt: row.CREATED_AT instanceof Date ? row.CREATED_AT.toISOString() : row.CREATED_AT,
          validUntil: validUntil.toISOString(),
          timeRemainingMin: +timeRemainingMin.toFixed(1),
          conditions: evalResult.details,
          conditionsMet: evalResult.details.filter(d => d.met).length,
          conditionsTotal: evalResult.details.length,
          structure: buildStructureMonitor({
            direction: row.DIRECTION,
            confidence: row.CONFIDENCE,
            entryConditions,
            currentData,
          }),
        });
      }
      plans.sort((a, b) => (b.conditionsMet / (b.conditionsTotal || 1)) - (a.conditionsMet / (a.conditionsTotal || 1)));
      return { plans };
    } catch (err) {
      logger.error(`[API] Failed to fetch plan status: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Execution Plans ──
  fastify.get('/api/plans', async (req, reply) => {
    const { status = 'ACTIVE' } = req.query;
    const conn = await getPool().getConnection();
    try {
      const sql = status === 'ACTIVE' ? queries.getPlansActive : queries.getPlans;
      const result = await conn.execute(sql, { status }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rows = await Promise.all(result.rows.map(toRow));
      return rows.map((row) => {
        const entryConditions = parseJsonField(row.entry_conditions);
        return {
          ...row,
          entry_conditions: entryConditions,
          structure: buildStructureMonitor({
            direction: row.direction,
            confidence: row.confidence,
            entryConditions,
          }),
        };
      });
    } catch (err) {
      logger.error(`[API] Failed to fetch plans: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Plan 상세 조회 ──
  fastify.get('/api/plans/:id', async (req, reply) => {
    const { id } = req.params;
    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.getPlanById, { id: parseInt(id, 10) }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (!result.rows?.length) return reply.status(404).send({ error: 'Not found' });
      const row = (await Promise.all(result.rows.map(toRow)))[0];
      const entryConditions = parseJsonField(row.entry_conditions);
      const stopConditions = parseJsonField(row.stop_conditions);
      const currentData = row.status === 'ACTIVE' && server.ruleEngine
        ? await server.ruleEngine._getCurrentData(row.symbol)
        : null;
      return {
        ...row,
        entry_conditions: entryConditions,
        stop_conditions: stopConditions,
        structure: buildStructureMonitor({
          direction: row.direction,
          confidence: row.confidence,
          entryConditions,
          currentData,
        }),
      };
    } catch (err) {
      logger.error(`[API] Failed to fetch plan detail: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Scenario 저장 API ──
  fastify.post('/api/scenarios', async (req, reply) => {
    const { symbol, direction, entryConditions, targetPrice, stopPrice, stopConditions, timeStopMin, confidence, reasoning } = req.body;
    const normalizedEntry = normalizeConditions(entryConditions);
    let normalizedStop = normalizeConditions(stopConditions);
    if (!hasValidConditions(normalizedEntry)) {
      return reply.status(400).send({ error: 'Invalid entryConditions' });
    }
    if (!hasValidConditions(normalizedStop) && stopPrice != null) {
      normalizedStop = direction === 'LONG'
        ? { price: { op: '<=', value: stopPrice } }
        : { price: { op: '>=', value: stopPrice } };
    }

    const conn = await getPool().getConnection();
    try {
      const result = await conn.execute(queries.insertPlan, {
        sym: symbol, dir: direction,
        entry: { type: oracledb.DB_TYPE_JSON, val: normalizedEntry || {} },
        target: targetPrice ?? null,
        stopPrice: stopPrice ?? null,
        stop: { type: oracledb.DB_TYPE_JSON, val: normalizedStop || {} },
        ts: timeStopMin || 480,
        conf: confidence ?? 0.5,
        reason: reasoning || '',
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }, { autoCommit: true });
      return { ok: true, id: result.outBinds.id[0] };
    } catch (err) {
      logger.error(`[API] Failed to save scenario: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  // ── Plan 상태 변경 / 삭제 ──
  fastify.post('/api/plans/:id/status', async (req, reply) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!['ACTIVE', 'EXPIRED', 'FAILED', 'CANCELLED', 'TRIGGERED'].includes(status)) {
      return reply.status(400).send({ error: 'Invalid status' });
    }
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.updatePlanStatus, { id: parseInt(id), status }, { autoCommit: true });
      return { ok: true, id: parseInt(id), status };
    } catch (err) {
      logger.error(`[API] Failed to update plan status: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });

  fastify.post('/api/plans/:id/delete', async (req, reply) => {
    const { id } = req.params;
    const conn = await getPool().getConnection();
    try {
      await conn.execute(queries.deletePlan, { id: parseInt(id) }, { autoCommit: true });
      return { ok: true, deleted: parseInt(id) };
    } catch (err) {
      logger.error(`[API] Failed to delete plan: ${err.message}`);
      reply.status(500).send({ error: 'Internal Server Error' });
    } finally {
      await conn.close();
    }
  });
}
