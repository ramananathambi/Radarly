/**
 * fetchNSE.js
 * Fetches ALL corporate actions from NSE API and upserts into corporate_actions.
 * Handles: Dividend, Bonus, Split, Buyback, Rights
 *
 * Strategy:
 *   1. Try curl (different TLS/JA3 fingerprint from Node.js — bypasses Akamai)
 *   2. Fall back to axios if curl fails
 *
 * NSE blocks hosting/datacenter IPs via TLS fingerprinting (JA3 hash).
 * curl uses OpenSSL while Node.js uses its own TLS stack → different fingerprint.
 */
const { execSync } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const axios = require('axios');
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

/**
 * Classify a corporate action from its subject/purpose text.
 * Returns the action_type string or null to skip.
 */
function classifyAction(text) {
  const t = text.toUpperCase();
  if (t.includes('DIVIDEND'))                                          return 'DIVIDEND';
  if (t.includes('BONUS'))                                             return 'BONUS';
  if (t.includes('SPLIT') || t.includes('SUB-DIVISION') ||
      t.includes('SUBDIVISION') || t.includes('SUB DIVISION'))        return 'SPLIT';
  if (t.includes('BUYBACK') || t.includes('BUY BACK') ||
      t.includes('BUY-BACK'))                                          return 'BUYBACK';
  if (t.includes('RIGHTS'))                                            return 'RIGHTS';
  return null; // Unknown / not a tracked type — skip
}

// ─── Browser-like constants ──────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─── Strategy 1: curl-based fetch (different TLS fingerprint) ────────────────

