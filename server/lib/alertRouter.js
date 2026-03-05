/**
 * alertRouter.js
 * Routes an alert_type to its WhatsApp message template.
 * Add new templates here when activating new alert types.
 */

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function dayBefore(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  return formatDate(d.toISOString());
}

const templates = {
  DIVIDEND: (user, action) => {
    const details = action.details || {};
    const amount  = details.amount  ? `₹${details.amount}` : 'N/A';
    const yieldPc = details.yield   ? `${details.yield}%`  : 'N/A';
    const exDate  = formatDate(action.ex_date);
    const buyBy   = dayBefore(action.ex_date);

    return (
      `Hi ${user.name} 👋\n\n` +
      `📢 *Dividend Alert — ${action.company_name || action.symbol} (${action.symbol})*\n\n` +
      `📅 Ex-Date: ${exDate}\n` +
      `💰 Dividend: ${amount} per share\n` +
      `📊 Yield: ${yieldPc}\n` +
      `🏛 Exchange: ${action.exchange || 'NSE/BSE'}\n\n` +
      `Buy before *${buyBy}* to be eligible.\n\n` +
      `Reply STOP to unsubscribe. — Radarly`
    );
  },

  // Future templates — add here when activating new alert types
  BONUS: (user, action) => {
    const details = action.details || {};
    return (
      `Hi ${user.name} 👋\n\n` +
      `📢 *Bonus Issue — ${action.symbol}*\n\n` +
      `📅 Ex-Date: ${formatDate(action.ex_date)}\n` +
      `🎁 Ratio: ${details.ratio || 'N/A'}\n\n` +
      `Reply STOP to unsubscribe. — Radarly`
    );
  },
};

function getTemplate(alertType) {
  if (!templates[alertType]) {
    throw new Error(`No message template found for alert type: ${alertType}`);
  }
  return templates[alertType];
}

function buildMessage(alertType, user, action) {
  const template = getTemplate(alertType);
  return template(user, action);
}

module.exports = { buildMessage };
