/**
 * fetchPrices.js
 * Batch-fetches Last Traded Prices (LTP) from NSE index APIs
 * and updates stocks_master.last_price + price_updated_at.
 *
 * Strategy:
 *   1. Use curl (different TLS/JA3 fingerprint — bypasses Akamai on hosting IPs)
 *   2. Fall back to axios if curl fails
 *   3. Fetch multiple NSE indices (each returns ~50-750 stocks with lastPrice)
 *   4. Merge all results, deduplicate by symbol
 *   5. Batch-upsert last_price into stocks_master
 *
 * Runs at market hours: 9:15 AM - 3:45 PM IST, every 5 minutes.
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const axios = require('axios');
const { pool } = require('../lib/db');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// NSE indices to fetch prices from (covers ~1500 stocks)
const INDICES = [
  'NIFTY 500',
  'NIFTY TOTAL MARKET',
  'NIFTY MIDCAP 150',
  'NIFTY SMALLCAP 250',
  'NIFTY MICROCAP 250',
];

// ─── Strategy 1: curl-based fetch (bypasses Akamai TLS fingerprinting) ───────

async function fetchIndexViaCurl(indexName, cookieFile) {
  const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(indexName)}`;

  const raw = execSync(
    `curl -s -L -b "${cookieFile}" --max-time 30 --compressed ` +
    `-H "User-Agent: ${UA}" ` +
    `-H "Accept: application/json, text/javascript, */*; q=0.01" ` +
    `-H "Accept-Language: en-US,en;q=0.9" ` +
    `-H "Accept-Encoding: gzip, deflate, br" ` +
    `-H "Connection: keep-alive" ` +
    `-H "Referer: https://www.nseindia.com/market-data/live-equity-market" ` +
    `-H "Sec-Fetch-Dest: empty" ` +
    `-H "Sec-Fetch-Mode: cors" ` +
    `-H "Sec-Fetch-Site: same-origin" ` +
    `-H "X-Requested-With: XMLHttpRequest" ` +
    `"${url}"`,
    { encoding: 'utf8', timeout: 35000, maxBuffer: 10 * 1024 * 1024 }
  );

  const parsed = JSON.parse(raw);
  return (parsed?.data || [])
    .filter(s => s.symbol && s.lastPrice != null && s.symbol !== indexName)
    .map(s => ({
      symbol: s.symbol,
      lastPrice: parseFloat(String(s.lastPrice).replace(/,/g, '')) || null,
    }))
    .filter(s => s.lastPrice !== null);
}

async function fetchAllViaCurl() {
  const cookieFile = path.join(os.tmpdir(), `nse_prices_${Date.now()}.txt`);

  try {
    // Step 1: Get session cookies
    console.log('[Prices/curl] Getting session cookies...');
    execSync(
      `curl -s -L -c "${cookieFile}" --max-time 15 --compressed ` +
      `-H "User-Agent: ${UA}" ` +
      `-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `-H "Accept-Encoding: gzip, deflate, br" ` +
      `-H "Connection: keep-alive" ` +
      `-H "Upgrade-Insecure-Requests: 1" ` +
      `-H "Sec-Fetch-Dest: document" ` +
      `-H "Sec-Fetch-Mode: navigate" ` +
      `-H "Sec-Fetch-Site: none" ` +
      `-H "Sec-Fetch-User: ?1" ` +
      `-o /dev/null ` +
      `"https://www.nseindia.com"`,
      { encoding: 'utf8', timeout: 20000 }
    );
    console.log('[Prices/curl] Session cookies acquired');

    await sleep(2000 + Math.random() * 1500);

    // Step 2: Fetch each index
    const priceMap = new Map();

    for (const index of INDICES) {
      try {
        console.log(`[Prices/curl] Fetching ${index}...`);
        const stocks = await fetchIndexViaCurl(index, cookieFile);
        for (const s of stocks) {
          if (!priceMap.has(s.symbol)) {
            priceMap.set(s.symbol, s);
          }
        }
        console.log(`[Prices/curl] ${index}: ${stocks.length} prices`);
        await sleep(1500 + Math.random() * 1000); // Rate limit
      } catch (err) {
        console.warn(`[Prices/curl] ${index} failed: ${err.message}`);
      }
    }

    return priceMap;
  } finally {
    try { fs.unlinkSync(cookieFile); } catch {}
  }
}

// ─── Strategy 2: axios fallback ──────────────────────────────────────────────

async function fetchAllViaAxios() {
  console.log('[Prices/axios] Getting session cookies...');
  const res1 = await axios.get('https://www.nseindia.com', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 10000,
  });

  const cookies = (res1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  await sleep(2000);

  const priceMap = new Map();

  for (const index of INDICES) {
    try {
      console.log(`[Prices/axios] Fetching ${index}...`);
      const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(index)}`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.nseindia.com/',
          'Cookie': cookies,
        },
        timeout: 15000,
      });

      const stocks = (res.data?.data || [])
        .filter(s => s.symbol && s.lastPrice != null && s.symbol !== index)
        .map(s => ({
          symbol: s.symbol,
          lastPrice: parseFloat(String(s.lastPrice).replace(/,/g, '')) || null,
        }))
        .filter(s => s.lastPrice !== null);

      for (const s of stocks) {
        if (!priceMap.has(s.symbol)) priceMap.set(s.symbol, s);
      }
      console.log(`[Prices/axios] ${index}: ${stocks.length} prices`);
      await sleep(1500);
    } catch (err) {
      console.warn(`[Prices/axios] ${index} failed: ${err.message}`);
    }
  }

  return priceMap;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function fetchPrices() {
  console.log('[Prices] Starting LTP fetch...');
  const startTime = Date.now();

  // Try curl first, fall back to axios
  let priceMap;
  try {
    priceMap = await fetchAllViaCurl();
  } catch (err) {
    console.warn('[Prices] curl strategy failed:', err.message);
    console.log('[Prices] Falling back to axios...');
    try {
      priceMap = await fetchAllViaAxios();
    } catch (err2) {
      console.error('[Prices] axios also failed:', err2.message);
      return { success: false, error: err2.message };
    }
  }

  if (!priceMap || priceMap.size === 0) {
    console.error('[Prices] No prices fetched from any index');
    return { success: false, error: 'No prices fetched' };
  }

  console.log(`[Prices] Total unique prices: ${priceMap.size}`);

  // Batch upsert into stocks_master
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
