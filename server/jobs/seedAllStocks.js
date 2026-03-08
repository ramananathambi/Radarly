/**
 * seedAllStocks.js
 * Fetches ALL listed stocks from NSE and BSE, deduplicates, and upserts into stocks_master.
 *
 * NSE source: EQUITY_L.csv from nsearchives (~2000 equities)
 *   - Fallback: index APIs via curl (NIFTY TOTAL MARKET + 4 other indices)
 * BSE source: ListofScripData API for groups A, B, T, X, XT, Z (~4000 stocks)
 *
 * Dedup: NSE takes priority. BSE fills gaps for BSE-only stocks.
 * Result: ~4000-5000 unique stocks in stocks_master.
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

const BSE_HEADERS = {
  'User-Agent':       UA,
  'Accept':           'application/json, text/plain, */*',
  'Accept-Language':  'en-US,en;q=0.9',
  'Referer':          'https://www.bseindia.com/',
  'Origin':           'https://www.bseindia.com',
  'Connection':       'keep-alive',
};

// Equity series to include from NSE CSV
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST']);

// BSE groups to fetch
const BSE_GROUPS = ['A', 'B', 'T', 'X', 'XT', 'Z'];

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
      exchange:     'NSE',
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
            exchange:     'NSE',
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
  // Strategy 1: CSV via curl
  try {
    return await fetchNSECsvViaCurl();
  } catch (err) {
    console.warn('[SeedAll] NSE CSV via curl failed:', err.message);
  }

  // Strategy 2: CSV via axios
  try {
    return await fetchNSECsvViaAxios();
  } catch (err) {
    console.warn('[SeedAll] NSE CSV via axios failed:', err.message);
  }

  // Strategy 3: Index APIs via curl
  try {
    return await fetchNSEViaIndices();
  } catch (err) {
    console.warn('[SeedAll] NSE indices fallback failed:', err.message);
  }

  return [];
}

// ─── BSE: JSON API ───────────────────────────────────────────────────────────

async function fetchBSEGroup(group) {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=${group}&flag=true&Status=Active`;

  const res = await axios.get(url, {
    headers: BSE_HEADERS,
    timeout: 30000,
  });

  let records = [];
  if (Array.isArray(res.data)) {
    records = res.data;
  } else if (res.data?.Table) {
    records = res.data.Table;
  }

  const stocks = [];
  for (const item of records) {
    // Use scrip_id (trading symbol) as primary symbol
    const symbol = (item.scrip_id || item.SCRIP_ID || '').trim().toUpperCase();

    // Skip empty or purely numeric symbols
    if (!symbol || /^\d+$/.test(symbol) || symbol.length > 30) continue;

    stocks.push({
      symbol,
      company_name: item.LONG_NAME || item.Scrip_Name || item.long_name || symbol,
      exchange:     'BSE',
      sector:       item.Industry || item.industry || null,
    });
  }

  return stocks;
}

async function fetchAllBSE() {
  const allStocks = new Map();

  for (const group of BSE_GROUPS) {
    try {
      const stocks = await fetchBSEGroup(group);
      let added = 0;
      for (const s of stocks) {
        if (!allStocks.has(s.symbol)) {
          allStocks.set(s.symbol, s);
          added++;
        }
      }
      console.log(`[SeedAll] BSE Group ${group}: ${stocks.length} stocks (${added} new, total unique: ${allStocks.size})`);
      await sleep(1000);
    } catch (err) {
      console.warn(`[SeedAll] BSE Group ${group} failed:`, err.message);
    }
  }

  console.log(`[SeedAll] BSE total: ${allStocks.size} unique stocks`);
  return Array.from(allStocks.values());
}

// ─── Merge + Upsert ─────────────────────────────────────────────────────────

async function seedAllStocks() {
  console.log('[SeedAll] ═══ Starting full stock seed ═══');
  const startTime = Date.now();
  const results = { nse: 0, bseOnly: 0, total: 0, upserted: 0, errors: [] };

  // 1. Fetch NSE stocks
  let nseStocks = [];
  try {
    nseStocks = await fetchAllNSE();
    results.nse = nseStocks.length;
    console.log(`[SeedAll] NSE: ${nseStocks.length} stocks fetched`);
  } catch (err) {
    results.errors.push(`NSE failed: ${err.message}`);
    console.error('[SeedAll] NSE fetch failed entirely:', err.message);
  }

  // 2. Fetch BSE stocks
  let bseStocks = [];
  try {
    bseStocks = await fetchAllBSE();
    console.log(`[SeedAll] BSE: ${bseStocks.length} stocks fetched`);
  } catch (err) {
    results.errors.push(`BSE failed: ${err.message}`);
    console.error('[SeedAll] BSE fetch failed entirely:', err.message);
  }

  // 3. Merge: NSE first (priority), BSE fills gaps
  const merged = new Map();

  for (const s of nseStocks) {
    const sym = s.symbol.trim().toUpperCase();
    if (sym && !merged.has(sym)) {
      merged.set(sym, s);
    }
  }

  for (const s of bseStocks) {
    const sym = s.symbol.trim().toUpperCase();
    if (sym && !merged.has(sym)) {
      merged.set(sym, s);
      results.bseOnly++;
    }
  }

  const allStocks = Array.from(merged.values());
  results.total = allStocks.length;

  if (allStocks.length === 0) {
    console.error('[SeedAll] No stocks fetched from any source');
    return results;
  }

  console.log(`[SeedAll] Merged: ${results.total} unique stocks (${results.nse} NSE + ${results.bseOnly} BSE-only)`);

  // 4. Batch upsert (200 per batch)
  const batchSize = 200;
  let upserted = 0;

  for (let i = 0; i < allStocks.length; i += batchSize) {
    const batch = allStocks.slice(i, i + batchSize);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [
      s.symbol.trim().toUpperCase(),
      s.company_name || null,
      s.exchange || 'NSE',
      s.sector || null,
      1, // is_active
    ]);

    try {
      await pool.query(
        `INSERT INTO stocks_master (symbol, company_name, exchange, sector, is_active)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           company_name = VALUES(company_name),
           exchange     = VALUES(exchange),
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
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  results.elapsed = elapsed;

  console.log(`[SeedAll] ═══ Complete: ${upserted} stocks upserted in ${elapsed}s ═══`);
  return results;
}

module.exports = { seedAllStocks };
