const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');

// GET /api/dividends/upcoming?days=7
// Public — no auth required (used on dashboard for all users)
router.get('/upcoming', async (req, res) => {
  const days = Math.min(30, parseInt(req.query.days) || 7);

  const today   = new Date();
  const toDate  = new Date();
  toDate.setDate(today.getDate() + days);

  const from = today.toISOString().split('T')[0];
  const to   = toDate.toISOString().split('T')[0];

  try {
    const [rows] = await pool.execute(
      `SELECT ca.symbol, ca.ex_date, ca.record_date, ca.details, ca.announced_at,
              sm.company_name, sm.exchange, sm.sector
       FROM corporate_actions ca
       JOIN stocks_master sm ON ca.symbol = sm.symbol
       WHERE ca.action_type = 'DIVIDEND'
         AND ca.ex_date >= ?
         AND ca.ex_date <= ?
       ORDER BY ca.ex_date`,
      [from, to]
    );

    // Restructure to match Supabase nested format
    const dividends = rows.map(r => ({
      symbol:       r.symbol,
      ex_date:      r.ex_date,
      record_date:  r.record_date,
      details:      r.details,
      announced_at: r.announced_at,
      stocks_master: {
        company_name: r.company_name,
        exchange:     r.exchange,
        sector:       r.sector,
      },
    }));

    res.json({ dividends, from, to });
  } catch (err) {
    console.error('[Dividends] Upcoming error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch upcoming dividends' });
  }
});

module.exports = router;
