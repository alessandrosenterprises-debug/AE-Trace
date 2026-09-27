import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1';

const $ = selector => document.querySelector(selector);
let supabase;
let orders = [];
let previewRows = [];
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (currency, amount) => amount == null || amount === '' ? '—' : `${currency || 'K'}${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = value => Number(value || 0);
const delivered = row => /delivered/i.test(row.status || '');
const valid = row => /^(yes|true|valid|1)$/i.test(String(row.valid || '').trim());
const api = async (url, options = {}) => {
  const { data: { session } = {} } = await supabase.auth.getSession();
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

function showToast(message) {
  $('#delivery-toast').textContent = message;
  $('#delivery-toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#delivery-toast').classList.remove('show'), 3500);
}

function parseDelimited(text) {
  const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else if (quoted || cell.length === 0) quoted = !quoted;
      else cell += char;
    } else if (char === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function parseNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).replace(/,/g, '').trim();
  const parsed = Number(normalized.replace(/^[^0-9.+-]+/, ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseValue(value) {
  const raw = String(value || '').trim().replace(/,/g, '');
  const match = raw.match(/^([^0-9.+-]*)([-+]?\d+(?:\.\d+)?)$/);
  if (!match) return { currency: raw ? null : null, amount: raw ? NaN : null };
  return { currency: match[1].trim() || 'K', amount: Number(match[2]) };
}

function rowsFromPaste(text) {
  const matrix = parseDelimited(text);
  if (matrix.length < 2) throw new Error('Paste a header row and at least one delivery row.');
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const headers = matrix[0].map(normalize);
  const aliases = {
    orderNo: ['orderno', 'ordernumber', 'order'], date: ['date', 'deliverydate'], time: ['time', 'deliverytime'],
    customerName: ['customersname', 'customername', 'customer'], source: ['source'], store: ['store', 'site', 'branch'],
    driverName: ['drivername', 'ridername', 'driver', 'rider'], status: ['status'], value: ['value', 'amount'],
    mbd: ['mbd'], valid: ['valid', 'validity'],
  };
  const positions = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(header => names.includes(header))]));
  if (positions.orderNo < 0) throw new Error('Could not find the Order No column in the pasted header row.');
  return matrix.slice(1).filter(cells => cells.some(cell => cell !== '')).map(cells => {
    const get = key => positions[key] < 0 ? '' : (cells[positions[key]] || '').trim();
    const value = parseValue(get('value'));
    const mbd = parseNumber(get('mbd'));
    if (Number.isNaN(value.amount) || Number.isNaN(mbd)) throw new Error(`Check the Value and MBD cells on order ${get('orderNo') || '(unknown)'}.`);
    return { orderNo: get('orderNo'), date: get('date') || null, time: get('time') || null, customerName: get('customerName') || null, source: get('source') || null, store: get('store') || null, driverName: get('driverName') || null, status: get('status') || null, valueCurrency: value.currency, valueAmount: value.amount, mbd, valid: get('valid') || null };
  });
}

function setActiveView(name) {
  const page = $(`#view-${name}`);
  if (!page) return;
  document.querySelectorAll('.delivery-page').forEach(item => item.classList.toggle('active', item === page));
  document.querySelectorAll('.delivery-nav button').forEach(item => item.classList.toggle('active', item.dataset.view === name));
  $('#delivery-page-label').textContent = page.dataset.title;
  $('#delivery-sidebar').classList.remove('open');
  $('#delivery-scrim').classList.remove('show');
  history.replaceState(null, '', `#${name}`);
  if (name === 'data-sheet') renderSheet();
}

function totalByCurrency(rows) {
  const totals = new Map();
  for (const row of rows) {
    const currency = row.valueCurrency || 'K';
    totals.set(currency, (totals.get(currency) || 0) + num(row.valueAmount));
  }
  return totals.size ? [...totals].map(([currency, amount]) => money(currency, amount)).join(' · ') : '—';
}

function emptyRow(span, text = 'No delivery data yet. Paste your spreadsheet in the Data Sheet.') {
  return `<tr><td class="empty-row" colspan="${span}">${esc(text)}</td></tr>`;
}

