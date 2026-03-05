const { supabaseAdmin } = require('../lib/supabase');

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, name, phone, email, is_verified')
    .eq('session_token', token)
    .gt('session_expires_at', new Date().toISOString().replace('Z', ''))
    .maybeSingle();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = user;
  next();
}

module.exports = { requireAuth };
