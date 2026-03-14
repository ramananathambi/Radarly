/**
 * alertEngine.js
 * T-2 alert broadcaster — runs daily at 9:30 AM IST after data fetch.
 *
 * Logic:
 *   1. Find all DIVIDEND corporate actions with ex_date = today + 2
 *   2. For each action, find eligible users:
 *        - scope = 'all_stocks'  → all users with DIVIDEND pref enabled
 *        - scope = 'selected_stocks' → only users who bookmarked that symbol
 *   3. Skip if already in alert_log (deduplication)
 *   4. Send WhatsApp via Twilio
 *   5. Log to alert_log (sent or failed)
 */

const { pool } = require('../lib/db');
const { buildMessage }  = require('../lib/alertRouter');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTodayPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function sendWhatsApp(user, action) {
  const { client } = require('../lib/twilio');
  const message = buildMessage('DIVIDEND', user, action);

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to:   `whatsapp:${user.phone}`,
    body: message,
  });
}

// ─── Main engine ──────────────────────────────────────────────────────────────

async function runAlertEngine() {
  const targetDate = getTodayPlusDays(2);
  console.log(`[AlertEngine] Running for ex_date = ${targetDate}`);

  // Step 1: fetch all active DIVIDEND alert types (extensible — reads from DB)
  const [activeTypes] = await pool.execute(
    'SELECT code FROM alert_types WHERE is_active = 1'
  );

  const activeCodes = (activeTypes || []).map(t => t.code);
  if (!activeCodes.includes('DIVIDEND')) {
    console.log('[AlertEngine] DIVIDEND alert type is not active — skipping');
    return;
  }

  // Step 2: fetch corporate actions for T-2 date with stock details
  const [actions] = await pool.execute(
    `SELECT ca.symbol, ca.action_type, ca.ex_date, ca.record_date, ca.details,
            sm.company_name
     FROM corporate_actions ca
     JOIN stocks_master sm ON ca.symbol = sm.symbol
     WHERE ca.action_type = 'DIVIDEND' AND ca.ex_date = ?`,
    [targetDate]
  );

  if (!actions || actions.length === 0) {
    console.log(`[AlertEngine] No DIVIDEND actions for ${targetDate}`);
    return;
  }

  console.log(`[AlertEngine] Found ${actions.length} dividend actions for ${targetDate}`);

  let sent = 0, skipped = 0, failed = 0;

  for (const action of actions) {
    // Enrich action with company details for the message template
    const enrichedAction = {
      ...action,
      company_name: action.company_name || action.symbol,
      exchange:     action.exchange     || 'NSE/BSE',
      stocks_master: {
        company_name: action.company_name,
        exchange:     action.exchange,
      },
    };

    // Step 3: find eligible users for this action
    const eligibleUsers = await getEligibleUsers(action.symbol, 'DIVIDEND');

    for (const user of eligibleUsers) {
      // Step 4: deduplication check
      const [existingRows] = await pool.execute(
        `SELECT user_id FROM alert_log
         WHERE user_id = ? AND symbol = ? AND alert_type = 'DIVIDEND' AND event_date = ?`,
        [user.id, action.symbol, action.ex_date]
      );

      if (existingRows.length > 0) {
        skipped++;
        continue;
      }

      // Step 5: send WhatsApp
      let status = 'sent';
      try {
        if (process.env.DEV_MODE === 'true') {
          const msg = buildMessage('DIVIDEND', user, enrichedAction);
          console.log(`[AlertEngine][DEV] Would send to ${user.phone}:\n${msg}\n`);
        } else {
          await sendWhatsApp(user, enrichedAction);
        }
        sent++;
      } catch (err) {
        console.error(`[AlertEngine] WhatsApp failed for ${user.phone}:`, err.message);
        status = 'failed';
        failed++;
      }

      // Step 6: log to alert_log regardless of send outcome
      await pool.execute(
        `INSERT INTO alert_log (user_id, symbol, alert_type, event_date, status)
         VALUES (?, ?, 'DIVIDEND', ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), sent_at = NOW()`,
        [user.id, action.symbol, action.ex_date, status]
      );
    }
  }

  console.log(`[AlertEngine] Done — sent: ${sent}, skipped: ${skipped}, failed: ${failed}`);
  return { sent, skipped, failed };
}

// ─── Eligible user resolution ─────────────────────────────────────────────────

async function getEligibleUsers(symbol, alertType) {
  // Users with 'all_stocks' scope — get all of them with pref enabled
  const [allStocksRows] = await pool.execute(
    `SELECT u.id, u.name, u.phone
     FROM user_alert_preferences uap
     JOIN users u ON uap.user_id = u.id
     WHERE uap.alert_type = ? AND uap.scope = 'all_stocks' AND uap.is_enabled = 1`,
    [alertType]
  );

  // Users with 'selected_stocks' scope — only if they bookmarked this symbol
  const [selectedStocksRows] = await pool.execute(
    `SELECT u.id, u.name, u.phone
     FROM user_alert_preferences uap
     JOIN users u ON uap.user_id = u.id
     WHERE uap.alert_type = ? AND uap.scope = 'selected_stocks' AND uap.is_enabled = 1`,
    [alertType]
  );

  // Filter selected_stocks users to those who have this symbol bookmarked
  let qualifiedSelected = [];
  if (selectedStocksRows.length > 0) {
    const selectedUserIds = selectedStocksRows.map(u => u.id);
    const placeholders = selectedUserIds.map(() => '?').join(',');

    const [bookmarked] = await pool.query(
      `SELECT user_id FROM user_stocks WHERE symbol = ? AND user_id IN (${placeholders})`,
      [symbol, ...selectedUserIds]
    );

    const bookmarkedIds = new Set(bookmarked.map(b => b.user_id));
    qualifiedSelected = selectedStocksRows.filter(u => bookmarkedIds.has(u.id));
  }

  // Merge both groups, deduplicate by user_id, filter users with phone
  const allUsers = [...allStocksRows, ...qualifiedSelected];
  const seen     = new Set();
  const users    = [];

  for (const u of allUsers) {
    if (!u.phone) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    users.push(u);
  }

  return users;
}

module.exports = { runAlertEngine };
