/**
 * seedAllStocks.js
 * Fetches ALL listed NSE equities and upserts into stocks_master.
 *
 * NSE source: EQUITY_L.csv from nsearchives (~2000 equities)
 *   - Fallback: index APIs via curl (NIFTY TOTAL MARKET + 4 other indices)
 */
const { execSync } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const axios = require('axios');
const { pool } = require('../lib/db');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent':       UA,
  'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':  'en-US,en;q=0.9',
  'Accept-Encoding':  'gzip, deflate, br',
  'Connection':       'keep-alive',
};

// Equity series to include from NSE CSV
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST']);

// NSE indices for fallback
const NSE_INDICES = [
  'NIFTY TOTAL MARKET',
  'NIFTY 500',
  'NIFTY MIDCAP 150',
  'NIFTY SMALLCAP 250',
  'NIFTY MICROCAP 250',
];

// ─── NSE: CSV approach ───────────────────────────────────────────────────────

function parseNSECsv(csvText) {
  const lines = csvText.trim().split('\n');
  const stocks = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // CSV columns: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
    const cols = line.split(',').map(c => c.trim());
    if (cols.length < 3) continue;

    const symbol      = cols[0].toUpperCase();
    const companyName = cols[1];
    const series      = cols[2].toUpperCase();

    // Only include equity series
    if (!EQUITY_SERIES.has(series)) continue;
    if (!symbol || symbol.length > 30) continue;

    stocks.push({
      symbol,
      company_name: companyName,
      sector:       null, // CSV doesn't include sector
    });
  }

  return stocks;
}

async function fetchNSECsvViaCurl() {
  console.log('[SeedAll] Trying NSE EQUITY_L.csv via curl...');
  const csvUrl = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

  const raw = execSync(
    `curl -s -L --max-time 30 --compressed ` +
    `-H "User-Agent: ${UA}" ` +
    `-H "Accept: text/csv, text/plain, */*" ` +
    `-H "Accept-Language: en-US,en;q=0.9" ` +
    `-H "Accept-Encoding: gzip, deflate, br" ` +
    `-H "Referer: https://www.nseindia.com/" ` +
    `"${csvUrl}"`,
    { encoding: 'utf8', timeout: 35000, maxBuffer: 10 * 1024 * 1024 }
  );

  if (!raw || raw.length < 100 || raw.includes('<html')) {
    throw new Error('NSE CSV returned HTML or empty response');
  }

  const stocks = parseNSECsv(raw);
  console.log(`[SeedAll] NSE CSV: parsed ${stocks.length} equity stocks`);
  return stocks;
}

async function fetchNSECsvViaAxios() {
  console.log('[SeedAll] Trying NSE EQUITY_L.csv via axios...');
  const csvUrl = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

  const res = await axios.get(csvUrl, {
    headers: BROWSER_HEADERS,
    timeout: 30000,
    responseType: 'text',
  });

  if (!res.data || res.data.length < 100 || res.data.includes('<html')) {
    throw new Error('NSE CSV returned HTML or empty response');
  }

  const stocks = parseNSECsv(res.data);
  console.log(`[SeedAll] NSE CSV (axios): parsed ${stocks.length} equity stocks`);
  return stocks;
}

async function fetchNSEViaIndices() {
  console.log('[SeedAll] Falling back to NSE index APIs via curl...');
  const cookieFile = path.join(os.tmpdir(), `nse_seed_cookies_${Date.now()}.txt`);
  const allStocks = new Map();

  try {
    // Step 1: get cookies
    execSync(
      `curl -s -L -c "${cookieFile}" --max-time 15 --compressed ` +
      `-H "User-Agent: ${UA}" ` +
      `-H "Accept: text/html,application/xhtml+xml" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `-o /dev/null ` +
      `"https://www.nseindia.com"`,
      { encoding: 'utf8', timeout: 20000 }
    );
    console.log('[SeedAll] NSE cookies acquired');

    await sleep(2000);

    // Step 2: fetch each index
    for (const idx of NSE_INDICES) {
      try {
        await sleep(1500 + Math.random() * 1000);
        const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(idx)}`;
        const raw = execSync(
          `curl -s -L -b "${cookieFile}" --max-time 30 --compressed ` +
          `-H "User-Agent: ${UA}" ` +
          `-H "Accept: application/json" ` +
          `-H "Accept-Language: en-US,en;q=0.9" ` +
          `-H "Referer: https://www.nseindia.com/market-data/live-equity-market" ` +
          `-H "Sec-Fetch-Dest: empty" ` +
          `-H "Sec-Fetch-Mode: cors" ` +
          `-H "Sec-Fetch-Site: same-origin" ` +
          `"${url}"`,
          { encoding: 'utf8', timeout: 35000, maxBuffer: 10 * 1024 * 1024 }
        );

        const parsed = JSON.parse(raw);
        const data = parsed?.data || [];

        for (const item of data) {
          const symbol = (item.symbol || '').trim().toUpperCase();
          if (!symbol || symbol === 'NIFTY 50' || symbol.includes(' ')) continue;
          if (allStocks.has(symbol)) continue;

          allStocks.set(symbol, {
            symbol,
            company_name: item.companyName || item.meta?.companyName || symbol,
            sector:       item.industry || item.meta?.industry || null,
          });
        }
        console.log(`[SeedAll] NSE ${idx}: ${data.length} stocks (total unique: ${allStocks.size})`);
      } catch (err) {
        console.warn(`[SeedAll] NSE ${idx} failed:`, err.message);
      }
    }
  } finally {
    try { fs.unlinkSync(cookieFile); } catch {}
  }

  console.log(`[SeedAll] NSE indices total: ${allStocks.size} unique stocks`);
  return Array.from(allStocks.values());
}

