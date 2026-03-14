/**
 * app.js — Shared client-side utilities for Radarly
 * Requires supabase-client.js to be loaded first (provides window._supa)
 */

// ─── Session management (Supabase) ───────────────────────────────────────────

async function getToken() {
  const { data: { session } } = await _supa.auth.getSession();
  return session?.access_token || null;
}

async function logout() {
  await _supa.auth.signOut();
  window.location.href = '/';
}

// ─── API helper ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const token = await getToken();
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
  const { data: { session } } = await _supa.auth.getSession();
  if (!session) { window.location.href = '/login.html'; return null; }
  const user = await getMe();
  if (!user) { window.location.href = '/login.html'; return null; }
  return user;
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

// ─── Toast notification ───────────────────────────────────────────────────────

function showToast(message, type = 'success') {
  const existing = document.getElementById('radarly-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'radarly-toast';
  const bg = type === 'error' ? 'var(--danger)' : '#111111';
  toast.style.cssText = `
    position:fixed; bottom:28px; left:50%;
    transform:translateX(-50%) translateY(16px);
    background:${bg}; color:#fff;
    padding:10px 22px; border-radius:24px;
    font-size:13px; font-weight:600; letter-spacing:-0.01em;
    box-shadow:0 4px 20px rgba(0,0,0,0.22);
    z-index:9999; opacity:0; pointer-events:none; white-space:nowrap;
    transition:opacity 0.22s ease, transform 0.22s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  }));

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 2600);
}

// ─── Nav helper ──────────────────────────────────────────────────────────────

function setupNav(activePage) {
  const links = document.querySelectorAll('.nav-links a');
  links.forEach(a => {
    if (a.getAttribute('href') === `/${activePage}`) a.classList.add('active');
    else a.classList.remove('active');
  });
}

// ─── Mobile sidebar menu ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('.nav');
  const navLinks = nav?.querySelector('.nav-links');
  if (!nav || !navLinks) return;

  const toggle = document.createElement('button');
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', 'Toggle menu');
  toggle.innerHTML = '&#9776;';
  nav.insertBefore(toggle, nav.firstChild);

  const overlay = document.createElement('div');
  overlay.className = 'nav-overlay';
  document.body.appendChild(overlay);

  function openMenu() {
    navLinks.classList.add('open');
    overlay.classList.add('open');
    toggle.innerHTML = '&#10005;';
  }

  function closeMenu() {
    navLinks.classList.remove('open');
    overlay.classList.remove('open');
    toggle.innerHTML = '&#9776;';
  }

  toggle.addEventListener('click', () => {
    navLinks.classList.contains('open') ? closeMenu() : openMenu();
  });

  overlay.addEventListener('click', closeMenu);

  navLinks.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', closeMenu);
  });
});
