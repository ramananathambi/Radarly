const express        = require('express');
const router         = express.Router();
const { requireAdmin }  = require('../middleware/adminAuth');
const { pool }          = require('../lib/db');
const { runDataFetch }   = require('../jobs/scheduler');
const { runAlertEngine } = require('../jobs/alertEngine');
const { seedAllStocks }  = require('../jobs/seedAllStocks');

// GET /api/admin/stats
router.get('/stats', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  try {
    const [
      [usersRow],
      [alertsTodayRow],
      [alertsTotalRow],
      [actionsRow],
      [stocksRow],
    ] = await Promise.all([
      pool.execute('SELECT COUNT(*) AS cnt FROM users'),
      pool.execute('SELECT COUNT(*) AS cnt FROM alert_log WHERE sent_at >= ?', [today]),
      pool.execute('SELECT COUNT(*) AS cnt FROM alert_log'),
      pool.execute('SELECT COUNT(*) AS cnt FROM corporate_actions WHERE last_fetched >= ?', [today]),
      pool.execute('SELECT COUNT(*) AS cnt FROM stocks_master'),
    ]);

    res.json({
      total_users:           usersRow[0].cnt       || 0,
      alerts_sent_today:     alertsTodayRow[0].cnt || 0,
      alerts_sent_total:     alertsTotalRow[0].cnt || 0,
      actions_fetched_today: actionsRow[0].cnt     || 0,
      total_stocks:          stocksRow[0].cnt      || 0,
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/users — paginated user list
router.get('/users', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const limit = 25;
  const offset = (page - 1) * limit;

  try {
    const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM users');
    const total = countRows[0].total;

    const [rows] = await pool.execute(
      `SELECT id, name, phone, is_verified, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`
    );

    // Cast is_verified
    rows.forEach(r => { r.is_verified = !!r.is_verified; });

    res.json({ users: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Users list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/alerts — recent alert log
router.get('/alerts', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const limit = 25;
  const offset = (page - 1) * limit;

  try {
    const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM alert_log');
    const total = countRows[0].total;

    const [rows] = await pool.execute(
      `SELECT al.user_id, al.symbol, al.alert_type, al.event_date, al.status, al.sent_at,
              u.name, u.phone
       FROM alert_log al
       JOIN users u ON al.user_id = u.id
       ORDER BY al.sent_at DESC
       LIMIT ${limit} OFFSET ${offset}`
    );

    // Restructure to match Supabase nested format
    const alerts = rows.map(r => ({
      user_id:    r.user_id,
      symbol:     r.symbol,
      alert_type: r.alert_type,
      event_date: r.event_date,
      status:     r.status,
      sent_at:    r.sent_at,
      users: {
        name:  r.name,
        phone: r.phone,
      },
    }));

    res.json({ alerts, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Alert log error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch alert log' });
  }
});

// GET /api/admin/actions — recent corporate actions
router.get('/actions', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const limit = 25;
  const offset = (page - 1) * limit;

  try {
    const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM corporate_actions');
    const total = countRows[0].total;

    const [rows] = await pool.execute(
      `SELECT symbol, action_type, ex_date, record_date, details, last_fetched
       FROM corporate_actions
       ORDER BY ex_date DESC
       LIMIT ${limit} OFFSET ${offset}`
    );

    res.json({ actions: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Actions list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch corporate actions' });
  }
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

// POST /api/admin/seed-stocks — fetch all NSE stocks and upsert
router.post('/seed-stocks', requireAdmin, async (req, res) => {
  console.log('[Admin] Full stock seed triggered');
  seedAllStocks()
    .then(results => console.log('[Admin] Stock seed complete:', JSON.stringify(results)))
    .catch(err => console.error('[Admin] Stock seed error:', err.message));
  res.json({ success: true, message: 'Stock seed started in background — fetching NSE equity stocks. Check logs for progress.' });
});

module.exports = router;
