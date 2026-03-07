/**
 * fetchPrices.js
 * Batch-fetches Last Traded Prices (LTP) from NSE index APIs
 * and updates stocks_master.last_price + price_updated_at.
 *
 * Strategy:
 *   1. Fetch multiple NSE indices (each returns ~50-750 stocks with lastPrice)
 *   2. Merge all results, deduplicate by symbol
 *   3. Batch-upsert last_price into stocks_master
 *
 * Runs at market hours: 9:15 AM - 3:45 PM IST, every 5 minutes.
 */

const axios = require('axios');
const { pool } = require('../lib/db');

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// NSE indices to fetch prices from (covers ~1500 stocks)
const INDICES = [
  'NIFTY 500',
  'NIFTY TOTAL MARKET',
  'NIFTY MIDCAP 150',
  'NIFTY SMALLCAP 250',
  'NIFTY MICROCAP 250',
];

async function getNSECookies() {
  const session = await axios.get('https://www.nseindia.com', {
    headers: { ...NSE_HEADERS, Accept: 'text/html' },
    timeout: 10000,
  });
  return (session.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

async function fetchIndexPrices(indexName, cookies) {
  const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(indexName)}`;
  const res = await axios.get(url, {
    headers: { ...NSE_HEADERS, Cookie: cookies },
    timeout: 15000,
  });

  return (res.data?.data || [])
    .filter(s => s.symbol && s.lastPrice != null && s.symbol !== indexName)
    .map(s => ({
      symbol: s.symbol,
      lastPrice: parseFloat(s.lastPrice) || null,
      change: parseFloat(s.change) || 0,
      pChange: parseFloat(s.pChange) || 0,
    }))
    .filter(s => s.lastPrice !== null);
}

async function fetchPrices() {
  console.log('[Prices] Starting LTP fetch...');
  const startTime = Date.now();

  let cookies;
  try {
    cookies = await getNSECookies();
  } catch (err) {
    console.error('[Prices] Failed to get NSE session:', err.message);
    return { success: false, error: err.message };
  }

  await sleep(2000);

  // Fetch all indices
  const priceMap = new Map(); // symbol -> { lastPrice, change, pChange }

  for (const index of INDICES) {
    try {
      console.log(`[Prices] Fetching ${index}...`);
      const stocks = await fetchIndexPrices(index, cookies);
      for (const s of stocks) {
        if (!priceMap.has(s.symbol)) {
          priceMap.set(s.symbol, s);
        }
      }
      console.log(`[Prices] ${index}: ${stocks.length} prices`);
      await sleep(1500); // Rate limit between requests
    } catch (err) {
      console.warn(`[Prices] ${index} failed: ${err.message}`);
    }
  }

  if (priceMap.size === 0) {
    console.error('[Prices] No prices fetched from any index');
    return { success: false, error: 'No prices fetched' };
  }

  console.log(`[Prices] Total unique prices: ${priceMap.size}`);

  // Batch update stocks_master using multi-row INSERT ON DUPLICATE KEY UPDATE
  const now = new Date();
  const updates = Array.from(priceMap.values());

  const batchSize = 200;
  let totalUpdated = 0;

  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [s.symbol, s.lastPrice, now]);

    try {
      await pool.query(
        `INSERT INTO stocks_master (symbol, last_price, price_updated_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           last_price = VALUES(last_price),
           price_updated_at = VALUES(price_updated_at)`,
        values
      );
      totalUpdated += batch.length;
    } catch (err) {
      console.error(`[Prices] Upsert batch ${Math.floor(i / batchSize) + 1} error:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Prices] Updated ${totalUpdated} stock prices in ${elapsed}s`);

  return { success: true, updated: totalUpdated, elapsed };
}

module.exports = { fetchPrices };
