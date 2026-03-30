/**
 * @module 바이낸스 선물 클라이언트 (메인)
 * @description Binance USDT-M Futures API 클라이언트의 메인 클래스로, 초기화 및 전체 기능을 통합한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Executor     │ ───→ │ Binance      │ ───→ │ Binance      │
 * │ (Trade)      │      │ Client       │      │ API          │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *
 * @zone z3-exec
 * @dependencies binance-futures-orders.js, logger.js
 */

import { logger } from "../shared/logger.js";
import { BinanceFuturesOrders } from "./binance-futures-orders.js";

export class BinanceFuturesClient extends BinanceFuturesOrders {
  /** 서버 시작 시 1회 호출 — 심볼 정보 로드 */
  async init() {
    try {
      if (!this.apiKey) {
        logger.info('[Binance] No API key — exchange calls disabled');
        return;
      }
      await this._loadExchangeInfo();
      logger.info(`[Binance] Init complete (${this.testnet ? 'TESTNET' : 'MAINNET'}, ${this._symbolInfo.size} symbols)`);
    } catch (err) {
      logger.error(`[Binance] Init error: ${err.message}`);
    }
  }
}
