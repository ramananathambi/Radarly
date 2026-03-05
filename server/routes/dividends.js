const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');

// GET /api/dividends/upcoming?days=7
// Public — no auth required (used on dashboard for all users)
router.get('/upcoming', async (req, res) => {
  const days = Math.min(30, parseInt(req.query.days) || 7);

  const today   = new Date();
  const toDate  = new Date();
  toDate.setDate(today.getDate() + days);

  const from = today.toISOString().split('T')[0];
  const to   = toDate.toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('corporate_actions')
    .select(`
      id,
      symbol,
      ex_date,
      record_date,
      details,
      announced_at,
      stocks_master ( company_name, exchange, sector )
    `)
    .eq('action_type', 'DIVIDEND')
    .gte('ex_date', from)
    .lte('ex_date', to)
    .order('ex_date');

  if (error) {
    console.error('[Dividends] Upcoming error:', error);
    return res.status(500).json({ error: 'Failed to fetch upcoming dividends' });
  }

  res.json({ dividends: data, from, to });
});

module.exports = router;
