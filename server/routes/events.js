const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');

// GET /api/events/upcoming?days=30
// Returns all corporate actions across all types for the next N days
router.get('/upcoming', async (req, res) => {
  const days = Math.min(365, parseInt(req.query.days) || 30);

  const today  = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + days);

  const from = today.toISOString().split('T')[0];
  const to   = toDate.toISOString().split('T')[0];

  try {
    const [rows] = await pool.execute(
      `SELECT ca.symbol, ca.action_type, ca.ex_date, ca.details,
              sm.company_name, sm.exchange, sm.last_price
       FROM corporate_actions ca
       JOIN stocks_master sm ON ca.symbol = sm.symbol
       WHERE ca.ex_date >= ?
         AND ca.ex_date <= ?
       ORDER BY ca.ex_date ASC, ca.action_type ASC, ca.symbol ASC`,
      [from, to]
    );

    const events = rows.map(r => ({
      symbol:      r.symbol,
      action_type: r.action_type,
      ex_date:     r.ex_date,
      details:     r.details,
      stocks_master: {
        company_name: r.company_name,
        exchange:     r.exchange,
        last_price:   r.last_price,
      },
    }));

    res.json({ events, from, to, days });
  } catch (err) {
    console.error('[Events] Upcoming error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch upcoming events' });
  }
});

module.exports = router;
