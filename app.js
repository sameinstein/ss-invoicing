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
const state = {
  session: null,
  profile: null,
  clients: [],
  items: [],
  categories: [],
};

async function loadReferenceData() {
  const [{ data: profile }, { data: clients }, { data: items }, { data: cats }] = await Promise.all([
    sb.from('business_profile').select('*').maybeSingle(),
    sb.from('clients').select('*').order('name'),
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
    sb.from('invoice_summary').select('id, number, client_name, total, paid, balance_due, status, issue_date').order('issue_date', { ascending: false }),
    sb.from('payments').select('amount, paid_on').gte('paid_on', since),
    sb.from('expenses').select('amount, spent_on').gte('spent_on', since),
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

async function viewInvoiceList() {
  const view = $('#view');
  const { data: inv, error } = await sb.from('invoice_summary').select('*').order('issue_date', { ascending: false });
  if (error) throw error;

  const tabs = [
    ['all', 'All'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['partial', 'Partial'], ['paid', 'Paid'], ['draft', 'Draft'],
  ];

  function render() {
    let rows = inv;
    if (invFilter !== 'all') rows = rows.filter(i => i.status === invFilter);
    if (invSearch.trim()) {
      const q = invSearch.trim().toLowerCase();
      rows = rows.filter(i => i.client_name.toLowerCase().includes(q) || i.number.toLowerCase().includes(q));
    }
    $('#invRows').innerHTML = rows.length ? rows.map(invoiceRow).join('') : '<div class="empty">No invoices match</div>';
    $$('#invTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.f === invFilter));
  }

  view.innerHTML = `
    <div class="searchbar field"><input id="invSearchInput" placeholder="Search client or invoice #" value="${esc(invSearch)}" /></div>
    <div class="tabs" id="invTabs">${tabs.map(([f, l]) => `<div class="tab" data-f="${f}">${l}</div>`).join('')}</div>
    <div class="card" style="padding-bottom:2px" id="invRows"></div>
  `;
  render();
  $('#invSearchInput').addEventListener('input', (e) => { invSearch = e.target.value; render(); });
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
  $('#shareBtn').addEventListener('click', () => shareInvoice(inv));
  [$('#addPayBtn'), $('#recordPayBtn')].forEach((btn) => {
    if (btn) btn.addEventListener('click', () => openPaymentModal(inv, () => viewInvoiceDetail(id)));
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
      ${p.invoice_footer ? `<div class="inv-note"><p>${esc(p.invoice_footer)}</p></div>` : `<div class="inv-thanks">Thank you for your business.</div>`}
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

async function shareInvoice(inv) {
  const text = `${state.profile?.name || 'Invoice'} — ${inv.number}\n` +
    `Client: ${inv.client_name}\nTotal: ${money(inv.total)}\nBalance due: ${money(inv.balance_due)}\n` +
    (inv.due_date ? `Due: ${fmtDate(inv.due_date)}\n` : '');
  if (navigator.share) {
    try { await navigator.share({ title: inv.number, text }); return; } catch (e) { /* user cancelled */ return; }
  }
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(wa, '_blank');
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
      <input type="file" id="linePhotoInput" accept="image/*" capture="environment" class="hidden" />
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
  const { data: clients, error } = await sb.from('clients').select('*').order('name');
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
          <input name="receipt" type="file" accept="image/*" capture="environment" />
          ${exp?.receipt_path ? `<div class="small muted" style="margin-top:4px">A receipt is already attached.</div>` : ''}
        </div>
        <button class="btn primary block" type="submit" id="expSaveBtn">Save expense</button>
      </form>
    </div>
  `;
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
        <input name="photo" type="file" accept="image/*" capture="environment" />
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
    sb.from('payments').select('amount, paid_on').gte('paid_on', since),
    sb.from('expenses').select('amount, spent_on, expense_categories(name)').gte('spent_on', since),
    sb.from('invoice_summary').select('total, issue_date, status').gte('issue_date', since),
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
