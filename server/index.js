require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const compression = require('compression');
const { startScheduler } = require('./jobs/scheduler');
const { pool } = require('./lib/db');

async function initDb() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_otps (
        email       VARCHAR(255) PRIMARY KEY,
        otp_code    VARCHAR(6),
        reset_token VARCHAR(64),
        expires_at  DATETIME NOT NULL
      )
    `);
    console.log('[DB] password_reset_otps table ready');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }

  // ── Scheduler log table ───────────────────────────────────────────────────
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS scheduler_log (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        job_name    VARCHAR(100) NOT NULL,
        started_at  DATETIME NOT NULL DEFAULT NOW(),
        finished_at DATETIME,
        status      ENUM('running','success','failed') DEFAULT 'running',
        message     TEXT,
        INDEX idx_job_name (job_name),
        INDEX idx_started_at (started_at)
      )
    `);
    console.log('[DB] scheduler_log table ready');
  } catch (err) {
    console.error('[DB] scheduler_log migration error:', err.message);
  }

  // ── Unique email constraint (deduplicate first, then enforce) ────────────
  try {
    // Step 1: clean up related data for duplicate email accounts (keep the oldest)
    await pool.execute(`
      DELETE FROM user_alert_preferences
      WHERE user_id IN (
        SELECT id FROM (
          SELECT u1.id FROM users u1
          INNER JOIN users u2 ON u1.email = u2.email
          WHERE u1.email IS NOT NULL AND u1.created_at > u2.created_at
        ) AS dupes
      )
    `);
    await pool.execute(`
      DELETE FROM user_stocks
      WHERE user_id IN (
        SELECT id FROM (
          SELECT u1.id FROM users u1
          INNER JOIN users u2 ON u1.email = u2.email
          WHERE u1.email IS NOT NULL AND u1.created_at > u2.created_at
        ) AS dupes
      )
    `);
    await pool.execute(`
      DELETE FROM alert_log
      WHERE user_id IN (
        SELECT id FROM (
          SELECT u1.id FROM users u1
          INNER JOIN users u2 ON u1.email = u2.email
          WHERE u1.email IS NOT NULL AND u1.created_at > u2.created_at
        ) AS dupes
      )
    `);
    // Step 2: delete the duplicate users themselves (keep oldest per email)
    await pool.execute(`
      DELETE u1 FROM users u1
      INNER JOIN users u2 ON u1.email = u2.email
      WHERE u1.email IS NOT NULL AND u1.created_at > u2.created_at
    `);
    // Step 3: add UNIQUE constraint (ignore error if it already exists)
    await pool.execute(`
      ALTER TABLE users ADD UNIQUE INDEX idx_unique_email (email)
    `);
    console.log('[DB] Unique email constraint enforced');
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') {
      console.log('[DB] Unique email index already exists — skipping');
    } else {
      console.error('[DB] Email unique constraint migration error:', err.message);
    }
  }

  // ── Alert type migrations ─────────────────────────────────────────────────
  try {
    // Activate RIGHTS (was previously inactive / coming soon)
    await pool.execute(
      `UPDATE alert_types SET is_active = 1 WHERE code = 'RIGHTS'`
    );

    // Add IPO alert type if it doesn't exist yet
    await pool.execute(
      `INSERT IGNORE INTO alert_types (code, name, description, is_active)
       VALUES ('IPO', 'IPO Alerts', 'Get notified about upcoming IPO listings on NSE/BSE.', 1)`
    );

    // Backfill existing users — give them RIGHTS + IPO prefs if they don't have them
    await pool.execute(`
      INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
      SELECT u.id, at.code, 'all_stocks', 1
      FROM users u
      CROSS JOIN alert_types at
      WHERE at.code IN ('RIGHTS', 'IPO')
        AND at.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM user_alert_preferences uap
          WHERE uap.user_id = u.id AND uap.alert_type = at.code
        )
    `);

    console.log('[DB] Alert types migration complete (RIGHTS active, IPO added, users backfilled)');
  } catch (err) {
    console.error('[DB] Alert types migration error:', err.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Hostinger / nginx)
app.set('trust proxy', 1);

// Middleware
app.use(compression()); // gzip all responses
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend files with cache headers
// HTML files: no cache (always fresh)
// Assets (CSS/JS/images): cached for 7 days
app.use(express.static(path.join(__dirname, '../client'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
    }
  }
}));

// API Routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/stocks',    require('./routes/stocks'));
app.use('/api/user',      require('./routes/user'));
app.use('/api/dividends', require('./routes/dividends'));
app.use('/api/events',    require('./routes/events'));
app.use('/api/webhooks',  require('./routes/webhooks'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/contact',   require('./routes/contact'));

// Catch-all — serve index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Start server
const server = app.listen(PORT, async () => {
  console.log(`[Radarly] Server running on http://localhost:${PORT}`);
  await initDb();
  startScheduler();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Radarly] Port ${PORT} is already in use. Kill the existing process and restart.`);
    process.exit(1);
  } else {
    throw err;
  }
});
