/* =====================================================================
   S&S Shop Invoicing — app.js
   A single-file vanilla-JS PWA talking directly to Supabase.
   No build step: edit and re-upload if you ever want to change it.
   ===================================================================== */

// ---- Your Supabase project (safe to be public — RLS protects the data) ----
const SUPABASE_URL = 'https://sobcqgdzwouzvjllicqz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jFylkFTj0JFkzhAIAMssQw_nZpwylJZ';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function money(n, currency) {
  const v = Math.round(Number(n || 0));
  const s = Math.abs(v).toLocaleString('en-US');
  return (v < 0 ? '-' : '') + (currency || state.profile?.currency || 'UGX') + ' ' + s;
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function uid() { return Math.random().toString(36).slice(2, 10); }

// ---------------------------------------------------------------------
// Product photos — client-side compression before upload, so the free
// Supabase storage quota (1GB) lasts for thousands of photos instead of
// a few hundred full-size phone photos.
// ---------------------------------------------------------------------
function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith('image/')) { resolve(file); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        resolve(blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function uploadItemPhoto(file) {
  const compressed = await compressImage(file, 1600, 0.75);
  const path = `${Date.now()}-${uid()}.jpg`;
  const { error } = await sb.storage.from('item-photos').upload(path, compressed, { upsert: false, contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}

async function signedItemPhotoUrls(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const { data, error } = await sb.storage.from('item-photos').createSignedUrls(list, 3600);
  if (error || !data) return {};
  const map = {};
  data.forEach((d) => { if (d && d.signedUrl && d.path) map[d.path] = d.signedUrl; });
  return map;
}

function shortMoney(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1000000) return (v / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + 'M';
  if (abs >= 1000) return (v / 1000).toFixed(0) + 'K';
  return String(Math.round(v));
}

// ---------------------------------------------------------------------
// Chart.js helper — bar charts for the dashboard & reports pages.
// Keeps one Chart instance per canvas id and destroys the previous one
// before re-drawing, since every SPA navigation re-renders the markup.
// ---------------------------------------------------------------------
const chartInstances = {};
function renderBarChart(canvasId, labels, datasets) {
  const el = document.getElementById(canvasId);
  if (!el || typeof Chart === 'undefined') return;
  if (chartInstances[canvasId]) { chartInstances[canvasId].destroy(); delete chartInstances[canvasId]; }
  chartInstances[canvasId] = new Chart(el, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${money(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          beginAtZero: true,
          grid: { color: '#ececef' },
          ticks: { font: { size: 11 }, callback: (v) => shortMoney(v) },
        },
      },
    },
  });
}

function toast(msg, isErr) {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), isErr ? 4000 : 2400);
}

function friendlyError(err) {
  const m = (err && (err.message || err.error_description || String(err))) || 'Something went wrong';
  if (/locked/i.test(m)) return m.replace(/^.*?(Invoice|Line items|This payment)/, '$1');
  if (/JWT|network|fetch/i.test(m)) return 'Connection problem — check your internet and try again.';
  return m;
}

function navigate(hash) { location.hash = hash; }

// ---------------------------------------------------------------------
// App state (loaded once after login, refreshed as needed)
// ---------------------------------------------------------------------
// Authorised signature printed on every invoice and debt reminder (aspect ratio 1.466 : 1).
const SIGNATURE_PNG = 'data:image/png;base64,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';
const SIGNATURE_RATIO = 1.4664;

const state = {
  session: null,
  profile: null,
  clients: [],
  items: [],
  categories: [],
};

// Supabase returns at most 1,000 rows per request. Now that older years are
// imported (1,500+ invoices), anything that needs "all rows" must page through.
// Pass a function that builds a FRESH query each call; add a unique tie-break
// column (like id) to its .order() so pages never skip or repeat rows.
async function fetchAll(build, pageSize = 1000) {
  let all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
  }
  return { data: all, error: null };
}

