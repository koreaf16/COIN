/**
 * @module 수집기 통합 테스트
 * @description Coinglass 및 온체인 수집기의 동작을 테스트한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ APIs     │ ──→ │ Collector│ ──→ │ Oracle   │
 * │          │     │ Test     │     │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/test
 * @dependencies db.js, coinglass-collector.js, onchain-collector.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { config } from '../../src/shared/config.js';
import { CoinglassCollector } from '../../src/z0-raw/coinglass-collector.js';
import { OnchainCollector } from '../../src/z0-raw/onchain-collector.js';
import { initDb } from '../../src/shared/db.js';

async function main() {
  try {
    await initDb();
    logger.info("Testing Coinglass...");
    const cg = new CoinglassCollector(['BTCUSDT']);
    try {
      await cg._fetchAllHeatmap();
      logger.info(`Coinglass heatmap stats: ${JSON.stringify(cg.stats)}`);
    } catch (e) {
      logger.error("Coinglass Error:", e);
    }

    logger.info("Testing CryptoQuant...");
    const cq = new OnchainCollector();
    try {
      await cq._fetchAll();
      logger.info(`CryptoQuant stats: ${JSON.stringify(cq.stats)}`);
    } catch (e) {
      logger.error("CryptoQuant Error:", e);
    }
  } catch (e) {
    logger.error("Error in test_collectors:", e);
  } finally {
    process.exit(0);
  }
}
main().catch(logger.error);
