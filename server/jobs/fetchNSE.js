/**
 * fetchNSE.js
 * Fetches corporate actions from NSE API and upserts into corporate_actions.
 * NSE requires a fresh cookie from the homepage before hitting the data API.
 */
const axios          = require('axios');
const { supabaseAdmin } = require('../lib/supabase');

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

// ─── NSE session cookie ───────────────────────────────────────────────────────

async function getNSECookies() {
  const res = await axios.get('https://www.nseindia.com', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 20000,
  });
  return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchNSE() {
  console.log('[NSE] Starting fetch...');

  const today  = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + 30);

  const fromStr = formatNSEDate(today);
  const toStr   = formatNSEDate(toDate);

  // Step 1: get fresh session cookie
  let cookies;
  try {
    cookies = await getNSECookies();
    console.log('[NSE] Session cookie acquired');
  } catch (err) {
    console.error('[NSE] Failed to get session cookie:', err.message);
    throw err;
  }

  // Brief pause to appear human-like
  await new Promise(r => setTimeout(r, 2000));

  // Step 2: fetch corporate actions
  const url = `https://www.nseindia.com/api/corporates-pit?index=equities&from_date=${fromStr}&to_date=${toStr}`;

  let records;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':      'application/json, text/plain, */*',
        'Referer':     'https://www.nseindia.com/companies-listing/corporate-filings-corporateActions',
        'Cookie':      cookies,
      },
      timeout: 30000,
    });
    records = res.data?.data || [];
  } catch (err) {
    console.error('[NSE] API request failed:', err.message);
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
    const { data: stock } = await supabaseAdmin
      .from('stocks_master')
      .select('symbol')
      .eq('symbol', symbol)
      .maybeSingle();

    if (!stock) { skipped++; continue; }

    const purpose = r.subject || r.purpose || '';

    const { error } = await supabaseAdmin
      .from('corporate_actions')
      .upsert({
        symbol,
        action_type:   'DIVIDEND',
        ex_date:       exDate,
        record_date:   parseNSEDate(r.recDate),
        details: {
          amount:      extractAmount(purpose),
          raw_purpose: purpose,
          face_value:  r.faceVal || null,
          series:      r.series  || null,
          source:      'NSE',
        },
        announced_at:  new Date().toISOString(),
        last_fetched:  new Date().toISOString(),
      }, { onConflict: 'symbol,action_type,ex_date' });

    if (error) {
      console.error(`[NSE] Upsert error for ${symbol}:`, error.message);
    } else {
      upserted++;
    }
  }

  console.log(`[NSE] Complete — ${upserted} upserted, ${skipped} skipped`);
  return { upserted, skipped, total: dividends.length };
}

module.exports = { fetchNSE };
