/**
 * supabase-client.js — Radarly Supabase auth client
 * Must be loaded AFTER the Supabase CDN script and BEFORE app.js
 */
window._supa = supabase.createClient(
  'https://tzksxheopspuwdtmwjcx.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR6a3N4aGVvcHNwdXdkdG13amN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2MzAyMDgsImV4cCI6MjA4ODIwNjIwOH0.p9cCeEju54rz55E4wt55XVdNSJxB5k5E5jrEldbEXdQ'
);
