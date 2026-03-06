const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth }   = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

// ─── User Stocks ──────────────────────────────────────────────────────────────

// GET /api/user/stocks
router.get('/stocks', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_stocks')
    .select(`
      symbol,
      added_at,
      stocks_master ( company_name, exchange, sector, last_price, price_updated_at )
    `)
    .eq('user_id', req.user.id)
    .order('added_at', { ascending: false });

  if (error) {
    console.error('[User] Get stocks error:', error);
    return res.status(500).json({ error: 'Failed to fetch your stocks' });
  }

  res.json({ stocks: data });
});

// POST /api/user/stocks — { symbol }
router.post('/stocks', async (req, res) => {
  const { symbol } = req.body;

  if (!symbol?.trim()) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  const sym = symbol.trim().toUpperCase();

  // Verify stock exists
  const { data: stock } = await supabaseAdmin
    .from('stocks_master')
    .select('symbol')
    .eq('symbol', sym)
    .maybeSingle();

  if (!stock) {
    return res.status(404).json({ error: `Stock ${sym} not found` });
  }

  const { error } = await supabaseAdmin
    .from('user_stocks')
    .upsert({ user_id: req.user.id, symbol: sym }, { onConflict: 'user_id,symbol', ignoreDuplicates: true });

  if (error) {
    console.error('[User] Add stock error:', error);
    return res.status(500).json({ error: 'Failed to add stock' });
  }

  res.json({ success: true, symbol: sym });
});

// DELETE /api/user/stocks/:symbol
router.delete('/stocks/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();

  const { error } = await supabaseAdmin
    .from('user_stocks')
    .delete()
    .eq('user_id', req.user.id)
    .eq('symbol', sym);

  if (error) {
    console.error('[User] Remove stock error:', error);
    return res.status(500).json({ error: 'Failed to remove stock' });
  }

  res.json({ success: true, symbol: sym });
});

// ─── Alert Preferences ────────────────────────────────────────────────────────

// GET /api/user/preferences
router.get('/preferences', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_alert_preferences')
    .select(`
      alert_type,
      scope,
      is_enabled,
      updated_at,
      alert_types ( name, description, is_active )
    `)
    .eq('user_id', req.user.id);

  if (error) {
    console.error('[User] Get prefs error:', error);
    return res.status(500).json({ error: 'Failed to fetch preferences' });
  }

  res.json({ preferences: data });
});

// PUT /api/user/preferences — { alert_type, scope, is_enabled }
router.put('/preferences', async (req, res) => {
  const { alert_type, scope, is_enabled } = req.body;

  if (!alert_type) {
    return res.status(400).json({ error: 'alert_type is required' });
  }

  // Validate scope if provided
  if (scope && !['all_stocks', 'selected_stocks'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be all_stocks or selected_stocks' });
  }

  // Verify alert_type is valid and active
  const { data: alertType } = await supabaseAdmin
    .from('alert_types')
    .select('code')
    .eq('code', alert_type)
    .eq('is_active', true)
    .maybeSingle();

  if (!alertType) {
    return res.status(400).json({ error: `Alert type ${alert_type} is not available` });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (scope      !== undefined) updates.scope      = scope;
  if (is_enabled !== undefined) updates.is_enabled = is_enabled;

  const { error } = await supabaseAdmin
    .from('user_alert_preferences')
    .update(updates)
    .eq('user_id', req.user.id)
    .eq('alert_type', alert_type);

  if (error) {
    console.error('[User] Update prefs error:', error);
    return res.status(500).json({ error: 'Failed to update preference' });
  }

  res.json({ success: true });
});

// GET /api/user/me — current user info (used by frontend to check session)
router.get('/me', async (req, res) => {
  res.json({
    id:    req.user.id,
    name:  req.user.name,
    phone: req.user.phone,
  });
});

module.exports = router;
