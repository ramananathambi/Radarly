/**
 * scheduler.js
 * Cron job runner — all jobs run in Asia/Kolkata (IST) timezone.
 *
 * Schedule:
 *   8:00 AM IST — NSE corporate actions fetch (pre-market)
 *   9:15 AM - 3:45 PM IST (every 5 min) — LTP price fetch
 *   9:30 AM IST — Alert engine
 *   6:00 PM IST — NSE corporate actions fetch (post-market, catches intraday announcements)
 */
const cron = require('node-cron');
const { fetchNSE }       = require('./fetchNSE');
const { runAlertEngine } = require('./alertEngine');
const { fetchPrices }    = require('./fetchPrices');

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

  try {
    const result = await withRetry('NSE fetch', fetchNSE);
    console.log('[Scheduler] ── Data fetch complete ──', result);
    return result;
  } catch (err) {
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

// ─── Cron registration ────────────────────────────────────────────────────────

function startScheduler() {
  // 8:00 AM IST — fetch NSE corporate actions
  cron.schedule('0 8 * * *', async () => {
    try {
      await runDataFetch();
    } catch (err) {
      console.error('[Scheduler] Data fetch run error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Every 5 minutes during market hours (9:15 AM - 3:45 PM IST, Mon-Fri)
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    // Only run during market window: 9:15 AM to 3:45 PM
    const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const istNow = new Date(now);
    const hour = istNow.getHours();
    const minute = istNow.getMinutes();
    const timeMinutes = hour * 60 + minute;

    // Market open: 9:15 (555 min), Market close: 15:45 (945 min)
    if (timeMinutes >= 555 && timeMinutes <= 945) {
      await runPriceFetch();
    }
  }, { timezone: 'Asia/Kolkata' });

  // 9:30 AM IST — alert engine (1.5hr after morning corporate actions fetch)
  cron.schedule('30 9 * * *', async () => {
    console.log('[Scheduler] ── Alert engine started ──');
    try {
      await runAlertEngine();
      console.log('[Scheduler] ── Alert engine complete ──');
    } catch (err) {
      console.error('[Scheduler] Alert engine failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // 6:00 PM IST — post-market data fetch (captures intraday announcements)
  cron.schedule('0 18 * * *', async () => {
    try {
      await runDataFetch();
    } catch (err) {
      console.error('[Scheduler] Evening data fetch run error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] Cron jobs registered (IST timezone)');
  console.log('[Scheduler]   8:00 AM IST      — NSE corporate actions fetch (pre-market)');
  console.log('[Scheduler]   9:15-15:45 IST   — LTP price fetch (every 5 min, Mon-Fri)');
  console.log('[Scheduler]   9:30 AM IST      — Alert engine');
  console.log('[Scheduler]   6:00 PM IST      — NSE corporate actions fetch (post-market)');
}

module.exports = { startScheduler, runDataFetch, runPriceFetch };