async function fetchViaCurl(fromStr, toStr) {
  const cookieFile = path.join(os.tmpdir(), `nse_cookies_${Date.now()}.txt`);

  try {
    // Step 1: Visit homepage to get session cookies
    console.log('[NSE/curl] Getting session cookies...');
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
    console.log('[NSE/curl] Session cookies acquired');

    // Brief human-like pause
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

    // Step 2: Fetch ALL corporate actions (no category filter)
    const apiUrl = `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${fromStr}&to_date=${toStr}`;

    console.log('[NSE/curl] Fetching corporate actions API...');
    const raw = execSync(
      `curl -s -L -b "${cookieFile}" --max-time 30 --compressed ` +
      `-H "User-Agent: ${UA}" ` +
      `-H "Accept: application/json, text/javascript, */*; q=0.01" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `-H "Accept-Encoding: gzip, deflate, br" ` +
      `-H "Connection: keep-alive" ` +
      `-H "Referer: https://www.nseindia.com/companies-listing/corporate-filings-corporateActions" ` +
      `-H "Sec-Fetch-Dest: empty" ` +
      `-H "Sec-Fetch-Mode: cors" ` +
      `-H "Sec-Fetch-Site: same-origin" ` +
      `-H "X-Requested-With: XMLHttpRequest" ` +
      `"${apiUrl}"`,
      { encoding: 'utf8', timeout: 35000, maxBuffer: 10 * 1024 * 1024 }
    );

    console.log('[NSE/curl] Raw response (first 500 chars):', raw.substring(0, 500));

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[NSE/curl] JSON parse failed — response is not JSON (likely HTML/captcha)');
      console.log('[NSE/curl] Response starts with:', raw.substring(0, 200));
      throw new Error('NSE returned non-JSON response');
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      console.log('[NSE/curl] Response keys:', Object.keys(parsed));
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) console.log(`[NSE/curl]   ${k}: ${v.length} items`);
        else console.log(`[NSE/curl]   ${k}: ${typeof v}`);
      }
    }

    const records = parsed?.data || parsed || [];

    if (!Array.isArray(records)) {
      console.warn('[NSE/curl] Unexpected response type:', typeof records, JSON.stringify(records).substring(0, 300));
      return [];
    }

    console.log(`[NSE/curl] Got ${records.length} records`);
    return records;

  } finally {
    try { fs.unlinkSync(cookieFile); } catch {}
  }
}

// ─── Strategy 2: axios-based fetch (fallback) ────────────────────────────────

async function fetchViaAxios(fromStr, toStr) {
  console.log('[NSE/axios] Getting session cookies...');

  const pageHeaders = {
    'User-Agent':                UA,
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  const res1 = await axios.get('https://www.nseindia.com', {
    headers: pageHeaders,
    timeout: 15000,
    maxRedirects: 5,
  });

  const cookies = (res1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log('[NSE/axios] Session cookies acquired');

  await new Promise(r => setTimeout(r, 2500));

  // No category filter — fetch all corporate actions
  const apiUrl = `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${fromStr}&to_date=${toStr}`;

  const res2 = await axios.get(apiUrl, {
    headers: {
      'User-Agent':         UA,
      'Accept':             'application/json, text/javascript, */*; q=0.01',
      'Accept-Language':    'en-US,en;q=0.9',
      'Accept-Encoding':    'gzip, deflate, br',
      'Connection':         'keep-alive',
      'Referer':            'https://www.nseindia.com/companies-listing/corporate-filings-corporateActions',
      'Cookie':             cookies,
      'Sec-Fetch-Dest':     'empty',
      'Sec-Fetch-Mode':     'cors',
      'Sec-Fetch-Site':     'same-origin',
      'X-Requested-With':   'XMLHttpRequest',
    },
    timeout: 30000,
  });

  const records = res2.data?.data || res2.data || [];
  return Array.isArray(records) ? records : [];
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchNSE() {
  console.log('[NSE] Starting fetch...');

  const today  = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + 90); // 90 days ahead to capture more events

  const fromStr = formatNSEDate(today);
  const toStr   = formatNSEDate(toDate);

  // Try curl first (different TLS fingerprint), fall back to axios
  let records = [];

  try {
    records = await fetchViaCurl(fromStr, toStr);
  } catch (err) {
    console.warn('[NSE] curl strategy failed:', err.message);
    console.log('[NSE] Falling back to axios...');
    try {
      records = await fetchViaAxios(fromStr, toStr);
    } catch (err2) {
      console.error('[NSE] axios strategy also failed:', err2.response?.status || err2.message);
      throw err2;
    }
  }

  console.log(`[NSE] Received ${records.length} total records`);

  // Classify ALL records by action type (not just dividends)
  const classified = [];
  let unrecognised = 0;

  for (const r of records) {
    const text = ((r.subject || '') + ' ' + (r.purpose || '')).trim();
    const actionType = classifyAction(text);
    if (actionType) {
      classified.push({ r, actionType });
    } else {
      unrecognised++;
    }
  }

  // Log breakdown by type
  const typeCounts = {};
  for (const { actionType } of classified) {
    typeCounts[actionType] = (typeCounts[actionType] || 0) + 1;
  }
  console.log(`[NSE] Classified ${classified.length} records:`, typeCounts);
  if (unrecognised > 0) console.log(`[NSE] Skipped ${unrecognised} unrecognised records`);

  // Upsert into corporate_actions
  let upserted = 0, skipped = 0;

  for (const { r, actionType } of classified) {
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
      raw_purpose: purpose,
      amount:      actionType === 'DIVIDEND' ? extractAmount(purpose) : null,
      face_value:  r.faceVal || null,
      series:      r.series  || null,
      source:      'NSE',
    });

    try {
      await pool.execute(
        `INSERT INTO corporate_actions (symbol, action_type, ex_date, record_date, details, announced_at, last_fetched)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           record_date  = VALUES(record_date),
           details      = VALUES(details),
           announced_at = VALUES(announced_at),
           last_fetched = VALUES(last_fetched)`,
        [symbol, actionType, exDate, parseNSEDate(r.recDate), details, now, now]
      );
      upserted++;
    } catch (err) {
      console.error(`[NSE] Upsert error for ${symbol} (${actionType}):`, err.message);
    }
  }

  console.log(`[NSE] Complete — ${upserted} upserted, ${skipped} skipped`);
  return { upserted, skipped, total: classified.length, typeCounts };
}

module.exports = { fetchNSE };
