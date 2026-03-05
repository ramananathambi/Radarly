/**
 * app.js — Shared client-side utilities for Radarly
 */

// ─── Session management ──────────────────────────────────────────────────────

function getToken() { return localStorage.getItem('session_token'); }
function setToken(t) { localStorage.setItem('session_token', t); }
function clearToken() { localStorage.removeItem('session_token'); }

// ─── API helper ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Auth checks ─────────────────────────────────────────────────────────────

async function getMe() {
  try { return await api('GET', '/api/user/me'); }
  catch { return null; }
}

async function requireLogin() {
  const user = await getMe();
  if (!user) { window.location.href = '/login.html'; return null; }
  return user;
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch {}
  clearToken();
  window.location.href = '/';
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function showAlert(containerId, message, type = 'info') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  setTimeout(() => { if (el.firstChild) el.firstChild.style.opacity = '0.6'; }, 4000);
}

function clearAlert(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function setLoading(btnEl, loading) {
  if (loading) {
    btnEl.dataset.origText = btnEl.textContent;
    btnEl.textContent = 'Loading...';
    btnEl.disabled = true;
  } else {
    btnEl.textContent = btnEl.dataset.origText || btnEl.textContent;
    btnEl.disabled = false;
  }
}

// ─── Nav helper (update Login/Logout link) ───────────────────────────────────

function setupNav(activePage) {
  const links = document.querySelectorAll('.nav-links a');
  links.forEach(a => {
    if (a.getAttribute('href') === `/${activePage}`) a.classList.add('active');
    else a.classList.remove('active');
  });
}
