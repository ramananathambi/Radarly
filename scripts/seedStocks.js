/**
 * seedStocks.js
 * Populates stocks_master from NSE + BSE public APIs.
 * Run: node scripts/seedStocks.js
 *
 * Strategy:
 *   1. Try fetching from multiple NSE indices (NIFTY 500, MIDCAP 150, SMALLCAP 250, TOTAL MARKET)
 *   2. Try fetching from multiple BSE groups (A, B, T)
 *   3. Fall back to built-in 500+ stock list if APIs fail
 *
 * Usage:
 *   node scripts/seedStocks.js          — fetch from APIs (run from Indian IP)
 *   node scripts/seedStocks.js --static — use built-in static list only
 */

require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST,
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port:     parseInt(process.env.MYSQL_PORT) || 3306,
  waitForConnections: true,
  connectionLimit:    5,
  queueLimit:         0,
});

const useStaticOnly = process.argv.includes('--static');

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
};

const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.bseindia.com',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── NSE Session ──────────────────────────────────────────────────────────────

async function getNSESession() {
  console.log('[NSE] Getting session cookie...');
  const session = await axios.get('https://www.nseindia.com', {
    headers: {
      ...NSE_HEADERS,
      'Accept': 'text/html',
    },
    timeout: 10000,
  });
  const cookies = (session.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  await sleep(2000);
  return cookies;
}

// ─── NSE Index Fetcher ────────────────────────────────────────────────────────

async function fetchNSEIndex(indexName, cookies) {
  const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(indexName)}`;
  const res = await axios.get(url, {
    headers: { ...NSE_HEADERS, 'Cookie': cookies },
    timeout: 15000,
  });

  const stocks = (res.data?.data || [])
    .filter(s => s.symbol && s.symbol !== indexName)
    .map(s => ({
      symbol: s.symbol,
      company_name: s.companyName || s.symbol,
      exchange: 'NSE',
      sector: s.industry || null,
      is_active: true,
    }));

  return stocks;
}

async function fetchNSEStocks() {
  console.log('[Seed] Fetching NSE stocks from multiple indices...');
  const cookies = await getNSESession();

  const indices = [
    'NIFTY 500',
    'NIFTY TOTAL MARKET',
    'NIFTY MIDCAP 150',
    'NIFTY SMALLCAP 250',
    'NIFTY MICROCAP 250',
  ];

  const allStocks = [];

  for (const index of indices) {
    try {
      console.log(`[NSE] Fetching ${index}...`);
      const stocks = await fetchNSEIndex(index, cookies);
      console.log(`[NSE] ${index}: ${stocks.length} stocks`);
      allStocks.push(...stocks);
      await sleep(1500); // Rate limit
    } catch (err) {
      console.warn(`[NSE] ${index} failed: ${err.message}`);
    }
  }

  // Deduplicate
  const map = new Map();
  for (const s of allStocks) {
    if (!map.has(s.symbol)) map.set(s.symbol, s);
  }

  const unique = Array.from(map.values());
  console.log(`[Seed] NSE total: ${unique.length} unique stocks`);
  return unique;
}

// ─── BSE Fetcher ────────────────────────────────────────────────────────────

async function fetchBSEGroup(group) {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=${group}&flag=true`;
  const res = await axios.get(url, {
    headers: BSE_HEADERS,
    timeout: 15000,
  });

  return (res.data || [])
    .map(s => ({
      symbol: s.SCRIP_CD || s.scrip_id,
      company_name: s.LONG_NAME || s.Scrip_Name || s.SCRIP_CD,
      exchange: 'BSE',
      sector: s.Industry || null,
      is_active: true,
    }))
    .filter(s => s.symbol);
}

async function fetchBSEStocks() {
  console.log('[Seed] Fetching BSE stocks from multiple groups...');
  const groups = ['A', 'B', 'T'];
  const allStocks = [];

  for (const group of groups) {
    try {
      console.log(`[BSE] Fetching Group ${group}...`);
      const stocks = await fetchBSEGroup(group);
      console.log(`[BSE] Group ${group}: ${stocks.length} stocks`);
      allStocks.push(...stocks);
      await sleep(1000);
    } catch (err) {
      console.warn(`[BSE] Group ${group} failed: ${err.message}`);
    }
  }

  // Deduplicate
  const map = new Map();
  for (const s of allStocks) {
    if (!map.has(s.symbol)) map.set(s.symbol, s);
  }

  const unique = Array.from(map.values());
  console.log(`[Seed] BSE total: ${unique.length} unique stocks`);
  return unique;
}

// ─── Static Fallback (500+ stocks) ──────────────────────────────────────────

