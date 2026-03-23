import { config } from './src/shared/config.js';

const API_KEY = config.coinglass.apiKey;
const BASE_URL = 'https://open-api-v3.coinglass.com/api';

async function test() {
  const url = `${BASE_URL}/futures/liquidation/aggregated-heatmap?symbol=BTC&range=24h`;
  const res = await fetch(url, {
    headers: { 'CG-API-KEY': API_KEY },
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Data keys:", Object.keys(data));
  console.log("Success:", data.success);
  console.log("Msg:", data.msg);
  if (data.data) {
    console.log("Is array?", Array.isArray(data.data));
    console.log("First item:", Array.isArray(data.data) ? data.data[0] : Object.keys(data.data));
  }
}
test().catch(console.error);