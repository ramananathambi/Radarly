/**
 * fetchBSE.js
 * Fetches corporate actions (dividends) from BSE API and upserts into corporate_actions.
 * Tries multiple BSE API endpoints for reliability.
 */
const axios  = require('axios');
const { pool } = require('../lib/db');

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatBSEDate(date) {
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatBSEDateDash(date) {
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${yyyy}${mm}${dd}`;
}

function parseBSEDate(str) {
  if (!str) return null;
  str = String(str).trim();

  // Format: "2026-01-29T00:00:00"
  if (str.includes('T')) return str.split('T')[0];

  // Format: "29/01/2026"
  if (str.includes('/')) {
    const [dd, mm, yyyy] = str.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Format: "09 Mar 2026" or "09 March 2026"
  if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }

  // Format: "20260309" (YYYYMMDD compact)
  if (/^\d{8}$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }

  // Fallback: try native Date parsing
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];

  return null;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function extractAmount(purpose) {
  if (!purpose) return null;
  const m = purpose.match(/(?:RS\.?\s*|INR\s*|₹\s*)(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

// ─── BSE request headers ─────────────────────────────────────────────────────

const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':     'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':    'https://www.bseindia.com/',
  'Origin':     'https://www.bseindia.com',
  'Connection': 'keep-alive',
};

// ─── Try multiple BSE API endpoints ──────────────────────────────────────────

async function fetchBSERecords(fromStr, toStr) {
  // Endpoint 1: DefaultData endpoint (original)
  const url1 = `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Atea=&Category=&Ession=&ExDate=${fromStr}&FDate=&Ession=&TDate=&Ession=&an_session=&pageno=1&strCat=Dividend&strPrevDate=${fromStr}&strScrip=&strSearch=P&strToDate=${toStr}&strType=C`;

  // Endpoint 2: CorporateAction endpoint
  const url2 = `https://api.bseindia.com/BseIndiaAPI/api/CorporateAction/w?scripcode=&index=&sector=&fromdate=${fromStr}&todate=${toStr}&category=Dividend`;

  // Endpoint 3: Original DefaultData (simpler params)
  const url3 = `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Category=CA&pageno=1&subcategory=Dividend&scripcode=&strdate=${fromStr}&todate=${toStr}`;

  const endpoints = [
    { name: 'BSE DefaultData v2', url: url1, parser: 'table' },
    { name: 'BSE CorporateAction', url: url2, parser: 'direct' },
    { name: 'BSE DefaultData v1', url: url3, parser: 'table' },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[BSE] Trying ${ep.name}...`);
      console.log(`[BSE] URL: ${ep.url}`);
      const res = await axios.get(ep.url, {
        headers: BSE_HEADERS,
        timeout: 30000,
      });

      // Debug: log raw response shape
      const rawStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      console.log(`[BSE] ${ep.name} raw response (first 500 chars):`, rawStr.substring(0, 500));

      if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
        console.log(`[BSE] ${ep.name} response keys:`, Object.keys(res.data));
      }

      let records;
      // BSE sometimes returns a direct array, sometimes wrapped in {Table: [...]}
      if (Array.isArray(res.data)) {
        records = res.data;
      } else if (ep.parser === 'table') {
        records = res.data?.Table || res.data?.table || [];
      } else {
        records = res.data?.Table || res.data?.data || [];
      }

      if (!Array.isArray(records)) {
        console.log(`[BSE] ${ep.name} returned non-array:`, typeof res.data);
        continue;
      }

      console.log(`[BSE] ${ep.name} returned ${records.length} records`);

      if (records.length > 0) {
        return { records, source: ep.name };
      }
    } catch (err) {
      console.warn(`[BSE] ${ep.name} failed:`, err.response?.status || err.message);
    }
  }

  // All endpoints returned empty or failed
  return { records: [], source: 'none' };
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchBSE() {
  console.log('[BSE] Starting fetch...');

  const today  = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + 60);  // Look 60 days ahead for more results

  const fromStr = formatBSEDate(today);
  const toStr   = formatBSEDate(toDate);

  const { records, source } = await fetchBSERecords(fromStr, toStr);

  if (records.length === 0) {
    console.log('[BSE] No dividend records found from any endpoint');
    return { upserted: 0, skipped: 0, total: 0 };
  }

  console.log(`[BSE] Processing ${records.length} records from ${source}`);

  let upserted = 0, skipped = 0;

  for (const r of records) {
    // BSE field names vary: short_name, SHORT_NAME, ShortName etc.
    const symbol = (
      r.short_name || r.SHORT_NAME || r.ShortName ||
      r.TRADING_SYMBOL || r.TradingSymbol || ''
    ).trim().toUpperCase();

    if (!symbol) { skipped++; continue; }

    // Ex_date can be "09 Mar 2026" or "2026-03-09T00:00:00" or "20260309"
    const rawExDate = r.Ex_date || r.EX_DATE || r.ExDate || r.ex_date || r.exDate || r.ex_dt;
    const exDate = parseBSEDate(rawExDate);
    if (!exDate) { skipped++; continue; }

    const purpose = r.Purpose || r.PURPOSE || r.purpose || r.REMARKS || r.Remarks || '';
    if (!purpose.toUpperCase().includes('DIVIDEND')) { skipped++; continue; }

    // Only upsert if symbol exists in stocks_master
    const [stockRows] = await pool.execute(
      'SELECT symbol FROM stocks_master WHERE symbol = ?',
      [symbol]
    );

    if (stockRows.length === 0) {
      skipped++;
      // Log first few skipped symbols for debugging
      if (skipped <= 5) console.log(`[BSE] Skipped ${symbol} — not in stocks_master`);
      continue;
    }

    const now = new Date();

    const details = JSON.stringify({
      amount:      extractAmount(purpose),
      raw_purpose: purpose,
      scrip_code:  r.scrip_code || r.SCRIP_CD || r.ScripCode || null,
      source:      'BSE',
    });

    const rawRecDate = r.RD_Date || r.RD_DATE || r.Record_Date || r.RecordDate || r.record_dt;
    const recordDate = parseBSEDate(rawRecDate);

    try {
      await pool.execute(
        `INSERT INTO corporate_actions (symbol, action_type, ex_date, record_date, details, announced_at, last_fetched)
         VALUES (?, 'DIVIDEND', ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           record_date  = VALUES(record_date),
           details      = VALUES(details),
           announced_at = VALUES(announced_at),
           last_fetched = VALUES(last_fetched)`,
        [symbol, exDate, recordDate, details, now, now]
      );
      upserted++;
    } catch (err) {
      console.error(`[BSE] Upsert error for ${symbol}:`, err.message);
    }
  }

  console.log(`[BSE] Complete — ${upserted} upserted, ${skipped} skipped`);
  return { upserted, skipped, total: records.length };
}

module.exports = { fetchBSE };
