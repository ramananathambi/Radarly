const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Anon client — used for user-facing operations (respects RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Service role client — used for admin/backend operations (bypasses RLS)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = { supabase, supabaseAdmin };
