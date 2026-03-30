import assert from 'node:assert/strict';

import { EventMonitor } from '../../src/z2-intel/event-monitor-fixed.js';

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const newsCollector = {
    items: [],
    getRecentNews(count = 20) {
      return this.items.slice(0, count);
    },
  };

  const ringBuffer = {
    getTradesWindow(symbol) {
      if (symbol !== 'BTCUSDT') return [];
      return [
        { price: 100, ts: now - 299 },
        { price: 104, ts: now },
      ];
    },
    getLastPrice() {
      return 104;
    },
  };

  const monitor = new EventMonitor(newsCollector, ringBuffer, {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    priceShockCooldownSec: 300,
  });

  const handled = [];
  monitor._handleEvent = async (type, text, symbol) => {
    handled.push({ type, text, symbol });
  };

  newsCollector.items = [
    { title: 'ETF approved for ETH market', tickers: 'ETHUSDT', ts: now - 5 },
    { title: 'normal update', tickers: 'BTCUSDT', ts: now - 10 },
    { title: 'normal update 2', tickers: 'BTCUSDT', ts: now - 20 },
    { title: 'normal update 3', tickers: 'BTCUSDT', ts: now - 30 },
    { title: 'normal update 4', tickers: 'BTCUSDT', ts: now - 40 },
  ];

  await monitor._check();
  assert.equal(handled.some(item => item.type === 'news' && item.symbol === 'ETHUSDT'), true);
  assert.equal(handled.some(item => item.type === 'price_shock' && item.symbol === 'BTCUSDT'), true);

  newsCollector.items = [
    { title: 'SEC emergency action on BTC', tickers: 'BTCUSDT', ts: now },
    newsCollector.items[0],
    newsCollector.items[1],
    newsCollector.items[2],
    newsCollector.items[3],
  ];

  const newsCountBefore = handled.filter(item => item.type === 'news').length;
  await monitor._check();
  const newsCountAfter = handled.filter(item => item.type === 'news').length;
  assert.equal(newsCountAfter, newsCountBefore + 1);

  console.log('event-monitor-smoke ok');
}

main();