async function fetchAllNSE() {
  // Step 1: Get full stock list from CSV (symbol + company_name, no sector)
  let stocks = [];

  try {
    stocks = await fetchNSECsvViaCurl();
  } catch (err) {
    console.warn('[SeedAll] NSE CSV via curl failed:', err.message);
    try {
      stocks = await fetchNSECsvViaAxios();
    } catch (err2) {
      console.warn('[SeedAll] NSE CSV via axios also failed:', err2.message);
    }
  }

  // Step 2: Always enrich with sector data from index APIs (regardless of CSV success)
  // NSE indices return industry/sector which the CSV lacks entirely
  try {
    const indexStocks = await fetchNSEViaIndices();
    const sectorMap = new Map(
      indexStocks.filter(s => s.sector).map(s => [s.symbol, s.sector])
    );
    console.log(`[SeedAll] Sector data available for ${sectorMap.size} stocks from indices`);

    if (stocks.length > 0) {
      // Enrich CSV stocks with sector where available
      stocks = stocks.map(s => ({
        ...s,
        sector: sectorMap.get(s.symbol) || s.sector || null,
      }));
    } else {
      // CSV failed entirely — use index stocks as the stock list
      stocks = indexStocks;
    }
  } catch (err) {
    console.warn('[SeedAll] Index sector enrichment failed:', err.message);
    // Continue with whatever stocks we have (sector will be null for all)
  }

  return stocks;
}

// ─── Upsert ──────────────────────────────────────────────────────────────────

async function seedAllStocks() {
  console.log('[SeedAll] ═══ Starting stock seed ═══');
  const startTime = Date.now();
  const results = { total: 0, upserted: 0, errors: [] };

  // Fetch NSE stocks
  let stocks = [];
  try {
    stocks = await fetchAllNSE();
    results.total = stocks.length;
    console.log(`[SeedAll] NSE: ${stocks.length} stocks fetched`);
  } catch (err) {
    results.errors.push(`NSE failed: ${err.message}`);
    console.error('[SeedAll] NSE fetch failed entirely:', err.message);
    return results;
  }

  if (stocks.length === 0) {
    console.error('[SeedAll] No stocks fetched');
    return results;
  }

  // Batch upsert (200 per batch)
  const batchSize = 200;
  let upserted = 0;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [
      s.symbol.trim().toUpperCase(),
      s.company_name || null,
      s.sector || null,
      1, // is_active
    ]);

    try {
      await pool.query(
        `INSERT INTO stocks_master (symbol, company_name, sector, is_active)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           company_name = VALUES(company_name),
           sector       = COALESCE(VALUES(sector), sector),
           is_active    = VALUES(is_active)`,
        values
      );
      upserted += batch.length;
    } catch (err) {
      console.error(`[SeedAll] Upsert batch ${Math.floor(i / batchSize) + 1} error:`, err.message);
      results.errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${err.message}`);
    }
  }

  results.upserted = upserted;

  // Drop exchange column if it still exists
  try {
    await pool.query(`ALTER TABLE stocks_master DROP COLUMN IF EXISTS exchange`);
    console.log('[SeedAll] Dropped exchange column from stocks_master');
  } catch (err) {
    // Ignore — column may not exist or DB doesn't support DROP COLUMN IF EXISTS
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  results.elapsed = elapsed;

  console.log(`[SeedAll] ═══ Complete: ${upserted} stocks upserted in ${elapsed}s ═══`);
  return results;
}

module.exports = { seedAllStocks };
