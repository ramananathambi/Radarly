const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');

const PAGE_SIZE = 50;

// GET /api/stocks?page=1&exchange=NSE&sector=IT
router.get('/', async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const exchange = req.query.exchange?.toUpperCase(); // 'NSE', 'BSE', 'BOTH'
  const sector   = req.query.sector;
  const offset   = (page - 1) * PAGE_SIZE;

  // Build WHERE clause dynamically
  const conditions = ['is_active = 1'];
  const params     = [];

  if (exchange) {
    conditions.push('FIND_IN_SET(?, exchange) > 0');
    params.push(exchange);
  }
  if (sector) {
    conditions.push('sector = ?');
    params.push(sector);
  }

  const whereClause = conditions.join(' AND ');

  try {
    // Get total count
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM stocks_master WHERE ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Get paginated data
    const [rows] = await pool.execute(
      `SELECT symbol, company_name, exchange, sector, industry, last_price, price_updated_at
       FROM stocks_master
       WHERE ${whereClause}
       ORDER BY symbol
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    res.json({
      stocks:    rows,
      total,
      page,
      pageSize:  PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (err) {
    console.error('[Stocks] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

// GET /api/stocks/search?q=reliance
router.get('/search', async (req, res) => {
  const q = req.query.q?.trim();

  if (!q || q.length < 1) {
    return res.status(400).json({ error: 'Search query required' });
  }

  try {
    const searchTerm = `%${q}%`;
    const [rows] = await pool.execute(
      `SELECT symbol, company_name, exchange, sector, last_price, price_updated_at
       FROM stocks_master
       WHERE is_active = 1 AND (symbol LIKE ? OR company_name LIKE ?)
       ORDER BY symbol
       LIMIT 30`,
      [searchTerm, searchTerm]
    );

    res.json({ stocks: rows });
  } catch (err) {
    console.error('[Stocks] Search error:', err.message);
    return res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/stocks/sectors — distinct sector list for filter dropdown
router.get('/sectors', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT sector FROM stocks_master
       WHERE is_active = 1 AND sector IS NOT NULL
       ORDER BY sector`
    );

    const sectors = rows.map(r => r.sector).filter(Boolean);
    res.json({ sectors });
  } catch (err) {
    console.error('[Stocks] Sectors error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch sectors' });
  }
});

module.exports = router;
