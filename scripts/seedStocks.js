/**
 * seedStocks.js
 * Populates stocks_master from NSE + BSE public APIs.
 * Run: node scripts/seedStocks.js
 *
 * Strategy:
 *   1. Try fetching from NSE (may fail outside India)
 *   2. Try fetching from BSE
 *   3. Fall back to built-in NIFTY 500 list if APIs fail
 *
 * Usage:
 *   node scripts/seedStocks.js          — fetch from APIs
 *   node scripts/seedStocks.js --static — use built-in static list only
 */

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const useStaticOnly = process.argv.includes('--static');

// ─── NSE Fetcher ────────────────────────────────────────────────────────────

async function fetchNSEStocks() {
  console.log('[Seed] Fetching NSE stocks...');

  // Get session cookie
  const session = await axios.get('https://www.nseindia.com', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    timeout: 10000,
  });

  const cookies = (session.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  await new Promise(r => setTimeout(r, 2000));

  // Fetch NIFTY 500 constituents (covers most liquid stocks)
  const res = await axios.get('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Cookie': cookies,
    },
    timeout: 15000,
  });

  const stocks = (res.data?.data || []).map(s => ({
    symbol: s.symbol,
    company_name: s.companyName || s.symbol,
    exchange: 'NSE',
    sector: s.industry || null,
    is_active: true,
  }));

  console.log(`[Seed] NSE: ${stocks.length} stocks fetched`);
  return stocks;
}

// ─── BSE Fetcher ────────────────────────────────────────────────────────────

async function fetchBSEStocks() {
  console.log('[Seed] Fetching BSE stocks...');

  // BSE lists active scripts
  const res = await axios.get('https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=A&flag=true', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://www.bseindia.com',
    },
    timeout: 15000,
  });

  const stocks = (res.data || []).map(s => ({
    symbol: s.SCRIP_CD || s.scrip_id,
    company_name: s.LONG_NAME || s.Scrip_Name || s.SCRIP_CD,
    exchange: 'BSE',
    sector: s.Industry || null,
    is_active: true,
  })).filter(s => s.symbol);

  console.log(`[Seed] BSE: ${stocks.length} stocks fetched`);
  return stocks;
}

// ─── Static NIFTY 50 + Next 50 fallback ─────────────────────────────────────

