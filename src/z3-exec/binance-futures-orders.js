/**
 * @module 바이낸스 선물 주문 관리
 * @description Binance USDT-M Futures API를 통한 주문 생성, 취소 및 조회를 담당한다.
 *
 * ┌──────────────┐      ┌──────────────┐
 * │ Binance      │ ───→ │ Binance      │
 * │ Orders       │      │ API          │
 * └──────────────┘      └──────────────┘
 *
 * @zone z3-exec
 * @dependencies binance-futures-market.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { BinanceFuturesMarket } from "./binance-futures-market.js";

export class BinanceFuturesOrders extends BinanceFuturesMarket {
  /** 시장가 진입 */
  async marketOrder(symbol, side, qty) {
    try {
      const roundedQty = this._roundQty(symbol, qty);
      if (!roundedQty || roundedQty <= 0) {
        throw new Error(`Invalid qty for ${symbol}: ${qty} → ${roundedQty}`);
      }

      const result = await this._signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity: roundedQty,
      });

      return {
        orderId: result.orderId,
        symbol: result.symbol,
        side: result.side,
        type: result.type,
        status: result.status,
        avgPrice: parseFloat(result.avgPrice || 0),
        executedQty: parseFloat(result.executedQty || 0),
        cumQuote: parseFloat(result.cumQuote || 0),
      };
    } catch (err) {
      logger.error(`[Binance] marketOrder error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 지정가 주문 */
  async limitOrder(symbol, side, qty, price, timeInForce = 'GTC') {
    try {
      const roundedQty = this._roundQty(symbol, qty);
      const roundedPrice = this._roundPrice(symbol, price);

      const result = await this._signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'LIMIT',
        quantity: roundedQty,
        price: roundedPrice,
        timeInForce,
      });

      return {
        orderId: result.orderId,
        symbol: result.symbol,
        side: result.side,
        status: result.status,
        price: parseFloat(result.price),
      };
    } catch (err) {
      logger.error(`[Binance] limitOrder error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 스탑마켓 (안전망 손절) */
  async stopMarketOrder(symbol, side, qty, stopPrice) {
    try {
      const roundedQty = this._roundQty(symbol, qty);
      const roundedStop = this._roundPrice(symbol, stopPrice);

      const result = await this._signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'STOP_MARKET',
        quantity: roundedQty,
        stopPrice: roundedStop,
        closePosition: 'false',
        reduceOnly: 'true',
      });

      return {
        orderId: result.orderId,
        symbol: result.symbol,
        side: result.side,
        status: result.status,
        stopPrice: parseFloat(result.stopPrice),
      };
    } catch (err) {
      logger.error(`[Binance] stopMarketOrder error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 테이크프로핏 마켓 */
  async takeProfitMarketOrder(symbol, side, qty, stopPrice) {
    try {
      const roundedQty = this._roundQty(symbol, qty);
      const roundedStop = this._roundPrice(symbol, stopPrice);

      const result = await this._signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'TAKE_PROFIT_MARKET',
        quantity: roundedQty,
        stopPrice: roundedStop,
        closePosition: 'false',
        reduceOnly: 'true',
      });

      return { orderId: result.orderId, status: result.status };
    } catch (err) {
      logger.error(`[Binance] takeProfitMarketOrder error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 포지션 전량 청산 */
  async closePosition(symbol, side, qty) {
    try {
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
      const roundedQty = this._roundQty(symbol, qty);
      if (!roundedQty || roundedQty <= 0) {
        throw new Error(`Invalid close qty for ${symbol}: ${qty} → ${roundedQty}`);
      }
      const result = await this._signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: roundedQty,
        reduceOnly: 'true',
      });
      return {
        orderId: result.orderId,
        symbol: result.symbol,
        side: result.side,
        status: result.status,
        avgPrice: parseFloat(result.avgPrice || 0),
        executedQty: parseFloat(result.executedQty || 0),
      };
    } catch (err) {
      logger.error(`[Binance] closePosition error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 미체결 주문 취소 */
  async cancelAllOrders(symbol) {
    try {
      return await this._signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
    } catch (err) {
      logger.error(`[Binance] cancelAllOrders error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 주문 상태 조회 */
  async getOrder(symbol, orderId) {
    try {
      const result = await this._signedRequest('GET', '/fapi/v1/order', { symbol, orderId });
      return {
        orderId: result.orderId,
        status: result.status,
        avgPrice: parseFloat(result.avgPrice || 0),
        executedQty: parseFloat(result.executedQty || 0),
      };
    } catch (err) {
      logger.error(`[Binance] getOrder error ${symbol}: ${err.message}`);
      throw err;
    }
  }

  /** 미체결 주문 목록 */
  async getOpenOrders(symbol = null) {
    try {
      const params = symbol ? { symbol } : {};
      return await this._signedRequest('GET', '/fapi/v1/openOrders', params);
    } catch (err) {
      logger.error(`[Binance] getOpenOrders error: ${err.message}`);
      throw err;
    }
  }

  /** 최근 체결 내역 조회 */
  async getUserTrades(symbol, limit = 10) {
    try {
      const result = await this._signedRequest('GET', '/fapi/v1/userTrades', { symbol, limit });
      return result.map(t => ({
        orderId: t.orderId,
        price: parseFloat(t.price),
        qty: parseFloat(t.qty),
        realizedPnl: parseFloat(t.realizedPnl),
        side: t.side,
        time: t.time,
      }));
    } catch (err) {
      logger.error(`[Binance] getUserTrades error ${symbol}: ${err.message}`);
      throw err;
    }
  }
}
