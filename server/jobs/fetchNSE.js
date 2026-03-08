/**
 * fetchNSE.js
 * Fetches corporate actions from NSE API and upserts into corporate_actions.
 * NSE requires a fresh cookie from the homepage before hitting the data API.
 * Uses full browser-like headers to bypass Akamai WAF/bot detection.
 */
const axios  = require('axios');
const { pool } = require('../lib/db');

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatNSEDate(date) {
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function parseNSEDate(str) {
  if (!str || str === '-') return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function extractAmount(purpose) {
  if (!purpose) return null;
  const m = purpose.match(/(?:RS\.?\s*|INR\s*|₹\s*)(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

// ─── Browser-like headers ────────────────────────────────────────────────────

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PAGE_HEADERS = {
  'User-Agent':                 BROWSER_UA,
  'Accept':                     'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language':            'en-US,en;q=0.9',
  'Accept-Encoding':            'gzip, deflate, br',
  'Connection':                 'keep-alive',
  'Cache-Control':              'max-age=0',
  'Sec-Ch-Ua':                  '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile':           '?0',
  'Sec-Ch-Ua-Platform':         '"Windows"',
  'Sec-Fetch-Dest':             'document',
  'Sec-Fetch-Mode':             'navigate',
  'Sec-Fetch-Site':             'none',
  'Sec-Fetch-User':             '?1',
  'Upgrade-Insecure-Requests':  '1',
};

const API_HEADERS = {
  'User-Agent':          BROWSER_UA,
  'Accept':              'application/json, text/javascript, */*; q=0.01',
  'Accept-Language':     'en-US,en;q=0.9',
  'Accept-Encoding':     'gzip, deflate, br',
  'Connection':          'keep-alive',
  'Sec-Ch-Ua':           '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile':    '?0',
  'Sec-Ch-Ua-Platform':  '"Windows"',
  'Sec-Fetch-Dest':      'empty',
  'Sec-Fetch-Mode':      'cors',
  'Sec-Fetch-Site':      'same-origin',
  'X-Requested-With':    'XMLHttpRequest',
};

// ─── NSE session cookie (multi-step) ─────────────────────────────────────────

async function getNSECookies() {
  // Step 1: Visit homepage to get initial cookies
  const res1 = await axios.get('https://www.nseindia.com', {
    headers: PAGE_HEADERS,
    timeout: 15000,
    maxRedirects: 5,
  });

  const cookies1 = (res1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log('[NSE] Homepage cookies acquired');

  // Brief human-like pause
  await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));

  // Step 2: Visit corporate actions page to warm up session
  try {
    await axios.get('https://www.nseindia.com/companies-listing/corporate-filings-corporateActions', {
      headers: {
        ...PAGE_HEADERS,
        'Cookie':  cookies1,
        'Referer': 'https://www.nseindia.com/',
        'Sec-Fetch-Site': 'same-origin',
      },
      timeout: 15000,
      maxRedirects: 5,
    });
    console.log('[NSE] Corporate actions page visited');
  } catch (err) {
    // Non-fatal — some setups skip this
    console.warn('[NSE] Corporate actions page visit failed (non-fatal):', err.message);
  }

  return cookies1;
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchNSE() {
  console.log('[NSE] Starting fetch...');

  const today  = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + 30);

  const fromStr = formatNSEDate(today);
  const toStr   = formatNSEDate(toDate);

  // Step 1: get fresh session cookie (multi-step)
  let cookies;
  try {
    cookies = await getNSECookies();
  } catch (err) {
    console.error('[NSE] Failed to get session cookie:', err.message);
    throw err;
  }

  // Human-like pause before API call
  await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

  // Step 2: fetch corporate actions
  const url = `https://www.nseindia.com/api/corporates-pit?index=equities&from_date=${fromStr}&to_date=${toStr}`;

  let records;
  try {
    const res = await axios.get(url, {
      headers: {
        ...API_HEADERS,
        'Cookie':  cookies,
        'Referer': 'https://www.nseindia.com/companies-listing/corporate-filings-corporateActions',
      },
      timeout: 30000,
    });
    records = res.data?.data || res.data || [];
    if (!Array.isArray(records)) {
      console.warn('[NSE] Unexpected response shape:', typeof records);
      records = [];
    }
  } catch (err) {
    console.error('[NSE] API request failed:', err.response?.status, err.message);
    throw err;
  }

  console.log(`[NSE] Received ${records.length} total records`);

  // Step 3: filter dividends
  const dividends = records.filter(r => {
    const text = ((r.subject || '') + ' ' + (r.purpose || '')).toUpperCase();
    return text.includes('DIVIDEND');
  });

  console.log(`[NSE] ${dividends.length} dividend records to process`);

  // Step 4: upsert into corporate_actions
  let upserted = 0, skipped = 0;

  for (const r of dividends) {
    const symbol = r.symbol?.trim().toUpperCase();
    if (!symbol) { skipped++; continue; }

    const exDate = parseNSEDate(r.exDate || r.xDivDate);
    if (!exDate) { skipped++; continue; }

    // Only upsert if symbol exists in stocks_master
    const [stockRows] = await pool.execute(
      'SELECT symbol FROM stocks_master WHERE symbol = ?',
      [symbol]
    );

    if (stockRows.length === 0) { skipped++; continue; }

    const purpose = r.subject || r.purpose || '';
    const now = new Date();

    const details = JSON.stringify({
      amount:      extractAmount(purpose),
      raw_purpose: purpose,
      face_value:  r.faceVal || null,
      series:      r.series  || null,
      source:      'NSE',
    });

    try {
      await pool.execute(
        `INSERT INTO corporate_actions (symbol, action_type, ex_date, record_date, details, announced_at, last_fetched)
         VALUES (?, 'DIVIDEND', ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           record_date  = VALUES(record_date),
           details      = VALUES(details),
           announced_at = VALUES(announced_at),
           last_fetched = VALUES(last_fetched)`,
        [symbol, exDate, parseNSEDate(r.recDate), details, now, now]
      );
      upserted++;
    } catch (err) {
      console.error(`[NSE] Upsert error for ${symbol}:`, err.message);
    }
  }

  console.log(`[NSE] Complete — ${upserted} upserted, ${skipped} skipped`);
  return { upserted, skipped, total: dividends.length };
}

module.exports = { fetchNSE };
