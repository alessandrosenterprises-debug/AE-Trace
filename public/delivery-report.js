import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1';

const $ = selector => document.querySelector(selector);
const listen = (selector, eventName, handler, options) => {
  const element = $(selector);
  if (!element) {
    console.error(`Delivery Report control is missing: ${selector}`);
    return false;
  }
  element.addEventListener(eventName, handler, options);
  return true;
};
let supabase;
let orders = [];
let totalOrderCount = 0;
let previewRows = [];
let previewSource = '';
let importedRowsInPreview = 0;
let riderMonthData = [];
let riderRoster = [];
let storeTargets = new Map();
let reportStoreTargets = new Map();
let monthlyStoreMetrics = new Map();
let monthlyStoreMetricsMonth = '';
let reportMonthlyStoreMetrics = new Map();
let dashboardMetricRows = [];
let dashboardMetricRange = '';
let storeReportMode = 'monthly';
let dashboardDatesManuallyChanged = false;
let pendingTargetStores = new Set();
let riderTargetMonth = '';
let riderDataMonth = '';
let riderMonthManuallySelected = false;
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (currency, amount) => amount == null || amount === '' ? '—' : `${currency || 'K'}${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = value => Number(value || 0);
const IMPORT_BATCH_SIZE = 1000;
const MAX_IMPORT_ROWS = 1000000;
const ORDER_PAGE_SIZE = 1000;
const delivered = row => /delivered/i.test(row.status || '');
const valid = row => /^(yes|true|valid|1)$/i.test(String(row.valid || '').trim());
const normalizedName = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const api = async (url, options = {}) => {
  const { data: { session } = {} } = await supabase.auth.getSession();
  const request = { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(options.headers || {}) } };
  const canRetry = ['GET', 'PUT', 'DELETE'].includes(String(options.method || 'GET').toUpperCase());
  let response;
  for (let attempt = 0; ; attempt++) {
    try { response = await fetch(url, request); break; }
    catch (error) {
      if (canRetry && attempt === 0) { await new Promise(resolve => setTimeout(resolve, 700)); continue; }
      console.error('Could not reach the AE-Trace API', { path: url, origin: window.location.origin, error });
      throw new Error(`Could not reach the AE-Trace server at ${window.location.host}. Check your connection and retry; pasted data is still in this form.`);
    }
  }
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
  const firstLine = text.split(/\r?\n/, 1)[0];
  const separatorCounts = new Map([['\t', 0], [',', 0], [';', 0]]);
  let quotedHeader = false;
  for (let index = 0; index < firstLine.length; index++) {
    const char = firstLine[index];
    if (char === '"') {
      if (quotedHeader && firstLine[index + 1] === '"') index++;
      else quotedHeader = !quotedHeader;
    } else if (!quotedHeader && separatorCounts.has(char)) separatorCounts.set(char, separatorCounts.get(char) + 1);
  }
  const delimiter = [...separatorCounts].sort((a, b) => b[1] - a[1])[0][0];
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

function rosterRowsFromPaste(text) {
  const matrix = parseDelimited(text);
  if (!matrix.length) throw new Error('Paste rider names and their home stores.');
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const headers = matrix[0].map(normalize);
  const nameAliases = ['ridername', 'rider', 'name', 'names', 'fullname', 'fullnames'];
  const storeAliases = ['homestore', 'store', 'storebelongto', 'site', 'branch'];
  const nameIndex = headers.findIndex(value => nameAliases.includes(value));
  const storeIndex = headers.findIndex(value => storeAliases.includes(value));
  const hasHeader = nameIndex >= 0 && storeIndex >= 0;
  const data = hasHeader ? matrix.slice(1) : matrix;
  const positions = hasHeader ? [nameIndex, storeIndex] : [0, 1];
  const ridersByName = new Map();
  const conflictsByName = new Map();
  let duplicates = 0;
  data.filter(row => row.some(value => value.trim())).forEach((row, index) => {
    const riderName = (row[positions[0]] || '').trim();
    const homeStore = (row[positions[1]] || '').trim();
    if (!riderName || !homeStore) throw new Error(`Roster row ${index + 1}: include both a rider name and a home store.`);
    const key = normalizedName(riderName);
    if (conflictsByName.has(key)) { conflictsByName.get(key).stores.add(homeStore); return; }
    const existing = ridersByName.get(key);
    if (existing) {
      if (normalizedName(existing.homeStore) !== normalizedName(homeStore)) {
        ridersByName.delete(key);
        conflictsByName.set(key, { riderName: existing.riderName, stores: new Set([existing.homeStore, homeStore]) });
        return;
      }
      duplicates++;
      return;
    }
    ridersByName.set(key, { riderName, homeStore });
  });
  const riders = [...ridersByName.values()];
  if (!riders.length && !conflictsByName.size) throw new Error('Paste at least one rider and home store.');
  return { riders, duplicates, conflicts: [...conflictsByName.values()].map(conflict => ({ riderName: conflict.riderName, stores: [...conflict.stores] })) };
}

function parseNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = normalizeNumericText(String(value).replace(/[^\d.,+-]/g, ''));
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeNumericText(value) {
  let normalized = value.trim();
  const comma = normalized.lastIndexOf(',');
  const dot = normalized.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot ? normalized.replace(/\./g, '').replace(',', '.') : normalized.replace(/,/g, '');
  } else if (comma >= 0) {
    const decimals = normalized.length - comma - 1;
    normalized = decimals > 0 && decimals <= 2 ? normalized.replace(',', '.') : normalized.replace(/,/g, '');
  }
  return normalized;
}

function parseValue(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*?)([-+]?\d[\d.,]*)\s*$/);
  if (!match) return { currency: raw ? null : null, amount: raw ? NaN : null };
  return { currency: match[1].trim() || 'K', amount: Number(normalizeNumericText(match[2])) };
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
  const hasHeader = headers.some(header => aliases.orderNo.includes(header));
  const positions = hasHeader
    ? Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(header => names.includes(header))]))
    : { orderNo: 0, date: 1, time: 2, customerName: 3, source: 4, store: 5, driverName: 6, status: 7, value: 8, mbd: 9, valid: 10 };
  if (!hasHeader && matrix[0].length < 11) throw new Error('Include the header row, or paste tab-separated rows with all 11 expected columns.');
  const dataRows = hasHeader ? matrix.slice(1) : matrix;
  return dataRows.filter(cells => cells.some(value => value !== '')).map((cells, rowIndex) => {
    const get = key => positions[key] < 0 ? '' : (cells[positions[key]] || '').trim();
    const value = parseValue(get('value'));
    const mbd = parseNumber(get('mbd'));
    if (Number.isNaN(value.amount) || Number.isNaN(mbd)) throw new Error(`Row ${rowIndex + 1} (order ${get('orderNo') || '(unknown)'}): could not read Value “${get('value')}” or MBD “${get('mbd')}”.`);
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
  if (name === 'store-targets') renderStoreTargets();
  if (name === 'store-reports') loadStoreReportData().catch(error => showToast(error.message));
  if (name === 'store-inputs') loadMonthlyStoreMetrics($('#store-input-month').value || monthNow()).catch(error => showToast(error.message));
  if (name === 'rider-roster') renderRiderRoster();
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
  const names = knownStoreNames();
  const picker = $('#dashboard-store-picker');
  const previouslySelected = [...picker.selectedOptions].map(option => option.value);
  picker.innerHTML = names.map(name => `<option value="${esc(name)}" ${previouslySelected.includes(name) ? 'selected' : ''}>${esc(name)}</option>`).join('');
  const mode = $('#dashboard-store-mode').value || 'all';
  $('#dashboard-store-picker-wrap').classList.toggle('hidden', mode === 'all');
  const selected = [...picker.selectedOptions].map(option => option.value);
  const from = $('#dashboard-date-from').value || '0000-01-01';
  const to = $('#dashboard-date-to').value || '9999-12-31';
  const matchesStore = store => mode === 'all' || selected.some(name => normalizedName(name) === normalizedName(store));
  const activeOrders = orders.filter(row => row.date && row.date >= from && row.date <= to && matchesStore(row.store));
  const fromMonth = from.slice(0, 7), toMonth = to.slice(0, 7);
  const activeMetrics = dashboardMetricRows.filter(row => row.month >= fromMonth && row.month <= toMonth && matchesStore(row.storeName));
  const aggregateMetrics = rows => {
    const sum = field => rows.reduce((total, row) => total + (row[field] == null ? 0 : Number(row[field])), 0);
    const average = field => {
      const present = rows.filter(row => row[field] != null);
      const weight = present.reduce((total, row) => total + Math.max(0, Number(row.onlineOrders) || 0), 0);
      return weight ? present.reduce((total, row) => total + Number(row[field]) * Math.max(0, Number(row.onlineOrders) || 0), 0) / weight : present.length ? present.reduce((total, row) => total + Number(row[field]), 0) / present.length : null;
    };
    return { onlineOrders: sum('onlineOrders'), failedOrders: sum('failedOrders'), failedRevenue: sum('failedRevenue'), live: average('liveTrackingPercent'), failedPercent: average('failedPercent') };
  };
  const count = activeOrders.length;
  const deliveredCount = activeOrders.filter(delivered).length;
  const stores = new Set(activeOrders.map(row => row.store).filter(Boolean));
  const manualTotals = aggregateMetrics(activeMetrics);
  $('#stat-orders').textContent = count.toLocaleString();
  $('#stat-delivered').textContent = count ? `${Math.round(deliveredCount / count * 100)}%` : '—';
  $('#dashboard-valid').textContent = activeOrders.filter(valid).length.toLocaleString();
  $('#dashboard-invalid').textContent = activeOrders.filter(row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim())).length.toLocaleString();
  $('#stat-stores').textContent = stores.size.toLocaleString();
  $('#stat-value').textContent = totalByCurrency(activeOrders);
  $('#dashboard-online').textContent = manualTotals.onlineOrders.toLocaleString();
  $('#dashboard-live').textContent = manualTotals.live == null ? '—' : `${manualTotals.live.toFixed(1)}%`;
  $('#dashboard-failed').textContent = manualTotals.failedOrders.toLocaleString();
  $('#dashboard-failed-revenue').textContent = `ZMK ${Number(manualTotals.failedRevenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $('#dashboard-failed-rate').textContent = manualTotals.failedPercent == null ? '—' : `${manualTotals.failedPercent.toFixed(1)}%`;
  const modeLabel = mode === 'all' ? 'All stores' : selected.length === 1 ? selected[0] : `${selected.length} selected stores`;
  $('#dashboard-scope-caption').textContent = `${modeLabel} · ${from} to ${to} · monthly figures for months in range`;
  const statuses = new Map();
  for (const row of activeOrders) { const key = row.status || 'Unspecified'; statuses.set(key, (statuses.get(key) || 0) + 1); }
  const statusRows = [...statuses].sort((a, b) => b[1] - a[1]);
  $('#status-breakdown').innerHTML = statusRows.length ? statusRows.slice(0, 5).map(([status, value]) => `<div class="status-line"><span>${esc(status)}</span><div class="status-track"><div class="status-fill" style="width:${Math.max(3, value / count * 100)}%"></div></div><b>${value.toLocaleString()}</b></div>`).join('') : '<div class="empty-note">No orders in this date/store selection.</div>';
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const row of activeOrders) { const hour = Number(String(row.time || '').slice(0, 2)); if (Number.isInteger(hour) && hour >= 0 && hour < 24) hourly[hour]++; }
  const peak = Math.max(1, ...hourly);
  $('#dashboard-hour-bars').innerHTML = hourly.map((value, hour) => `<div class="hour-column" title="${String(hour).padStart(2, '0')}:00 · ${value} orders"><i style="height:${value ? Math.max(4, value / peak * 100) : 0}%"></i><span>${String(hour).padStart(2, '0')}</span></div>`).join('');
  const storeNames = new Set([...activeOrders.map(row => row.store).filter(Boolean), ...activeMetrics.map(row => row.storeName).filter(Boolean)]);
  const storeRows = [...storeNames].sort((a, b) => a.localeCompare(b)).map(store => {
    const storeOrders = activeOrders.filter(row => normalizedName(row.store) === normalizedName(store));
    const storeMetrics = aggregateMetrics(activeMetrics.filter(row => normalizedName(row.storeName) === normalizedName(store)));
    const deliveredRows = storeOrders.filter(delivered).length;
    const reason = [...new Set(activeMetrics.filter(row => normalizedName(row.storeName) === normalizedName(store)).map(row => row.failedReason?.trim()).filter(Boolean))].join('; ');
    return `<tr><td><strong>${esc(store)}</strong></td><td>${storeOrders.length.toLocaleString()}</td><td>${storeOrders.length ? `${Math.round(deliveredRows / storeOrders.length * 100)}%` : '—'}</td><td>${storeOrders.filter(valid).length.toLocaleString()}</td><td>${storeOrders.filter(row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim())).length.toLocaleString()}</td><td>${esc(totalByCurrency(storeOrders))}</td><td>${storeMetrics.onlineOrders.toLocaleString()}</td><td>${storeMetrics.live == null ? '—' : `${storeMetrics.live.toFixed(1)}%`}</td><td>${storeMetrics.failedOrders.toLocaleString()}</td><td>${esc(`ZMK ${Number(storeMetrics.failedRevenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}</td><td>${storeMetrics.failedPercent == null ? '—' : `${storeMetrics.failedPercent.toFixed(1)}%`}</td><td>${esc(reason || '—')}</td></tr>`;
  });
  $('#dashboard-store-rows').innerHTML = storeRows.length ? storeRows.join('') : emptyRow(12, mode !== 'all' && !selected.length ? 'Choose at least one store to see this overview.' : 'No stores match this date range.');
  const latest = activeOrders.slice(0, 8);
  $('#dashboard-latest').innerHTML = latest.length ? latest.map(row => `<tr><td>${esc(row.orderNo)}</td><td>${esc(row.date || '—')}</td><td>${esc(row.customerName || '—')}</td><td>${esc(row.store || '—')}</td><td>${esc(row.driverName || '—')}</td><td>${esc(row.status || '—')}</td><td>${esc(money(row.valueCurrency, row.valueAmount))}</td></tr>`).join('') : emptyRow(7);
}

function knownStoreNames() {
  const names = new Map();
  const add = name => { if (typeof name === 'string' && name.trim()) names.set(normalizedName(name), name.trim()); };
  orders.forEach(row => add(row.store));
  riderRoster.forEach(row => add(row.homeStore));
  storeTargets.forEach(row => add(row.storeName));
  reportStoreTargets.forEach(row => add(row.storeName));
  monthlyStoreMetrics.forEach(row => add(row.storeName));
  reportMonthlyStoreMetrics.forEach(row => add(row.storeName));
  dashboardMetricRows.forEach(row => add(row.storeName));
  return [...names.values()].sort((a, b) => a.localeCompare(b));
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

function monthBounds(month) {
  const [year, number] = month.split('-').map(Number);
  return { start: `${month}-01`, end: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10), days: new Date(Date.UTC(year, number, 0)).getUTCDate() };
}

function storeReportDates() {
  const month = $('#store-report-month').value || monthNow();
  if (storeReportMode === 'monthly') return { ...monthBounds(month), month };
  const start = $('#store-report-start').value, end = $('#store-report-end').value;
  return { start, end, month, days: start && end ? Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1 : 0 };
}

const invalidOrder = row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim());

function renderStoreReport() {
  const { start, end, month, days } = storeReportDates();
  if (!start || !end || end < start) { $('#store-report-rows').innerHTML = emptyRow(18, 'Choose a valid date range.'); return; }
  const monthRange = monthBounds(month);
  const rangeOrders = orders.filter(row => row.date && row.date >= start && row.date <= end);
  const names = new Map();
  const addName = name => { if (name?.trim()) names.set(normalizedName(name), name.trim()); };
  knownStoreNames().forEach(addName);
  rangeOrders.forEach(row => addName(row.store));
  const metricMap = reportMonthlyStoreMetrics;
  const rows = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([key, store]) => {
    const items = rangeOrders.filter(row => normalizedName(row.store) === key);
    const actual = items.length;
    const deliveredCount = items.filter(delivered).length;
    const validCount = items.filter(valid).length;
    const invalidCount = items.filter(invalidOrder).length;
    const timed = items.filter(row => row.mbd != null && row.mbd !== '' && Number.isFinite(Number(row.mbd)));
    const onTimeRate = timed.length ? timed.filter(row => Number(row.mbd) >= 0).length / timed.length * 100 : null;
    const monthlyTarget = reportStoreTargets.get(key)?.target ?? null;
    const target = monthlyTarget == null ? null : storeReportMode === 'monthly' ? Number(monthlyTarget) : Math.round(Number(monthlyTarget) * days / monthRange.days);
    const manual = metricMap.get(key) || {};
    return { store, actual, deliveredCount, validCount, invalidCount, onTimeRate, target, manual, value: totalByCurrency(items), notDelivered: actual - deliveredCount };
  });
  const pct = value => value == null ? '—' : `${value.toFixed(1)}%`;
  $('#store-report-title').textContent = storeReportMode === 'monthly' ? 'Monthly store report' : 'Weekly store report';
  $('#store-report-caption').textContent = `${storeReportMode === 'monthly' ? 'Imported orders in selected month' : 'Imported orders in selected week'} · manual figures use ${month}`;
  $('#store-report-period').textContent = storeReportMode === 'monthly' ? new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase() : `${start} — ${end}`;
  $('#store-report-rows').innerHTML = rows.length ? rows.map(row => {
    const below = row.target == null ? '—' : (row.target - row.actual).toLocaleString();
    const achieved = row.target ? pct(row.actual / row.target * 100) : '—';
    return `<tr><td><strong>${esc(row.store)}</strong></td><td>${row.target == null ? '—' : row.target.toLocaleString()}</td><td>${row.actual.toLocaleString()}</td><td>${row.validCount.toLocaleString()}</td><td>${row.invalidCount.toLocaleString()}</td><td>${row.actual ? pct(row.deliveredCount / row.actual * 100) : '—'}</td><td>${pct(row.onTimeRate)}</td><td>—</td><td>—</td><td>${row.notDelivered.toLocaleString()}</td><td>${below}</td><td>${achieved}</td><td>${row.manual.onlineOrders == null ? '—' : Number(row.manual.onlineOrders).toLocaleString()}</td><td>${row.manual.liveTrackingPercent == null ? '—' : `${Number(row.manual.liveTrackingPercent).toFixed(1)}%`}</td><td>${row.manual.failedOrders == null ? '—' : Number(row.manual.failedOrders).toLocaleString()}</td><td>${row.manual.failedRevenue == null ? '—' : esc(money('ZMK ', row.manual.failedRevenue))}</td><td>${row.manual.failedPercent == null ? '—' : `${Number(row.manual.failedPercent).toFixed(1)}%`}</td><td class="store-reason">${esc(row.manual.failedReason || '—')}</td></tr>`;
  }).join('') : emptyRow(18);
}

async function loadStoreReportData() {
  const { month } = storeReportDates();
  const [targets, metrics] = await Promise.all([
    api(`/api/delivery-report/store-targets?month=${encodeURIComponent(month)}`),
    api(`/api/delivery-report/store-monthly-metrics?month=${encodeURIComponent(month)}`),
  ]);
  if (storeReportDates().month !== month) return;
  reportStoreTargets = new Map(targets.map(row => [normalizedName(row.storeName), row]));
  reportMonthlyStoreMetrics = new Map(metrics.map(row => [normalizedName(row.storeName), row]));
  renderStoreReport();
  renderDashboard();
}

function renderStoreInputs() {
  const rows = knownStoreNames();
  $('#store-input-rows').innerHTML = rows.length ? rows.map(store => {
    const metric = monthlyStoreMetrics.get(normalizedName(store)) || {};
    const field = (key, label, type = 'number', step = '1', max = '') => `<input class="store-metric-input" data-field="${key}" type="${type}" ${type === 'number' ? `min="0" step="${step}" ${max ? `max="${max}"` : ''}` : 'maxlength="1000"'} aria-label="${esc(`${label} for ${store}`)}" value="${type === 'text' ? esc(metric[key] || '') : metric[key] == null ? '' : esc(metric[key])}" placeholder="—">`;
    return `<tr data-store="${esc(store)}"><td><strong>${esc(store)}</strong></td><td>${field('onlineOrders', 'Online orders')}</td><td>${field('liveTrackingPercent', 'Live tracking %', 'number', '0.01', '100')}</td><td>${field('failedOrders', 'Failed orders')}</td><td>${field('failedRevenue', 'Failed revenue', 'number', '0.01')}</td><td>${field('failedPercent', 'Failed %', 'number', '0.01', '100')}</td><td>${field('failedReason', 'Failed reason', 'text')}</td></tr>`;
  }).join('') : emptyRow(7, 'Import order data or add riders to the Rider Roster to list stores here.');
}

async function loadMonthlyStoreMetrics(month) {
  if (monthlyStoreMetricsMonth === month) { renderStoreInputs(); return; }
  const rows = await api(`/api/delivery-report/store-monthly-metrics?month=${encodeURIComponent(month)}`);
  if ($('#store-input-month').value !== month && $('#store-report-month').value !== month) return;
  monthlyStoreMetrics = new Map(rows.map(row => [normalizedName(row.storeName), row]));
  monthlyStoreMetricsMonth = month;
  renderStoreInputs(); renderDashboard();
}

async function loadDashboardMetrics() {
  const from = $('#dashboard-date-from').value, to = $('#dashboard-date-to').value;
  if (!from || !to || to < from) { dashboardMetricRows = []; dashboardMetricRange = ''; renderDashboard(); return; }
  const fromMonth = from.slice(0, 7), toMonth = to.slice(0, 7);
  const key = `${fromMonth}:${toMonth}`;
  if (dashboardMetricRange === key) { renderDashboard(); return; }
  dashboardMetricRange = key;
  const rows = await api(`/api/delivery-report/store-monthly-metrics?from=${encodeURIComponent(fromMonth)}&to=${encodeURIComponent(toMonth)}`);
  if (`${$('#dashboard-date-from').value.slice(0, 7)}:${$('#dashboard-date-to').value.slice(0, 7)}` !== key) return;
  dashboardMetricRows = rows.map(row => ({ ...row, month: row.month }));
  renderDashboard();
}

function monthNow() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function riderMonthRows() {
  const selectedMonth = $('#rider-report-month')?.value;
  // Keep the target count tied to the selected month while a new month loads.
  if (selectedMonth && riderDataMonth !== selectedMonth) return [];
  return riderMonthData.filter(row => row.driverName?.trim());
}

function riderComment(stats, target) {
  if (!stats.listed) return 'Add this rider to the Rider Roster and assign a home store.';
  if (target == null) return 'Set a monthly target for this rider’s home store.';
  const achievement = target === 0 ? (stats.achieved > 0 ? 1 : 0) : stats.achieved / target;
  const quality = stats.onTimeRate != null && stats.onTimeRate >= 0.8 && stats.invalid <= 2;
  if (achievement >= 1 && quality) return 'Outstanding performance — target achieved with good on-time and controlled invalids.';
  if (achievement >= 1) return 'Target achieved — improve on-time (80%+) and keep invalid orders to 2 or fewer.';
  if (achievement >= 0.9 && quality) return 'Very good performance — slightly below target with strong quality.';
  if (achievement >= 0.9) return 'Near target — improve on-time performance and reduce invalid orders.';
  if (achievement >= 0.75) return 'Average performance — increase deliveries and improve order quality.';
  return 'Below expectations — increase delivery effort and control invalid orders.';
}

function renderRiderReport() {
  const month = $('#rider-report-month')?.value || monthNow();
  const assignedRiders = riderRoster.filter(entry => entry.riderName?.trim() && entry.homeStore?.trim());
  const orderGroups = new Map();
  for (const row of riderMonthRows()) {
    const key = normalizedName(row.driverName);
    if (!orderGroups.has(key)) orderGroups.set(key, { name: row.driverName.trim(), items: [] });
    orderGroups.get(key).items.push(row);
  }
  const byStore = new Map();
  for (const entry of assignedRiders) {
    if (!orderGroups.has(normalizedName(entry.riderName))) continue;
    const store = entry.homeStore.trim();
    const key = normalizedName(store);
    if (!byStore.has(key)) byStore.set(key, { store, riders: [] });
    byStore.get(key).riders.push(entry);
  }
  for (const group of byStore.values()) group.riders.sort((a, b) => a.riderName.localeCompare(b.riderName));
  const allocated = new Map();
  for (const [key, group] of byStore) {
    const storeTarget = storeTargets.get(key)?.target;
    if (storeTarget == null || !group.riders.length) continue;
    const base = Math.floor(storeTarget / group.riders.length);
    const remainder = storeTarget % group.riders.length;
    group.riders.forEach((rider, index) => allocated.set(normalizedName(rider.riderName), { target: base + (index < remainder ? 1 : 0), store: group.store }));
  }
  const riderRecords = assignedRiders.map(entry => ({ key: normalizedName(entry.riderName), name: entry.riderName, store: entry.homeStore, listed: true }));
  for (const [key, group] of orderGroups) if (!assignedRiders.some(entry => normalizedName(entry.riderName) === key)) riderRecords.push({ key, name: group.name, store: 'Not in Rider Roster', listed: false });
  const riders = riderRecords.map(entry => {
    const items = orderGroups.get(entry.key)?.items || [];
    const validCount = items.filter(valid).length;
    const invalidCount = items.filter(row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim())).length;
    const withMbd = items.filter(row => row.mbd != null && row.mbd !== '' && Number.isFinite(Number(row.mbd)));
    const onTime = withMbd.filter(row => Number(row.mbd) >= 0).length;
    const target = allocated.get(entry.key)?.target ?? null;
    const stats = { name: entry.name, store: entry.store, listed: entry.listed, items, achieved: items.length, valid: validCount, invalid: invalidCount, onTime, onTimeCount: withMbd.length, onTimeRate: withMbd.length ? onTime / withMbd.length : null, target };
    stats.balance = target == null ? null : target - stats.achieved;
    stats.comment = riderComment(stats, target);
    return stats;
  }).sort((a, b) => b.achieved - a.achieved || (b.target ? b.achieved / b.target : 0) - (a.target ? a.achieved / a.target : 0) || a.name.localeCompare(b.name));
  const ridersWithOrders = riders.filter(rider => rider.achieved > 0);
  const totalTarget = riders.reduce((sum, rider) => sum + (rider.target || 0), 0);
  const targetedRiders = riders.filter(rider => rider.target != null).length;
  const totalAchieved = riders.reduce((sum, rider) => sum + rider.achieved, 0);
  const totalOnTime = riders.reduce((sum, rider) => sum + rider.onTime, 0);
  const totalWithMbd = riders.reduce((sum, rider) => sum + rider.onTimeCount, 0);
  $('#rider-stat-count').textContent = ridersWithOrders.length.toLocaleString();
  $('#rider-stat-target').textContent = targetedRiders ? totalTarget.toLocaleString() : 'Set store targets';
  $('#rider-stat-target-note').textContent = `${targetedRiders} roster riders have an allocated target`;
  $('#rider-stat-achieved').textContent = totalAchieved.toLocaleString();
  $('#rider-stat-ontime').textContent = totalWithMbd ? `${Math.round(totalOnTime / totalWithMbd * 100)}%` : '—';
  $('#rider-report-period').textContent = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase();
  const champion = ridersWithOrders[0];
  $('#rider-champion-name').textContent = champion?.name || 'No rider orders this month';
  $('#rider-champion-detail').textContent = champion ? `${champion.store} · ${champion.target == null ? 'Store target not set' : `${champion.achieved} of ${champion.target} deliveries`} · ${champion.onTimeRate == null ? 'On-time data unavailable' : `${Math.round(champion.onTimeRate * 100)}% on-time`}` : 'Add riders to the Rider Roster to see the month’s top performer.';
  $('#rider-champion-score').textContent = champion ? champion.achieved.toLocaleString() : '—';
  $('#rider-report-rows').innerHTML = ridersWithOrders.length ? ridersWithOrders.map((rider, index) => `<tr><td><span class="rider-rank ${index < 3 ? 'top-rank' : ''}">${index + 1}</span></td><td><strong>${esc(rider.name)}</strong></td><td class="${rider.listed ? '' : 'unlisted-rider'}">${esc(rider.store || '—')}</td><td>${rider.target == null ? '—' : rider.target.toLocaleString()}</td><td><b>${rider.achieved.toLocaleString()}</b></td><td>${rider.valid.toLocaleString()}</td><td>${rider.invalid.toLocaleString()}</td><td><span class="rider-rate ${rider.onTimeRate != null && rider.onTimeRate < .8 ? 'rate-low' : ''}">${rider.onTimeRate == null ? '—' : `${Math.round(rider.onTimeRate * 100)}%`}</span></td><td>${rider.balance == null ? '—' : `<span class="balance-value ${rider.balance < 0 ? 'balance-ahead' : rider.balance > 0 ? 'balance-behind' : ''}">${rider.balance > 0 ? '+' : ''}${rider.balance.toLocaleString()}</span>`}</td><td class="rider-comment">${esc(rider.comment)}</td></tr>`).join('') : emptyRow(10, `No rider orders for ${esc($('#rider-report-period').textContent)}. Riders with zero orders are hidden from this list.`);
  renderStoreTargets();
}

function renderStoreTargets() {
  const month = $('#store-target-month')?.value || $('#rider-report-month')?.value || monthNow();
  const workedRiderKeys = new Set(riderMonthRows().map(row => normalizedName(row.driverName)));
  const stores = new Map();
  for (const rider of riderRoster.filter(entry => entry.riderName?.trim() && entry.homeStore?.trim())) {
    const key = normalizedName(rider.homeStore);
    if (!stores.has(key)) stores.set(key, { name: rider.homeStore, riders: [] });
    if (workedRiderKeys.has(normalizedName(rider.riderName))) stores.get(key).riders.push(rider);
  }
  for (const saved of storeTargets.values()) if (!stores.has(normalizedName(saved.storeName))) stores.set(normalizedName(saved.storeName), { name: saved.storeName, riders: [] });
  const rows = [...stores.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('#target-store-count').textContent = rows.filter(([, group]) => group.riders.length).length.toLocaleString();
  $('#target-rider-count').textContent = [...workedRiderKeys].filter(key => riderRoster.some(entry => normalizedName(entry.riderName) === key && entry.homeStore?.trim())).length.toLocaleString();
  const total = rows.reduce((sum, [key]) => sum + (storeTargets.get(key)?.target || 0), 0);
  const setCount = rows.filter(([key]) => storeTargets.get(key)?.target != null).length;
  $('#target-total').textContent = setCount ? total.toLocaleString() : 'Set targets';
  $('#target-store-note').textContent = `${setCount} of ${rows.length} listed stores have a target`;
  $('#target-month-label').textContent = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  $('#store-target-rows').innerHTML = rows.length ? rows.map(([key, group]) => {
    const assigned = [...group.riders].sort((a, b) => a.riderName.localeCompare(b.riderName));
    const target = storeTargets.get(key)?.target;
    const allocation = target == null ? 'Set target first' : !assigned.length ? 'No riders worked this month' : (() => {
      const base = Math.floor(target / assigned.length), remainder = target % assigned.length;
      return assigned.map((rider, index) => `${esc(rider.riderName)}: ${base + (index < remainder ? 1 : 0)}`).join(' · ');
    })();
    return `<tr><td><strong>${esc(group.name)}</strong></td><td>${assigned.length}</td><td><input class="store-target-input" type="number" min="1" max="1000000" step="1" inputmode="numeric" aria-label="${esc(`Monthly target for ${group.name}`)}" data-store="${esc(group.name)}" value="${target == null ? '' : esc(target)}" placeholder="Set target"></td><td class="allocation-text">${allocation}</td></tr>`;
  }).join('') : emptyRow(4, 'Add rider-to-store assignments in the Rider Roster to list stores here.');
}

async function loadStoreTargets() {
  const month = $('#rider-report-month').value;
  if (riderTargetMonth === month) { renderStoreTargets(); return; }
  riderTargetMonth = month;
  storeTargets = new Map((await api(`/api/delivery-report/store-targets?month=${encodeURIComponent(month)}`)).map(item => [normalizedName(item.storeName), { storeName: item.storeName, target: item.target }]));
  if ($('#rider-report-month').value !== month) return;
  renderStoreTargets(); renderRiderReport();
}

async function loadRiderReportData() {
  const month = $('#rider-report-month').value;
  if (riderDataMonth === month) { renderRiderReport(); return; }
  const rows = orders.filter(row => row.date?.slice(0, 7) === month);
  if ($('#rider-report-month').value !== month) return;
  riderMonthData = rows.map(row => ({ driverName: row.driverName, store: row.store, valid: row.valid, mbd: row.mbd, date: row.date }));
  riderDataMonth = month;
  renderRiderReport();
}

async function loadRiderMonth() {
  await Promise.all([loadStoreTargets(), loadRiderReportData()]);
}

async function selectReportMonth(month) {
  if (!month) return;
  $('#rider-report-month').value = month;
  $('#store-target-month').value = month;
  riderMonthManuallySelected = true;
  pendingTargetStores.clear();
  riderTargetMonth = '';
  riderDataMonth = '';
  await loadRiderMonth();
}

async function loadRiderRoster() {
  riderRoster = await api('/api/delivery-report/rider-roster');
  renderRiderRoster();
  renderStoreInputs();
  renderStoreTargets();
  renderRiderReport();
}

function renderRiderRoster() {
  $('#roster-count').textContent = riderRoster.length.toLocaleString();
  $('#rider-roster-rows').innerHTML = riderRoster.length ? riderRoster.map((rider, index) => `<tr data-roster-index="${index}" data-original-name="${esc(rider.riderName)}"><td><input class="roster-name-input" aria-label="Rider name" value="${esc(rider.riderName)}" maxlength="160"></td><td><input class="roster-store-input" aria-label="Home store" value="${esc(rider.homeStore)}" maxlength="160" list="roster-store-options"></td><td><button class="remove-roster-row" data-remove-roster="${index}" aria-label="Remove ${esc(rider.riderName)}">Remove</button></td></tr>`).join('') : emptyRow(3, 'No rider assignments yet. Add riders or paste a two-column roster above.');
  const stores = [...new Set(riderRoster.map(rider => rider.homeStore.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  let options = document.querySelector('#roster-store-options');
  if (!options) { options = document.createElement('datalist'); options.id = 'roster-store-options'; document.body.append(options); }
  options.innerHTML = stores.map(store => `<option value="${esc(store)}"></option>`).join('');
}

function rosterImportSummary(count, duplicates, conflicts, responseRecovered = false) {
  const parts = [`${count} rider assignments ${responseRecovered ? 'are saved' : 'imported'}`];
  if (responseRecovered) parts.push('the connection dropped before the confirmation arrived, but the saved roster was verified');
  if (duplicates) parts.push(`${duplicates} formatting duplicate ${duplicates === 1 ? 'row was' : 'rows were'} merged`);
  if (conflicts.length) parts.push(`${conflicts.length} riders were skipped because they have different home stores: ${conflicts.map(conflict => `${conflict.riderName} (${conflict.stores.join(' / ')})`).join('; ')}. Add each once with their official home store`);
  return `${parts.join('. ')}.`;
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
  $('#sheet-row-count').textContent = totalOrderCount.toLocaleString();
  $('#delivery-sheet-rows').innerHTML = orders.length ? orders.slice(0, ORDER_PAGE_SIZE).map(row => `<tr><td>${esc(row.orderNo)}</td><td>${esc(row.date || '—')}</td><td>${esc(row.time || '—')}</td><td>${esc(row.customerName || '—')}</td><td>${esc(row.source || '—')}</td><td>${esc(row.store || '—')}</td><td>${esc(row.driverName || '—')}</td><td>${esc(row.status || '—')}</td><td>${esc(money(row.valueCurrency, row.valueAmount))}</td><td>${row.mbd == null ? '—' : esc(row.mbd)}</td><td>${esc(row.valid || '—')}</td></tr>`).join('') : emptyRow(11);
}

function renderAll() {
  renderDashboard(); renderOverview(); renderStoreReport(); renderStoreInputs(); renderRiderReport(); renderSheet();
  $('#delivery-count-label').textContent = `${totalOrderCount.toLocaleString()} imported records`;
}

async function fetchAllOrders() {
  const firstPage = await api(`/api/delivery-report/orders?limit=${ORDER_PAGE_SIZE}&offset=0`);
  const total = Number(firstPage.total) || firstPage.rows.length;
  const rows = [...firstPage.rows];
  const pageCount = Math.ceil(total / ORDER_PAGE_SIZE);
  for (let firstPageIndex = 1; firstPageIndex < pageCount; firstPageIndex += 8) {
    const pageIndexes = Array.from({ length: Math.min(8, pageCount - firstPageIndex) }, (_, index) => firstPageIndex + index);
    const pages = await Promise.all(pageIndexes.map(pageIndex => api(`/api/delivery-report/orders?limit=${ORDER_PAGE_SIZE}&offset=${pageIndex * ORDER_PAGE_SIZE}`)));
    rows.push(...pages.flatMap(page => page.rows));
    $('#delivery-count-label').textContent = `Loading reports · ${rows.length.toLocaleString()} of ${total.toLocaleString()}`;
  }
  return { rows, total };
}

async function loadOrders() {
  try {
    const loaded = await fetchAllOrders();
    orders = loaded.rows;
    totalOrderCount = loaded.total;
    const selectedMonth = $('#rider-report-month')?.value;
    if (!riderMonthManuallySelected && selectedMonth && !orders.some(row => row.date?.slice(0, 7) === selectedMonth)) {
      const latestMonth = orders.find(row => row.date)?.date.slice(0, 7);
      if (latestMonth) {
        $('#rider-report-month').value = latestMonth;
        $('#store-target-month').value = latestMonth;
        riderTargetMonth = '';
      }
    }
    if (!dashboardDatesManuallyChanged) {
      const dates = orders.map(row => row.date).filter(Boolean).sort();
      if (dates.length) {
        $('#dashboard-date-from').value = dates[0];
        $('#dashboard-date-to').value = dates.at(-1);
        dashboardMetricRange = '';
      }
    }
    riderDataMonth = '';
    renderAll();
    try { await loadDashboardMetrics(); } catch (error) { showToast(error.message); }
    try { await loadRiderReportData(); } catch (error) { showToast(error.message); }
  }
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
      const goView = event.target.closest('[data-go-view]');
      if (event.target.closest('[data-open-sheet]')) { setActiveView('data-sheet'); return; }
      if (goView) { setActiveView(goView.dataset.goView); return; }
      if (event.target.closest('#delivery-menu')) { $('#delivery-sidebar').classList.toggle('open'); $('#delivery-scrim').classList.toggle('show'); return; }
      if (event.target.id === 'delivery-scrim') { $('#delivery-sidebar').classList.remove('open'); $('#delivery-scrim').classList.remove('show'); }
    });
    listen('#delivery-signout', 'click', async () => { await supabase.auth.signOut(); window.location.assign('/'); });
    listen('#delivery-refresh', 'click', loadOrders);
    listen('#data-sheet-refresh', 'click', loadOrders);
    listen('#dashboard-date-from', 'change', () => { dashboardDatesManuallyChanged = true; dashboardMetricRange = ''; renderDashboard(); loadDashboardMetrics().catch(error => showToast(error.message)); });
    listen('#dashboard-date-to', 'change', () => { dashboardDatesManuallyChanged = true; dashboardMetricRange = ''; renderDashboard(); loadDashboardMetrics().catch(error => showToast(error.message)); });
    listen('#dashboard-store-mode', 'change', event => {
      const picker = $('#dashboard-store-picker');
      if (event.currentTarget.value !== 'all' && !picker.selectedOptions.length && picker.options.length) picker.options[0].selected = true;
      if (event.currentTarget.value === 'single' && picker.selectedOptions.length > 1) [...picker.selectedOptions].slice(1).forEach(option => { option.selected = false; });
      renderDashboard();
    });
    listen('#dashboard-store-picker', 'change', event => {
      if ($('#dashboard-store-mode').value === 'single' && event.currentTarget.selectedOptions.length > 1) {
        const latest = event.currentTarget.selectedOptions.at(-1).value;
        [...event.currentTarget.options].forEach(option => { option.selected = option.value === latest; });
      }
      renderDashboard();
    });
    $('#store-report-month').value = monthNow();
    $('#store-input-month').value = monthNow();
    const today = new Date();
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    $('#store-report-start').value = monday.toISOString().slice(0, 10);
    $('#store-report-end').value = sunday.toISOString().slice(0, 10);
    document.querySelectorAll('[data-store-report-mode]').forEach(button => button.addEventListener('click', async () => {
      storeReportMode = button.dataset.storeReportMode;
      document.querySelectorAll('[data-store-report-mode]').forEach(tab => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.weekly-report-field').forEach(field => field.classList.toggle('hidden', storeReportMode !== 'weekly'));
      if (storeReportMode === 'weekly' && $('#store-report-start').value) $('#store-report-month').value = $('#store-report-start').value.slice(0, 7);
      try { await loadStoreReportData(); } catch (error) { showToast(error.message); }
    }));
    listen('#store-report-month', 'change', async () => { try { await loadStoreReportData(); } catch (error) { showToast(error.message); } });
    listen('#store-report-start', 'change', async event => {
      if (event.currentTarget.value) $('#store-report-month').value = event.currentTarget.value.slice(0, 7);
      try { await loadStoreReportData(); } catch (error) { showToast(error.message); }
    });
    listen('#store-report-end', 'change', async () => { try { await loadStoreReportData(); } catch (error) { showToast(error.message); } });
    listen('#store-input-month', 'change', async event => { try { await loadMonthlyStoreMetrics(event.currentTarget.value); } catch (error) { showToast(error.message); } });
    listen('#save-store-inputs', 'click', async event => {
      const button = event.currentTarget;
      const metrics = [...document.querySelectorAll('#store-input-rows tr[data-store]')].map(row => {
        const field = name => row.querySelector(`[data-field="${name}"]`).value.trim();
        const number = name => field(name) === '' ? null : Number(field(name));
        return { storeName: row.dataset.store, onlineOrders: number('onlineOrders'), liveTrackingPercent: number('liveTrackingPercent'), failedOrders: number('failedOrders'), failedRevenue: number('failedRevenue'), failedPercent: number('failedPercent'), failedReason: field('failedReason') };
      });
      button.disabled = true; button.textContent = 'Saving…';
      try {
        const month = $('#store-input-month').value;
        const result = await api('/api/delivery-report/store-monthly-metrics', { method: 'PUT', body: JSON.stringify({ month, metrics }) });
        monthlyStoreMetricsMonth = '';
        dashboardMetricRange = '';
        await loadMonthlyStoreMetrics(month);
        await loadDashboardMetrics();
        showToast(`${result.saved} stores’ monthly figures saved.`);
      } catch (error) { showToast(error.message); }
      finally { button.disabled = false; button.textContent = 'Save monthly inputs'; }
    });
    listen('#export-store-report', 'click', () => {
      const columns = ['STORE','TARGET','ACTUAL','VALID','INVALID','% DELIVERED','% ON-TIME','% AUTO ASSIGN','AVG PREP TIME','NOT DELIVERED','BELOW TARGET','% TARGET ACHIEVED','ONLINE ORDERS','LIVE TRACKING','FAILED ORDERS','FAILED REVENUE','% FAILED','FAILED REASON'];
      const rows = [...document.querySelectorAll('#store-report-rows tr')].filter(row => row.children.length === columns.length).map(row => [...row.children].map(cell => cell.innerText.trim()));
      const csv = [columns, ...rows].map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `ae-trace-store-${storeReportMode}-report-${$('#store-report-month').value}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    listen('#delivery-file', 'change', async event => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      if (file.size > 100 * 1024 * 1024) {
        $('#paste-feedback').textContent = 'Choose a CSV/TSV file smaller than 100 MB.';
        $('#paste-feedback').style.color = '#ffac8a';
        event.currentTarget.value = '';
        return;
      }
      try {
        $('#paste-feedback').textContent = `Reading ${file.name}…`;
        const content = await file.text();
        $('#delivery-paste').value = content;
        $('#delivery-paste').dispatchEvent(new Event('input', { bubbles: true }));
        $('#preview-paste').click();
      } catch (error) {
        $('#paste-feedback').textContent = `Could not read ${file.name}: ${error.message}`;
        $('#paste-feedback').style.color = '#ffac8a';
      } finally { event.currentTarget.value = ''; }
    });
    $('#rider-report-month').value = monthNow();
    $('#store-target-month').value = monthNow();
    listen('#rider-report-month', 'change', async event => {
      try { await selectReportMonth(event.currentTarget.value); } catch (error) { showToast(error.message); }
    });
    listen('#store-target-month', 'change', async event => {
      try { await selectReportMonth(event.currentTarget.value); } catch (error) { showToast(error.message); }
    });
    listen('#save-store-targets', 'click', async event => {
      const button = event.currentTarget;
      const targets = [];
      for (const input of document.querySelectorAll('.store-target-input')) {
        const value = input.value.trim();
        if (value === '') {
          if (pendingTargetStores.has(normalizedName(input.dataset.store))) { showToast(`Enter a monthly target for ${input.dataset.store} before saving.`); input.focus(); return; }
          targets.push({ storeName: input.dataset.store, target: null }); continue;
        }
        const target = Number(value);
        if (!Number.isInteger(target) || target < 1 || target > 1000000) { showToast(`Enter a whole-number target from 1 to 1,000,000 for ${input.dataset.store}.`); input.focus(); return; }
        targets.push({ storeName: input.dataset.store, target });
      }
      button.disabled = true; button.textContent = 'Saving…';
      try {
        const result = await api('/api/delivery-report/store-targets', { method: 'PUT', body: JSON.stringify({ month: $('#store-target-month').value, targets }) });
        pendingTargetStores.clear(); riderTargetMonth = ''; await loadStoreTargets();
        showToast(`${result.saved} store targets saved${result.cleared ? `, ${result.cleared} cleared` : ''}.`);
      } catch (error) { showToast(error.message); }
      finally { button.disabled = false; button.textContent = 'Save targets'; }
    });
    listen('#add-target-store', 'click', () => {
      const input = $('#new-target-store');
      const storeName = input.value.trim();
      if (!storeName) { showToast('Enter a store name first.'); input.focus(); return; }
      const key = normalizedName(storeName);
      if (storeTargets.has(key) || riderRoster.some(rider => normalizedName(rider.homeStore) === key)) { showToast(`${storeName} is already listed for this month.`); input.focus(); return; }
      storeTargets.set(key, { storeName, target: null }); pendingTargetStores.add(key);
      input.value = ''; renderStoreTargets();
      document.querySelectorAll('.store-target-input').forEach(targetInput => { if (normalizedName(targetInput.dataset.store) === key) targetInput.focus(); });
    });
    listen('#export-rider-report', 'click', () => {
      const columns = ['RANK', 'NAMES', 'STORE BELONG TO', 'TARGET', 'ACHIEVED', 'VALID', 'INVALID', 'ONTIME %', 'TARGET BALANCE', 'COMMENT'];
      const rows = [...document.querySelectorAll('#rider-report-rows tr')].filter(row => row.children.length === 10).map(row => [...row.children].map(cell => cell.innerText.trim()));
      const csv = [columns, ...rows].map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `ae-trace-rider-report-${$('#rider-report-month').value}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    listen('#add-roster-rider', 'click', () => {
      riderRoster.push({ riderName: '', homeStore: '' }); renderRiderRoster();
      $('#rider-roster-rows tr:last-child .roster-name-input')?.focus();
    });
    listen('#rider-roster-rows', 'click', async event => {
      const button = event.target.closest('[data-remove-roster]');
      if (!button) return;
      const row = button.closest('tr');
      const originalName = row.dataset.originalName;
      if (!originalName) { riderRoster.splice(Number(button.dataset.removeRoster), 1); renderRiderRoster(); return; }
      if (!window.confirm(`Remove ${originalName} from the Rider Roster? Their order history stays intact; the store target will be divided among the remaining riders.`)) return;
      button.disabled = true;
      try { await api(`/api/delivery-report/rider-roster/${encodeURIComponent(originalName)}`, { method: 'DELETE' }); await loadRiderRoster(); showToast(`${originalName} removed from the roster.`); }
      catch (error) { showToast(error.message); button.disabled = false; }
    });
    listen('#save-roster', 'click', async event => {
      const button = event.currentTarget;
      const riders = [];
      const names = new Map();
      for (const row of document.querySelectorAll('#rider-roster-rows tr[data-roster-index]')) {
        const riderName = row.querySelector('.roster-name-input').value.trim();
        const homeStore = row.querySelector('.roster-store-input').value.trim();
        if (!riderName && !homeStore) continue;
        if (!riderName || !homeStore) { showToast('Complete both the rider name and home store for every roster row.'); row.querySelector(!riderName ? '.roster-name-input' : '.roster-store-input').focus(); return; }
        const key = normalizedName(riderName);
        const existingStore = names.get(key);
        if (existingStore) {
          if (normalizedName(existingStore) !== normalizedName(homeStore)) { showToast(`Rider “${riderName}” appears more than once with different home stores. Keep one rider entry and choose their official home store.`); row.querySelector('.roster-store-input').focus(); return; }
          continue;
        }
        names.set(key, homeStore);
        const originalName = row.dataset.originalName || '';
        riders.push({ riderName, homeStore, ...(originalName && originalName !== riderName ? { previousName: originalName } : {}) });
      }
      button.disabled = true; button.textContent = 'Saving…';
      try {
        const result = await api('/api/delivery-report/rider-roster', { method: 'PUT', body: JSON.stringify({ riders }) });
        await loadRiderRoster(); showToast(`${result.saved} rider assignments saved.`);
      } catch (error) { showToast(error.message); }
      finally { button.disabled = false; button.textContent = 'Save roster'; }
    });
    listen('#import-roster', 'click', async event => {
      const button = event.currentTarget;
      let parsed;
      try { parsed = rosterRowsFromPaste($('#roster-paste').value); }
      catch (error) { $('#roster-feedback').textContent = error.message; $('#roster-feedback').className = 'roster-status error'; return; }
      const { riders, duplicates, conflicts } = parsed;
      if (!riders.length) { $('#roster-feedback').textContent = 'Every rider is listed under multiple home stores. Resolve those assignments, then import again.'; $('#roster-feedback').className = 'roster-status error'; return; }
      button.disabled = true; button.textContent = 'Importing…';
      try {
        const result = await api('/api/delivery-report/rider-roster', { method: 'PUT', body: JSON.stringify({ riders }) });
        $('#roster-paste').value = '';
        const summary = rosterImportSummary(result.saved, duplicates, conflicts);
        $('#roster-feedback').textContent = summary; $('#roster-feedback').className = conflicts.length ? 'roster-status error' : 'roster-status success';
        await loadRiderRoster(); showToast(`${result.saved} roster rows imported${duplicates ? `; ${duplicates} duplicates merged` : ''}${conflicts.length ? `; ${conflicts.length} need a home-store choice` : ''}.`);
      } catch (error) {
        let saved = false;
        try {
          const currentRoster = await api('/api/delivery-report/rider-roster');
          const savedByName = new Map(currentRoster.map(rider => [normalizedName(rider.riderName), normalizedName(rider.homeStore)]));
          saved = riders.every(rider => savedByName.get(normalizedName(rider.riderName)) === normalizedName(rider.homeStore));
        } catch (checkError) { console.error('Could not verify roster after a dropped import response', checkError); }
        if (saved) {
          $('#roster-paste').value = '';
          $('#roster-feedback').textContent = rosterImportSummary(riders.length, duplicates, conflicts, true);
          $('#roster-feedback').className = conflicts.length ? 'roster-status error' : 'roster-status success';
          try { await loadRiderRoster(); } catch (refreshError) { console.error('Could not refresh the saved rider roster', refreshError); }
          showToast('Roster saved; its confirmation was recovered after a brief connection drop.');
        } else {
          $('#roster-feedback').textContent = error.message; $('#roster-feedback').className = 'roster-status error';
        }
      }
      finally { button.disabled = false; button.textContent = 'Import roster rows'; }
    });
    listen('#delivery-paste', 'input', () => {
      previewRows = []; previewSource = ''; importedRowsInPreview = 0; $('#import-paste').disabled = true;
      $('#paste-feedback').textContent = 'Preview your updated rows before importing.'; $('#paste-feedback').style.color = '';
    });
    listen('#preview-paste', 'click', () => {
      try {
        const source = $('#delivery-paste').value;
        previewRows = rowsFromPaste(source);
        if (previewRows.length > MAX_IMPORT_ROWS) throw new Error(`Import ${MAX_IMPORT_ROWS.toLocaleString()} rows or fewer at a time.`);
        if (previewSource !== source) importedRowsInPreview = 0;
        previewSource = source;
        $('#paste-feedback').textContent = importedRowsInPreview ? `${importedRowsInPreview.toLocaleString()} of ${previewRows.length.toLocaleString()} rows already imported. Ready to continue.` : `${previewRows.length.toLocaleString()} rows ready to import.`;
        $('#paste-feedback').style.color = '#77e1bf';
        $('#import-paste').disabled = importedRowsInPreview >= previewRows.length;
      } catch (error) {
        previewRows = []; previewSource = ''; importedRowsInPreview = 0; $('#import-paste').disabled = true;
        $('#paste-feedback').textContent = error.message; $('#paste-feedback').style.color = '#ffac8a';
      }
    });
    listen('#import-paste', 'click', async event => {
      const button = event.currentTarget;
      if (!previewRows.length || button.disabled) return;
      button.disabled = true; button.textContent = 'Importing…';
      try {
        while (importedRowsInPreview < previewRows.length) {
          const rows = previewRows.slice(importedRowsInPreview, importedRowsInPreview + IMPORT_BATCH_SIZE);
          const result = await api('/api/delivery-report/orders/import', { method: 'POST', body: JSON.stringify({ rows }) });
          importedRowsInPreview += result.imported;
          $('#paste-feedback').textContent = `Importing ${importedRowsInPreview.toLocaleString()} of ${previewRows.length.toLocaleString()} rows…`;
        }
        const imported = importedRowsInPreview;
        $('#delivery-paste').value = ''; previewRows = []; previewSource = ''; importedRowsInPreview = 0;
        $('#paste-feedback').textContent = `${imported.toLocaleString()} rows imported successfully.`; $('#paste-feedback').style.color = '#77e1bf';
        showToast(`${imported.toLocaleString()} delivery rows imported`); await loadOrders();
      } catch (error) {
        showToast(error.message);
        $('#paste-feedback').textContent = `${importedRowsInPreview.toLocaleString()} of ${previewRows.length.toLocaleString()} rows imported. Retry to continue. ${error.message}`;
        $('#paste-feedback').style.color = '#ffac8a';
      }
      finally { button.disabled = !previewRows.length || importedRowsInPreview >= previewRows.length; button.textContent = importedRowsInPreview ? 'Continue import' : 'Import rows'; }
    });
    listen('#export-delivery-csv', 'click', () => {
      const columns = [['Order No/', 'orderNo'], ['Date', 'date'], ['Time', 'time'], ['Customers Name', 'customerName'], ['Source', 'source'], ['Store', 'store'], ['Driver Name', 'driverName'], ['Status', 'status'], ['Value', 'value'], ['MBD', 'mbd'], ['Valid', 'valid']];
      const csv = [columns.map(([name]) => name), ...orders.map(row => columns.map(([, key]) => key === 'value' ? money(row.valueCurrency, row.valueAmount) : row[key] ?? ''))].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `ae-trace-delivery-data-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    const initialView = location.hash.slice(1);
    setActiveView(['dashboard', 'overview', 'store-reports', 'store-inputs', 'store-targets', 'riders-reports', 'rider-roster', 'data-sheet'].includes(initialView) ? initialView : 'dashboard');
    $('#rider-report-month').value = monthNow();
    $('#store-target-month').value = monthNow();
    try { await loadRiderRoster(); } catch (error) { showToast(error.message); }
    await loadOrders();
    try { await loadRiderMonth(); } catch (error) { showToast(error.message); }
  } catch (error) {
    $('#delivery-auth-loading').classList.add('hidden');
    $('#delivery-auth-error').classList.remove('hidden');
    $('#delivery-auth-message').textContent = error.message || 'Sign in with an AE-Trace administrator account to continue.';
  }
}

boot();
