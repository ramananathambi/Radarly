const express        = require('express');
const router         = express.Router();
const { requireAdmin }  = require('../middleware/adminAuth');
const { pool }          = require('../lib/db');
const { runDataFetch }   = require('../jobs/scheduler');
const { runAlertEngine } = require('../jobs/alertEngine');
const { seedAllStocks }  = require('../jobs/seedAllStocks');

// ─── Stats ─────────────────────────────────────────────────────────────────

router.get('/stats', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const [
      [usersRow],
      [alertsTodayRow],
      [alertsTotalRow],
      [actionsRow],
      [stocksRow],
      [failedRow],
    ] = await Promise.all([
      pool.execute('SELECT COUNT(*) AS cnt FROM users'),
      pool.execute('SELECT COUNT(*) AS cnt FROM alert_log WHERE sent_at >= ?', [today]),
      pool.execute('SELECT COUNT(*) AS cnt FROM alert_log'),
      pool.execute('SELECT COUNT(*) AS cnt FROM corporate_actions WHERE last_fetched >= ?', [today]),
      pool.execute('SELECT COUNT(*) AS cnt FROM stocks_master'),
      pool.execute('SELECT COUNT(*) AS cnt FROM alert_log WHERE status = "failed"'),
    ]);
    res.json({
      total_users:           usersRow[0].cnt        || 0,
      alerts_sent_today:     alertsTodayRow[0].cnt  || 0,
      alerts_sent_total:     alertsTotalRow[0].cnt  || 0,
      actions_fetched_today: actionsRow[0].cnt      || 0,
      total_stocks:          stocksRow[0].cnt       || 0,
      alerts_failed_total:   failedRow[0].cnt       || 0,
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── Scheduler status ──────────────────────────────────────────────────────

router.get('/scheduler', requireAdmin, async (req, res) => {
  const jobNames = ['NSE Fetch (Morning)', 'NSE Fetch (Evening)', 'Alert Engine'];
  try {
    const results = {};
    for (const name of jobNames) {
      const [rows] = await pool.execute(
        'SELECT * FROM scheduler_log WHERE job_name = ? ORDER BY started_at DESC LIMIT 1',
        [name]
      );
      results[name] = rows[0] || null;
    }
    res.json({ jobs: results });
  } catch (err) {
    console.error('[Admin] Scheduler status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Alert Types ───────────────────────────────────────────────────────────

router.get('/alert-types', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM alert_types ORDER BY id');
    res.json({ types: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/alert-types/:code/toggle', requireAdmin, async (req, res) => {
  const { code } = req.params;
  try {
    await pool.execute(
      'UPDATE alert_types SET is_active = NOT is_active WHERE code = ?',
      [code]
    );
    const [[type]] = await pool.execute('SELECT * FROM alert_types WHERE code = ?', [code]);
    res.json({ success: true, type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Users (paginated + search) ────────────────────────────────────────────

router.get('/users', requireAdmin, async (req, res) => {
  const page   = parseInt(req.query.page) || 1;
  const search = req.query.search?.trim() || '';
  const limit  = 25;
  const offset = (page - 1) * limit;

  try {
    let countQuery = 'SELECT COUNT(*) AS total FROM users';
    let dataQuery  = 'SELECT id, name, phone, email, is_verified, created_at FROM users';
    const params   = [];

    if (search) {
      const like = `%${search}%`;
      countQuery += ' WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?';
      dataQuery  += ' WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?';
      params.push(like, like, like);
    }

    dataQuery += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const searchParams = search ? params : [];
    const [countRows] = await pool.execute(countQuery, searchParams);
    const total = countRows[0].total;
    const [rows] = await pool.execute(dataQuery, searchParams);

    rows.forEach(r => { r.is_verified = !!r.is_verified; });
    res.json({ users: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Users list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/users/:id — user detail
router.get('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [[user]] = await pool.execute(
      'SELECT id, name, phone, email, is_verified, created_at FROM users WHERE id = ?', [id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [watchlist] = await pool.execute(
      `SELECT us.symbol, sm.company_name
       FROM user_stocks us
       LEFT JOIN stocks_master sm ON us.symbol = sm.symbol
       WHERE us.user_id = ? ORDER BY us.symbol`,
      [id]
    );
    const [prefs] = await pool.execute(
      'SELECT alert_type, scope, is_enabled FROM user_alert_preferences WHERE user_id = ?', [id]
    );
    const [alertHistory] = await pool.execute(
      `SELECT symbol, alert_type, event_date, status, sent_at
       FROM alert_log WHERE user_id = ? ORDER BY sent_at DESC LIMIT 20`,
      [id]
    );

    user.is_verified = !!user.is_verified;
    res.json({ user, watchlist, prefs, alertHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id — delete user from MySQL + Supabase
router.delete('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Delete all MySQL data first
    await pool.execute('DELETE FROM user_alert_preferences WHERE user_id = ?', [id]);
    await pool.execute('DELETE FROM user_stocks WHERE user_id = ?', [id]);
    await pool.execute('DELETE FROM alert_log WHERE user_id = ?', [id]);
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);

    // 2. Delete from Supabase Auth so the email is fully freed
    const supaDeleteResp = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }
    );

    if (!supaDeleteResp.ok && supaDeleteResp.status !== 404) {
      // Log but don't fail — MySQL is already cleaned, partial success is still useful
      const errBody = await supaDeleteResp.text();
      console.error(`[Admin] Supabase delete failed for ${id}:`, errBody);
      return res.json({ success: true, warning: 'MySQL deleted but Supabase delete failed — check service role key' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Alert Log (with status filter) ───────────────────────────────────────

router.get('/alerts', requireAdmin, async (req, res) => {
  const page   = parseInt(req.query.page) || 1;
  const status = req.query.status || '';
  const limit  = 25;
  const offset = (page - 1) * limit;

  try {
    const where = (status === 'sent' || status === 'failed') ? 'WHERE al.status = ?' : '';
    const args  = where ? [status] : [];

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM alert_log al ${where}`, args
    );
    const total = countRows[0].total;

    const [rows] = await pool.execute(
      `SELECT al.user_id, al.symbol, al.alert_type, al.event_date, al.status, al.sent_at,
              u.name, u.phone
       FROM alert_log al
       JOIN users u ON al.user_id = u.id
       ${where}
       ORDER BY al.sent_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      args
    );

    const alerts = rows.map(r => ({
      user_id: r.user_id, symbol: r.symbol, alert_type: r.alert_type,
      event_date: r.event_date, status: r.status, sent_at: r.sent_at,
      users: { name: r.name, phone: r.phone },
    }));

    res.json({ alerts, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Alert log error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// ─── Corporate Actions (with type filter) ─────────────────────────────────

router.get('/actions', requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page) || 1;
  const type  = req.query.type || '';
  const limit = 25;
  const offset = (page - 1) * limit;

  try {
    const where = type ? 'WHERE action_type = ?' : '';
    const args  = type ? [type.toUpperCase()] : [];

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM corporate_actions ${where}`, args
    );
    const total = countRows[0].total;

    const [rows] = await pool.execute(
      `SELECT symbol, action_type, ex_date, record_date, details, last_fetched
       FROM corporate_actions ${where}
       ORDER BY ex_date DESC
       LIMIT ${limit} OFFSET ${offset}`,
      args
    );

    res.json({ actions: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Actions list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch actions' });
  }
});

// ─── Alerts Chart (last 14 days) ───────────────────────────────────────────

router.get('/alerts-chart', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DATE(sent_at) AS date, COUNT(*) AS count
       FROM alert_log
       WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
       GROUP BY DATE(sent_at)
       ORDER BY date ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Watchlist Stats ───────────────────────────────────────────────────────

router.get('/watchlist-stats', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT us.symbol, sm.company_name, COUNT(DISTINCT us.user_id) AS user_count
       FROM user_stocks us
       LEFT JOIN stocks_master sm ON us.symbol = sm.symbol
       GROUP BY us.symbol, sm.company_name
       ORDER BY user_count DESC
       LIMIT 25`
    );
    res.json({ stocks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Broadcast ─────────────────────────────────────────────────────────────

router.post('/broadcast', requireAdmin, async (req, res) => {
  const { message, dry_run } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  try {
    const [users] = await pool.execute(
      'SELECT id, name, phone FROM users WHERE is_verified = 1 AND phone IS NOT NULL AND phone != ""'
    );

    if (dry_run) {
      return res.json({ success: true, dry_run: true, recipient_count: users.length });
    }

    if (users.length === 0) {
      return res.json({ success: true, sent: 0, message: 'No verified users with phone numbers' });
    }

    // Acknowledge immediately, send in background
    res.json({ success: true, message: `Broadcast started to ${users.length} users` });

    const { client } = require('../lib/twilio');
    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        await client.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to:   `whatsapp:${user.phone}`,
          body: message.trim(),
        });
        sent++;
      } catch (err) {
        console.error(`[Broadcast] Failed to send to ${user.phone}:`, err.message);
        failed++;
      }
    }
    console.log(`[Broadcast] Complete — sent: ${sent}, failed: ${failed}`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Manual triggers ───────────────────────────────────────────────────────

router.post('/fetch', requireAdmin, async (req, res) => {
  console.log('[Admin] Manual fetch triggered');
  runDataFetch('NSE Fetch (Manual)').catch(err => console.error('[Admin] Manual fetch error:', err.message));
  res.json({ success: true, message: 'Data fetch started in background' });
});

router.post('/alert', requireAdmin, async (req, res) => {
  console.log('[Admin] Manual alert run triggered');
  runAlertEngine().catch(err => console.error('[Admin] Manual alert error:', err.message));
  res.json({ success: true, message: 'Alert engine started in background' });
});

router.post('/seed-stocks', requireAdmin, async (req, res) => {
  console.log('[Admin] Full stock seed triggered');
  seedAllStocks()
    .then(results => console.log('[Admin] Stock seed complete:', JSON.stringify(results)))
    .catch(err => console.error('[Admin] Stock seed error:', err.message));
  res.json({ success: true, message: 'Stock seed started in background — fetching NSE equity stocks. Check logs for progress.' });
});

module.exports = router;
