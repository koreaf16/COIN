import { config } from './src/shared/config.js';
import { CoinglassCollector } from './src/z0-raw/coinglass-collector.js';
import { OnchainCollector } from './src/z0-raw/onchain-collector.js';
import { initDb } from './src/shared/db.js';

async function main() {
  await initDb();
  console.log("Testing Coinglass...");
  const cg = new CoinglassCollector(['BTCUSDT']);
  try {
    await cg._fetchAllHeatmap();
    console.log("Coinglass heatmap stats:", cg.stats);
  } catch (e) {
    console.error("Coinglass Error:", e);
  }

  console.log("Testing CryptoQuant...");
  const cq = new OnchainCollector();
  try {
    await cq._fetchAll();
    console.log("CryptoQuant stats:", cq.stats);
  } catch (e) {
    console.error("CryptoQuant Error:", e);
  }
  process.exit(0);
}
main().catch(console.error);