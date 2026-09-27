import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1';

const $ = selector => document.querySelector(selector);
let supabase;
let orders = [];
let previewRows = [];
let riderMonthData = [];
let riderTargets = new Map();
let riderTargetMonth = '';
let riderDataMonth = '';
let riderMonthManuallySelected = false;
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
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseValue(value) {
  const raw = String(value || '').trim().replace(/,/g, '');
  const match = raw.match(/^(.*?)([-+]?\d+(?:\.\d+)?)\s*$/);
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

function monthNow() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function riderMonthRows() {
  return riderMonthData.filter(row => row.driverName?.trim());
}

function riderComment(stats, target) {
  if (target == null) return 'Set a monthly target to generate a performance comment.';
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
  const rows = riderMonthRows();
  const groups = new Map();
  for (const row of rows) {
    const name = row.driverName.trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  const riders = [...groups].map(([name, items]) => {
    const validCount = items.filter(valid).length;
    const invalidCount = items.filter(row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim())).length;
    const withMbd = items.filter(row => row.mbd != null && row.mbd !== '' && Number.isFinite(Number(row.mbd)));
    const onTime = withMbd.filter(row => Number(row.mbd) >= 0).length;
    const stores = [...new Set(items.map(row => row.store?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const target = riderTargets.has(name) ? Number(riderTargets.get(name)) : null;
    const stats = { name, items, stores, achieved: items.length, valid: validCount, invalid: invalidCount, onTime, onTimeCount: withMbd.length, onTimeRate: withMbd.length ? onTime / withMbd.length : null, target };
    stats.balance = target == null ? null : target - stats.achieved;
    stats.comment = riderComment(stats, target);
    return stats;
  }).sort((a, b) => b.achieved - a.achieved || (b.target ? b.achieved / b.target : 0) - (a.target ? a.achieved / a.target : 0) || a.name.localeCompare(b.name));
  const totalTarget = riders.reduce((sum, rider) => sum + (rider.target || 0), 0);
  const totalAchieved = riders.reduce((sum, rider) => sum + rider.achieved, 0);
  const totalOnTime = riders.reduce((sum, rider) => sum + rider.onTime, 0);
  const totalWithMbd = riders.reduce((sum, rider) => sum + rider.onTimeCount, 0);
  $('#rider-stat-count').textContent = riders.length.toLocaleString();
  $('#rider-stat-target').textContent = riders.some(rider => rider.target != null) ? totalTarget.toLocaleString() : 'Set targets';
  $('#rider-stat-target-note').textContent = `${riders.filter(rider => rider.target != null).length} of ${riders.length} riders have a target`;
  $('#rider-stat-achieved').textContent = totalAchieved.toLocaleString();
  $('#rider-stat-ontime').textContent = totalWithMbd ? `${Math.round(totalOnTime / totalWithMbd * 100)}%` : '—';
  $('#rider-report-period').textContent = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase();
  const champion = riders[0];
  $('#rider-champion-name').textContent = champion?.name || 'No rider data yet';
  $('#rider-champion-detail').textContent = champion ? `${champion.stores.join(', ') || 'Store not specified'} · ${champion.target == null ? 'Target not set' : `${champion.achieved} of ${champion.target} deliveries`} · ${champion.onTimeRate == null ? 'On-time data unavailable' : `${Math.round(champion.onTimeRate * 100)}% on-time`}` : 'Import monthly delivery rows to see the top performer.';
  $('#rider-champion-score').textContent = champion ? champion.achieved.toLocaleString() : '—';
  $('#rider-report-rows').innerHTML = riders.length ? riders.map((rider, index) => `<tr><td><span class="rider-rank ${index < 3 ? 'top-rank' : ''}">${index + 1}</span></td><td><strong>${esc(rider.name)}</strong></td><td>${esc(rider.stores.join(', ') || '—')}</td><td><input class="rider-target" type="number" min="1" max="100000" step="1" inputmode="numeric" aria-label="${esc(`Monthly target for ${rider.name}`)}" data-rider="${esc(rider.name)}" value="${rider.target == null ? '' : esc(rider.target)}" placeholder="Set target"></td><td><b>${rider.achieved.toLocaleString()}</b></td><td>${rider.valid.toLocaleString()}</td><td>${rider.invalid.toLocaleString()}</td><td><span class="rider-rate ${rider.onTimeRate != null && rider.onTimeRate < .8 ? 'rate-low' : ''}">${rider.onTimeRate == null ? '—' : `${Math.round(rider.onTimeRate * 100)}%`}</span></td><td>${rider.balance == null ? '—' : `<span class="balance-value ${rider.balance < 0 ? 'balance-ahead' : rider.balance > 0 ? 'balance-behind' : ''}">${rider.balance > 0 ? '+' : ''}${rider.balance.toLocaleString()}</span>`}</td><td class="rider-comment">${esc(rider.comment)}</td></tr>`).join('') : emptyRow(10, `No dated rider orders for ${esc($('#rider-report-period').textContent)}. Import rows with a Date and Driver Name in the Data Sheet.`);
}

async function loadRiderTargets() {
  const month = $('#rider-report-month').value;
  if (riderTargetMonth === month) { renderRiderReport(); return; }
  riderTargetMonth = month;
  riderTargets = new Map((await api(`/api/delivery-report/rider-targets?month=${encodeURIComponent(month)}`)).map(item => [item.riderName, item.target]));
  renderRiderReport();
}

async function loadRiderReportData() {
  const month = $('#rider-report-month').value;
  if (riderDataMonth === month) { renderRiderReport(); return; }
  riderDataMonth = month;
  const result = await api(`/api/delivery-report/rider-orders?month=${encodeURIComponent(month)}`);
  if ($('#rider-report-month').value !== month) return;
  riderMonthData = result.rows;
  renderRiderReport();
  if (result.truncated) showToast('This report is limited to 20,000 orders for the selected month.');
}

async function loadRiderMonth() {
  await Promise.all([loadRiderTargets(), loadRiderReportData()]);
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
  renderDashboard(); renderOverview(); reportTable(groupRows('store'), '#store-report-rows'); renderRiderReport(); renderSheet();
  $('#delivery-count-label').textContent = `${orders.length.toLocaleString()} imported records`;
}

async function loadOrders() {
  try {
    orders = await api('/api/delivery-report/orders?limit=5000');
    const selectedMonth = $('#rider-report-month')?.value;
    if (!riderMonthManuallySelected && selectedMonth && !orders.some(row => row.date?.slice(0, 7) === selectedMonth)) {
      const latestMonth = orders.find(row => row.date)?.date.slice(0, 7);
      if (latestMonth) { $('#rider-report-month').value = latestMonth; riderTargetMonth = ''; }
    }
    riderDataMonth = '';
    renderAll();
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
      if (event.target.closest('[data-open-sheet]') || event.target.closest('[data-go-view="data-sheet"]')) { setActiveView('data-sheet'); return; }
      if (event.target.closest('#delivery-menu')) { $('#delivery-sidebar').classList.toggle('open'); $('#delivery-scrim').classList.toggle('show'); return; }
      if (event.target.id === 'delivery-scrim') { $('#delivery-sidebar').classList.remove('open'); $('#delivery-scrim').classList.remove('show'); }
    });
    $('#delivery-signout').addEventListener('click', async () => { await supabase.auth.signOut(); window.location.assign('/'); });
    $('#delivery-refresh').addEventListener('click', loadOrders);
    $('#data-sheet-refresh').addEventListener('click', loadOrders);
    $('#rider-report-month').value = monthNow();
    $('#rider-report-month').addEventListener('change', async () => {
      riderMonthManuallySelected = true;
      riderTargetMonth = '';
      riderDataMonth = '';
      try { await loadRiderMonth(); } catch (error) { showToast(error.message); }
    });
    $('#save-rider-targets').addEventListener('click', async event => {
      const button = event.currentTarget;
      const targets = [];
      for (const input of document.querySelectorAll('.rider-target')) {
        const value = input.value.trim();
        if (value === '') { targets.push({ riderName: input.dataset.rider, target: null }); continue; }
        const target = Number(value);
        if (!Number.isInteger(target) || target < 1 || target > 100000) { showToast(`Enter a whole-number target from 1 to 100,000 for ${input.dataset.rider}.`); input.focus(); return; }
        targets.push({ riderName: input.dataset.rider, target });
      }
      button.disabled = true; button.textContent = 'Saving…';
      try {
        const result = await api('/api/delivery-report/rider-targets', { method: 'PUT', body: JSON.stringify({ month: $('#rider-report-month').value, targets }) });
        riderTargetMonth = ''; await loadRiderTargets();
        showToast(`${result.saved} targets saved${result.cleared ? `, ${result.cleared} cleared` : ''} for ${$('#rider-report-month').value}.`);
      } catch (error) { showToast(error.message); }
      finally { button.disabled = false; button.textContent = 'Save targets'; }
    });
    $('#export-rider-report').addEventListener('click', () => {
      const rows = riderMonthRows();
      const groups = new Map();
      rows.forEach(row => { const name = row.driverName.trim(); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(row); });
      const result = [...groups].map(([name, items]) => {
        const target = riderTargets.has(name) ? Number(riderTargets.get(name)) : '';
        const validCount = items.filter(valid).length;
        const invalidCount = items.filter(row => /^(no|false|invalid|0)$/i.test(String(row.valid || '').trim())).length;
        const timed = items.filter(row => row.mbd != null && row.mbd !== '' && Number.isFinite(Number(row.mbd)));
        const onTime = timed.filter(row => Number(row.mbd) >= 0).length;
        const balance = target === '' ? '' : target - items.length;
        return [name, [...new Set(items.map(row => row.store).filter(Boolean))].join('; '), target, items.length, validCount, invalidCount, timed.length ? `${Math.round(onTime / timed.length * 100)}%` : '', balance, riderComment({ achieved: items.length, invalid: invalidCount, onTimeRate: timed.length ? onTime / timed.length : null }, target === '' ? null : target)];
      }).sort((a, b) => b[3] - a[3]);
      const columns = ['RANK', 'NAMES', 'STORE BELONG TO', 'TARGET', 'ACHIEVED', 'VALID', 'INVALID', 'ONTIME %', 'TARGET BALANCE', 'COMMENT'];
      const csv = [columns, ...result.map((row, index) => [index + 1, ...row])].map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `ae-trace-rider-report-${$('#rider-report-month').value}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    $('#delivery-paste').addEventListener('input', () => {
      previewRows = []; $('#import-paste').disabled = true;
      $('#paste-feedback').textContent = 'Preview your updated rows before importing.'; $('#paste-feedback').style.color = '';
    });
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
    try { await loadRiderMonth(); } catch (error) { showToast(error.message); }
  } catch (error) {
    $('#delivery-auth-loading').classList.add('hidden');
    $('#delivery-auth-error').classList.remove('hidden');
    $('#delivery-auth-message').textContent = error.message || 'Sign in with an AE-Trace administrator account to continue.';
  }
}

boot();