async function loadReferenceData() {
  const [{ data: profile }, { data: clients }, { data: items }, { data: cats }] = await Promise.all([
    sb.from('business_profile').select('*').maybeSingle(),
    fetchAll(() => sb.from('clients').select('*').order('name').order('id')),
    sb.from('items').select('*').eq('is_active', true).order('name'),
    sb.from('expense_categories').select('*').eq('is_active', true).order('sort_order'),
  ]);
  state.profile = profile || null;
  state.clients = clients || [];
  state.items = items || [];
  state.categories = cats || [];
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
async function login(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  try { localStorage.setItem('ss_last_email', email); } catch (e) { /* private browsing, etc. */ }
}
function lastEmail() {
  try { return localStorage.getItem('ss_last_email') || ''; } catch (e) { return ''; }
}
async function logout() {
  await sb.auth.signOut();
}

sb.auth.onAuthStateChange((_evt, session) => {
  state.session = session;
  onAuthChanged();
});

const NAV_ITEMS = [
  { tab: 'dashboard', hash: '#/dashboard', label: 'Dashboard', ic: 'fa-house' },
  { tab: 'invoices',  hash: '#/invoices',  label: 'Invoices', ic: 'fa-file-invoice' },
  { tab: 'expenses',  hash: '#/expenses',  label: 'Expenses', ic: 'fa-wallet' },
  { tab: 'clients',   hash: '#/clients',   label: 'Customers', ic: 'fa-users' },
  { tab: 'reports',   hash: '#/reports',   label: 'Reports', ic: 'fa-chart-column' },
  { tab: 'settings',  hash: '#/settings',  label: 'Settings', ic: 'fa-gear' },
];

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

async function onAuthChanged() {
  const loggedIn = !!state.session;
  $('#tabbar').classList.toggle('hidden', !loggedIn);
  $('#logoutBtn').classList.toggle('hidden', !loggedIn);
  $('#sidebar').classList.toggle('hidden', !loggedIn);
  if (loggedIn && !state.profile) {
    try { await loadReferenceData(); } catch (e) { console.error(e); }
  }
  if (!loggedIn) { state.profile = null; state.clients = []; state.items = []; state.categories = []; }
  if (loggedIn) {
    $('#sidebarNav').innerHTML = NAV_ITEMS.map(n => `<a href="${n.hash}" data-tab="${n.tab}"><span class="ic"><i class="fa-solid ${n.ic}"></i></span>${n.label}</a>`).join('');
  }
  route();
}

$('#logoutBtn').addEventListener('click', async () => {
  await logout();
  navigate('#/dashboard');
});
$('#sidebarLogoutBtn').addEventListener('click', async () => {
  await logout();
  navigate('#/dashboard');
});

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
const routes = [
  { p: /^#\/login$/, v: viewLogin },
  { p: /^#?$|^#\/dashboard$/, v: viewDashboard },
  { p: /^#\/invoices$/, v: viewInvoiceList },
  { p: /^#\/invoices\/new$/, v: () => viewInvoiceForm(null) },
  { p: /^#\/invoices\/([^/]+)\/edit$/, v: (id) => viewInvoiceForm(id) },
  { p: /^#\/invoices\/([^/]+)$/, v: (id) => viewInvoiceDetail(id) },
  { p: /^#\/clients$/, v: viewClients },
  { p: /^#\/expenses$/, v: viewExpenseList },
  { p: /^#\/expenses\/new$/, v: () => viewExpenseForm(null) },
  { p: /^#\/expenses\/([^/]+)\/edit$/, v: (id) => viewExpenseForm(id) },
  { p: /^#\/reports$/, v: viewReports },
  { p: /^#\/settings$/, v: viewSettings },
  { p: /^#\/more$/, v: viewMore },
];

function setActiveTab(name) {
  const bottomTab = ['dashboard', 'invoices', 'expenses'].includes(name) ? name : (name ? 'more' : '');
  $$('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === bottomTab));
  $$('#sidebarNav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}

async function route() {
  const hash = location.hash || '#/dashboard';
  if (!state.session && hash !== '#/login') { navigate('#/login'); return; }
  if (state.session && hash === '#/login') { navigate('#/dashboard'); return; }
  $('#app').classList.toggle('on-login', hash === '#/login');

  for (const r of routes) {
    const m = hash.match(r.p);
    if (m) {
      const view = $('#view');
      view.innerHTML = '<div class="center-load"><div class="spin"></div></div>';
      window.scrollTo(0, 0);
      const tab = hash.startsWith('#/invoices') ? 'invoices'
        : hash.startsWith('#/expenses') ? 'expenses'
        : hash.startsWith('#/clients') ? 'clients'
        : hash.startsWith('#/reports') ? 'reports'
        : hash.startsWith('#/settings') ? 'settings'
        : hash.startsWith('#/more') ? 'more'
        : hash.startsWith('#/dashboard') || hash === '' || hash === '#' ? 'dashboard' : '';
      setActiveTab(tab);
      try {
        await r.v(m[1]);
      } catch (e) {
        console.error(e);
        view.innerHTML = `<div class="card"><p class="muted">Could not load this page.</p><p class="small muted">${esc(friendlyError(e))}</p></div>`;
      }
      return;
    }
  }
  navigate('#/dashboard');
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
function viewLogin() {
  $('#tabbar').classList.add('hidden');
  $('#sidebar').classList.add('hidden');
  $('#view').innerHTML = `
    <div class="login-page">
      <img class="bg" src="images/login-bg-v2.jpg" alt="" />
      <div class="login-intro">
        <a class="brand" href="#"><img src="icons/logo-white-mark.png" alt="S&amp;S"
          onerror="this.outerHTML='<span style=&quot;color:#fff;font-weight:700;font-size:22px&quot;>S&amp;S</span>';" /></a>
        <p class="login-kicker">Simply Elegant</p>
        <h1 class="login-headline">Invoicing made simply elegant.</h1>
      </div>

      <section class="login-glass" aria-labelledby="loginTitle">
        <h2 id="loginTitle">Sign in</h2>
        <p class="sub">Good to see you again.</p>
        <form id="loginForm" novalidate>
          <div class="login-field">
            <label for="loginEmail">Email address</label>
            <input id="loginEmail" name="email" type="email" autocomplete="username" required placeholder="you@example.com" value="${esc(lastEmail())}" />
          </div>
          <div class="login-field">
            <label for="loginPw">Password</label>
            <div class="login-pw">
              <input id="loginPw" name="password" type="password" autocomplete="current-password" required placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" />
              <button class="login-eye" type="button" id="togglePw" aria-label="Show password" aria-pressed="false" aria-controls="loginPw">
                <svg class="on" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                <svg class="off" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
              </button>
            </div>
          </div>
          <div class="login-row"><span>Forgot password? Reset it from the Supabase dashboard.</span></div>
          <div id="loginErr" class="login-err"></div>
          <button class="btn primary" type="submit" style="margin-top:14px">
            <span id="loginBtnLabel">Sign in</span>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </form>
        <p class="login-foot">S&amp;S Shop Invoicing</p>
      </section>
    </div>`;
  $('#togglePw').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const i = $('#loginPw');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#loginBtnLabel').innerHTML = '<span class="spin"></span>';
    $('#loginErr').textContent = '';
    try {
      await login(f.get('email').trim(), f.get('password'));
    } catch (err) {
      $('#loginErr').textContent = friendlyError(err);
      $('#loginBtnLabel').textContent = 'Sign in';
    }
  });
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l10-10M7 7h10v10"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M7 17h10V7"/></svg>',
  flat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>',
};
function trendPill(pct) {
  const dir = pct > 2 ? 'up' : pct < -2 ? 'down' : 'flat';
  const sign = pct > 0 ? '+' : '';
  return `<span class="kpi-pill ${dir}">${ICON[dir]} ${sign}${Math.round(pct)}%</span>`;
}
function trendCompare(dir, prevAmt, label) {
  return `<div class="kpi-compare ${dir}">${ICON[dir]} ${dir === 'flat' ? 'holding around' : dir === 'up' ? 'up from' : 'down from'} <strong>${money(prevAmt)}</strong><span class="muted">&middot; ${label}</span></div>`;
}
function pctAndDir(curr, prev) {
  const pct = prev > 0 ? ((curr - prev) / prev) * 100 : (curr > 0 ? 100 : 0);
  const dir = pct > 2 ? 'up' : pct < -2 ? 'down' : 'flat';
  return { pct, dir };
}

async function viewDashboard() {
  const view = $('#view');
  const monthStart = todayISO().slice(0, 8) + '01';
  const yearStart = todayISO().slice(0, 4) + '-01-01';
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const chartLookback = addDays(todayISO(), -28);
  const since = [prevMonthStart, chartLookback, yearStart].sort()[0];

  const [{ data: inv, error: e1 }, { data: allPay }, { data: allExp }] = await Promise.all([
    fetchAll(() => sb.from('invoice_summary').select('id, number, client_name, total, paid, balance_due, status, issue_date').order('issue_date', { ascending: false }).order('id')),
    fetchAll(() => sb.from('payments').select('amount, paid_on').gte('paid_on', since).order('id')),
    fetchAll(() => sb.from('expenses').select('amount, spent_on').gte('spent_on', since).order('id')),
  ]);
  if (e1) throw e1;

  const outstanding = inv.filter(i => !['void', 'draft'].includes(i.status)).reduce((s, i) => s + Number(i.balance_due), 0);
  const overdue = inv.filter(i => i.status === 'overdue');
  const partial = inv.filter(i => i.status === 'partial');

  const collectedThisMonth = (allPay || []).filter(p => p.paid_on >= monthStart).reduce((s, p) => s + Number(p.amount), 0);
  const collectedPrevMonth = (allPay || []).filter(p => p.paid_on >= prevMonthStart && p.paid_on < monthStart).reduce((s, p) => s + Number(p.amount), 0);
  const collectedThisYear = (allPay || []).filter(p => p.paid_on >= yearStart).reduce((s, p) => s + Number(p.amount), 0);
  const spentThisMonth = (allExp || []).filter(e => e.spent_on >= monthStart).reduce((s, e) => s + Number(e.amount), 0);
  const spentPrevMonth = (allExp || []).filter(e => e.spent_on >= prevMonthStart && e.spent_on < monthStart).reduce((s, e) => s + Number(e.amount), 0);
  const invoicedThisMonth = inv.filter(i => i.issue_date >= monthStart && !['void', 'draft'].includes(i.status))
    .reduce((s, i) => s + Number(i.total), 0);

  const collectedTrend = pctAndDir(collectedThisMonth, collectedPrevMonth);
  const spentTrend = pctAndDir(spentThisMonth, spentPrevMonth);

  // last 4 weeks, collected vs spent
  const weeks = [];
  for (let w = 3; w >= 0; w--) {
    const start = addDays(todayISO(), -7 * (w + 1) + 1);
    const end = addDays(todayISO(), -7 * w);
    const c = (allPay || []).filter(p => p.paid_on > addDays(start, -1) && p.paid_on <= end).reduce((s, p) => s + Number(p.amount), 0);
    const s2 = (allExp || []).filter(e => e.spent_on > addDays(start, -1) && e.spent_on <= end).reduce((s, e) => s + Number(e.amount), 0);
    weeks.push({ label: 'W' + (4 - w), collected: c, spent: s2 });
  }
  const maxBar = Math.max(1, ...weeks.map(w => Math.max(w.collected, w.spent)));

  const recent = inv.slice(0, 6);
  const greeting = new Date().getHours() < 12 ? 'Good Morning' : new Date().getHours() < 18 ? 'Good Afternoon' : 'Good Evening';
  const firstName = (state.profile?.name || 'there').split(' ')[0];

  view.innerHTML = `
    <div class="dash-topbar">
      <div class="dash-greeting">${greeting} ${esc(firstName)}!</div>
      <div class="dash-actions">
        <a class="btn primary sm" href="#/invoices/new"><i class="fa-solid fa-plus"></i> Invoice</a>
        <a class="btn sm" href="#/expenses/new"><i class="fa-solid fa-plus"></i> Expense</a>
        <a class="dash-link" href="#/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <button class="btn danger-solid sm" id="dashLogoutBtn"><i class="fa-solid fa-right-from-bracket"></i> Log Out</button>
      </div>
    </div>

    <div class="dash-grid">
      <article class="card g-outstanding">
        <div class="kpi-top">
          <div class="kpi-identity"><div class="icon-circle red"><i class="fa-solid fa-file-invoice-dollar"></i></div><div class="kpi-label">Outstanding</div></div>
          ${overdue.length ? `<span class="kpi-pill down">${ICON.down} ${overdue.length} overdue</span>` : `<span class="kpi-pill flat">${ICON.flat} none overdue</span>`}
        </div>
        <div class="kpi-value" style="color:var(--red)">${money(outstanding)}</div>
        <div class="kpi-compare"><span class="muted">${inv.filter(i => !['void', 'draft'].includes(i.status) && Number(i.balance_due) > 0).length} invoice(s) awaiting payment</span></div>
      </article>

      <article class="card g-collected-month">
        <div class="kpi-top">
          <div class="kpi-identity"><div class="icon-circle green"><i class="fa-solid fa-circle-check"></i></div><div class="kpi-label">Collected &middot; this month</div></div>
          ${trendPill(collectedTrend.pct)}
        </div>
        <div class="kpi-value" style="color:var(--ok)">${money(collectedThisMonth)}</div>
        ${trendCompare(collectedTrend.dir, collectedPrevMonth, 'last month')}
      </article>

      <article class="card g-alerts">
        <div class="card-head"><div><span class="eyebrow" style="color:var(--red)">Alerts</span><div class="card-title" style="color:var(--red)">Needs attention</div></div><i class="fa-solid fa-bell" style="color:var(--red);opacity:.6"></i></div>
        ${(overdue.length || partial.length) ? `
          ${overdue.length ? `<a class="attn-row" href="#/invoices"><div class="attn-count">${overdue.length}</div><div class="main"><div class="name">Overdue</div><div class="sub">${money(overdue.reduce((s, i) => s + Number(i.balance_due), 0))}</div></div><span class="muted">&rsaquo;</span></a>` : ''}
          ${partial.length ? `<a class="attn-row" href="#/invoices"><div class="attn-count" style="background:var(--warn)">${partial.length}</div><div class="main"><div class="name">Partial</div><div class="sub">${money(partial.reduce((s, i) => s + Number(i.balance_due), 0))}</div></div><span class="muted">&rsaquo;</span></a>` : ''}
        ` : '<div class="empty small">All clear &mdash; nothing needs attention.</div>'}
      </article>

      <article class="card g-expenses">
        <div class="kpi-top">
          <div class="kpi-identity"><div class="icon-circle purple"><i class="fa-solid fa-wallet"></i></div><div class="kpi-label">Expenses &middot; this month</div></div>
          ${trendPill(spentTrend.pct)}
        </div>
        <div class="kpi-value" style="color:#7c3aed">${money(spentThisMonth)}</div>
        ${trendCompare(spentTrend.dir, spentPrevMonth, 'last month')}
      </article>

      <article class="card g-collected-year">
        <div class="kpi-top">
          <div class="kpi-identity"><div class="icon-circle green"><i class="fa-solid fa-chart-line"></i></div><div class="kpi-label">Collected &middot; this year</div></div>
        </div>
        <div class="kpi-value" style="color:var(--ok)">${money(collectedThisYear)}</div>
        <div class="kpi-compare"><span class="muted">Since 1 Jan ${new Date().getFullYear()}</span></div>
      </article>

      <article class="card g-recent" style="padding-bottom:2px">
        <div class="card-head"><div><span class="eyebrow">Invoices</span><div class="card-title">Recent invoices</div></div><a class="card-action" href="#/invoices">See all ${ICON.arrow}</a></div>
        <div style="max-height:360px;overflow-y:auto">
          ${recent.length ? recent.map(invoiceRow).join('') : '<div class="empty">No invoices yet</div>'}
        </div>
      </article>

      <div class="card g-glance">
        <div class="card-head">
          <div><span class="eyebrow">Performance</span><div class="card-title">Month at a glance</div></div>
          <span class="card-action">Invoiced ${money(invoicedThisMonth)}</span>
        </div>
        <div class="row between" style="align-items:flex-start">
          <div>
            <div class="row between small" style="padding:3px 0;gap:24px"><span class="muted">Collected</span><b>${money(collectedThisMonth)}</b></div>
            <div class="row between small" style="padding:3px 0;gap:24px"><span class="muted">Spent</span><b>${money(spentThisMonth)}</b></div>
            <div class="row between" style="padding:6px 0 0;border-top:1px solid var(--line);margin-top:4px;gap:24px">
              <span class="small muted">Net</span><b style="color:${collectedThisMonth - spentThisMonth >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(collectedThisMonth - spentThisMonth)}</b>
            </div>
          </div>
          <div style="width:52%">
            <div class="chart-legend"><span><span class="dot" style="background:var(--ok)"></span>Collected</span><span><span class="dot" style="background:#e6c15c"></span>Spent</span></div>
            <div class="chart-box sm"><canvas id="glanceChart"></canvas></div>
          </div>
        </div>
      </div>
    </div>
  `;
  $('#dashLogoutBtn').addEventListener('click', async () => { await logout(); navigate('#/dashboard'); });
  renderBarChart('glanceChart', weeks.map(w => w.label), [
    { label: 'Collected', data: weeks.map(w => w.collected), backgroundColor: '#0f6e56', borderRadius: 4, maxBarThickness: 22 },
    { label: 'Spent', data: weeks.map(w => w.spent), backgroundColor: '#e6c15c', borderRadius: 4, maxBarThickness: 22 },
  ]);
}

function statusBadge(status) {
  const label = { paid: 'Paid', partial: 'Partial', unpaid: 'Unpaid', overdue: 'Overdue', draft: 'Draft', void: 'Void' }[status] || status;
  return `<span class="badge ${esc(status)}">${label}</span>`;
}

function invoiceRow(i) {
  return `<a class="list-item" href="#/invoices/${i.id}">
    <div class="avatar ${esc(i.status)}">${esc(initials(i.client_name))}</div>
    <div class="main">
      <div class="name">${esc(i.client_name)}</div>
      <div class="sub">${esc(i.number)} &middot; ${fmtDate(i.issue_date)} &middot; ${statusBadge(i.status)}</div>
    </div>
    <div class="amt">${money(i.total)}${Number(i.balance_due) > 0 ? `<div class="small" style="color:var(--danger)">${money(i.balance_due)} due</div>` : ''}</div>
  </a>`;
}

// ---------------------------------------------------------------------
// Invoices — list
// ---------------------------------------------------------------------
let invFilter = 'all';
let invSearch = '';
let invOpenYears = null; // Set of year strings currently expanded

async function viewInvoiceList() {
  const view = $('#view');
  const { data: inv, error } = await fetchAll(() => sb.from('invoice_summary').select('*').order('issue_date', { ascending: false }).order('id'));
  if (error) throw error;

  const tabs = [
    ['all', 'All'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['partial', 'Partial'], ['paid', 'Paid'], ['draft', 'Draft'],
  ];

  // Years, newest first. The newest year starts open; older ones start closed
  // and only build their rows when opened (keeps the list fast with 1,500+ invoices).
  if (!invOpenYears) {
    const newest = inv.length ? String(inv[0].issue_date).slice(0, 4) : null;
    invOpenYears = new Set(newest ? [newest] : []);
  }

  function render() {
    let rows = inv;
    if (invFilter !== 'all') rows = rows.filter(i => i.status === invFilter);
    const searching = !!invSearch.trim();
    if (searching) {
      const q = invSearch.trim().toLowerCase();
      rows = rows.filter(i => i.client_name.toLowerCase().includes(q) || i.number.toLowerCase().includes(q));
    }
    const groups = new Map();
    rows.forEach(i => {
      const y = String(i.issue_date).slice(0, 4);
      if (!groups.has(y)) groups.set(y, []);
      groups.get(y).push(i);
    });
    const years = [...groups.keys()].sort((a, b) => b.localeCompare(a));
    $('#invRows').innerHTML = years.length ? years.map(y => {
      const list = groups.get(y);
      const open = searching || invOpenYears.has(y);
      const total = list.reduce((s, i) => s + Number(i.total), 0);
      const due = list.filter(i => !['void', 'draft'].includes(i.status)).reduce((s, i) => s + Number(i.balance_due), 0);
      return `<button type="button" class="year-head ${open ? 'open' : ''}" data-year="${y}">
          <span class="yr">${y}</span>
          <span class="ymeta">${list.length} invoice${list.length === 1 ? '' : 's'} &middot; ${money(total)}${due > 0 ? `<br/><b>${money(due)} due</b>` : ''}</span>
          <i class="fa-solid fa-chevron-right chev"></i>
        </button>
        ${open ? `<div class="year-body">${list.map(invoiceRow).join('')}</div>` : ''}`;
    }).join('') : '<div class="empty">No invoices match</div>';
    $$('#invTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.f === invFilter));
  }

  view.innerHTML = `
    <div class="searchbar field"><input id="invSearchInput" placeholder="Search client or invoice #" value="${esc(invSearch)}" /></div>
    <div class="tabs" id="invTabs">${tabs.map(([f, l]) => `<div class="tab" data-f="${f}">${l}</div>`).join('')}</div>
    <div class="card" style="padding-bottom:2px" id="invRows"></div>
  `;
  render();
  $('#invSearchInput').addEventListener('input', (e) => { invSearch = e.target.value; render(); });
  $('#invRows').addEventListener('click', (e) => {
    const h = e.target.closest('.year-head'); if (!h) return;
    const y = h.dataset.year;
    if (invOpenYears.has(y)) invOpenYears.delete(y); else invOpenYears.add(y);
    render();
  });
  $('#invTabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    invFilter = t.dataset.f; render();
  });
}

// ---------------------------------------------------------------------
// Invoice — detail (read view)
// ---------------------------------------------------------------------
async function viewInvoiceDetail(id) {
  const view = $('#view');
  const [{ data: invRows, error: e1 }, { data: lines, error: e2 }, { data: pays, error: e3 }] = await Promise.all([
    sb.from('invoice_summary').select('*').eq('id', id),
    sb.from('invoice_lines').select('*').eq('invoice_id', id).order('position'),
    sb.from('payments').select('*').eq('invoice_id', id).order('paid_on'),
  ]);
  if (e1) throw e1; if (e2) throw e2; if (e3) throw e3;
  const inv = invRows && invRows[0];
  if (!inv) { view.innerHTML = '<div class="empty">Invoice not found</div>'; return; }

  const p = state.profile || {};
  view.innerHTML = `
    <div class="row" style="margin-bottom:14px;gap:12px">
      <a class="btn sm" style="padding:8px 11px" href="#/invoices">&larr;</a>
      <div class="spacer">
        <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Invoice details</div>
      </div>
      ${!inv.is_locked && !inv.is_void ? `<a class="btn sm" href="#/invoices/${inv.id}/edit">Edit</a>` : ''}
      <button class="btn sm" id="printBtn">PDF</button>
      <button class="btn sm danger" id="deleteInvBtn" title="Delete invoice"><i class="fa-solid fa-trash"></i></button>
    </div>

    <div class="card">
      <div class="row between" style="align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-weight:700;font-size:16px">${esc(inv.client_name)}</div>
          <div class="small muted">${esc(inv.number)} &middot; ${fmtDate(inv.issue_date)}</div>
        </div>
        <div>${statusBadge(inv.status)}${inv.is_locked ? ' <span class="badge lock">Imported</span>' : ''}</div>
      </div>
      <div class="inv-hero"><div class="amt">${money(inv.total)}</div></div>
      <div class="balance-box ${Number(inv.balance_due) <= 0 ? 'clear' : ''}">
        <span>${Number(inv.balance_due) <= 0 ? 'Fully paid' : 'Balance due'}</span>
        <span>${money(inv.balance_due)}</span>
      </div>
    </div>

    ${lines.length ? `<div class="card">
      <h2>Items (${lines.length})</h2>
      ${lines.map(l => `<div class="row small" style="padding:6px 0;border-bottom:1px solid var(--line);gap:10px">
        <div class="item-thumb" ${l.photo_path ? `data-thumb-path="${esc(l.photo_path)}"` : ''}>${l.photo_path ? '' : '<i class="fa-solid fa-image"></i>'}</div>
        <span class="spacer">${esc(l.description)} ${Number(l.quantity) !== 1 ? `&times; ${l.quantity}` : ''}</span><span style="font-weight:600">${money(l.amount)}</span>
      </div>`).join('')}
    </div>` : (inv.is_locked ? `<div class="card small muted">Imported from Invoice Simple as a summary — the original itemised list wasn't part of the export.</div>` : '')}

    <div class="card">
      <div class="row between small" style="padding:3px 0"><span class="muted">Subtotal</span><span>${money(inv.subtotal)}</span></div>
      ${Number(inv.discount) > 0 ? `<div class="row between small" style="padding:3px 0"><span class="muted">Discount</span><span>-${money(inv.discount)}</span></div>` : ''}
      ${inv.vat_applied ? `<div class="row between small" style="padding:3px 0"><span class="muted">VAT (${inv.vat_rate}%)</span><span>${money(inv.vat_amount)}</span></div>` : ''}
      <div class="row between small" style="padding:3px 0;border-top:1px solid var(--line);margin-top:4px;padding-top:8px"><span class="muted">Paid</span><span>${money(inv.paid)}</span></div>
      ${inv.due_date ? `<div class="row between small" style="padding:3px 0"><span class="muted">Due</span><span>${fmtDate(inv.due_date)}</span></div>` : ''}
    </div>

    ${inv.notes ? `<div class="card small"><div class="muted" style="margin-bottom:4px;font-weight:700">Notes</div>${esc(inv.notes)}</div>` : ''}

    <div class="card">
      <div class="row between"><h2 style="margin:0">Payments</h2>${!inv.is_void ? '<button class="btn ghost sm" id="addPayBtn">+ Record</button>' : ''}</div>
      ${pays.length ? pays.map(pmt => `<div class="row between small" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <span>${fmtDate(pmt.paid_on)} &middot; ${methodLabel(pmt.method)}${pmt.reference ? ' &middot; ' + esc(pmt.reference) : ''}</span><span style="font-weight:600">${money(pmt.amount)}</span>
      </div>`).join('') : '<div class="empty small">No payments recorded</div>'}
    </div>

    <div class="row" style="gap:10px;margin-top:4px">
      ${Number(inv.balance_due) > 0 && !inv.is_void ? `<button class="btn primary" style="flex:1" id="recordPayBtn">Record Payment</button>` : ''}
      <button class="btn ${Number(inv.balance_due) > 0 && !inv.is_void ? '' : 'primary'}" style="flex:1" id="shareBtn">Send Reminder</button>
    </div>
  `;

  $('#printBtn').addEventListener('click', () => printInvoice(inv, lines));
  $('#shareBtn').addEventListener('click', () => shareInvoice(inv, lines, pays));
  // Build the reminder PDF in the background so sharing is instant when tapped.
  setTimeout(() => { prepareReminder(inv, lines, pays).catch(() => {}); }, 300);
  [$('#addPayBtn'), $('#recordPayBtn')].forEach((btn) => {
    if (btn) btn.addEventListener('click', () => openPaymentModal(inv, () => viewInvoiceDetail(id)));
  });
  const deleteInvBtn = $('#deleteInvBtn');
  if (deleteInvBtn) deleteInvBtn.addEventListener('click', () => {
    confirmDelete(
      'Delete invoice?',
      `${inv.number} — ${inv.client_name} — ${money(inv.total)}` +
        (Number(inv.balance_due) > 0 ? ` (${money(inv.balance_due)} still due)` : '') +
        `\n\nThis invoice and its ${pays.length} payment(s) will be permanently deleted` +
        (inv.is_imported ? ' (it was imported from Invoice Simple)' : '') + '. This cannot be undone.',
      'Delete invoice',
      async () => {
        const photoPaths = lines.map(l => l.photo_path).filter(Boolean);
        const { error } = await sb.from('invoices').delete().eq('id', inv.id);
        if (error) throw error;
        if (photoPaths.length) sb.storage.from('item-photos').remove(photoPaths).catch(() => {});
        closeModal(); toast('Invoice deleted'); navigate('#/invoices');
      }
    );
  });
  const linePhotoPaths = lines.map(l => l.photo_path).filter(Boolean);
  if (linePhotoPaths.length) {
    signedItemPhotoUrls(linePhotoPaths).then((map) => {
      $$('[data-thumb-path]').forEach((el) => {
        const url = map[el.dataset.thumbPath];
        if (url) el.innerHTML = `<img src="${url}" alt="" />`;
      });
    });
  }
}

function methodLabel(m) {
  return { cash: 'Cash', bank: 'Bank', card: 'Card', mobile_money: 'Mobile money', cheque: 'Cheque', other: 'Other' }[m] || m;
}

// ---------------------------------------------------------------------
// Record a payment (modal)
// ---------------------------------------------------------------------
function openPaymentModal(inv, onDone) {
  const balance = Number(inv.balance_due || (inv.total - (inv.paid || 0)));
  openModal(`
    <h3>Record payment — ${esc(inv.number)}</h3>
    <form id="payForm" class="stack">
      <div class="field"><label>Amount</label><input name="amount" type="number" min="1" step="1" value="${balance > 0 ? balance : ''}" required /></div>
      <div class="field"><label>Date</label><input name="paid_on" type="date" value="${todayISO()}" required /></div>
      <div class="field"><label>Method</label>
        <select name="method">
          <option value="cash">Cash</option><option value="bank">Bank</option><option value="mobile_money">Mobile money</option>
          <option value="card">Card</option><option value="cheque">Cheque</option><option value="other">Other</option>
        </select>
      </div>
      <div class="field"><label>Reference (optional)</label><input name="reference" /></div>
      <button class="btn primary block" type="submit">Save payment</button>
    </form>
  `);
  $('#payForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { error } = await sb.from('payments').insert({
        invoice_id: inv.id, amount: Number(f.get('amount')), paid_on: f.get('paid_on'),
        method: f.get('method'), reference: f.get('reference') || null,
      });
      if (error) throw error;
      closeModal(); toast('Payment recorded'); onDone && onDone();
    } catch (err) { toast(friendlyError(err), true); }
  });
}

// ---------------------------------------------------------------------
// Print / PDF and Share
// ---------------------------------------------------------------------
async function printInvoice(inv, lines) {
  const p = state.profile || {};

  // Resolve any per-line photos (private bucket → signed URLs) before we
  // build the markup, so the printed/PDF output actually shows them.
  const linePaths = lines.map(l => l.photo_path).filter(Boolean);
  const photoMap = linePaths.length ? await signedItemPhotoUrls(linePaths) : {};

  const rowsHtml = lines.length
    ? lines.map(l => `<tr>
        <td><div class="inv-line-desc">
          ${l.photo_path && photoMap[l.photo_path] ? `<img class="inv-line-thumb" src="${photoMap[l.photo_path]}" alt="" />` : ''}
          <span>${esc(l.description)}</span>
        </div></td>
        <td class="num">${l.quantity}</td><td class="num">${money(l.unit_price)}</td><td class="num">${money(l.amount)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="muted">Summary invoice — itemised list not available</td></tr>`;

  const balanceClear = Number(inv.balance_due) <= 0;

  $('#printSheet').innerHTML = `
    <div class="inv-sheet">
      <div class="inv-head">
        <div class="inv-brand">
          ${p.logo_data ? `<img src="${p.logo_data}" alt="" />` : ''}
          <div>
            <div class="bname">${esc(p.name || '')}</div>
            ${p.tagline ? `<div class="btag">${esc(p.tagline)}</div>` : ''}
          </div>
        </div>
        <div class="inv-meta">
          <div class="doctitle">Invoice</div>
          <div class="num">${esc(inv.number)}</div>
          <div class="dates">Issued ${fmtDate(inv.issue_date)}${inv.due_date ? `<br/>Due ${fmtDate(inv.due_date)}` : ''}</div>
        </div>
      </div>

      <div class="inv-parties">
        <div>
          <div class="lbl">From</div>
          <div class="nm">${esc(p.name || '')}</div>
          <div class="dt">${esc(p.address || '')}${p.phone ? `<br/>${esc(p.phone)}` : ''}${p.email ? `<br/>${esc(p.email)}` : ''}</div>
        </div>
        <div>
          <div class="lbl">Bill to</div>
          <div class="nm">${esc(inv.client_name)}</div>
          <div class="dt">${esc(inv.client_phone || '')}${inv.client_email ? `<br/>${esc(inv.client_email)}` : ''}</div>
        </div>
      </div>

      <table class="inv-table">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <div class="inv-totals-wrap">
        <div class="inv-totals">
          <div class="row"><span>Subtotal</span><span>${money(inv.subtotal)}</span></div>
          ${Number(inv.discount) > 0 ? `<div class="row"><span>Discount</span><span>-${money(inv.discount)}</span></div>` : ''}
          ${inv.vat_applied ? `<div class="row"><span>VAT (${inv.vat_rate}%)</span><span>${money(inv.vat_amount)}</span></div>` : ''}
          <div class="row total"><span>Total</span><span>${money(inv.total)}</span></div>
          <div class="row"><span>Paid</span><span>${money(inv.paid)}</span></div>
          <div class="row balance ${balanceClear ? 'clear' : ''}"><span>${balanceClear ? 'Fully paid' : 'Balance due'}</span><span>${money(inv.balance_due)}</span></div>
        </div>
      </div>

      ${inv.notes ? `<div class="inv-note"><b>Notes</b><p>${esc(inv.notes)}</p></div>` : ''}
      ${p.payment_instructions ? `<div class="inv-note cols"><b>Payment instructions</b><p>${esc(p.payment_instructions)}</p></div>` : ''}
      <div class="inv-sign">
        <div class="sig-box">
          <img src="${SIGNATURE_PNG}" alt="Signature" />
          <div class="sig-line"></div>
          <div class="sig-cap">Authorised signature</div>
        </div>
      </div>
      ${p.invoice_footer ? `<div class="inv-footer-note"><p>${esc(p.invoice_footer)}</p></div>` : `<div class="inv-thanks">Thank you for your business.</div>`}
    </div>
  `;

  // Make sure every image (logo + line thumbnails) has actually finished
  // loading before the print dialog opens, or it prints blank.
  const imgs = $$('#printSheet img');
  await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise((res) => {
    img.onload = res; img.onerror = res;
  })));
  setTimeout(() => window.print(), 50);
}

// ---------------------------------------------------------------------
// Debt Reminder — a real PDF file (not text) listing every installment
// the client has paid on this invoice, shared via the phone's share sheet.
// ---------------------------------------------------------------------
function loadImageSize(dataUrl) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve(null);
    im.src = dataUrl;
  });
}

// jsPDF's built-in fonts only cover basic Latin, so strip anything else.
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');
}

async function buildDebtReminderPdf(inv, lines, pays) {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDF) throw new Error('PDF library did not load. Check your internet connection and reload.');
  const p = state.profile || {};
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210, H = 297, M = 15, R = W - M;
  const RED = [200, 30, 45], INK = [30, 30, 36], MUTED = [110, 110, 120], LINE = [225, 225, 230];
  let y = M;

  const setC = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const t = (s, x, yy, opts) => doc.text(pdfSafe(s), x, yy, opts);
  const ensure = (need) => { if (y + need > H - 18) { doc.addPage(); y = M; } };
  const hr = (yy, c) => { doc.setDrawColor((c || LINE)[0], (c || LINE)[1], (c || LINE)[2]); doc.setLineWidth(0.2); doc.line(M, yy, R, yy); };

  // ---- Header: logo + brand (left), title (right)
  let textX = M;
  if (p.logo_data && /^data:image\/(png|jpe?g)/i.test(p.logo_data)) {
    const sz = await loadImageSize(p.logo_data);
    if (sz) {
      const h = 16, w = Math.min(40, h * sz.w / sz.h);
      try {
        doc.addImage(p.logo_data, /png/i.test(p.logo_data.slice(0, 20)) ? 'PNG' : 'JPEG', M, y, w, h);
        textX = M + w + 4;
      } catch (e) { /* skip logo if it can't be embedded */ }
    }
  }
  setC(INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  t(p.name || '', textX, y + 7);
  if (p.tagline) { doc.setFont('helvetica', 'italic'); doc.setFontSize(9); setC(MUTED); t(p.tagline, textX, y + 12); }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); setC(RED);
  t('DEBT REMINDER', R, y + 7, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); setC(MUTED);
  t('Invoice ' + inv.number, R, y + 12.5, { align: 'right' });
  t('Date: ' + fmtDate(todayISO()), R, y + 17, { align: 'right' });
  y += 22;
  doc.setDrawColor(RED[0], RED[1], RED[2]); doc.setLineWidth(0.9); doc.line(M, y, R, y);
  y += 8;

  // ---- From / Bill to
  const colW = (R - M) / 2 - 3;
  const party = (x, label, name, detail) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); setC(MUTED); t(label.toUpperCase(), x, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); setC(INK); t(name || '', x, y + 5.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); setC(MUTED);
    const ls = doc.splitTextToSize(pdfSafe(detail || ''), colW);
    doc.text(ls, x, y + 10.5);
    return 10.5 + ls.length * 4;
  };
  const h1 = party(M, 'From', p.name, [p.address, p.phone, p.email].filter(Boolean).join('\n'));
  const h2 = party(M + colW + 6, 'Bill to', inv.client_name, [inv.client_phone, inv.client_email].filter(Boolean).join('\n'));
  y += Math.max(h1, h2) + 4;

  // ---- Outstanding balance banner
  const balance = Number(inv.balance_due);
  let overdueTxt = '';
  if (inv.due_date && balance > 0) {
    const days = Math.floor((new Date(todayISO() + 'T00:00:00') - new Date(inv.due_date + 'T00:00:00')) / 86400000);
    overdueTxt = days > 0 ? `Overdue by ${days} day${days === 1 ? '' : 's'}` : (days === 0 ? 'Due today' : `Due in ${-days} day${days === -1 ? '' : 's'}`);
  }
  doc.setFillColor(253, 242, 243); doc.setDrawColor(RED[0], RED[1], RED[2]); doc.setLineWidth(0.4);
  doc.roundedRect(M, y, R - M, 24, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); setC(MUTED);
  t(balance > 0 ? 'OUTSTANDING BALANCE' : 'BALANCE', M + 6, y + 8);
  doc.setFontSize(21); setC(RED); t(money(balance), M + 6, y + 18);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); setC(INK);
  t('Issued ' + fmtDate(inv.issue_date), R - 6, y + 9, { align: 'right' });
  if (inv.due_date) t('Due ' + fmtDate(inv.due_date), R - 6, y + 14, { align: 'right' });
  if (overdueTxt) { doc.setFont('helvetica', 'bold'); setC(RED); t(overdueTxt, R - 6, y + 19.5, { align: 'right' }); }
  y += 32;

  // ---- Message
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); setC(INK);
  const paidTotal = Number(inv.paid || 0);
  const msg = `Dear ${inv.client_name || 'Customer'}, this is a friendly reminder that invoice ${inv.number} for ${money(inv.total)} ` +
    (paidTotal > 0 ? `has been partly paid (${money(paidTotal)} received so far). ` : 'has not yet received any payment. ') +
    `The remaining balance of ${money(balance)} is still outstanding. Kindly arrange payment at your earliest convenience. ` +
    'If you have already paid, please share the payment details with us so we can update our records. Thank you.';
  const ml = doc.splitTextToSize(pdfSafe(msg), R - M);
  doc.text(ml, M, y); y += ml.length * 4.8 + 5;

  // ---- Generic table helper
  const th = (cols) => {
    ensure(14);
    doc.setFillColor(RED[0], RED[1], RED[2]); doc.rect(M, y, R - M, 7, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 255, 255);
    cols.forEach((c) => t(c.h, c.right ? c.x : c.x, y + 4.8, { align: c.right ? 'right' : 'left' }));
    y += 7;
  };
  const section = (title) => {
    ensure(24);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); setC(INK); t(title, M, y); y += 4;
  };

  // ---- Payment history (the key part)
  section(`Payment history (${pays.length} ${pays.length === 1 ? 'payment' : 'payments'})`);
  if (pays.length) {
    const cols = [
      { h: '#', x: M + 2 }, { h: 'Date', x: M + 12 }, { h: 'Method', x: M + 48 },
      { h: 'Reference', x: M + 85 }, { h: 'Amount', x: R - 2, right: true },
    ];
    th(cols);
    let running = 0;
    pays.forEach((pm, i) => {
      running += Number(pm.amount || 0);
      ensure(8);
      if (i % 2) { doc.setFillColor(248, 248, 250); doc.rect(M, y, R - M, 7, 'F'); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); setC(INK);
      t(String(i + 1), M + 2, y + 4.8);
      t(fmtDate(pm.paid_on), M + 12, y + 4.8);
      t(methodLabel(pm.method), M + 48, y + 4.8);
      const ref = doc.splitTextToSize(pdfSafe(pm.reference || '-'), 60)[0];
      doc.text(ref, M + 85, y + 4.8);
      doc.setFont('helvetica', 'bold'); t(money(pm.amount), R - 2, y + 4.8, { align: 'right' });
      y += 7;
    });
    hr(y); y += 1;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); setC(INK);
    t('Total paid', R - 50, y + 5, { align: 'right' }); t(money(running), R - 2, y + 5, { align: 'right' });
    y += 10;
  } else {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9.5); setC(MUTED);
    t('No payments have been received on this invoice yet.', M, y + 5); y += 11;
  }

  // ---- Account summary
  ensure(34);
  const sumRow = (label, val, bold, color) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 11 : 9.5); setC(color || INK);
    t(label, R - 62, y); t(val, R, y, { align: 'right' }); y += bold ? 7 : 5.5;
  };
  sumRow('Invoice total', money(inv.total));
  sumRow('Total paid', '-' + money(paidTotal).replace(/^-/, ''));
  hr(y - 3.5);
  y += 1;
  sumRow('Balance due', money(balance), true, balance > 0 ? RED : [20, 130, 70]);
  y += 3;

  // ---- Items on the invoice (compact)
  if (lines.length) {
    section('Invoice items');
    const cols = [
      { h: 'Description', x: M + 2 }, { h: 'Qty', x: R - 70, right: true },
      { h: 'Price', x: R - 38, right: true }, { h: 'Amount', x: R - 2, right: true },
    ];
    th(cols);
    lines.forEach((l, i) => {
      const dl = doc.splitTextToSize(pdfSafe(l.description), 95);
      const rowH = Math.max(7, dl.length * 4 + 3);
      ensure(rowH + 1);
      if (i % 2) { doc.setFillColor(248, 248, 250); doc.rect(M, y, R - M, rowH, 'F'); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); setC(INK);
      doc.text(dl, M + 2, y + 4.8);
      t(String(l.quantity), R - 70, y + 4.8, { align: 'right' });
      t(money(l.unit_price), R - 38, y + 4.8, { align: 'right' });
      t(money(l.amount), R - 2, y + 4.8, { align: 'right' });
      y += rowH;
    });
    hr(y); y += 8;
  }

  // ---- Payment instructions + footer
  if (p.payment_instructions) {
    const il = doc.splitTextToSize(pdfSafe(p.payment_instructions), R - M);
    ensure(il.length * 4.2 + 12);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); setC(INK); t('How to pay', M, y); y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); setC(MUTED);
    doc.text(il, M, y); y += il.length * 4.2 + 4;
  }
  // ---- Authorised signature (right-aligned)
  {
    const sw = 32, sh = sw / SIGNATURE_RATIO;
    ensure(sh + 8);
    try { doc.addImage(SIGNATURE_PNG, 'PNG', R - sw, y, sw, sh, 'ssSignature', 'FAST'); } catch (e) { /* skip if it can't be embedded */ }
    y += sh + 1;
    doc.setDrawColor(150, 150, 160); doc.setLineWidth(0.25); doc.line(R - 52, y, R, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); setC(MUTED);
    t('Authorised signature', R, y + 4, { align: 'right' });
    y += 8;
  }
  const foot = p.invoice_footer || 'Thank you for your business.';
  const fl = doc.splitTextToSize(pdfSafe(foot), R - M);
  // Footer sits at the bottom of the last page; only add a page if there's truly no room.
  if (y > H - 22) { doc.addPage(); y = M; }
  y = Math.max(y, H - 14 - fl.length * 4);
  hr(y); y += 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); setC(MUTED);
  doc.text(fl, W / 2, y, { align: 'center' });

  return doc.output('blob');
}

// The PDF is built in the background as soon as an invoice opens, so by the
// time "Send Reminder" is tapped it is ready and the share sheet opens
// instantly. (Android refuses to open the share sheet if too much time
// passes between the tap and the share call.)
let reminderCache = { key: null, promise: null };
function prepareReminder(inv, lines, pays) {
  const key = [inv.id, inv.total, inv.balance_due, (pays || []).length, (lines || []).length].join('|');
  if (reminderCache.key === key && reminderCache.promise) return reminderCache.promise;
  const promise = buildDebtReminderPdf(inv, lines || [], pays || []);
  reminderCache = { key, promise };
  promise.catch(() => { if (reminderCache.promise === promise) reminderCache = { key: null, promise: null }; });
  return promise;
}

async function shareInvoice(inv, lines, pays) {
  const btn = $('#shareBtn');
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Preparing PDF...'; }
  const textSummary = `${state.profile?.name || 'Invoice'} - Debt reminder\n${inv.number}\n` +
    `Client: ${inv.client_name}\nTotal: ${money(inv.total)}\nPaid: ${money(inv.paid)}\nBalance due: ${money(inv.balance_due)}\n` +
    (inv.due_date ? `Due: ${fmtDate(inv.due_date)}\n` : '');
  try {
    const blob = await prepareReminder(inv, lines, pays);
    const fname = ('Debt-Reminder-' + inv.number).replace(/[^\w.-]+/g, '-') + '.pdf';
    const file = new File([blob], fname, { type: 'application/pdf' });

    // 1) Share the PDF file itself (phones / installed apps)
    let shareErr = null;
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Debt Reminder ' + inv.number, text: textSummary });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // person closed the share sheet
        shareErr = e;                                // a real failure: fall through, don't hide it
      }
    }

    // 2) This device can't share files from the app: share the details as text instead
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Debt Reminder ' + inv.number, text: textSummary });
        toast('Sent as text — this device could not attach the PDF' + (shareErr ? ' (' + (shareErr.name || 'error') + ')' : ''), true);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }

    // 3) Desktop browsers: download the PDF
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Debt reminder PDF downloaded');
  } catch (err) {
    // Never fail silently: show what went wrong, and still offer the text version on WhatsApp.
    toast('Reminder PDF failed: ' + (err && (err.message || err.name) || 'unknown error'), true);
    try {
      if (navigator.share) await navigator.share({ title: 'Debt Reminder ' + inv.number, text: textSummary });
      else window.open('https://wa.me/?text=' + encodeURIComponent(textSummary), '_blank');
    } catch (e) { /* ignore */ }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// ---------------------------------------------------------------------
// Invoice — new / edit form
// ---------------------------------------------------------------------
async function viewInvoiceForm(id) {
  const view = $('#view');
  const isEdit = !!id;
  let inv = null, existingLines = [];

  if (isEdit) {
    const [{ data: invRows, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
      sb.from('invoices').select('*').eq('id', id),
      sb.from('invoice_lines').select('*').eq('invoice_id', id).order('position'),
    ]);
    if (e1) throw e1; if (e2) throw e2;
    inv = invRows && invRows[0];
    if (!inv) { view.innerHTML = '<div class="empty">Invoice not found</div>'; return; }
    if (inv.is_locked) { navigate('#/invoices/' + id); return; }
    existingLines = lines;
  }

  const p = state.profile || {};
  const form = {
    clientId: inv?.client_id || null,
    clientName: inv?.client_name || '',
    clientPhone: inv?.client_phone || '',
    clientEmail: inv?.client_email || '',
    issueDate: inv?.issue_date || todayISO(),
    dueDate: inv?.due_date || addDays(todayISO(), p.default_due_days || 30),
    discount: Number(inv?.discount || 0),
    vatApplied: !!inv?.vat_applied,
    notes: inv?.notes || '',
    poNumber: inv?.po_number || '',
    lines: existingLines.length
      ? existingLines.map(l => ({
          key: uid(), item_id: l.item_id, description: l.description, quantity: Number(l.quantity), unit_price: Number(l.unit_price),
          photo_path: l.photo_path || null, photoFile: null, photoPreviewUrl: null, removePhoto: false,
        }))
      : [{ key: uid(), item_id: null, description: '', quantity: 1, unit_price: 0, photo_path: null, photoFile: null, photoPreviewUrl: null, removePhoto: false }],
  };

  function totals() {
    const subtotal = form.lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unit_price || 0), 0);
    const afterDiscount = Math.max(subtotal - Number(form.discount || 0), 0);
    const vatRate = Number(p.vat_rate || 18);
    const vatAmount = form.vatApplied ? Math.round(afterDiscount * vatRate) / 100 : 0;
    const total = afterDiscount + vatAmount;
    return { subtotal, vatRate, vatAmount, total };
  }

  function lineThumbHtml(l) {
    if (l.photoPreviewUrl) return `<img src="${l.photoPreviewUrl}" alt="" />`;
    if (!l.removePhoto && l.photo_path) return `<img data-thumb-path="${esc(l.photo_path)}" alt="" />`;
    if (!l.removePhoto && !l.photo_path) {
      const matched = (l.item_id && state.items.find(i => i.id === l.item_id)) || state.items.find(i => i.name === l.description);
      if (matched?.photo_path) return `<img data-thumb-path="${esc(matched.photo_path)}" alt="" />`;
    }
    return '<i class="fa-solid fa-camera"></i>';
  }
  function lineHasPhoto(l) {
    return !!(l.photoPreviewUrl || (!l.removePhoto && l.photo_path));
  }
  function linesHtml() {
    return form.lines.map((l, idx) => `
      <div class="line-item-row" data-key="${l.key}">
        <div class="ln-top">
          <div class="ln-photo-wrap">
            <button type="button" class="ln-photo" data-ln-photo="${l.key}" title="Add photo">${lineThumbHtml(l)}</button>
            ${lineHasPhoto(l) ? `<button type="button" class="ln-photo-x" data-ln-photo-x="${l.key}" title="Remove photo">&times;</button>` : ''}
          </div>
          <input class="ln-desc" list="itemsList" placeholder="Description" value="${esc(l.description)}" />
          <button type="button" class="rm" data-rm="${l.key}" ${form.lines.length === 1 ? 'style="visibility:hidden"' : ''}>&times;</button>
        </div>
        <div class="ln-bottom">
          <input class="ln-qty" type="number" inputmode="numeric" min="1" step="1" value="${Math.round(l.quantity)}" placeholder="Qty" />
          <input class="ln-price" type="number" inputmode="numeric" min="0" step="1" value="${l.unit_price}" placeholder="Price" />
        </div>
      </div>`).join('');
  }
  function resolveLineThumbs() {
    const imgs = $$('#linesBox img[data-thumb-path]');
    const paths = imgs.map(img => img.dataset.thumbPath);
    if (!paths.length) return;
    signedItemPhotoUrls(paths).then((map) => {
      imgs.forEach((img) => { if (map[img.dataset.thumbPath]) img.src = map[img.dataset.thumbPath]; });
    });
  }
  function refreshLineThumb(key) {
    const l = form.lines.find(x => x.key === key); if (!l) return;
    const wrap = document.querySelector(`.line-item-row[data-key="${key}"] .ln-photo-wrap`); if (!wrap) return;
    wrap.innerHTML = `
      <button type="button" class="ln-photo" data-ln-photo="${l.key}" title="Add photo">${lineThumbHtml(l)}</button>
      ${lineHasPhoto(l) ? `<button type="button" class="ln-photo-x" data-ln-photo-x="${l.key}" title="Remove photo">&times;</button>` : ''}
    `;
    resolveLineThumbs();
  }

  function renderTotals() {
    const t = totals();
    $('#totalsBox').innerHTML = `
      <div class="row between small" style="padding:3px 0"><span class="muted">Subtotal</span><span>${money(t.subtotal)}</span></div>
      <div class="row between small" style="padding:3px 0"><span class="muted">Discount</span><span>-${money(form.discount)}</span></div>
      ${form.vatApplied ? `<div class="row between small" style="padding:3px 0"><span class="muted">VAT (${t.vatRate}%)</span><span>${money(t.vatAmount)}</span></div>` : ''}
      <div class="row between" style="padding:8px 0 0;border-top:1px solid var(--line);margin-top:4px"><b>Total</b><b>${money(t.total)}</b></div>
    `;
  }

  view.innerHTML = `
    <h2 style="margin-top:0">${isEdit ? 'Edit invoice' : 'New invoice'}</h2>

    <div class="card">
      <label>Customer</label>
      <button type="button" class="picker-row" id="clientPickerBtn">
        <span class="ic"><i class="fa-solid fa-user"></i></span>
        <span class="val ${form.clientName ? '' : 'placeholder'}" id="clientPickerLabel">${esc(form.clientName || 'Select or add customer')}</span>
        <span class="chev">&rsaquo;</span>
      </button>
      <div id="clientPickerSub" class="small muted" style="margin-top:6px">${form.clientPhone ? esc(form.clientPhone) : ''}</div>
    </div>

    <div class="card">
      <div class="grid2">
        <div class="field">
          <label>Invoice date</label>
          <input id="issueDate" type="date" value="${form.issueDate}" />
        </div>
        <div class="field">
          <label>Payment terms</label>
          <select id="terms">
            <option value="0">Due on receipt</option>
            <option value="15">Net 15</option>
            <option value="30" selected>Net 30</option>
            <option value="45">Net 45</option>
            <option value="60">Net 60</option>
            <option value="custom">Custom date</option>
          </select>
        </div>
      </div>
      <div class="field" id="dueDateWrap"><label>Due date</label><input id="dueDate" type="date" value="${form.dueDate}" /></div>
      <div class="field" style="margin-bottom:0"><label>PO / reference (optional)</label><input id="poNumber" value="${esc(form.poNumber)}" /></div>
    </div>

    <div class="card">
      <div class="row between"><h2 style="margin:0">Items</h2><button type="button" class="btn ghost sm" id="addLine">+ Add line</button></div>
      <datalist id="itemsList">${state.items.map(i => `<option value="${esc(i.name)}" data-price="${i.unit_price}">`).join('')}</datalist>
      <div id="linesBox">${linesHtml()}</div>
      <input type="file" id="linePhotoInput" accept="image/*" class="hidden" />
    </div>

    <div class="card">
      <div class="field"><label>Discount (amount)</label><input id="discount" type="number" min="0" step="1" value="${form.discount}" /></div>
      <div class="check-row" style="margin-bottom:10px">
        <input type="checkbox" id="vatApplied" ${form.vatApplied ? 'checked' : ''} />
        <label style="margin:0" for="vatApplied">Apply VAT (${p.vat_rate || 18}%)</label>
      </div>
      <div id="totalsBox"></div>
    </div>

    <div class="card">
      <div class="field" style="margin-bottom:0"><label>Notes (optional)</label><textarea id="notes">${esc(form.notes)}</textarea></div>
    </div>

    <button class="btn primary block" id="saveBtn">${isEdit ? 'Save changes' : 'Create Invoice'}</button>
  `;
  renderTotals();
  resolveLineThumbs();
  let activeLinePhotoKey = null;

  // --- due date follows payment terms, unless "Custom date" is chosen ---
  const termsSel = $('#terms');
  const dueWrap = $('#dueDateWrap');
  function applyTerms() {
    if (termsSel.value === 'custom') { dueWrap.style.display = ''; return; }
    dueWrap.style.display = 'none';
    $('#dueDate').value = addDays($('#issueDate').value, Number(termsSel.value));
  }
  // guess initial terms selection from existing due date
  if (isEdit) {
    const diff = Math.round((new Date(form.dueDate) - new Date(form.issueDate)) / 86400000);
    const match = [0, 15, 30, 45, 60].includes(diff) ? String(diff) : 'custom';
    termsSel.value = match;
  }
  applyTerms();
  termsSel.addEventListener('change', applyTerms);
  $('#issueDate').addEventListener('change', applyTerms);

  // --- client picker modal ---
  $('#clientPickerBtn').addEventListener('click', () => openClientPicker(form, () => {
    $('#clientPickerLabel').textContent = form.clientName || 'Select or add customer';
    $('#clientPickerLabel').classList.toggle('placeholder', !form.clientName);
    $('#clientPickerSub').textContent = form.clientPhone || '';
  }));

  // --- line items ---
  $('#addLine').addEventListener('click', () => {
    form.lines.push({ key: uid(), item_id: null, description: '', quantity: 1, unit_price: 0, photo_path: null, photoFile: null, photoPreviewUrl: null, removePhoto: false });
    $('#linesBox').innerHTML = linesHtml();
    renderTotals();
    resolveLineThumbs();
  });
  $('#linesBox').addEventListener('click', (e) => {
    const photoBtn = e.target.closest('[data-ln-photo]');
    if (photoBtn) { activeLinePhotoKey = photoBtn.dataset.lnPhoto; $('#linePhotoInput').click(); return; }
    const xBtn = e.target.closest('[data-ln-photo-x]');
    if (xBtn) {
      const l = form.lines.find(x => x.key === xBtn.dataset.lnPhotoX); if (!l) return;
      if (l.photoPreviewUrl) URL.revokeObjectURL(l.photoPreviewUrl);
      l.photoFile = null; l.photoPreviewUrl = null; l.removePhoto = true;
      refreshLineThumb(l.key);
      return;
    }
    const rm = e.target.closest('[data-rm]'); if (!rm) return;
    const removed = form.lines.find(x => x.key === rm.dataset.rm);
    if (removed?.photoPreviewUrl) URL.revokeObjectURL(removed.photoPreviewUrl);
    form.lines = form.lines.filter(l => l.key !== rm.dataset.rm);
    if (!form.lines.length) form.lines.push({ key: uid(), item_id: null, description: '', quantity: 1, unit_price: 0, photo_path: null, photoFile: null, photoPreviewUrl: null, removePhoto: false });
    $('#linesBox').innerHTML = linesHtml();
    renderTotals();
    resolveLineThumbs();
  });
  $('#linePhotoInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file || !activeLinePhotoKey) return;
    const l = form.lines.find(x => x.key === activeLinePhotoKey); if (!l) return;
    if (l.photoPreviewUrl) URL.revokeObjectURL(l.photoPreviewUrl);
    l.photoFile = file;
    l.photoPreviewUrl = URL.createObjectURL(file);
    l.removePhoto = false;
    refreshLineThumb(l.key);
  });
  $('#linesBox').addEventListener('input', (e) => {
    const row = e.target.closest('.line-item-row'); if (!row) return;
    const l = form.lines.find(x => x.key === row.dataset.key); if (!l) return;
    l.description = row.querySelector('.ln-desc').value;
    l.quantity = Math.max(1, Math.round(Number(row.querySelector('.ln-qty').value || 1)));
    l.unit_price = Number(row.querySelector('.ln-price').value || 0);
    const matchedItem = state.items.find(i => i.name === l.description);
    const prevItemId = l.item_id;
    l.item_id = matchedItem ? matchedItem.id : null;
    if (l.item_id !== prevItemId && e.target.classList.contains('ln-desc')) refreshLineThumb(l.key);
    renderTotals();
  });
  $('#linesBox').addEventListener('change', (e) => {
    if (!e.target.classList.contains('ln-desc')) return;
    const row = e.target.closest('.line-item-row');
    const l = form.lines.find(x => x.key === row.dataset.key);
    const matchedItem = state.items.find(i => i.name === e.target.value);
    if (matchedItem && Number(l.unit_price) === 0) {
      row.querySelector('.ln-price').value = matchedItem.unit_price;
      l.unit_price = matchedItem.unit_price;
      renderTotals();
    }
  });

  $('#discount').addEventListener('input', (e) => { form.discount = Number(e.target.value || 0); renderTotals(); });
  $('#vatApplied').addEventListener('change', (e) => { form.vatApplied = e.target.checked; renderTotals(); });

  // --- save ---
  $('#saveBtn').addEventListener('click', async () => {
    const clientName = (form.clientName || '').trim();
    if (!clientName) { toast('Please select or add a customer', true); return; }
    const goodLines = form.lines.filter(l => l.description.trim() && Number(l.quantity) > 0);
    if (!goodLines.length) { toast('Add at least one item', true); return; }

    $('#saveBtn').disabled = true;
    $('#saveBtn').innerHTML = '<span class="spin"></span>';
    try {
      let clientId = form.clientId;
      const phone = (form.clientPhone || '').trim();
      const email = (form.clientEmail || '').trim();
      if (!clientId) {
        const { data: newClient, error: ce } = await sb.from('clients')
          .insert({ name: clientName, phone: phone || null, phone_normalized: normalizePhone(phone), email: email || null })
          .select().single();
        if (ce) throw ce;
        clientId = newClient.id;
        state.clients.push(newClient);
      } else {
        await sb.from('clients').update({ phone: phone || null, phone_normalized: normalizePhone(phone), email: email || null }).eq('id', clientId);
      }

      const t = totals();
      const payload = {
        client_id: clientId, client_name: clientName, client_phone: phone || null, client_email: email || null,
        issue_date: $('#issueDate').value, due_date: $('#dueDate').value || null,
        subtotal: t.subtotal, discount: Number(form.discount || 0),
        vat_applied: form.vatApplied, vat_rate: t.vatRate, vat_amount: t.vatAmount, total: t.total,
        notes: $('#notes').value.trim() || null, po_number: $('#poNumber').value.trim() || null,
      };

      let invoiceId = id;
      if (isEdit) {
        const { error: ue } = await sb.from('invoices').update(payload).eq('id', id);
        if (ue) throw ue;
        await sb.from('invoice_lines').delete().eq('invoice_id', id);
      } else {
        const { data: numRow, error: ne } = await sb.rpc('take_next_invoice_number');
        if (ne) throw ne;
        const { data: created, error: ie } = await sb.from('invoices').insert({ ...payload, number: numRow }).select().single();
        if (ie) throw ie;
        invoiceId = created.id;
      }

      const lineRows = [];
      for (let i = 0; i < goodLines.length; i++) {
        const l = goodLines[i];
        let photoPath = l.photo_path || null;
        if (l.photoFile) photoPath = await uploadItemPhoto(l.photoFile);
        else if (l.removePhoto) photoPath = null;
        lineRows.push({
          invoice_id: invoiceId, position: i, item_id: l.item_id, description: l.description.trim(),
          quantity: l.quantity, unit_price: l.unit_price, amount: Number(l.quantity) * Number(l.unit_price),
          photo_path: photoPath,
        });
      }
      const { error: le } = await sb.from('invoice_lines').insert(lineRows);
      if (le) throw le;

      // Clean up any old line photos that got replaced or dropped, so
      // storage doesn't quietly fill up with orphaned files.
      const keptPaths = new Set(lineRows.map(r => r.photo_path).filter(Boolean));
      const oldPaths = existingLines.map(l => l.photo_path).filter(Boolean);
      const toDelete = oldPaths.filter(p => !keptPaths.has(p));
      if (toDelete.length) sb.storage.from('item-photos').remove(toDelete).catch(() => {});

      toast('Invoice saved');
      navigate('#/invoices/' + invoiceId);
    } catch (err) {
      toast(friendlyError(err), true);
      $('#saveBtn').disabled = false;
      $('#saveBtn').textContent = isEdit ? 'Save changes' : 'Save invoice';
    }
  });
}

// ---------------------------------------------------------------------
// Import clients from a .vcf contacts export (iPhone: Contacts app →
// select contacts → Share Contact / or Settings → export). iOS Safari
// has no way to reach the Contacts app directly from a website, so this
// one-time file import is the closest equivalent — after this, the
// invoice screen's client field autocompletes from what's imported.
// ---------------------------------------------------------------------
function parseVCard(text) {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1);
  const out = [];
  for (const raw of blocks) {
    const lines = raw.split(/\r?\n/);
    let name = '', phone = '', email = '';
    for (const line of lines) {
      if (/^FN[:;]/i.test(line)) name = line.split(':').slice(1).join(':').trim();
      else if (!phone && /^TEL/i.test(line)) phone = line.split(':').slice(1).join(':').trim();
      else if (!email && /^EMAIL/i.test(line)) email = line.split(':').slice(1).join(':').trim();
    }
    if (name) out.push({ name, phone: phone || null, email: email || null });
  }
  return out;
}

async function importContactsFile(file) {
  const text = await file.text();
  const parsed = parseVCard(text);
  if (!parsed.length) { toast('No contacts found in that file', true); return; }

  const known = new Set(state.clients.map(c => c.phone_normalized).filter(Boolean));
  const toInsert = [];
  const seen = new Set();
  for (const c of parsed) {
    const pn = normalizePhone(c.phone);
    if (pn && (known.has(pn) || seen.has(pn))) continue;
    if (pn) seen.add(pn);
    toInsert.push({ name: c.name, phone: c.phone || null, phone_normalized: pn, email: c.email || null });
  }
  if (!toInsert.length) { toast('Everyone in that file is already a saved client'); return; }

  const { error } = await sb.from('clients').insert(toInsert);
  if (error) { toast(friendlyError(error), true); return; }
  await loadReferenceData();
  toast(`Imported ${toInsert.length} contact${toInsert.length > 1 ? 's' : ''} (${parsed.length - toInsert.length} already existed)`);
  viewSettings();
}

function normalizePhone(p) {
  if (!p) return null;
  let s = p.replace(/[^\d+]/g, '');
  if (s.startsWith('0') && s.length === 10) s = '+256' + s.slice(1);
  else if (s.startsWith('256')) s = '+' + s;
  return s || null;
}

// ---------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------
function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal-sheet">${html}</div></div>`;
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

// A destructive-action confirmation, since deleting an invoice or expense
// can't be undone.
function confirmDelete(title, message, confirmLabel, onConfirm) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="small muted" style="margin:0 0 18px;white-space:pre-line">${esc(message)}</p>
    <div class="row" style="gap:8px">
      <button type="button" class="btn block" id="confirmCancel">Cancel</button>
      <button type="button" class="btn danger-solid block" id="confirmGo">${esc(confirmLabel)}</button>
    </div>
  `);
  $('#confirmCancel').addEventListener('click', closeModal);
  $('#confirmGo').addEventListener('click', async () => {
    const btn = $('#confirmGo'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { await onConfirm(); } catch (err) { toast(friendlyError(err), true); closeModal(); }
  });
}

// ---------------------------------------------------------------------
// Client picker modal (used by the invoice form's "Select or add customer")
// ---------------------------------------------------------------------
function openClientPicker(form, onPick) {
  function listHtml(q) {
    const rows = q ? state.clients.filter(c => c.name.toLowerCase().includes(q.toLowerCase())) : state.clients;
    return rows.slice(0, 30).map(c => `
      <div class="list-item" style="cursor:pointer" data-pick="${c.id}">
        <div class="avatar unpaid">${esc(initials(c.name))}</div>
        <div class="main"><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.phone || '')}</div></div>
      </div>`).join('') || '<div class="empty small">No matches</div>';
  }
  openModal(`
    <h3>Select customer</h3>
    <div class="field"><input id="pickSearch" placeholder="Search customers…" autofocus /></div>
    <button type="button" class="btn ghost sm" id="addNewCustomerBtn" style="margin-bottom:6px">+ Add new customer</button>
    <div id="pickNewForm" class="hidden stack" style="margin-bottom:10px">
      <div class="field"><label>Name</label><input id="newCName" /></div>
      <div class="grid2">
        <div class="field"><label>Phone</label><input id="newCPhone" /></div>
        <div class="field"><label>Email</label><input id="newCEmail" /></div>
      </div>
      <button type="button" class="btn primary block sm" id="useNewCustomerBtn">Use this customer</button>
    </div>
    <div id="pickList" style="max-height:44vh;overflow-y:auto">${listHtml('')}</div>
  `);
  $('#pickSearch').addEventListener('input', (e) => { $('#pickList').innerHTML = listHtml(e.target.value); });
  $('#pickList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pick]'); if (!row) return;
    const c = state.clients.find(x => x.id === row.dataset.pick);
    if (c) { form.clientId = c.id; form.clientName = c.name; form.clientPhone = c.phone || ''; form.clientEmail = c.email || ''; }
    closeModal(); onPick && onPick();
  });
  $('#addNewCustomerBtn').addEventListener('click', () => {
    $('#pickNewForm').classList.remove('hidden');
    $('#newCName').focus();
  });
  $('#useNewCustomerBtn').addEventListener('click', () => {
    const name = $('#newCName').value.trim();
    if (!name) { toast('Enter a name', true); return; }
    form.clientId = null;
    form.clientName = name;
    form.clientPhone = $('#newCPhone').value.trim();
    form.clientEmail = $('#newCEmail').value.trim();
    closeModal(); onPick && onPick();
  });
}

// ---------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------
let clientSearch = '';

async function viewClients() {
  const { data: clients, error } = await fetchAll(() => sb.from('clients').select('*').order('name').order('id'));
  if (error) throw error;
  state.clients = clients;
  const { data: dupes } = await sb.from('possible_duplicate_clients').select('*');

  function render() {
    const q = clientSearch.trim().toLowerCase();
    const rows = q ? clients.filter(c => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q)) : clients;
    $('#clientRows').innerHTML = rows.length ? rows.map(c => `
      <div class="list-item" style="cursor:pointer" data-edit="${c.id}">
        <div class="avatar unpaid">${esc(initials(c.name))}</div>
        <div class="main"><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.phone || 'No phone')}${c.email ? ' · ' + esc(c.email) : ''}</div></div>
      </div>`).join('') : '<div class="empty">No clients found</div>';
  }

  $('#view').innerHTML = `
    <div class="row between" style="margin-bottom:10px"><h2 style="margin:0">Clients</h2><button class="btn primary sm" id="addClientBtn">+ Add</button></div>
    <div class="searchbar field"><input id="clientSearchInput" placeholder="Search clients" value="${esc(clientSearch)}" /></div>
    ${dupes && dupes.length ? `<div class="card small" style="border-color:var(--warn)"><b>${dupes.length} phone number${dupes.length > 1 ? 's' : ''}</b> appear under more than one name — worth a look before you merge anything by hand.</div>` : ''}
    <div class="card" style="padding-bottom:2px" id="clientRows"></div>
  `;
  render();
  $('#clientSearchInput').addEventListener('input', (e) => { clientSearch = e.target.value; render(); });
  $('#clientRows').addEventListener('click', (e) => {
    const row = e.target.closest('[data-edit]'); if (!row) return;
    openClientModal(clients.find(c => c.id === row.dataset.edit), () => viewClients());
  });
  $('#addClientBtn').addEventListener('click', () => openClientModal(null, () => viewClients()));
}

function openClientModal(client, onDone) {
  openModal(`
    <h3>${client ? 'Edit client' : 'Add client'}</h3>
    <form id="clientForm" class="stack">
      <div class="field"><label>Name</label><input name="name" value="${esc(client?.name || '')}" required /></div>
      <div class="field"><label>Phone</label><input name="phone" value="${esc(client?.phone || '')}" /></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc(client?.email || '')}" /></div>
      <div class="field"><label>Address</label><textarea name="address">${esc(client?.address || '')}</textarea></div>
      <div class="field"><label>Notes</label><textarea name="notes">${esc(client?.notes || '')}</textarea></div>
      <button class="btn primary block" type="submit">Save</button>
    </form>
  `);
  $('#clientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      name: f.get('name').trim(), phone: f.get('phone').trim() || null,
      phone_normalized: normalizePhone(f.get('phone').trim()),
      email: f.get('email').trim() || null, address: f.get('address').trim() || null, notes: f.get('notes').trim() || null,
    };
    try {
      const { error } = client
        ? await sb.from('clients').update(payload).eq('id', client.id)
        : await sb.from('clients').insert(payload);
      if (error) throw error;
      closeModal(); toast('Client saved'); onDone && onDone();
    } catch (err) { toast(friendlyError(err), true); }
  });
}

// ---------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------
let expMonth = todayISO().slice(0, 7);

async function viewExpenseList() {
  const from = expMonth + '-01';
  const to = addDays(from, 32).slice(0, 7) + '-01';
  const { data: expenses, error } = await sb.from('expenses')
    .select('*, expense_categories(name)').gte('spent_on', from).lt('spent_on', to).order('spent_on', { ascending: false });
  if (error) throw error;
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  $('#view').innerHTML = `
    <div class="row between" style="margin-bottom:10px">
      <input type="month" id="monthPick" value="${expMonth}" style="width:auto" />
      <span class="big-number" style="font-size:20px">${money(total)}</span>
    </div>
    <div class="card" style="padding-bottom:2px" id="expRows">
      ${expenses.length ? expenses.map(e => `
        <a class="list-item" href="#/expenses/${e.id}/edit">
          <div class="main"><div class="name">${esc(e.supplier || e.expense_categories?.name || 'Expense')}</div>
          <div class="sub">${fmtDate(e.spent_on)} · ${esc(e.expense_categories?.name || '')}</div></div>
          <div class="amt">${money(e.amount)}</div>
        </a>`).join('') : '<div class="empty">No expenses this month</div>'}
    </div>
  `;
  $('#monthPick').addEventListener('change', (e) => { expMonth = e.target.value; viewExpenseList(); });
}

async function viewExpenseForm(id) {
  let exp = null;
  if (id) {
    const { data, error } = await sb.from('expenses').select('*').eq('id', id).single();
    if (error) throw error;
    exp = data;
  }
  $('#view').innerHTML = `
    <h2 style="margin-top:0">${id ? 'Edit expense' : 'New expense'}</h2>
    <div class="card">
      <form id="expForm" class="stack">
        <div class="grid2">
          <div class="field"><label>Amount</label><input name="amount" type="number" min="1" step="1" value="${exp?.amount || ''}" required /></div>
          <div class="field"><label>Date</label><input name="spent_on" type="date" value="${exp?.spent_on || todayISO()}" required /></div>
        </div>
        <div class="field"><label>Category</label>
          <select name="category_id">${state.categories.map(c => `<option value="${c.id}" ${exp?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Supplier / payee</label><input name="supplier" value="${esc(exp?.supplier || '')}" /></div>
        <div class="field"><label>Payment method</label>
          <select name="payment_method">
            <option value="cash" ${exp?.payment_method === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="bank" ${exp?.payment_method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="mobile_money" ${exp?.payment_method === 'mobile_money' ? 'selected' : ''}>Mobile money</option>
            <option value="card" ${exp?.payment_method === 'card' ? 'selected' : ''}>Card</option>
            <option value="cheque" ${exp?.payment_method === 'cheque' ? 'selected' : ''}>Cheque</option>
            <option value="other" ${exp?.payment_method === 'other' ? 'selected' : ''}>Other</option>
          </select>
        </div>
        <div class="field"><label>Notes</label><textarea name="description">${esc(exp?.description || '')}</textarea></div>
        <div class="field">
          <label>Receipt photo ${exp?.receipt_path ? '(replace)' : '(optional)'}</label>
          <input name="receipt" type="file" accept="image/*" />
          ${exp?.receipt_path ? `<div class="small muted" style="margin-top:4px">A receipt is already attached.</div>` : ''}
        </div>
        <button class="btn primary block" type="submit" id="expSaveBtn">Save expense</button>
        ${id ? '<button type="button" class="btn danger block" id="delExpBtn" style="margin-top:8px">Delete expense</button>' : ''}
      </form>
    </div>
  `;
  const delExpBtn = $('#delExpBtn');
  if (delExpBtn) delExpBtn.addEventListener('click', () => {
    confirmDelete(
      'Delete expense?',
      `This expense of ${money(exp.amount)} on ${fmtDate(exp.spent_on)} will be permanently deleted. This cannot be undone.`,
      'Delete expense',
      async () => {
        const { error } = await sb.from('expenses').delete().eq('id', exp.id);
        if (error) throw error;
        if (exp.receipt_path) sb.storage.from('receipts').remove([exp.receipt_path]).catch(() => {});
        closeModal(); toast('Expense deleted'); navigate('#/expenses');
      }
    );
  });
  $('#expForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('#expSaveBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try {
      const payload = {
        amount: Number(f.get('amount')), spent_on: f.get('spent_on'),
        category_id: f.get('category_id') || null, supplier: f.get('supplier').trim() || null,
        payment_method: f.get('payment_method'), description: f.get('description').trim() || null,
      };
      const file = f.get('receipt');
      if (file && file.size) {
        const path = `${Date.now()}-${uid()}-${file.name}`.replace(/\s+/g, '_');
        const { error: upErr } = await sb.storage.from('receipts').upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        payload.receipt_path = path;
      }
      const { error } = exp ? await sb.from('expenses').update(payload).eq('id', exp.id) : await sb.from('expenses').insert(payload);
      if (error) throw error;
      toast('Expense saved');
      navigate('#/expenses');
    } catch (err) {
      toast(friendlyError(err), true); btn.disabled = false; btn.textContent = 'Save expense';
    }
  });
}

// ---------------------------------------------------------------------
// Settings — business profile, saved items, expense categories
// ---------------------------------------------------------------------
async function viewSettings() {
  const p = state.profile || {};
  $('#view').innerHTML = `
    <h2 style="margin-top:0">Business profile</h2>
    <div class="card">
      <form id="profForm" class="stack">
        <div class="field"><label>Business name</label><input name="name" value="${esc(p.name || '')}" required /></div>
        <div class="field"><label>Tagline</label><input name="tagline" value="${esc(p.tagline || '')}" /></div>
        <div class="field"><label>Address</label><textarea name="address">${esc(p.address || '')}</textarea></div>
        <div class="grid2">
          <div class="field"><label>Phone</label><input name="phone" value="${esc(p.phone || '')}" /></div>
          <div class="field"><label>Email</label><input name="email" value="${esc(p.email || '')}" /></div>
        </div>
        <div class="grid2">
          <div class="field"><label>VAT rate (%)</label><input name="vat_rate" type="number" step="0.1" value="${p.vat_rate ?? 18}" /></div>
          <div class="field"><label>Default due (days)</label><input name="default_due_days" type="number" value="${p.default_due_days ?? 30}" /></div>
        </div>
        <div class="field"><label>Payment instructions (shown on invoices)</label><textarea name="payment_instructions">${esc(p.payment_instructions || '')}</textarea></div>
        <div class="field"><label>Invoice footer note</label><textarea name="invoice_footer">${esc(p.invoice_footer || '')}</textarea></div>
        <div class="small muted">Next invoice number: ${esc(p.invoice_prefix || '')}${String(p.next_invoice_number ?? 1).padStart(p.number_padding || 4, '0')}</div>
        <button class="btn primary block" type="submit">Save profile</button>
      </form>
    </div>

    <h2 style="margin:22px 0 10px">Clients</h2>
    <div class="card">
      <div class="row between">
        <div>
          <div style="font-weight:600">Import from Contacts</div>
          <div class="small muted">Import a .vcf export from your iPhone as clients</div>
        </div>
        <button class="btn sm" id="importContactsBtn">Import</button>
      </div>
      <input type="file" id="contactsFile" accept=".vcf,text/vcard,text/x-vcard" class="hidden" />
      <div class="small muted" style="margin-top:10px">
        On iPhone: open <b>Contacts</b>, tap <b>Lists → All Contacts → Select → Select All</b>,
        then <b>Share Contacts</b> → <b>Save to Files</b>. Upload that file here. For one person at a time,
        open their contact card and use <b>Share Contact</b> instead.
      </div>
    </div>

    <div class="row between" style="margin:18px 0 10px"><h2 style="margin:0">Saved items</h2><button class="btn ghost sm" id="addItemBtn">+ Add</button></div>
    <div class="card" style="padding-bottom:2px" id="itemRows">
      ${state.items.length ? state.items.map(i => `
        <div class="list-item" style="cursor:pointer" data-item="${i.id}">
          <div class="item-thumb" id="thumb-${i.id}">${i.photo_path ? '' : '<i class="fa-solid fa-image"></i>'}</div>
          <div class="main"><div class="name">${esc(i.name)}</div></div>
          <div class="amt">${money(i.unit_price)}</div>
        </div>`).join('') : '<div class="empty">No saved items yet</div>'}
    </div>

    <div class="row between" style="margin:18px 0 10px"><h2 style="margin:0">Expense categories</h2><button class="btn ghost sm" id="addCatBtn">+ Add</button></div>
    <div class="card" style="padding-bottom:2px" id="catRows">
      ${state.categories.map(c => `<div class="list-item" style="cursor:pointer" data-cat="${c.id}"><div class="main"><div class="name">${esc(c.name)}</div></div></div>`).join('')}
    </div>

    <div style="height:8px"></div>
    <div class="small muted" style="text-align:center;margin-top:16px">S&amp;S Shop Invoicing</div>
  `;

  $('#profForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      name: f.get('name').trim(), tagline: f.get('tagline').trim() || null, address: f.get('address').trim() || null,
      phone: f.get('phone').trim() || null, email: f.get('email').trim() || null,
      vat_rate: Number(f.get('vat_rate') || 18), default_due_days: Number(f.get('default_due_days') || 30),
      payment_instructions: f.get('payment_instructions').trim() || null, invoice_footer: f.get('invoice_footer').trim() || null,
    };
    try {
      const { error } = await sb.from('business_profile').update(payload).eq('id', p.id);
      if (error) throw error;
      await loadReferenceData();
      toast('Profile saved');
    } catch (err) { toast(friendlyError(err), true); }
  });

  $('#importContactsBtn').addEventListener('click', () => $('#contactsFile').click());
  $('#contactsFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $('#importContactsBtn').innerHTML = '<span class="spin"></span>';
    try { await importContactsFile(file); } catch (err) { toast(friendlyError(err), true); }
    e.target.value = '';
  });
  $('#addItemBtn').addEventListener('click', () => openItemModal(null));
  $('#itemRows').addEventListener('click', (e) => {
    const row = e.target.closest('[data-item]'); if (!row) return;
    openItemModal(state.items.find(i => i.id === row.dataset.item));
  });
  const itemPhotoPaths = state.items.map(i => i.photo_path).filter(Boolean);
  if (itemPhotoPaths.length) {
    signedItemPhotoUrls(itemPhotoPaths).then((map) => {
      state.items.forEach((i) => {
        if (!i.photo_path || !map[i.photo_path]) return;
        const el = document.getElementById(`thumb-${i.id}`);
        if (el) el.innerHTML = `<img src="${map[i.photo_path]}" alt="" />`;
      });
    });
  }
  $('#addCatBtn').addEventListener('click', () => openCategoryModal(null));
  $('#catRows').addEventListener('click', (e) => {
    const row = e.target.closest('[data-cat]'); if (!row) return;
    openCategoryModal(state.categories.find(c => c.id === row.dataset.cat));
  });
}

function openItemModal(item) {
  openModal(`
    <h3>${item ? 'Edit item' : 'Add item'}</h3>
    <form id="itemForm" class="stack">
      <div class="field"><label>Name</label><input name="name" value="${esc(item?.name || '')}" required /></div>
      <div class="field"><label>Description</label><input name="description" value="${esc(item?.description || '')}" /></div>
      <div class="field"><label>Default price</label><input name="unit_price" type="number" min="0" step="1" value="${item?.unit_price ?? 0}" /></div>
      <div class="field">
        <label>Photo ${item?.photo_path ? '(replace)' : '(optional)'}</label>
        <input name="photo" type="file" accept="image/*" />
        <div class="small muted" style="margin-top:4px">Photos are shrunk automatically on upload to save space.</div>
        ${item?.photo_path ? `<label class="check-row" style="margin-top:8px"><input type="checkbox" name="remove_photo" /> Remove current photo</label>` : ''}
      </div>
      <div class="row" style="gap:8px">
        <button class="btn primary block" type="submit" id="itemSaveBtn">Save</button>
        ${item ? '<button type="button" class="btn danger" id="delItem">Remove</button>' : ''}
      </div>
    </form>
  `);
  $('#itemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('#itemSaveBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    const oldPath = item?.photo_path || null;
    try {
      const payload = { name: f.get('name').trim(), description: f.get('description').trim() || null, unit_price: Number(f.get('unit_price') || 0) };
      const file = f.get('photo');
      const removePhoto = f.get('remove_photo') === 'on';
      if (file && file.size) {
        payload.photo_path = await uploadItemPhoto(file);
      } else if (removePhoto) {
        payload.photo_path = null;
      }
      const { error } = item ? await sb.from('items').update(payload).eq('id', item.id) : await sb.from('items').insert(payload);
      if (error) throw error;
      if (oldPath && 'photo_path' in payload && payload.photo_path !== oldPath) {
        sb.storage.from('item-photos').remove([oldPath]).catch(() => {});
      }
      await loadReferenceData(); closeModal(); toast('Item saved'); viewSettings();
    } catch (err) { toast(friendlyError(err), true); btn.disabled = false; btn.textContent = 'Save'; }
  });
  const del = $('#delItem');
  if (del) del.addEventListener('click', async () => {
    try {
      const { error } = await sb.from('items').update({ is_active: false }).eq('id', item.id);
      if (error) throw error;
      await loadReferenceData(); closeModal(); toast('Item removed'); viewSettings();
    } catch (err) { toast(friendlyError(err), true); }
  });
}

function openCategoryModal(cat) {
  openModal(`
    <h3>${cat ? 'Edit category' : 'Add category'}</h3>
    <form id="catForm" class="stack">
      <div class="field"><label>Name</label><input name="name" value="${esc(cat?.name || '')}" required /></div>
      <button class="btn primary block" type="submit">Save</button>
    </form>
  `);
  $('#catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { error } = cat
        ? await sb.from('expense_categories').update({ name: f.get('name').trim() }).eq('id', cat.id)
        : await sb.from('expense_categories').insert({ name: f.get('name').trim(), sort_order: 50 });
      if (error) throw error;
      await loadReferenceData(); closeModal(); toast('Category saved'); viewSettings();
    } catch (err) { toast(friendlyError(err), true); }
  });
}

// ---------------------------------------------------------------------
// More menu (mobile) — hub for Customers, Reports, Settings, Log out
// ---------------------------------------------------------------------
async function viewMore() {
  const email = state.session?.user?.email || '';
  $('#view').innerHTML = `
    <div class="card">
      <div class="more-user">
        <div class="avatar">${esc(initials(email))}</div>
        <div class="main"><div class="name">${esc(state.profile?.name || 'Account')}</div><div class="sub">${esc(email)}</div></div>
      </div>
    </div>
    <div class="card more-nav" style="padding-bottom:2px">
      <a class="list-item" href="#/clients"><span class="ic"><i class="fa-solid fa-users"></i></span><div class="main"><div class="name">Customers</div></div><span class="chev">&rsaquo;</span></a>
      <a class="list-item" href="#/reports"><span class="ic"><i class="fa-solid fa-chart-column"></i></span><div class="main"><div class="name">Reports</div></div><span class="chev">&rsaquo;</span></a>
      <a class="list-item" href="#/settings"><span class="ic"><i class="fa-solid fa-gear"></i></span><div class="main"><div class="name">Settings</div></div><span class="chev">&rsaquo;</span></a>
    </div>
    <button class="btn danger block" id="logoutBtn3"><i class="fa-solid fa-right-from-bracket"></i> Log out</button>
  `;
  $('#logoutBtn3').addEventListener('click', async () => { await logout(); navigate('#/dashboard'); });
}

// ---------------------------------------------------------------------
// Reports — six-month trend plus simple totals
// ---------------------------------------------------------------------
async function viewReports() {
  const since = addDays(todayISO(), -185).slice(0, 8) + '01';
  const [{ data: pay, error: e1 }, { data: exp, error: e2 }, { data: inv, error: e3 }] = await Promise.all([
    fetchAll(() => sb.from('payments').select('amount, paid_on').gte('paid_on', since).order('id')),
    fetchAll(() => sb.from('expenses').select('amount, spent_on, expense_categories(name)').gte('spent_on', since).order('id')),
    fetchAll(() => sb.from('invoice_summary').select('total, issue_date, status').gte('issue_date', since).order('id')),
  ]);
  if (e1) throw e1; if (e2) throw e2; if (e3) throw e3;

  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('en-GB', { month: 'short' });
    const c = pay.filter(p => p.paid_on.startsWith(key)).reduce((s, p) => s + Number(p.amount), 0);
    const s2 = exp.filter(e => e.spent_on.startsWith(key)).reduce((s, e) => s + Number(e.amount), 0);
    months.push({ label, collected: c, spent: s2 });
  }
  const maxBar = Math.max(1, ...months.map(m => Math.max(m.collected, m.spent)));
  const totalCollected = months.reduce((s, m) => s + m.collected, 0);
  const totalSpent = months.reduce((s, m) => s + m.spent, 0);

  const byCat = {};
  exp.forEach(e => { const n = e.expense_categories?.name || 'Uncategorised'; byCat[n] = (byCat[n] || 0) + Number(e.amount); });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  $('#view').innerHTML = `
    <h2 style="margin-top:0">Reports</h2>
    <div class="card">
      <div class="card-head"><div><span class="eyebrow">Performance</span><div class="card-title">Last 6 months</div></div></div>
      <div class="chart-legend"><span><span class="dot" style="background:var(--ok)"></span>Collected</span><span><span class="dot" style="background:#e6c15c"></span>Spent</span></div>
      <div class="chart-box"><canvas id="reportsChart"></canvas></div>
      <div class="row between" style="padding-top:12px;border-top:1px solid var(--line);margin-top:10px">
        <div><div class="small muted">Collected</div><b style="color:var(--ok)">${money(totalCollected)}</b></div>
        <div><div class="small muted">Spent</div><b style="color:#b45309">${money(totalSpent)}</b></div>
        <div><div class="small muted">Net</div><b style="color:${totalCollected - totalSpent >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(totalCollected - totalSpent)}</b></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><span class="eyebrow">Breakdown</span><div class="card-title">Expenses by category</div></div></div>
      ${catRows.length ? catRows.map(([name, amt]) => `<div class="row between small" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(name)}</span><span style="font-weight:600">${money(amt)}</span></div>`).join('') : '<div class="empty small">No expenses in this period</div>'}
    </div>
  `;
  renderBarChart('reportsChart', months.map(m => m.label), [
    { label: 'Collected', data: months.map(m => m.collected), backgroundColor: '#0f6e56', borderRadius: 4, maxBarThickness: 32 },
    { label: 'Spent', data: months.map(m => m.spent), backgroundColor: '#e6c15c', borderRadius: 4, maxBarThickness: 32 },
  ]);
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
(async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  await onAuthChanged();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
