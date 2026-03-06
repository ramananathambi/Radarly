const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');

const PAGE_SIZE = 50;

// GET /api/stocks?page=1&exchange=NSE&sector=IT
router.get('/', async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const exchange = req.query.exchange?.toUpperCase(); // 'NSE', 'BSE', 'BOTH'
  const sector   = req.query.sector;
  const offset   = (page - 1) * PAGE_SIZE;

  let query = supabaseAdmin
    .from('stocks_master')
    .select('symbol, company_name, exchange, sector, industry, last_price, price_updated_at', { count: 'exact' })
    .eq('is_active', true)
    .order('symbol')
    .range(offset, offset + PAGE_SIZE - 1);

  if (exchange) query = query.eq('exchange', exchange);
  if (sector)   query = query.eq('sector', sector);

  const { data, error, count } = await query;

  if (error) {
    console.error('[Stocks] List error:', error);
    return res.status(500).json({ error: 'Failed to fetch stocks' });
  }

  res.json({
    stocks:    data,
    total:     count,
    page,
    pageSize:  PAGE_SIZE,
    totalPages: Math.ceil(count / PAGE_SIZE),
  });
});

// GET /api/stocks/search?q=reliance
router.get('/search', async (req, res) => {
  const q = req.query.q?.trim();

  if (!q || q.length < 1) {
    return res.status(400).json({ error: 'Search query required' });
  }

  const { data, error } = await supabaseAdmin
    .from('stocks_master')
    .select('symbol, company_name, exchange, sector, last_price, price_updated_at')
    .eq('is_active', true)
    .or(`symbol.ilike.%${q}%,company_name.ilike.%${q}%`)
    .order('symbol')
    .limit(30);

  if (error) {
    console.error('[Stocks] Search error:', error);
    return res.status(500).json({ error: 'Search failed' });
  }

  res.json({ stocks: data });
});

// GET /api/stocks/sectors — distinct sector list for filter dropdown
router.get('/sectors', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('stocks_master')
    .select('sector')
    .eq('is_active', true)
    .not('sector', 'is', null)
    .order('sector');

  if (error) return res.status(500).json({ error: 'Failed to fetch sectors' });

  const sectors = [...new Set(data.map(r => r.sector))].filter(Boolean);
  res.json({ sectors });
});

module.exports = router;
