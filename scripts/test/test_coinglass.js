/**
 * @module Coinglass API 테스트
 * @description Coinglass API 연결 및 데이터 수신을 테스트한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Coinglass│ ──→ │ Test     │ ──→ │ Logger   │
 * │ API      │     │ Script   │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/test
 * @dependencies config.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { config } from '../../src/shared/config.js';

const API_KEY = config.coinglass?.apiKey;
const BASE_URL = 'https://open-api-v3.coinglass.com/api';

async function test() {
  try {
    if (!API_KEY) {
      logger.error("Coinglass API key not found in config");
      return;
    }
    const url = `${BASE_URL}/futures/liquidation/aggregated-heatmap?symbol=BTC&range=24h`;
    const res = await fetch(url, {
      headers: { 'CG-API-KEY': API_KEY },
    });
    logger.info(`Status: ${res.status}`);
    const data = await res.json();
    logger.info(`Data keys: ${Object.keys(data)}`);
    logger.info(`Success: ${data.success}`);
    logger.info(`Msg: ${data.msg}`);
    if (data.data) {
      logger.info(`Is array? ${Array.isArray(data.data)}`);
      logger.info(`First item: ${Array.isArray(data.data) ? data.data[0] : Object.keys(data.data)}`);
    }
  } catch (e) {
    logger.error("Error in test_coinglass:", e);
  }
}
test().catch(logger.error);