function renderDashboard() {
  const count = orders.length;
  const deliveredCount = orders.filter(delivered).length;
  const stores = new Set(orders.map(row => row.store).filter(Boolean)).size;
  $('#stat-orders').textContent = count.toLocaleString();
  $('#stat-delivered').textContent = deliveredCount.toLocaleString();
  $('#stat-stores').textContent = stores.toLocaleString();
  $('#stat-value').textContent = totalByCurrency(orders);
  const statuses = new Map();
  for (const row of orders) { const key = row.status || 'Unspecified'; statuses.set(key, (statuses.get(key) || 0) + 1); }
  const statusRows = [...statuses].sort((a, b) => b[1] - a[1]);
  $('#status-breakdown').innerHTML = statusRows.length ? statusRows.slice(0, 5).map(([status, value]) => `<div class="status-line"><span>${esc(status)}</span><div class="status-track"><div class="status-fill" style="width:${Math.max(3, value / count * 100)}%"></div></div><b>${value}</b></div>`).join('') : '<div class="empty-note">Import data to see the breakdown.</div>';
  const recent = orders.slice(0, 8);
  $('#dashboard-latest').innerHTML = recent.length ? recent.map(row => `<tr><td>${esc(row.orderNo)}</td><td>${esc(row.date || '—')}</td><td>${esc(row.customerName || '—')}</td><td>${esc(row.store || '—')}</td><td>${esc(row.driverName || '—')}</td><td>${esc(row.status || '—')}</td><td>${esc(money(row.valueCurrency, row.valueAmount))}</td></tr>`).join('') : emptyRow(7);
}