function getStaticStocks() {
  console.log('[Seed] Using static stock list...');
  const stocks = [
    // NIFTY 50
    { symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'TCS', company_name: 'Tata Consultancy Services Ltd', sector: 'Information Technology' },
    { symbol: 'HDFCBANK', company_name: 'HDFC Bank Ltd', sector: 'Financial Services' },
    { symbol: 'INFY', company_name: 'Infosys Ltd', sector: 'Information Technology' },
    { symbol: 'ICICIBANK', company_name: 'ICICI Bank Ltd', sector: 'Financial Services' },
    { symbol: 'HINDUNILVR', company_name: 'Hindustan Unilever Ltd', sector: 'FMCG' },
    { symbol: 'SBIN', company_name: 'State Bank of India', sector: 'Financial Services' },
    { symbol: 'BHARTIARTL', company_name: 'Bharti Airtel Ltd', sector: 'Telecommunication' },
    { symbol: 'ITC', company_name: 'ITC Ltd', sector: 'FMCG' },
    { symbol: 'KOTAKBANK', company_name: 'Kotak Mahindra Bank Ltd', sector: 'Financial Services' },
    { symbol: 'LT', company_name: 'Larsen & Toubro Ltd', sector: 'Construction' },
    { symbol: 'AXISBANK', company_name: 'Axis Bank Ltd', sector: 'Financial Services' },
    { symbol: 'BAJFINANCE', company_name: 'Bajaj Finance Ltd', sector: 'Financial Services' },
    { symbol: 'ASIANPAINT', company_name: 'Asian Paints Ltd', sector: 'Consumer Durables' },
    { symbol: 'MARUTI', company_name: 'Maruti Suzuki India Ltd', sector: 'Automobile' },
    { symbol: 'TITAN', company_name: 'Titan Company Ltd', sector: 'Consumer Durables' },
    { symbol: 'SUNPHARMA', company_name: 'Sun Pharmaceutical Industries', sector: 'Healthcare' },
    { symbol: 'HCLTECH', company_name: 'HCL Technologies Ltd', sector: 'Information Technology' },
    { symbol: 'WIPRO', company_name: 'Wipro Ltd', sector: 'Information Technology' },
    { symbol: 'TATAMOTORS', company_name: 'Tata Motors Ltd', sector: 'Automobile' },
    { symbol: 'ULTRACEMCO', company_name: 'UltraTech Cement Ltd', sector: 'Construction Materials' },
    { symbol: 'NTPC', company_name: 'NTPC Ltd', sector: 'Power' },
    { symbol: 'NESTLEIND', company_name: 'Nestle India Ltd', sector: 'FMCG' },
    { symbol: 'POWERGRID', company_name: 'Power Grid Corp of India', sector: 'Power' },
    { symbol: 'M&M', company_name: 'Mahindra & Mahindra Ltd', sector: 'Automobile' },
    { symbol: 'TATASTEEL', company_name: 'Tata Steel Ltd', sector: 'Metals & Mining' },
    { symbol: 'TECHM', company_name: 'Tech Mahindra Ltd', sector: 'Information Technology' },
    { symbol: 'ONGC', company_name: 'Oil & Natural Gas Corp', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'JSWSTEEL', company_name: 'JSW Steel Ltd', sector: 'Metals & Mining' },
    { symbol: 'COALINDIA', company_name: 'Coal India Ltd', sector: 'Metals & Mining' },
    { symbol: 'ADANIENT', company_name: 'Adani Enterprises Ltd', sector: 'Metals & Mining' },
    { symbol: 'BAJAJFINSV', company_name: 'Bajaj Finserv Ltd', sector: 'Financial Services' },
    { symbol: 'GRASIM', company_name: 'Grasim Industries Ltd', sector: 'Construction Materials' },
    { symbol: 'DRREDDY', company_name: 'Dr. Reddys Laboratories', sector: 'Healthcare' },
    { symbol: 'CIPLA', company_name: 'Cipla Ltd', sector: 'Healthcare' },
    { symbol: 'DIVISLAB', company_name: 'Divis Laboratories Ltd', sector: 'Healthcare' },
    { symbol: 'BPCL', company_name: 'Bharat Petroleum Corp Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'EICHERMOT', company_name: 'Eicher Motors Ltd', sector: 'Automobile' },
    { symbol: 'BRITANNIA', company_name: 'Britannia Industries Ltd', sector: 'FMCG' },
    { symbol: 'APOLLOHOSP', company_name: 'Apollo Hospitals Enterprise', sector: 'Healthcare' },
    { symbol: 'INDUSINDBK', company_name: 'IndusInd Bank Ltd', sector: 'Financial Services' },
    { symbol: 'HEROMOTOCO', company_name: 'Hero MotoCorp Ltd', sector: 'Automobile' },
    { symbol: 'HINDALCO', company_name: 'Hindalco Industries Ltd', sector: 'Metals & Mining' },
    { symbol: 'TATACONSUM', company_name: 'Tata Consumer Products Ltd', sector: 'FMCG' },
    { symbol: 'SBILIFE', company_name: 'SBI Life Insurance Co', sector: 'Financial Services' },
    { symbol: 'HDFCLIFE', company_name: 'HDFC Life Insurance Co', sector: 'Financial Services' },
    { symbol: 'BAJAJ-AUTO', company_name: 'Bajaj Auto Ltd', sector: 'Automobile' },
    { symbol: 'ADANIPORTS', company_name: 'Adani Ports & SEZ Ltd', sector: 'Services' },
    { symbol: 'WIPRO', company_name: 'Wipro Ltd', sector: 'Information Technology' },
    { symbol: 'UPL', company_name: 'UPL Ltd', sector: 'Chemicals' },
    // NIFTY Next 50
    { symbol: 'AMBUJACEM', company_name: 'Ambuja Cements Ltd', sector: 'Construction Materials' },
    { symbol: 'BANKBARODA', company_name: 'Bank of Baroda', sector: 'Financial Services' },
    { symbol: 'BERGEPAINT', company_name: 'Berger Paints India Ltd', sector: 'Consumer Durables' },
    { symbol: 'BIOCON', company_name: 'Biocon Ltd', sector: 'Healthcare' },
    { symbol: 'CHOLAFIN', company_name: 'Cholamandalam Investment', sector: 'Financial Services' },
    { symbol: 'COLPAL', company_name: 'Colgate Palmolive India', sector: 'FMCG' },
    { symbol: 'DLF', company_name: 'DLF Ltd', sector: 'Realty' },
    { symbol: 'DABUR', company_name: 'Dabur India Ltd', sector: 'FMCG' },
    { symbol: 'GAIL', company_name: 'GAIL India Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'GODREJCP', company_name: 'Godrej Consumer Products', sector: 'FMCG' },
    { symbol: 'HAVELLS', company_name: 'Havells India Ltd', sector: 'Consumer Durables' },
    { symbol: 'ICICIPRULI', company_name: 'ICICI Prudential Life', sector: 'Financial Services' },
    { symbol: 'IOC', company_name: 'Indian Oil Corp Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'IRCTC', company_name: 'Indian Railway Catering & Tourism', sector: 'Services' },
    { symbol: 'JINDALSTEL', company_name: 'Jindal Steel & Power', sector: 'Metals & Mining' },
    { symbol: 'LUPIN', company_name: 'Lupin Ltd', sector: 'Healthcare' },
    { symbol: 'MARICO', company_name: 'Marico Ltd', sector: 'FMCG' },
    { symbol: 'MUTHOOTFIN', company_name: 'Muthoot Finance Ltd', sector: 'Financial Services' },
    { symbol: 'NAUKRI', company_name: 'Info Edge India Ltd', sector: 'Information Technology' },
    { symbol: 'PEL', company_name: 'Piramal Enterprises Ltd', sector: 'Financial Services' },
    { symbol: 'PIDILITIND', company_name: 'Pidilite Industries Ltd', sector: 'Chemicals' },
    { symbol: 'PNB', company_name: 'Punjab National Bank', sector: 'Financial Services' },
    { symbol: 'SAIL', company_name: 'Steel Authority of India', sector: 'Metals & Mining' },
    { symbol: 'SHREECEM', company_name: 'Shree Cement Ltd', sector: 'Construction Materials' },
    { symbol: 'SIEMENS', company_name: 'Siemens Ltd', sector: 'Capital Goods' },
    { symbol: 'SRF', company_name: 'SRF Ltd', sector: 'Chemicals' },
    { symbol: 'TORNTPHARM', company_name: 'Torrent Pharmaceuticals', sector: 'Healthcare' },
    { symbol: 'TRENT', company_name: 'Trent Ltd', sector: 'Consumer Durables' },
    { symbol: 'VEDL', company_name: 'Vedanta Ltd', sector: 'Metals & Mining' },
    { symbol: 'ZOMATO', company_name: 'Zomato Ltd', sector: 'Consumer Services' },
    // Additional popular stocks
    { symbol: 'ADANIGREEN', company_name: 'Adani Green Energy Ltd', sector: 'Power' },
    { symbol: 'ADANIPOWER', company_name: 'Adani Power Ltd', sector: 'Power' },
    { symbol: 'ATGL', company_name: 'Adani Total Gas Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'AWL', company_name: 'Adani Wilmar Ltd', sector: 'FMCG' },
    { symbol: 'CANBK', company_name: 'Canara Bank', sector: 'Financial Services' },
    { symbol: 'FEDERALBNK', company_name: 'Federal Bank Ltd', sector: 'Financial Services' },
    { symbol: 'IDFCFIRSTB', company_name: 'IDFC First Bank Ltd', sector: 'Financial Services' },
    { symbol: 'INDHOTEL', company_name: 'Indian Hotels Company', sector: 'Consumer Services' },
    { symbol: 'LICI', company_name: 'Life Insurance Corp of India', sector: 'Financial Services' },
    { symbol: 'LTIM', company_name: 'LTIMindtree Ltd', sector: 'Information Technology' },
    { symbol: 'MAXHEALTH', company_name: 'Max Healthcare Institute', sector: 'Healthcare' },
    { symbol: 'NHPC', company_name: 'NHPC Ltd', sector: 'Power' },
    { symbol: 'PAYTM', company_name: 'One97 Communications Ltd', sector: 'Financial Services' },
    { symbol: 'PERSISTENT', company_name: 'Persistent Systems Ltd', sector: 'Information Technology' },
    { symbol: 'POLYCAB', company_name: 'Polycab India Ltd', sector: 'Capital Goods' },
    { symbol: 'RECLTD', company_name: 'REC Ltd', sector: 'Financial Services' },
    { symbol: 'TATAELXSI', company_name: 'Tata Elxsi Ltd', sector: 'Information Technology' },
    { symbol: 'TATAPOWER', company_name: 'Tata Power Company Ltd', sector: 'Power' },
    { symbol: 'VOLTAS', company_name: 'Voltas Ltd', sector: 'Consumer Durables' },
    { symbol: 'ZYDUSLIFE', company_name: 'Zydus Lifesciences Ltd', sector: 'Healthcare' },
  ];

  // Deduplicate by symbol
  const seen = new Set();
  const unique = stocks.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  return unique.map(s => ({ ...s, exchange: 'NSE', is_active: true }));
}

// ─── Upsert to Supabase ────────────────────────────────────────────────────

async function upsertStocks(stocks) {
  if (stocks.length === 0) {
    console.log('[Seed] No stocks to upsert.');
    return;
  }

  // Upsert in batches of 200
  const batchSize = 200;
  let total = 0;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    const { error } = await supabase
      .from('stocks_master')
      .upsert(batch, { onConflict: 'symbol', ignoreDuplicates: false });

    if (error) {
      console.error(`[Seed] Upsert error (batch ${Math.floor(i / batchSize) + 1}):`, error.message);
    } else {
      total += batch.length;
      console.log(`[Seed] Upserted batch ${Math.floor(i / batchSize) + 1}: ${batch.length} stocks`);
    }
  }

  console.log(`[Seed] Total upserted: ${total} stocks`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Seed] Starting stocks_master seed...\n');

  let allStocks = [];

  if (useStaticOnly) {
    allStocks = getStaticStocks();
  } else {
    // Try NSE
    try {
      const nse = await fetchNSEStocks();
      allStocks.push(...nse);
    } catch (err) {
      console.warn(`[Seed] NSE fetch failed: ${err.message}`);
      console.warn('[Seed] This is expected outside India — NSE blocks non-Indian IPs.\n');
    }

    // Try BSE
    try {
      const bse = await fetchBSEStocks();
      allStocks.push(...bse);
    } catch (err) {
      console.warn(`[Seed] BSE fetch failed: ${err.message}\n`);
    }

    // Fallback to static if both APIs failed
    if (allStocks.length === 0) {
      console.log('[Seed] Both APIs failed. Using static fallback list.\n');
      allStocks = getStaticStocks();
    }
  }

  // Deduplicate by symbol (NSE takes priority)
  const map = new Map();
  for (const s of allStocks) {
    if (!map.has(s.symbol)) {
      map.set(s.symbol, s);
    }
  }
  const unique = Array.from(map.values());

  console.log(`\n[Seed] ${unique.length} unique stocks ready to upsert.\n`);
  await upsertStocks(unique);

  console.log('\n[Seed] Done!');
  process.exit(0);
}

main().catch(err => {
  console.error('[Seed] Fatal error:', err);
  process.exit(1);
});
