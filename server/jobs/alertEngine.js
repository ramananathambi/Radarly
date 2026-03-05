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

const { supabaseAdmin } = require('../lib/supabase');
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
  const { data: activeTypes } = await supabaseAdmin
    .from('alert_types')
    .select('code')
    .eq('is_active', true);

  const activeCodes = (activeTypes || []).map(t => t.code);
  if (!activeCodes.includes('DIVIDEND')) {
    console.log('[AlertEngine] DIVIDEND alert type is not active — skipping');
    return;
  }

  // Step 2: fetch corporate actions for T-2 date
  const { data: actions, error: actionsErr } = await supabaseAdmin
    .from('corporate_actions')
    .select(`
      id, symbol, action_type, ex_date, record_date, details,
      stocks_master ( company_name, exchange )
    `)
    .eq('action_type', 'DIVIDEND')
    .eq('ex_date', targetDate);

  if (actionsErr) {
    console.error('[AlertEngine] Failed to fetch actions:', actionsErr.message);
    throw actionsErr;
  }

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
      company_name: action.stocks_master?.company_name || action.symbol,
      exchange:     action.stocks_master?.exchange     || 'NSE/BSE',
    };

    // Step 3: find eligible users for this action
    const eligibleUsers = await getEligibleUsers(action.symbol, 'DIVIDEND');

    for (const user of eligibleUsers) {
      // Step 4: deduplication check
      const { data: existing } = await supabaseAdmin
        .from('alert_log')
        .select('id')
        .eq('user_id',    user.id)
        .eq('symbol',     action.symbol)
        .eq('alert_type', 'DIVIDEND')
        .eq('event_date', action.ex_date)
        .maybeSingle();

      if (existing) {
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
      await supabaseAdmin
        .from('alert_log')
        .upsert({
          user_id:    user.id,
          symbol:     action.symbol,
          alert_type: 'DIVIDEND',
          event_date: action.ex_date,
          status,
        }, { onConflict: 'user_id,symbol,alert_type,event_date', ignoreDuplicates: false });
    }
  }

  console.log(`[AlertEngine] Done — sent: ${sent}, skipped: ${skipped}, failed: ${failed}`);
  return { sent, skipped, failed };
}

// ─── Eligible user resolution ─────────────────────────────────────────────────

async function getEligibleUsers(symbol, alertType) {
  // Users with 'all_stocks' scope — get all of them with pref enabled
  const { data: allStocksUsers } = await supabaseAdmin
    .from('user_alert_preferences')
    .select('user_id, users ( id, name, phone, is_verified )')
    .eq('alert_type',  alertType)
    .eq('scope',       'all_stocks')
    .eq('is_enabled',  true);

  // Users with 'selected_stocks' scope — only if they bookmarked this symbol
  const { data: selectedStocksUsers } = await supabaseAdmin
    .from('user_alert_preferences')
    .select('user_id, users ( id, name, phone, is_verified )')
    .eq('alert_type', alertType)
    .eq('scope',      'selected_stocks')
    .eq('is_enabled', true);

  // Filter selected_stocks users to those who have this symbol bookmarked
  const selectedUserIds = (selectedStocksUsers || []).map(p => p.user_id);

  let qualifiedSelected = [];
  if (selectedUserIds.length > 0) {
    const { data: bookmarked } = await supabaseAdmin
      .from('user_stocks')
      .select('user_id')
      .eq('symbol', symbol)
      .in('user_id', selectedUserIds);

    const bookmarkedIds = new Set((bookmarked || []).map(b => b.user_id));
    qualifiedSelected = (selectedStocksUsers || []).filter(p => bookmarkedIds.has(p.user_id));
  }

  // Merge both groups, deduplicate by user_id, filter verified users with phone
  const allPrefs = [...(allStocksUsers || []), ...qualifiedSelected];
  const seen     = new Set();
  const users    = [];

  for (const pref of allPrefs) {
    const u = pref.users;
    if (!u || !u.phone || !u.is_verified) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    users.push(u);
  }

  return users;
}

module.exports = { runAlertEngine };