function groupRows(key) {
  const groups = new Map();
  for (const row of orders) {
    const name = row[key] || 'Unassigned';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function reportTable(rows, target) {
  $(target).innerHTML = rows.length ? rows.map(([name, items]) => {
    const deliveredCount = items.filter(delivered).length;
    const validCount = items.filter(valid).length;
    const mbdTotal = items.reduce((sum, row) => sum + num(row.mbd), 0);
    return `<tr><td>${esc(name)}</td><td>${items.length}</td><td>${deliveredCount}</td><td>${validCount}</td><td>${esc(totalByCurrency(items))}</td><td>${mbdTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td></tr>`;
  }).join('') : emptyRow(6);
}

function renderOverview() {
  $('#overview-valid').textContent = orders.filter(valid).length.toLocaleString();
  $('#overview-invalid').textContent = orders.filter(row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim())).length.toLocaleString();
  $('#overview-riders').textContent = new Set(orders.map(row => row.driverName).filter(Boolean)).size.toLocaleString();
  const mbd = orders.reduce((sum, row) => sum + num(row.mbd), 0);
  $('#overview-mbd').textContent = mbd.toLocaleString(undefined, { maximumFractionDigits: 2 });
  $('#overview-latest').innerHTML = orders.length ? orders.slice(0, 15).map(row => `<tr><td>${esc(row.date || '—')}</td><td>${esc(row.time || '—')}</td><td>${esc(row.customerName || '—')}</td><td>${esc(row.source || '—')}</td><td>${esc(row.store || '—')}</td><td>${esc(row.driverName || '—')}</td><td>${esc(row.status || '—')}</td><td>${esc(row.valid || '—')}</td></tr>`).join('') : emptyRow(8);
}

function renderSheet() {
  $('#sheet-row-count').textContent = orders.length.toLocaleString();
  $('#delivery-sheet-rows').innerHTML = orders.length ? orders.map(row => `<tr><td>${esc(row.orderNo)}</td><td>${esc(row.date || '—')}</td><td>${esc(row.time || '—')}</td><td>${esc(row.customerName || '—')}</td><td>${esc(row.source || '—')}</td><td>${esc(row.store || '—')}</td><td>${esc(row.driverName || '—')}</td><td>${esc(row.status || '—')}</td><td>${esc(money(row.valueCurrency, row.valueAmount))}</td><td>${row.mbd == null ? '—' : esc(row.mbd)}</td><td>${esc(row.valid || '—')}</td></tr>`).join('') : emptyRow(11);
}

function renderAll() {
  renderDashboard(); renderOverview(); reportTable(groupRows('store'), '#store-report-rows'); reportTable(groupRows('driverName'), '#rider-report-rows'); renderSheet();
  $('#delivery-count-label').textContent = `${orders.length.toLocaleString()} imported records`;
}

async function loadOrders() {
  try { orders = await api('/api/delivery-report/orders?limit=5000'); renderAll(); }
  catch (error) { showToast(error.message); $('#delivery-count-label').textContent = 'Could not load report data'; }
}

async function boot() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    if (!response.ok || !config.supabaseUrl || !config.supabaseAnonKey) throw new Error(config.error || 'AE-Trace is not configured.');
    supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { window.location.replace('/'); return; }
    const me = await api('/api/me');
    const name = me.firstName || 'Administrator';
    $('#delivery-user-name').textContent = name;
    $('#delivery-avatar').textContent = name.slice(0, 1).toUpperCase();
    $('#delivery-auth-loading').classList.add('hidden');
    $('#delivery-app').classList.remove('hidden');
    document.querySelectorAll('.delivery-nav button').forEach(button => button.addEventListener('click', () => setActiveView(button.dataset.view)));
    document.addEventListener('click', event => {
      if (event.target.closest('[data-open-sheet]') || event.target.closest('[data-go-view="data-sheet"]')) { setActiveView('data-sheet'); return; }
      if (event.target.closest('#delivery-menu')) { $('#delivery-sidebar').classList.toggle('open'); $('#delivery-scrim').classList.toggle('show'); return; }
      if (event.target.id === 'delivery-scrim') { $('#delivery-sidebar').classList.remove('open'); $('#delivery-scrim').classList.remove('show'); }
    });
    $('#delivery-signout').addEventListener('click', async () => { await supabase.auth.signOut(); window.location.assign('/'); });
    $('#delivery-refresh').addEventListener('click', loadOrders);
    $('#data-sheet-refresh').addEventListener('click', loadOrders);
    $('#preview-paste').addEventListener('click', () => {
      try {
        previewRows = rowsFromPaste($('#delivery-paste').value);
        if (previewRows.length > 2000) throw new Error('Import 2,000 rows or fewer at a time.');
        $('#paste-feedback').textContent = `${previewRows.length.toLocaleString()} rows ready to import.`;
        $('#paste-feedback').style.color = '#77e1bf';
        $('#import-paste').disabled = false;
      } catch (error) {
        previewRows = []; $('#import-paste').disabled = true;
        $('#paste-feedback').textContent = error.message; $('#paste-feedback').style.color = '#ffac8a';
      }
    });
    $('#import-paste').addEventListener('click', async event => {
      const button = event.currentTarget;
      if (!previewRows.length || button.disabled) return;
      button.disabled = true; button.textContent = 'Importing…';
      try {
        const result = await api('/api/delivery-report/orders/import', { method: 'POST', body: JSON.stringify({ rows: previewRows }) });
        $('#delivery-paste').value = ''; previewRows = [];
        $('#paste-feedback').textContent = `${result.imported} rows imported successfully.`; $('#paste-feedback').style.color = '#77e1bf';
        showToast(`${result.imported} delivery rows imported`); await loadOrders();
      } catch (error) { showToast(error.message); $('#paste-feedback').textContent = error.message; $('#paste-feedback').style.color = '#ffac8a'; }
      finally { button.disabled = true; button.textContent = 'Import rows'; }
    });
    $('#export-delivery-csv').addEventListener('click', () => {
      const columns = [['Order No/', 'orderNo'], ['Date', 'date'], ['Time', 'time'], ['Customers Name', 'customerName'], ['Source', 'source'], ['Store', 'store'], ['Driver Name', 'driverName'], ['Status', 'status'], ['Value', 'value'], ['MBD', 'mbd'], ['Valid', 'valid']];
      const csv = [columns.map(([name]) => name), ...orders.map(row => columns.map(([, key]) => key === 'value' ? money(row.valueCurrency, row.valueAmount) : row[key] ?? ''))].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `ae-trace-delivery-data-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    const initialView = location.hash.slice(1);
    setActiveView(['dashboard', 'overview', 'store-reports', 'riders-reports', 'data-sheet'].includes(initialView) ? initialView : 'dashboard');
    await loadOrders();
  } catch (error) {
    $('#delivery-auth-loading').classList.add('hidden');
    $('#delivery-auth-error').classList.remove('hidden');
    $('#delivery-auth-message').textContent = error.message || 'Sign in with an AE-Trace administrator account to continue.';
  }
}

boot();
