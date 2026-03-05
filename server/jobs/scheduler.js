/**
 * scheduler.js
 * Cron job runner — all jobs run in Asia/Kolkata (IST) timezone.
 *
 * Schedule:
 *   8:00 AM IST — NSE + BSE fetch (retry at 8:30 and 9:00 on failure)
 *   9:30 AM IST — Alert engine (runs after fetch window completes)
 */
const cron = require('node-cron');
const { fetchNSE }       = require('./fetchNSE');
const { fetchBSE }       = require('./fetchBSE');
const { runAlertEngine } = require('./alertEngine');

// In dev, retry after 5s so the process doesn't hang for 30 minutes
const RETRY_DELAY_MS = process.env.DEV_MODE === 'true'
  ? 5 * 1000            // 5 seconds in dev
  : 30 * 60 * 1000;     // 30 minutes in production
const MAX_RETRIES     = 3;

// ─── Retry wrapper ────────────────────────────────────────────────────────────

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

// ─── Job runners ──────────────────────────────────────────────────────────────

async function runDataFetch() {
  console.log('[Scheduler] ── Data fetch started ──');
  const results = { nse: null, bse: null };

  try {
    results.nse = await withRetry('NSE fetch', fetchNSE);
  } catch (err) {
    console.error('[Scheduler] NSE fetch ultimately failed — continuing to BSE');
  }

  try {
    results.bse = await withRetry('BSE fetch', fetchBSE);
  } catch (err) {
    console.error('[Scheduler] BSE fetch ultimately failed');
  }

  console.log('[Scheduler] ── Data fetch complete ──', results);
  return results;
}

// ─── Cron registration ────────────────────────────────────────────────────────

function startScheduler() {
  // 8:00 AM IST — fetch NSE + BSE corporate actions
  cron.schedule('0 8 * * *', async () => {
    try {
      await runDataFetch();
    } catch (err) {
      console.error('[Scheduler] Data fetch run error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // 9:30 AM IST — alert engine (1.5hr after fetch, ensures data is ready)
  cron.schedule('30 9 * * *', async () => {
    console.log('[Scheduler] ── Alert engine started ──');
    try {
      await runAlertEngine();
      console.log('[Scheduler] ── Alert engine complete ──');
    } catch (err) {
      console.error('[Scheduler] Alert engine failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] Cron jobs registered (IST timezone)');
  console.log('[Scheduler]   8:00 AM IST — NSE + BSE data fetch');
  console.log('[Scheduler]   9:30 AM IST — Alert engine');
}

module.exports = { startScheduler, runDataFetch };
