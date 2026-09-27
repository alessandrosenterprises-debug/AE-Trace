import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1';

const $ = selector => document.querySelector(selector);
let supabase;
let orders = [];
let previewRows = [];
let riderMonthData = [];
let riderRoster = [];
let storeTargets = new Map();
let pendingTargetStores = new Set();
let riderTargetMonth = '';
let riderDataMonth = '';
let riderMonthManuallySelected = false;
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (currency, amount) => amount == null || amount === '' ? '—' : `${currency || 'K'}${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = value => Number(value || 0);
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
  if (name === 'store-targets') renderStoreTargets();
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
  const stores = new Map();
  for (const rider of riderRoster.filter(entry => entry.riderName?.trim() && entry.homeStore?.trim())) {
    const key = normalizedName(rider.homeStore);
    if (!stores.has(key)) stores.set(key, { name: rider.homeStore, riders: [] });
    stores.get(key).riders.push(rider);
  }
  for (const saved of storeTargets.values()) if (!stores.has(normalizedName(saved.storeName))) stores.set(normalizedName(saved.storeName), { name: saved.storeName, riders: [] });
  const rows = [...stores.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('#target-store-count').textContent = rows.filter(([, group]) => group.riders.length).length.toLocaleString();
  $('#target-rider-count').textContent = riderRoster.filter(entry => entry.riderName?.trim() && entry.homeStore?.trim()).length.toLocaleString();
  const total = rows.reduce((sum, [key]) => sum + (storeTargets.get(key)?.target || 0), 0);
  const setCount = rows.filter(([key]) => storeTargets.get(key)?.target != null).length;
  $('#target-total').textContent = setCount ? total.toLocaleString() : 'Set targets';
  $('#target-store-note').textContent = `${setCount} of ${rows.length} listed stores have a target`;
  $('#target-month-label').textContent = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  $('#store-target-rows').innerHTML = rows.length ? rows.map(([key, group]) => {
    const assigned = [...group.riders].sort((a, b) => a.riderName.localeCompare(b.riderName));
    const target = storeTargets.get(key)?.target;
    const allocation = target == null ? 'Set target first' : !assigned.length ? 'No riders assigned' : (() => {
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
  riderDataMonth = month;
  const result = await api(`/api/delivery-report/rider-orders?month=${encodeURIComponent(month)}`);
  if ($('#rider-report-month').value !== month) return;
  riderMonthData = result.rows;
  renderRiderReport();
  if (result.truncated) showToast('This report is limited to 20,000 orders for the selected month.');
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
      if (latestMonth) {
        $('#rider-report-month').value = latestMonth;
        $('#store-target-month').value = latestMonth;
        riderTargetMonth = '';
      }
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
      const goView = event.target.closest('[data-go-view]');
      if (event.target.closest('[data-open-sheet]')) { setActiveView('data-sheet'); return; }
      if (goView) { setActiveView(goView.dataset.goView); return; }
      if (event.target.closest('#delivery-menu')) { $('#delivery-sidebar').classList.toggle('open'); $('#delivery-scrim').classList.toggle('show'); return; }
      if (event.target.id === 'delivery-scrim') { $('#delivery-sidebar').classList.remove('open'); $('#delivery-scrim').classList.remove('show'); }
    });
    $('#delivery-signout').addEventListener('click', async () => { await supabase.auth.signOut(); window.location.assign('/'); });
    $('#delivery-refresh').addEventListener('click', loadOrders);
    $('#data-sheet-refresh').addEventListener('click', loadOrders);
    $('#rider-report-month').value = monthNow();
    $('#store-target-month').value = monthNow();
    $('#rider-report-month').addEventListener('change', async event => {
      try { await selectReportMonth(event.currentTarget.value); } catch (error) { showToast(error.message); }
    });
    $('#store-target-month').addEventListener('change', async event => {
      try { await selectReportMonth(event.currentTarget.value); } catch (error) { showToast(error.message); }
    });
    $('#save-store-targets').addEventListener('click', async event => {
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
    $('#add-target-store').addEventListener('click', () => {
      const input = $('#new-target-store');
      const storeName = input.value.trim();
      if (!storeName) { showToast('Enter a store name first.'); input.focus(); return; }
      const key = normalizedName(storeName);
      if (storeTargets.has(key) || riderRoster.some(rider => normalizedName(rider.homeStore) === key)) { showToast(`${storeName} is already listed for this month.`); input.focus(); return; }
      storeTargets.set(key, { storeName, target: null }); pendingTargetStores.add(key);
      input.value = ''; renderStoreTargets();
      document.querySelectorAll('.store-target-input').forEach(targetInput => { if (normalizedName(targetInput.dataset.store) === key) targetInput.focus(); });
    });
    $('#export-rider-report').addEventListener('click', () => {
      const columns = ['RANK', 'NAMES', 'STORE BELONG TO', 'TARGET', 'ACHIEVED', 'VALID', 'INVALID', 'ONTIME %', 'TARGET BALANCE', 'COMMENT'];
      const rows = [...document.querySelectorAll('#rider-report-rows tr')].filter(row => row.children.length === 10).map(row => [...row.children].map(cell => cell.innerText.trim()));
      const csv = [columns, ...rows].map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `ae-trace-rider-report-${$('#rider-report-month').value}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    $('#add-roster-rider').addEventListener('click', () => {
      riderRoster.push({ riderName: '', homeStore: '' }); renderRiderRoster();
      $('#rider-roster-rows tr:last-child .roster-name-input')?.focus();
    });
    $('#rider-roster-rows').addEventListener('click', async event => {
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
    $('#save-roster').addEventListener('click', async event => {
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
    $('#import-roster').addEventListener('click', async event => {
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
    setActiveView(['dashboard', 'overview', 'store-reports', 'store-targets', 'riders-reports', 'rider-roster', 'data-sheet'].includes(initialView) ? initialView : 'dashboard');
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
