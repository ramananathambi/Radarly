/**
 * scheduler.js
 * Cron job runner — all jobs run in Asia/Kolkata (IST) timezone.
 *
 * Schedule:
 *   8:00 AM IST  — NSE corporate actions fetch (pre-market)
 *   9:15-15:45 IST (every 5 min, Mon-Fri) — LTP price fetch
 *   9:30 AM IST  — Alert engine
 *   6:00 PM IST  — NSE corporate actions fetch (post-market)
 */
const cron = require('node-cron');
const { fetchNSE }       = require('./fetchNSE');
const { runAlertEngine } = require('./alertEngine');
const { fetchPrices }    = require('./fetchPrices');
const { pool }           = require('../lib/db');

const RETRY_DELAY_MS = process.env.DEV_MODE === 'true'
  ? 5 * 1000
  : 30 * 60 * 1000;
const MAX_RETRIES = 3;

// ─── Retry wrapper ─────────────────────────────────────────────────────────

async function withRetry(label, fn, maxRetries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      console.log(`[Scheduler] ${label} succeeded on attempt ${attempt}`);
      return result;
    } catch (err) {
      console.error(`[Scheduler] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`[Scheduler] ${label} retrying in 30 minutes...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(`[Scheduler] ${label} all ${maxRetries} attempts failed`);
        throw err;
      }
    }
  }
}

// ─── DB logging helpers ────────────────────────────────────────────────────

async function logJobStart(jobName) {
  try {
    const [result] = await pool.execute(
      'INSERT INTO scheduler_log (job_name, started_at, status) VALUES (?, NOW(), "running")',
      [jobName]
    );
    return result.insertId;
  } catch {
    return null;
  }
}

async function logJobEnd(logId, status, message = null) {
  if (!logId) return;
  try {
    await pool.execute(
      'UPDATE scheduler_log SET finished_at = NOW(), status = ?, message = ? WHERE id = ?',
      [status, message ? String(message).substring(0, 500) : null, logId]
    );
  } catch { /* non-fatal */ }
}

// ─── Job runners ───────────────────────────────────────────────────────────

async function runDataFetch(jobLabel = 'NSE Fetch') {
  console.log('[Scheduler] ── Data fetch started ──');
  const logId = await logJobStart(jobLabel);
  try {
    const result = await withRetry('NSE fetch', fetchNSE);
    await logJobEnd(logId, 'success', result ? JSON.stringify(result).substring(0, 400) : 'Done');
    console.log('[Scheduler] ── Data fetch complete ──', result);
    return result;
  } catch (err) {
    await logJobEnd(logId, 'failed', err.message);
    console.error('[Scheduler] NSE fetch ultimately failed');
  }
}

async function runPriceFetch() {
  try {
    await fetchPrices();
  } catch (err) {
    console.error('[Scheduler] Price fetch error:', err.message);
  }
}

// ─── Cron registration ─────────────────────────────────────────────────────

function startScheduler() {
  // 8:00 AM IST — fetch NSE corporate actions (pre-market)
  cron.schedule('0 8 * * *', async () => {
    try {
      await runDataFetch('NSE Fetch (Morning)');
    } catch (err) {
      console.error('[Scheduler] Morning fetch error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Every 5 minutes during market hours (9:15 AM – 3:45 PM IST, Mon-Fri)
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const istNow = new Date(now);
    const timeMinutes = istNow.getHours() * 60 + istNow.getMinutes();
    if (timeMinutes >= 555 && timeMinutes <= 945) {
      await runPriceFetch();
    }
  }, { timezone: 'Asia/Kolkata' });

  // 9:30 AM IST — alert engine (runs after morning fetch)
  cron.schedule('30 9 * * *', async () => {
    const logId = await logJobStart('Alert Engine');
    console.log('[Scheduler] ── Alert engine started ──');
    try {
      const result = await runAlertEngine();
      await logJobEnd(logId, 'success', result ? JSON.stringify(result) : 'Done');
      console.log('[Scheduler] ── Alert engine complete ──');
    } catch (err) {
      await logJobEnd(logId, 'failed', err.message);
      console.error('[Scheduler] Alert engine failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // 6:00 PM IST — post-market data fetch (catches intraday announcements)
  cron.schedule('0 18 * * *', async () => {
    try {
      await runDataFetch('NSE Fetch (Evening)');
    } catch (err) {
      console.error('[Scheduler] Evening fetch error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] Cron jobs registered (IST timezone)');
  console.log('[Scheduler]   8:00 AM IST      — NSE corporate actions fetch (pre-market)');
  console.log('[Scheduler]   9:15-15:45 IST   — LTP price fetch (every 5 min, Mon-Fri)');
  console.log('[Scheduler]   9:30 AM IST      — Alert engine');
  console.log('[Scheduler]   6:00 PM IST      — NSE corporate actions fetch (post-market)');
}

module.exports = { startScheduler, runDataFetch, runPriceFetch };
