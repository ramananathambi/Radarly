/**
 * fetchBSE.js
 * Fetches corporate actions from BSE API and upserts into corporate_actions.
 */
const axios          = require('axios');
const { supabaseAdmin } = require('../lib/supabase');

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatBSEDate(date) {
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseBSEDate(str) {
  if (!str) return null;
  // BSE returns "2026-01-29T00:00:00"
  return str.split('T')[0];
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function extractAmount(purpose) {
  if (!purpose) return null;
  const m = purpose.match(/(?:RS\.?\s*|INR\s*|₹\s*)(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchBSE() {
  console.log('[BSE] Starting fetch...');

  const today  = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + 30);

  const fromStr = formatBSEDate(today);
  const toStr   = formatBSEDate(toDate);

  const url = `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Category=CA&pageno=1&subcategory=D&scripcode=&strdate=${fromStr}&todate=${toStr}`;

  let records;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'application/json',
        'Referer':    'https://www.bseindia.com',
        'Origin':     'https://www.bseindia.com',
      },
      timeout: 30000,
    });
    records = res.data?.Table || [];
  } catch (err) {
    console.error('[BSE] API request failed:', err.message);
    throw err;
  }

  console.log(`[BSE] Received ${records.length} records`);

  let upserted = 0, skipped = 0;

  for (const r of records) {
    // BSE uses SHORT_NAME as the trading symbol
    const symbol = (r.SHORT_NAME || r.TRADING_SYMBOL || '').trim().toUpperCase();
    if (!symbol) { skipped++; continue; }

    const exDate = parseBSEDate(r.EX_DATE || r.EXDATE);
    if (!exDate) { skipped++; continue; }

    const purpose = r.PURPOSE || r.REMARKS || '';
    if (!purpose.toUpperCase().includes('DIVIDEND')) { skipped++; continue; }

    // Only upsert if symbol exists in stocks_master
    const { data: stock } = await supabaseAdmin
      .from('stocks_master')
      .select('symbol')
      .eq('symbol', symbol)
      .maybeSingle();

    if (!stock) { skipped++; continue; }

    const { error } = await supabaseAdmin
      .from('corporate_actions')
      .upsert({
        symbol,
        action_type:  'DIVIDEND',
        ex_date:      exDate,
        record_date:  parseBSEDate(r.RD_DATE || r.RECORD_DATE),
        details: {
          amount:      extractAmount(purpose),
          raw_purpose: purpose,
          scrip_code:  r.SCRIP_CD  || null,
          source:      'BSE',
        },
        announced_at: new Date().toISOString(),
        last_fetched: new Date().toISOString(),
      }, { onConflict: 'symbol,action_type,ex_date' });

    if (error) {
      console.error(`[BSE] Upsert error for ${symbol}:`, error.message);
    } else {
      upserted++;
    }
  }

  console.log(`[BSE] Complete — ${upserted} upserted, ${skipped} skipped`);
  return { upserted, skipped, total: records.length };
}

module.exports = { fetchBSE };