function getStaticStocks() {
  console.log('[Seed] Using static stock list (500+ stocks)...');
  const stocks = [
    // ──── NIFTY 50 ────
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
    { symbol: 'UPL', company_name: 'UPL Ltd', sector: 'Chemicals' },
    { symbol: 'SHRIRAMFIN', company_name: 'Shriram Finance Ltd', sector: 'Financial Services' },
    // ──── NIFTY Next 50 ────
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
    // ──── NIFTY Midcap 150 (additional) ────
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
    { symbol: 'ICICIGI', company_name: 'ICICI Lombard General Insurance', sector: 'Financial Services' },
    { symbol: 'NYKAA', company_name: 'FSN E-Commerce Ventures', sector: 'Consumer Services' },
    { symbol: 'DELHIVERY', company_name: 'Delhivery Ltd', sector: 'Services' },
    { symbol: 'POLICYBZR', company_name: 'PB Fintech Ltd', sector: 'Financial Services' },
    { symbol: 'STARHEALTH', company_name: 'Star Health Insurance', sector: 'Financial Services' },
    { symbol: 'PIIND', company_name: 'PI Industries Ltd', sector: 'Chemicals' },
    { symbol: 'MCDOWELL-N', company_name: 'United Spirits Ltd', sector: 'FMCG' },
    { symbol: 'PAGEIND', company_name: 'Page Industries Ltd', sector: 'Textiles' },
    { symbol: 'ASTRAL', company_name: 'Astral Ltd', sector: 'Capital Goods' },
    { symbol: 'OFSS', company_name: 'Oracle Financial Services', sector: 'Information Technology' },
    { symbol: 'AUROPHARMA', company_name: 'Aurobindo Pharma Ltd', sector: 'Healthcare' },
    { symbol: 'CUMMINSIND', company_name: 'Cummins India Ltd', sector: 'Capital Goods' },
    { symbol: 'MPHASIS', company_name: 'MphasiS Ltd', sector: 'Information Technology' },
    { symbol: 'COFORGE', company_name: 'Coforge Ltd', sector: 'Information Technology' },
    { symbol: 'ABCAPITAL', company_name: 'Aditya Birla Capital Ltd', sector: 'Financial Services' },
    { symbol: 'GODREJPROP', company_name: 'Godrej Properties Ltd', sector: 'Realty' },
    { symbol: 'OBEROIRLTY', company_name: 'Oberoi Realty Ltd', sector: 'Realty' },
    { symbol: 'PHOENIXLTD', company_name: 'Phoenix Mills Ltd', sector: 'Realty' },
    { symbol: 'PRESTIGE', company_name: 'Prestige Estates Projects', sector: 'Realty' },
    { symbol: 'LODHA', company_name: 'Macrotech Developers Ltd', sector: 'Realty' },
    { symbol: 'SOBHA', company_name: 'Sobha Ltd', sector: 'Realty' },
    { symbol: 'BRIGADE', company_name: 'Brigade Enterprises Ltd', sector: 'Realty' },
    { symbol: 'TORNTPOWER', company_name: 'Torrent Power Ltd', sector: 'Power' },
    { symbol: 'CESC', company_name: 'CESC Ltd', sector: 'Power' },
    { symbol: 'JSWENERGY', company_name: 'JSW Energy Ltd', sector: 'Power' },
    { symbol: 'SJVN', company_name: 'SJVN Ltd', sector: 'Power' },
    { symbol: 'IREDA', company_name: 'Indian Renewable Energy Dev Agency', sector: 'Financial Services' },
    { symbol: 'PFC', company_name: 'Power Finance Corp Ltd', sector: 'Financial Services' },
    { symbol: 'HUDCO', company_name: 'Housing & Urban Development Corp', sector: 'Financial Services' },
    { symbol: 'IRFC', company_name: 'Indian Railway Finance Corp', sector: 'Financial Services' },
    { symbol: 'CANFINHOME', company_name: 'Can Fin Homes Ltd', sector: 'Financial Services' },
    { symbol: 'LICHSGFIN', company_name: 'LIC Housing Finance Ltd', sector: 'Financial Services' },
    { symbol: 'MANAPPURAM', company_name: 'Manappuram Finance Ltd', sector: 'Financial Services' },
    { symbol: 'POONAWALLA', company_name: 'Poonawalla Fincorp Ltd', sector: 'Financial Services' },
    { symbol: 'AUBANK', company_name: 'AU Small Finance Bank', sector: 'Financial Services' },
    { symbol: 'BANDHANBNK', company_name: 'Bandhan Bank Ltd', sector: 'Financial Services' },
    { symbol: 'IDBI', company_name: 'IDBI Bank Ltd', sector: 'Financial Services' },
    { symbol: 'UNIONBANK', company_name: 'Union Bank of India', sector: 'Financial Services' },
    { symbol: 'INDIANB', company_name: 'Indian Bank', sector: 'Financial Services' },
    { symbol: 'IOB', company_name: 'Indian Overseas Bank', sector: 'Financial Services' },
    { symbol: 'CENTRALBK', company_name: 'Central Bank of India', sector: 'Financial Services' },
    { symbol: 'UCOBANK', company_name: 'UCO Bank', sector: 'Financial Services' },
    { symbol: 'YESBANK', company_name: 'Yes Bank Ltd', sector: 'Financial Services' },
    { symbol: 'RBLBANK', company_name: 'RBL Bank Ltd', sector: 'Financial Services' },
    { symbol: 'KARURVYSYA', company_name: 'Karur Vysya Bank Ltd', sector: 'Financial Services' },
    { symbol: 'SOUTHBANK', company_name: 'South Indian Bank', sector: 'Financial Services' },
    { symbol: 'TMB', company_name: 'Tamilnad Mercantile Bank', sector: 'Financial Services' },
    { symbol: 'CUB', company_name: 'City Union Bank Ltd', sector: 'Financial Services' },
    { symbol: 'MAHABANK', company_name: 'Bank of Maharashtra', sector: 'Financial Services' },
    // ──── IT / Tech ────
    { symbol: 'LTTS', company_name: 'L&T Technology Services', sector: 'Information Technology' },
    { symbol: 'KPITTECH', company_name: 'KPIT Technologies Ltd', sector: 'Information Technology' },
    { symbol: 'CYIENT', company_name: 'Cyient Ltd', sector: 'Information Technology' },
    { symbol: 'ZENSAR', company_name: 'Zensar Technologies Ltd', sector: 'Information Technology' },
    { symbol: 'BIRLASOFT', company_name: 'Birlasoft Ltd', sector: 'Information Technology' },
    { symbol: 'SONATSOFTW', company_name: 'Sonata Software Ltd', sector: 'Information Technology' },
    { symbol: 'MASTEK', company_name: 'Mastek Ltd', sector: 'Information Technology' },
    { symbol: 'HAPPSTMNDS', company_name: 'Happiest Minds Technologies', sector: 'Information Technology' },
    { symbol: 'ROUTE', company_name: 'Route Mobile Ltd', sector: 'Information Technology' },
    { symbol: 'TANLA', company_name: 'Tanla Platforms Ltd', sector: 'Information Technology' },
    // ──── Pharma / Healthcare ────
    { symbol: 'ABBOTINDIA', company_name: 'Abbott India Ltd', sector: 'Healthcare' },
    { symbol: 'SANOFI', company_name: 'Sanofi India Ltd', sector: 'Healthcare' },
    { symbol: 'PFIZER', company_name: 'Pfizer Ltd', sector: 'Healthcare' },
    { symbol: 'GLAXO', company_name: 'GlaxoSmithKline Pharma', sector: 'Healthcare' },
    { symbol: 'IPCALAB', company_name: 'IPCA Laboratories Ltd', sector: 'Healthcare' },
    { symbol: 'ALKEM', company_name: 'Alkem Laboratories Ltd', sector: 'Healthcare' },
    { symbol: 'LAURUSLABS', company_name: 'Laurus Labs Ltd', sector: 'Healthcare' },
    { symbol: 'GLENMARK', company_name: 'Glenmark Pharmaceuticals', sector: 'Healthcare' },
    { symbol: 'NATCOPHARMA', company_name: 'Natco Pharma Ltd', sector: 'Healthcare' },
    { symbol: 'METROPOLIS', company_name: 'Metropolis Healthcare', sector: 'Healthcare' },
    { symbol: 'LALPATHLAB', company_name: 'Dr Lal PathLabs Ltd', sector: 'Healthcare' },
    { symbol: 'FORTIS', company_name: 'Fortis Healthcare Ltd', sector: 'Healthcare' },
    { symbol: 'MEDANTA', company_name: 'Global Health Ltd', sector: 'Healthcare' },
    { symbol: 'YATHARTH', company_name: 'Yatharth Hospital', sector: 'Healthcare' },
    { symbol: 'GRANULES', company_name: 'Granules India Ltd', sector: 'Healthcare' },
    { symbol: 'AJANTPHARM', company_name: 'Ajanta Pharma Ltd', sector: 'Healthcare' },
    { symbol: 'JBCHEPHARM', company_name: 'JB Chemicals & Pharma', sector: 'Healthcare' },
    // ──── Auto & Auto Ancillary ────
    { symbol: 'ASHOKLEY', company_name: 'Ashok Leyland Ltd', sector: 'Automobile' },
    { symbol: 'TVSMOTOR', company_name: 'TVS Motor Company Ltd', sector: 'Automobile' },
    { symbol: 'MOTHERSON', company_name: 'Samvardhana Motherson', sector: 'Automobile' },
    { symbol: 'BOSCHLTD', company_name: 'Bosch Ltd', sector: 'Automobile' },
    { symbol: 'MRF', company_name: 'MRF Ltd', sector: 'Automobile' },
    { symbol: 'BALKRISIND', company_name: 'Balkrishna Industries', sector: 'Automobile' },
    { symbol: 'APOLLOTYRE', company_name: 'Apollo Tyres Ltd', sector: 'Automobile' },
    { symbol: 'EXIDEIND', company_name: 'Exide Industries Ltd', sector: 'Automobile' },
    { symbol: 'AMARAJABAT', company_name: 'Amara Raja Energy', sector: 'Automobile' },
    { symbol: 'SONACOMS', company_name: 'Sona BLW Precision', sector: 'Automobile' },
    { symbol: 'TIINDIA', company_name: 'Tube Investments of India', sector: 'Automobile' },
    { symbol: 'SCHAEFFLER', company_name: 'Schaeffler India Ltd', sector: 'Automobile' },
    { symbol: 'SKFINDIA', company_name: 'SKF India Ltd', sector: 'Automobile' },
    { symbol: 'SUNDRMFAST', company_name: 'Sundram Fasteners Ltd', sector: 'Automobile' },
    { symbol: 'BHARATFORG', company_name: 'Bharat Forge Ltd', sector: 'Capital Goods' },
    // ──── Capital Goods / Industrials ────
    { symbol: 'ABB', company_name: 'ABB India Ltd', sector: 'Capital Goods' },
    { symbol: 'BHEL', company_name: 'Bharat Heavy Electricals', sector: 'Capital Goods' },
    { symbol: 'HAL', company_name: 'Hindustan Aeronautics', sector: 'Capital Goods' },
    { symbol: 'BEL', company_name: 'Bharat Electronics Ltd', sector: 'Capital Goods' },
    { symbol: 'THERMAX', company_name: 'Thermax Ltd', sector: 'Capital Goods' },
    { symbol: 'KAYNES', company_name: 'Kaynes Technology India', sector: 'Capital Goods' },
    { symbol: 'COCHINSHIP', company_name: 'Cochin Shipyard Ltd', sector: 'Capital Goods' },
    { symbol: 'MAZAGONDOCK', company_name: 'Mazagon Dock Shipbuilders', sector: 'Capital Goods' },
    { symbol: 'GRSE', company_name: 'Garden Reach Shipbuilders', sector: 'Capital Goods' },
    { symbol: 'BDL', company_name: 'Bharat Dynamics Ltd', sector: 'Capital Goods' },
    { symbol: 'SOLARINDS', company_name: 'Solar Industries India', sector: 'Capital Goods' },
    { symbol: 'HONAUT', company_name: 'Honeywell Automation India', sector: 'Capital Goods' },
    { symbol: 'AIAENG', company_name: 'AIA Engineering Ltd', sector: 'Capital Goods' },
    { symbol: 'CGPOWER', company_name: 'CG Power and Industrial', sector: 'Capital Goods' },
    { symbol: 'ELGIEQUIP', company_name: 'Elgi Equipments Ltd', sector: 'Capital Goods' },
    { symbol: 'GRINFRA', company_name: 'G R Infraprojects Ltd', sector: 'Capital Goods' },
    { symbol: 'KEC', company_name: 'KEC International Ltd', sector: 'Capital Goods' },
    { symbol: 'KALPATPOWR', company_name: 'Kalpataru Projects Intl', sector: 'Capital Goods' },
    // ──── FMCG ────
    { symbol: 'GODREJIND', company_name: 'Godrej Industries Ltd', sector: 'FMCG' },
    { symbol: 'EMAMILTD', company_name: 'Emami Ltd', sector: 'FMCG' },
    { symbol: 'TATAELXSI', company_name: 'Tata Elxsi Ltd', sector: 'Information Technology' },
    { symbol: 'VBL', company_name: 'Varun Beverages Ltd', sector: 'FMCG' },
    { symbol: 'RADICO', company_name: 'Radico Khaitan Ltd', sector: 'FMCG' },
    { symbol: 'PGHH', company_name: 'Procter & Gamble Hygiene', sector: 'FMCG' },
    { symbol: 'GILLETTE', company_name: 'Gillette India Ltd', sector: 'FMCG' },
    { symbol: 'JUBLFOOD', company_name: 'Jubilant Foodworks Ltd', sector: 'Consumer Services' },
    { symbol: 'DEVYANI', company_name: 'Devyani International', sector: 'Consumer Services' },
    { symbol: 'SAPPHIRE', company_name: 'Sapphire Foods India', sector: 'Consumer Services' },
    { symbol: 'BIKAJI', company_name: 'Bikaji Foods International', sector: 'FMCG' },
    { symbol: 'PATANJALI', company_name: 'Patanjali Foods Ltd', sector: 'FMCG' },
    { symbol: 'ATUL', company_name: 'Atul Ltd', sector: 'Chemicals' },
    { symbol: 'DEEPAKFERT', company_name: 'Deepak Fertilisers', sector: 'Chemicals' },
    { symbol: 'DEEPAKNTR', company_name: 'Deepak Nitrite Ltd', sector: 'Chemicals' },
    { symbol: 'CLEAN', company_name: 'Clean Science & Technology', sector: 'Chemicals' },
    // ──── Metals & Mining ────
    { symbol: 'NMDC', company_name: 'NMDC Ltd', sector: 'Metals & Mining' },
    { symbol: 'NATIONALUM', company_name: 'National Aluminium Co', sector: 'Metals & Mining' },
    { symbol: 'MOIL', company_name: 'MOIL Ltd', sector: 'Metals & Mining' },
    { symbol: 'RATNAMANI', company_name: 'Ratnamani Metals & Tubes', sector: 'Metals & Mining' },
    { symbol: 'APLAPOLLO', company_name: 'APL Apollo Tubes Ltd', sector: 'Metals & Mining' },
    { symbol: 'JSWINFRA', company_name: 'JSW Infrastructure Ltd', sector: 'Services' },
    { symbol: 'WELCORP', company_name: 'Welspun Corp Ltd', sector: 'Metals & Mining' },
    // ──── Oil & Gas ────
    { symbol: 'HINDPETRO', company_name: 'Hindustan Petroleum Corp', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'PETRONET', company_name: 'Petronet LNG Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'MGL', company_name: 'Mahanagar Gas Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'IGL', company_name: 'Indraprastha Gas Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'GUJGASLTD', company_name: 'Gujarat Gas Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'OIL', company_name: 'Oil India Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'MRPL', company_name: 'Mangalore Refinery', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'CHENNPETRO', company_name: 'Chennai Petroleum Corp', sector: 'Oil Gas & Consumable Fuels' },
    // ──── Cement ────
    { symbol: 'ACC', company_name: 'ACC Ltd', sector: 'Construction Materials' },
    { symbol: 'RAMCOCEM', company_name: 'Ramco Cements Ltd', sector: 'Construction Materials' },
    { symbol: 'JKCEMENT', company_name: 'JK Cement Ltd', sector: 'Construction Materials' },
    { symbol: 'DALBHARAT', company_name: 'Dalmia Bharat Ltd', sector: 'Construction Materials' },
    { symbol: 'JKLAKSHMI', company_name: 'JK Lakshmi Cement Ltd', sector: 'Construction Materials' },
    { symbol: 'BIRLACEM', company_name: 'Nuvoco Vistas Corp Ltd', sector: 'Construction Materials' },
    { symbol: 'STARCEMENT', company_name: 'Star Cement Ltd', sector: 'Construction Materials' },
    // ──── Telecom / Media ────
    { symbol: 'IDEA', company_name: 'Vodafone Idea Ltd', sector: 'Telecommunication' },
    { symbol: 'TATACOMM', company_name: 'Tata Communications', sector: 'Telecommunication' },
    { symbol: 'ZEEL', company_name: 'Zee Entertainment', sector: 'Media' },
    { symbol: 'SUNTV', company_name: 'Sun TV Network Ltd', sector: 'Media' },
    { symbol: 'PVR', company_name: 'PVR INOX Ltd', sector: 'Media' },
    // ──── Infra / Construction ────
    { symbol: 'IRCON', company_name: 'Ircon International Ltd', sector: 'Construction' },
    { symbol: 'NBCC', company_name: 'NBCC India Ltd', sector: 'Construction' },
    { symbol: 'NCC', company_name: 'NCC Ltd', sector: 'Construction' },
    { symbol: 'RVNL', company_name: 'Rail Vikas Nigam Ltd', sector: 'Construction' },
    { symbol: 'RAILTEL', company_name: 'RailTel Corporation', sector: 'Information Technology' },
    { symbol: 'CONCOR', company_name: 'Container Corp of India', sector: 'Services' },
    // ──── Consumer Durables ────
    { symbol: 'BATAINDIA', company_name: 'Bata India Ltd', sector: 'Consumer Durables' },
    { symbol: 'WHIRLPOOL', company_name: 'Whirlpool of India Ltd', sector: 'Consumer Durables' },
    { symbol: 'CROMPTON', company_name: 'Crompton Greaves Consumer', sector: 'Consumer Durables' },
    { symbol: 'BLUESTARCO', company_name: 'Blue Star Ltd', sector: 'Consumer Durables' },
    { symbol: 'DIXON', company_name: 'Dixon Technologies Ltd', sector: 'Consumer Durables' },
    { symbol: 'KAJARIACER', company_name: 'Kajaria Ceramics Ltd', sector: 'Consumer Durables' },
    { symbol: 'CENTURYTEX', company_name: 'Century Textiles', sector: 'Consumer Durables' },
    { symbol: 'RELAXO', company_name: 'Relaxo Footwears Ltd', sector: 'Consumer Durables' },
    { symbol: 'METROBRAND', company_name: 'Metro Brands Ltd', sector: 'Consumer Durables' },
    { symbol: 'CAMPUS', company_name: 'Campus Activewear Ltd', sector: 'Consumer Durables' },
    // ──── Insurance ────
    { symbol: 'GICRE', company_name: 'General Insurance Corp', sector: 'Financial Services' },
    { symbol: 'NIACL', company_name: 'New India Assurance Co', sector: 'Financial Services' },
    // ──── Miscellaneous / Services ────
    { symbol: 'DMART', company_name: 'Avenue Supermarts Ltd', sector: 'Consumer Services' },
    { symbol: 'TATACOMM', company_name: 'Tata Communications', sector: 'Telecommunication' },
    { symbol: 'GNFC', company_name: 'Gujarat Narmada Valley', sector: 'Chemicals' },
    { symbol: 'GSFC', company_name: 'Gujarat State Fertilizers', sector: 'Chemicals' },
    { symbol: 'CHAMBLFERT', company_name: 'Chambal Fertilisers', sector: 'Chemicals' },
    { symbol: 'COROMANDEL', company_name: 'Coromandel International', sector: 'Chemicals' },
    { symbol: 'SUMICHEM', company_name: 'Sumitomo Chemical India', sector: 'Chemicals' },
    { symbol: 'AAVAS', company_name: 'Aavas Financiers Ltd', sector: 'Financial Services' },
    { symbol: 'AARTIIND', company_name: 'Aarti Industries Ltd', sector: 'Chemicals' },
    { symbol: 'ABFRL', company_name: 'Aditya Birla Fashion', sector: 'Consumer Durables' },
    { symbol: 'ABSLAMC', company_name: 'Aditya Birla Sun Life AMC', sector: 'Financial Services' },
    { symbol: 'AEGISCHEM', company_name: 'Aegis Logistics Ltd', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'AFFLE', company_name: 'Affle India Ltd', sector: 'Information Technology' },
    { symbol: 'ALKYLAMINE', company_name: 'Alkyl Amines Chemicals', sector: 'Chemicals' },
    { symbol: 'ALOKINDS', company_name: 'Alok Industries Ltd', sector: 'Textiles' },
    { symbol: 'ANGELONE', company_name: 'Angel One Ltd', sector: 'Financial Services' },
    { symbol: 'APTUS', company_name: 'Aptus Value Housing Finance', sector: 'Financial Services' },
    { symbol: 'ARE&M', company_name: 'Amara Raja Energy & Mobility', sector: 'Automobile' },
    { symbol: 'ARVIND', company_name: 'Arvind Ltd', sector: 'Textiles' },
    { symbol: 'ASHOKA', company_name: 'Ashoka Buildcon Ltd', sector: 'Construction' },
    { symbol: 'BSOFT', company_name: 'BIRLASOFT Ltd', sector: 'Information Technology' },
    { symbol: 'BSE', company_name: 'BSE Ltd', sector: 'Financial Services' },
    { symbol: 'CANFINHOME', company_name: 'Can Fin Homes Ltd', sector: 'Financial Services' },
    { symbol: 'CARBORUNIV', company_name: 'Carborundum Universal', sector: 'Capital Goods' },
    { symbol: 'CDSL', company_name: 'Central Depository Services', sector: 'Financial Services' },
    { symbol: 'CENTURYPLY', company_name: 'Century Plyboards India', sector: 'Consumer Durables' },
    { symbol: 'CHALET', company_name: 'Chalet Hotels Ltd', sector: 'Consumer Services' },
    { symbol: 'COALINDIA', company_name: 'Coal India Ltd', sector: 'Metals & Mining' },
    { symbol: 'DATAPATTNS', company_name: 'Data Patterns India', sector: 'Capital Goods' },
    { symbol: 'DCMSHRIRAM', company_name: 'DCM Shriram Ltd', sector: 'Chemicals' },
    { symbol: 'ECLERX', company_name: 'eClerx Services Ltd', sector: 'Information Technology' },
    { symbol: 'EIDPARRY', company_name: 'EID Parry India Ltd', sector: 'FMCG' },
    { symbol: 'ESCORTS', company_name: 'Escorts Kubota Ltd', sector: 'Automobile' },
    { symbol: 'FINEORG', company_name: 'Fine Organic Industries', sector: 'Chemicals' },
    { symbol: 'FLUOROCHEM', company_name: 'Gujarat Fluorochemicals', sector: 'Chemicals' },
    { symbol: 'GLAND', company_name: 'Gland Pharma Ltd', sector: 'Healthcare' },
    { symbol: 'GMRAIRPORT', company_name: 'GMR Airports Infra', sector: 'Services' },
    { symbol: 'GODREJAGRO', company_name: 'Godrej Agrovet Ltd', sector: 'FMCG' },
    { symbol: 'GSPL', company_name: 'Gujarat State Petronet', sector: 'Oil Gas & Consumable Fuels' },
    { symbol: 'HEG', company_name: 'HEG Ltd', sector: 'Capital Goods' },
    { symbol: 'HFCL', company_name: 'HFCL Ltd', sector: 'Telecommunication' },
    { symbol: 'HINDCOPPER', company_name: 'Hindustan Copper Ltd', sector: 'Metals & Mining' },
    { symbol: 'HINDZINC', company_name: 'Hindustan Zinc Ltd', sector: 'Metals & Mining' },
    { symbol: 'IDFC', company_name: 'IDFC Ltd', sector: 'Financial Services' },
    { symbol: 'IEX', company_name: 'Indian Energy Exchange', sector: 'Financial Services' },
    { symbol: 'INDIACEM', company_name: 'India Cements Ltd', sector: 'Construction Materials' },
    { symbol: 'INDIGO', company_name: 'InterGlobe Aviation Ltd', sector: 'Services' },
    { symbol: 'INOXWIND', company_name: 'Inox Wind Ltd', sector: 'Capital Goods' },
    { symbol: 'INTELLECT', company_name: 'Intellect Design Arena', sector: 'Information Technology' },
    { symbol: 'JIOFIN', company_name: 'Jio Financial Services Ltd', sector: 'Financial Services' },
    { symbol: 'JKPAPER', company_name: 'JK Paper Ltd', sector: 'Capital Goods' },
    { symbol: 'JMFINANCIL', company_name: 'JM Financial Ltd', sector: 'Financial Services' },
    { symbol: 'JSL', company_name: 'Jindal Stainless Ltd', sector: 'Metals & Mining' },
    { symbol: 'JTEKTINDIA', company_name: 'JTEKT India Ltd', sector: 'Automobile' },
    { symbol: 'JYOTHYLAB', company_name: 'Jyothy Labs Ltd', sector: 'FMCG' },
    { symbol: 'KALYANKJIL', company_name: 'Kalyan Jewellers India', sector: 'Consumer Durables' },
    { symbol: 'KEI', company_name: 'KEI Industries Ltd', sector: 'Capital Goods' },
    { symbol: 'KIMS', company_name: 'Krishna Institute of Medical', sector: 'Healthcare' },
    { symbol: 'KRBL', company_name: 'KRBL Ltd', sector: 'FMCG' },
    { symbol: 'LAXMIMACH', company_name: 'Lakshmi Machine Works', sector: 'Capital Goods' },
    { symbol: 'LLOYDSME', company_name: 'Lloyds Metals & Energy', sector: 'Metals & Mining' },
    { symbol: 'LTFOODS', company_name: 'LT Foods Ltd', sector: 'FMCG' },
    { symbol: 'M&MFIN', company_name: 'Mahindra & Mahindra Financial', sector: 'Financial Services' },
    { symbol: 'MCX', company_name: 'Multi Commodity Exchange', sector: 'Financial Services' },
    { symbol: 'MEDPLUS', company_name: 'MedPlus Health Services', sector: 'Healthcare' },
    { symbol: 'MOTILALOFS', company_name: 'Motilal Oswal Financial', sector: 'Financial Services' },
    { symbol: 'NAM-INDIA', company_name: 'Nippon Life India AMC', sector: 'Financial Services' },
    { symbol: 'NAVINFLUOR', company_name: 'Navin Fluorine International', sector: 'Chemicals' },
    { symbol: 'NETWORK18', company_name: 'Network18 Media', sector: 'Media' },
    { symbol: 'OLECTRA', company_name: 'Olectra Greentech Ltd', sector: 'Automobile' },
    { symbol: 'PNBHOUSING', company_name: 'PNB Housing Finance', sector: 'Financial Services' },
    { symbol: 'POWERMECH', company_name: 'Power Mech Projects', sector: 'Construction' },
    { symbol: 'PVRINOX', company_name: 'PVR INOX Ltd', sector: 'Consumer Services' },
    { symbol: 'RAJESHEXPO', company_name: 'Rajesh Exports Ltd', sector: 'Consumer Durables' },
    { symbol: 'RAYMOND', company_name: 'Raymond Ltd', sector: 'Textiles' },
    { symbol: 'REDINGTON', company_name: 'Redington Ltd', sector: 'Information Technology' },
    { symbol: 'SBICARD', company_name: 'SBI Cards & Payment Services', sector: 'Financial Services' },
    { symbol: 'SIGNATURE', company_name: 'Signatureglobal India', sector: 'Realty' },
    { symbol: 'SUPRAJIT', company_name: 'Suprajit Engineering', sector: 'Automobile' },
    { symbol: 'SUVENPHAR', company_name: 'Suven Pharmaceuticals', sector: 'Healthcare' },
    { symbol: 'SYNGENE', company_name: 'Syngene International', sector: 'Healthcare' },
    { symbol: 'TATACHEM', company_name: 'Tata Chemicals Ltd', sector: 'Chemicals' },
    { symbol: 'TATAINVEST', company_name: 'Tata Investment Corp', sector: 'Financial Services' },
    { symbol: 'TITAGARH', company_name: 'Titagarh Rail Systems', sector: 'Capital Goods' },
    { symbol: 'TRIVENI', company_name: 'Triveni Engineering', sector: 'FMCG' },
    { symbol: 'TRIDENT', company_name: 'Trident Ltd', sector: 'Textiles' },
    { symbol: 'TVSSCS', company_name: 'TVS Supply Chain Solutions', sector: 'Services' },
    { symbol: 'UTIAMC', company_name: 'UTI AMC Ltd', sector: 'Financial Services' },
    { symbol: 'VAIBHAVGBL', company_name: 'Vaibhav Global Ltd', sector: 'Consumer Durables' },
    { symbol: 'VGUARD', company_name: 'V-Guard Industries Ltd', sector: 'Consumer Durables' },
    { symbol: 'VINATIORGA', company_name: 'Vinati Organics Ltd', sector: 'Chemicals' },
    { symbol: 'VSTIND', company_name: 'VST Industries Ltd', sector: 'FMCG' },
    { symbol: 'ZENSARTECH', company_name: 'Zensar Technologies', sector: 'Information Technology' },
    // ──── PSUs / Government ────
    { symbol: 'NHPC', company_name: 'NHPC Ltd', sector: 'Power' },
    { symbol: 'NLCINDIA', company_name: 'NLC India Ltd', sector: 'Power' },
    { symbol: 'NMDC', company_name: 'NMDC Ltd', sector: 'Metals & Mining' },
    { symbol: 'NMDCSTEEL', company_name: 'NMDC Steel Ltd', sector: 'Metals & Mining' },
    { symbol: 'BDL', company_name: 'Bharat Dynamics Ltd', sector: 'Capital Goods' },
    { symbol: 'BEML', company_name: 'BEML Ltd', sector: 'Capital Goods' },
    { symbol: 'HSCL', company_name: 'Himadri Speciality Chemical', sector: 'Chemicals' },
    { symbol: 'ITI', company_name: 'ITI Ltd', sector: 'Telecommunication' },
    { symbol: 'MAZDOCK', company_name: 'Mazagon Dock Shipbuilders', sector: 'Capital Goods' },
    { symbol: 'MIDHANI', company_name: 'Mishra Dhatu Nigam', sector: 'Metals & Mining' },
    { symbol: 'ENGINERSIN', company_name: 'Engineers India Ltd', sector: 'Construction' },
    { symbol: 'GMDCLTD', company_name: 'Gujarat Mineral Dev Corp', sector: 'Metals & Mining' },
    { symbol: 'HUDCO', company_name: 'HUDCO', sector: 'Financial Services' },
    { symbol: 'NFL', company_name: 'National Fertilizers Ltd', sector: 'Chemicals' },
    { symbol: 'RCF', company_name: 'Rashtriya Chemicals', sector: 'Chemicals' },
    // ──── Smallcap popular ────
    { symbol: 'RATEGAIN', company_name: 'RateGain Travel Technologies', sector: 'Information Technology' },
    { symbol: 'SWARAJENG', company_name: 'Swaraj Engines Ltd', sector: 'Automobile' },
    { symbol: 'SUZLON', company_name: 'Suzlon Energy Ltd', sector: 'Capital Goods' },
    { symbol: 'TATVA', company_name: 'Tatva Chintan Pharma', sector: 'Chemicals' },
    { symbol: 'TTML', company_name: 'Tata Teleservices Maharashtra', sector: 'Telecommunication' },
    { symbol: 'UJJIVANSFB', company_name: 'Ujjivan Small Finance Bank', sector: 'Financial Services' },
    { symbol: 'EQUITASBNK', company_name: 'Equitas Small Finance Bank', sector: 'Financial Services' },
    { symbol: 'FINPIPE', company_name: 'Finolex Industries Ltd', sector: 'Capital Goods' },
    { symbol: 'FINOLEX', company_name: 'Finolex Cables Ltd', sector: 'Capital Goods' },
    { symbol: 'GHCL', company_name: 'GHCL Ltd', sector: 'Chemicals' },
    { symbol: 'GESHIP', company_name: 'Great Eastern Shipping', sector: 'Services' },
    { symbol: 'JBMA', company_name: 'JBM Auto Ltd', sector: 'Automobile' },
    { symbol: 'JSPL', company_name: 'Jindal Steel & Power', sector: 'Metals & Mining' },
    { symbol: 'KANSAINER', company_name: 'Kansai Nerolac Paints', sector: 'Consumer Durables' },
    { symbol: 'KFINTECH', company_name: 'KFin Technologies Ltd', sector: 'Financial Services' },
    { symbol: 'LATENTVIEW', company_name: 'Latent View Analytics', sector: 'Information Technology' },
    { symbol: 'LICHSGFIN', company_name: 'LIC Housing Finance', sector: 'Financial Services' },
    { symbol: 'MFSL', company_name: 'Max Financial Services', sector: 'Financial Services' },
    { symbol: 'MMTC', company_name: 'MMTC Ltd', sector: 'Services' },
    { symbol: 'MOREPENLAB', company_name: 'Morepen Laboratories', sector: 'Healthcare' },
    { symbol: 'NAVNETEDUL', company_name: 'Navneet Education Ltd', sector: 'Consumer Services' },
    { symbol: 'NESCO', company_name: 'Nesco Ltd', sector: 'Realty' },
    { symbol: 'IIFL', company_name: 'IIFL Finance Ltd', sector: 'Financial Services' },
    { symbol: 'PPLPHARMA', company_name: 'Piramal Pharma Ltd', sector: 'Healthcare' },
    { symbol: 'PRINCEPIPE', company_name: 'Prince Pipes and Fittings', sector: 'Capital Goods' },
    { symbol: 'QUESS', company_name: 'Quess Corp Ltd', sector: 'Services' },
    { symbol: 'RITES', company_name: 'RITES Ltd', sector: 'Construction' },
    { symbol: 'SAKSOFT', company_name: 'Saksoft Ltd', sector: 'Information Technology' },
    { symbol: 'SPARC', company_name: 'Sun Pharma Advanced Research', sector: 'Healthcare' },
    { symbol: 'SUNDARMFIN', company_name: 'Sundaram Finance Ltd', sector: 'Financial Services' },
    { symbol: 'SUNTECK', company_name: 'Sunteck Realty Ltd', sector: 'Realty' },
    { symbol: 'SYMPHONY', company_name: 'Symphony Ltd', sector: 'Consumer Durables' },
    { symbol: 'TATATECH', company_name: 'Tata Technologies Ltd', sector: 'Information Technology' },
    { symbol: 'TIMKEN', company_name: 'Timken India Ltd', sector: 'Capital Goods' },
    { symbol: 'UNOMINDA', company_name: 'UNO Minda Ltd', sector: 'Automobile' },
    { symbol: 'WOCKPHARMA', company_name: 'Wockhardt Ltd', sector: 'Healthcare' },
    { symbol: 'ZFCVINDIA', company_name: 'ZF Commercial Vehicle', sector: 'Automobile' },
    { symbol: 'ZENSARTECH', company_name: 'Zensar Technologies', sector: 'Information Technology' },
    { symbol: 'CAMS', company_name: 'Computer Age Management', sector: 'Financial Services' },
    { symbol: 'SYRMA', company_name: 'Syrma SGS Technology', sector: 'Capital Goods' },
    { symbol: 'HAPPSTMNDS', company_name: 'Happiest Minds Technologies', sector: 'Information Technology' },
    { symbol: 'CRAFTSMAN', company_name: 'Craftsman Automation', sector: 'Capital Goods' },
    { symbol: 'CIE', company_name: 'CIE Automotive India', sector: 'Automobile' },
    { symbol: 'GPIL', company_name: 'Godawari Power & Ispat', sector: 'Metals & Mining' },
    { symbol: 'ISGEC', company_name: 'Isgec Heavy Engineering', sector: 'Capital Goods' },
    { symbol: 'J&KBANK', company_name: 'Jammu & Kashmir Bank', sector: 'Financial Services' },
    { symbol: 'JAMNAAUTO', company_name: 'Jamna Auto Industries', sector: 'Automobile' },
    { symbol: 'JKLAKSHMI', company_name: 'JK Lakshmi Cement', sector: 'Construction Materials' },
    { symbol: 'JUSTDIAL', company_name: 'Just Dial Ltd', sector: 'Consumer Services' },
  ];

  // Deduplicate by symbol
  const seen = new Set();
  const unique = stocks.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  return unique.map(s => ({ ...s, exchange: s.exchange || 'NSE', is_active: true }));
}

// ─── Upsert to MySQL ────────────────────────────────────────────────────────

async function upsertStocks(stocks) {
  if (stocks.length === 0) {
    console.log('[Seed] No stocks to upsert.');
    return;
  }

  const batchSize = 200;
  let total = 0;

  for (let i = 0; i < stocks.length; i += batchSize) {
    const batch = stocks.slice(i, i + batchSize);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(s => [
      s.symbol,
      s.company_name || null,
      s.exchange || 'NSE',
      s.sector || null,
      s.is_active !== undefined ? (s.is_active ? 1 : 0) : 1,
    ]);

    try {
      await pool.query(
        `INSERT INTO stocks_master (symbol, company_name, exchange, sector, is_active)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           company_name = VALUES(company_name),
           exchange     = VALUES(exchange),
           sector       = VALUES(sector),
           is_active    = VALUES(is_active)`,
        values
      );
      total += batch.length;
      console.log(`[Seed] Upserted batch ${Math.floor(i / batchSize) + 1}: ${batch.length} stocks`);
    } catch (err) {
      console.error(`[Seed] Upsert error (batch ${Math.floor(i / batchSize) + 1}):`, err.message);
    }
  }

  console.log(`[Seed] Total upserted: ${total} stocks`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Seed] Starting stocks_master seed (expanded)...\n');

  let allStocks = [];

  if (useStaticOnly) {
    allStocks = getStaticStocks();
  } else {
    // Try NSE (multiple indices)
    try {
      const nse = await fetchNSEStocks();
      allStocks.push(...nse);
    } catch (err) {
      console.warn(`[Seed] NSE fetch failed: ${err.message}`);
      console.warn('[Seed] This is expected outside India — NSE blocks non-Indian IPs.\n');
    }

    // Try BSE (multiple groups)
    try {
      const bse = await fetchBSEStocks();
      allStocks.push(...bse);
    } catch (err) {
      console.warn(`[Seed] BSE fetch failed: ${err.message}\n`);
    }

    // If API fetches got fewer than 200 stocks, supplement with static
    if (allStocks.length < 200) {
      console.log(`[Seed] Only ${allStocks.length} stocks from APIs. Supplementing with static list.\n`);
      const staticStocks = getStaticStocks();
      allStocks.push(...staticStocks);
    }
  }

  // Deduplicate by symbol (first occurrence wins — NSE takes priority)
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
  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('[Seed] Fatal error:', err);
  process.exit(1);
});
