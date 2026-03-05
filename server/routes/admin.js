const express        = require('express');
const router         = express.Router();
const { requireAdmin }  = require('../middleware/adminAuth');
const { supabaseAdmin } = require('../lib/supabase');
const { runDataFetch }  = require('../jobs/scheduler');
const { runAlertEngine } = require('../jobs/alertEngine');

// GET /api/admin/stats
router.get('/stats', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const [users, alertsToday, alertsTotal, actions, stocks] = await Promise.all([
    supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('alert_log').select('id', { count: 'exact', head: true }).gte('sent_at', today),
    supabaseAdmin.from('alert_log').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('corporate_actions').select('id', { count: 'exact', head: true }).gte('last_fetched', today),
    supabaseAdmin.from('stocks_master').select('symbol', { count: 'exact', head: true }),
  ]);

  res.json({
    total_users:           users.count       || 0,
    alerts_sent_today:     alertsToday.count || 0,
    alerts_sent_total:     alertsTotal.count || 0,
    actions_fetched_today: actions.count     || 0,
    total_stocks:          stocks.count      || 0,
  });
});

// GET /api/admin/users — paginated user list
router.get('/users', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const limit = 25;
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  const { data, error, count } = await supabaseAdmin
    .from('users')
    .select('id, name, phone, is_verified, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    console.error('[Admin] Users list error:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }

  res.json({ users: data, total: count, page, totalPages: Math.ceil(count / limit) });
});

// GET /api/admin/alerts — recent alert log
router.get('/alerts', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const limit = 25;
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  const { data, error, count } = await supabaseAdmin
    .from('alert_log')
    .select(`
      id, symbol, alert_type, event_date, status, sent_at,
      users ( name, phone )
    `, { count: 'exact' })
    .order('sent_at', { ascending: false })
    .range(from, to);

  if (error) {
    console.error('[Admin] Alert log error:', error);
    return res.status(500).json({ error: 'Failed to fetch alert log' });
  }

  res.json({ alerts: data, total: count, page, totalPages: Math.ceil(count / limit) });
});

// GET /api/admin/actions — recent corporate actions
router.get('/actions', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const limit = 25;
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  const { data, error, count } = await supabaseAdmin
    .from('corporate_actions')
    .select('id, symbol, action_type, ex_date, record_date, details, last_fetched', { count: 'exact' })
    .order('ex_date', { ascending: false })
    .range(from, to);

  if (error) {
    console.error('[Admin] Actions list error:', error);
    return res.status(500).json({ error: 'Failed to fetch corporate actions' });
  }

  res.json({ actions: data, total: count, page, totalPages: Math.ceil(count / limit) });
});

// POST /api/admin/fetch — trigger manual data fetch
router.post('/fetch', requireAdmin, async (req, res) => {
  console.log('[Admin] Manual fetch triggered');
  runDataFetch().catch(err => console.error('[Admin] Manual fetch error:', err.message));
  res.json({ success: true, message: 'Data fetch started in background' });
});

// POST /api/admin/alert — trigger manual alert run
router.post('/alert', requireAdmin, async (req, res) => {
  console.log('[Admin] Manual alert run triggered');
  runAlertEngine().catch(err => console.error('[Admin] Manual alert error:', err.message));
  res.json({ success: true, message: 'Alert engine started in background' });
});

module.exports = router;
