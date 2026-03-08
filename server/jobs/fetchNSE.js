/**
 * fetchNSE.js
 * Fetches corporate actions from NSE API and upserts into corporate_actions.
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

    // Step 2: Fetch corporate actions API
    const apiUrl = `https://www.nseindia.com/api/corporates-pit?index=equities&from_date=${fromStr}&to_date=${toStr}`;

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

    // Debug: log raw response shape
    console.log('[NSE/curl] Raw response (first 500 chars):', raw.substring(0, 500));

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[NSE/curl] JSON parse failed — response is not JSON (likely HTML/captcha)');
      console.log('[NSE/curl] Response starts with:', raw.substring(0, 200));
      throw new Error('NSE returned non-JSON response');
    }

    // Debug: log response keys
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      console.log('[NSE/curl] Response keys:', Object.keys(parsed));
      // Log the length of each array-valued key
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
    // Clean up cookie file
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

  const apiUrl = `https://www.nseindia.com/api/corporates-pit?index=equities&from_date=${fromStr}&to_date=${toStr}`;

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
  toDate.setDate(today.getDate() + 30);

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

  // Filter dividends
  const dividends = records.filter(r => {
    const text = ((r.subject || '') + ' ' + (r.purpose || '')).toUpperCase();
    return text.includes('DIVIDEND');
  });

  console.log(`[NSE] ${dividends.length} dividend records to process`);

  // Upsert into corporate_actions
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
