import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.1';
const $ = selector => document.querySelector(selector);
let supabase;
const api = async (url, options = {}) => {
  const { data: { session } = {} } = supabase ? await supabase.auth.getSession() : {};
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}), ...(options.headers || {}) } });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data?.error || `Request failed (${response.status})`); error.status = response.status; throw error; }
  return data;
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const dateText = value => value ? new Date(value).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : 'Never';
const since = value => {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
let map, historyMap, mapTilerKey = null, devices = [], markers = new Map(), refreshTimer, toastTimer, realtimeChannel;
function addBaseTiles(targetMap, noticeSelector) {
  const notice=$(noticeSelector);
  if(!mapTilerKey){notice.textContent='Map tiles need a MapTiler API key. Add MAPTILER_API_KEY to .env or the Vercel project settings.';notice.classList.remove('hidden');return;}
  const tiles=L.tileLayer(`https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=${encodeURIComponent(mapTilerKey)}`,{
    tileSize:512,zoomOffset:-1,minZoom:1,maxZoom:20,attribution:'&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',crossOrigin:true
  });
  tiles.on('tileerror',()=>{notice.textContent='Map tiles were rejected. Check the MapTiler key and its allowed website domains.';notice.classList.remove('hidden');});
  tiles.on('tileload',()=>notice.classList.add('hidden'));
  tiles.addTo(targetMap);
}
function showToast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600); }
function showDashboard(username) {
  $('#login').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); $('#admin-name').textContent = username;
  if (!map) { map = L.map('map').setView([-12.8, 28.2], 5); addBaseTiles(map,'#map-notice'); }
  setTimeout(() => map.invalidateSize(), 100); loadAll(); connectSocket(); clearInterval(refreshTimer); refreshTimer = setInterval(loadAll, 12000);
}
async function boot() {
  try {
    const response=await fetch('/api/config'); const config=await response.json();
    if(!response.ok||!config.supabaseUrl||!config.supabaseAnonKey) throw new Error(config.error||'Supabase is not configured.');
    supabase=createClient(config.supabaseUrl,config.supabaseAnonKey);mapTilerKey=config.mapTilerKey;
    const {data:{session}}=await supabase.auth.getSession();
    if(!session){$('#login').classList.remove('hidden');return;}
    const me=await api('/api/me');showDashboard(me.username);
  } catch(error) { $('#login').classList.remove('hidden'); if(error.message)$('#login-error').textContent=error.message; }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try { const {error}=await supabase.auth.signInWithPassword({email:form.get('email'),password:form.get('password')}); if(error)throw error; const me=await api('/api/me'); await api('/api/login-audit',{method:'POST',body:'{}'}); formElement.reset(); showDashboard(me.username); }
  catch (error) { await supabase.auth.signOut(); $('#login-error').textContent = error.message; }
});
$('#logout').addEventListener('click', async () => { try { await api('/api/logout', { method:'POST', body:'{}' }); } finally { await supabase.auth.signOut(); $('#dashboard').classList.add('hidden'); $('#login').classList.remove('hidden'); if (map) { map.remove(); map=null; markers.clear(); } } });
$('#refresh').addEventListener('click', loadAll);
async function loadAll() {
  try { const [nextDevices, auditRows] = await Promise.all([api('/api/devices'), api('/api/audit?limit=12')]); devices=nextDevices; renderDevices(); renderAudit(auditRows); renderMarkers(); }
  catch (error) { if (error.status === 401) { $('#dashboard').classList.add('hidden'); $('#login').classList.remove('hidden'); } else showToast(error.message); }
}
function renderDevices() {
  $('#total-count').textContent=devices.length; $('#device-count').textContent=devices.length;
  $('#online-count').textContent=devices.filter(d => d.status === 'online').length;
  $('#located-count').textContent=devices.filter(d => Number.isFinite(d.latitude)).length;
  const tbody=$('#devices');
  if (!devices.length) { tbody.innerHTML='<tr><td colspan="6" class="empty">No devices enrolled yet. Create an enrollment code to start.</td></tr>'; return; }
  tbody.innerHTML=devices.map(d=>`<tr><td><div class="device-cell"><span class="device-icon">${d.platform==='ios'?'▯':'▣'}</span><span><span class="device-name">${esc(d.name)}</span><span class="subline">${esc(d.platform)} · ${esc(d.id.slice(0,8))}</span></span></div></td><td><span class="status-chip ${d.status==='online'?'online':'offline'}">● ${esc(d.status)}</span></td><td>${d.battery==null?'—':`${d.battery}%`}</td><td>${d.latitude==null?'—':`${Number(d.latitude).toFixed(4)}, ${Number(d.longitude).toFixed(4)}`}<span class="subline">${d.locationAt?esc(since(d.locationAt)):'No location yet'}</span></td><td>${esc(since(d.lastSeenAt))}</td><td><div class="button-row"><button class="tiny-button" data-action="history" data-id="${esc(d.id)}">History</button><button class="tiny-button danger" data-action="remove" data-id="${esc(d.id)}">Remove</button></div></td></tr>`).join('');
}
function renderAudit(rows) {
  const tbody=$('#audit');
  if (!rows.length) { tbody.innerHTML='<tr><td colspan="4" class="empty">No activity recorded.</td></tr>'; return; }
  tbody.innerHTML=rows.map(r=>`<tr><td>${esc(dateText(r.createdAt))}</td><td>${esc(r.actor)}</td><td>${esc(r.action.replaceAll('_',' '))}</td><td>${esc(r.deviceId?r.deviceId.slice(0,8):'—')}</td></tr>`).join('');
}
function renderMarkers() {
  if (!map) return;
  const present=new Set();
  for (const d of devices) {
    if (!Number.isFinite(d.latitude) || !Number.isFinite(d.longitude)) continue;
    present.add(d.id);
    const popup=`<b>${esc(d.name)}</b><br>${esc(d.status)} · battery ${d.battery==null?'—':`${d.battery}%`}<br><span>${esc(since(d.locationAt))}</span>`;
    if (markers.has(d.id)) markers.get(d.id).setLatLng([d.latitude,d.longitude]).setPopupContent(popup);
    else {
      const icon=L.divIcon({className:'device-marker',html:'',iconSize:[20,20],iconAnchor:[10,10],popupAnchor:[0,-11]});
      markers.set(d.id,L.marker([d.latitude,d.longitude],{icon}).addTo(map).bindPopup(popup));
    }
  }
  for (const [id,marker] of markers) if (!present.has(id)) { marker.remove(); markers.delete(id); }
  const points=devices.filter(d=>Number.isFinite(d.latitude)).map(d=>[d.latitude,d.longitude]);
  if (points.length && !map._userMoved) map.fitBounds(points,{padding:[35,35],maxZoom:12});
}
$('#map').addEventListener('mousedown',()=>{if(map)map._userMoved=true;});
function connectSocket() {
  if(realtimeChannel)return;
  realtimeChannel=supabase.channel('aetrace-fleet-updates')
    .on('postgres_changes',{event:'*',schema:'public',table:'locations'},()=>loadAll())
    .on('postgres_changes',{event:'*',schema:'public',table:'devices'},()=>loadAll())
    .on('postgres_changes',{event:'*',schema:'public',table:'audit_log'},()=>loadAll())
    .subscribe();
}
$('#new-enrollment').addEventListener('click',()=>{ $('#enroll-dialog').showModal(); $('#code-result').classList.add('hidden'); $('#enroll-error').textContent=''; });
$('#enroll-form').addEventListener('submit',async event=>{
  event.preventDefault(); $('#enroll-error').textContent='';
  const formElement=event.currentTarget;
  try { const data=await api('/api/enrollments',{method:'POST',body:JSON.stringify({label:new FormData(formElement).get('label')})}); $('#enroll-code').textContent=data.code; $('#enroll-expiry').textContent=`Expires ${dateText(data.expiresAt)}`; $('#code-result').classList.remove('hidden'); formElement.reset(); loadAll(); }
  catch(error){$('#enroll-error').textContent=error.message;}
});
$('#copy-code').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#enroll-code').textContent);showToast('Enrollment code copied');}catch{showToast('Select and copy the code manually');}});
$('#devices').addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]'); if(!button)return;
  const device=devices.find(d=>d.id===button.dataset.id); if(!device)return;
  if(button.dataset.action==='remove'){
    if(!confirm(`Remove ${device.name} and revoke its access? This also deletes its saved location history.`))return;
    try{await api(`/api/devices/${encodeURIComponent(device.id)}`,{method:'DELETE'});showToast('Device removed');loadAll();}catch(error){showToast(error.message);}
  } else openHistory(device);
});
async function openHistory(device){
  $('#history-title').textContent=`${device.name} · location history`; $('#history-list').textContent='Loading…'; $('#history-dialog').showModal();
  if(!historyMap){historyMap=L.map('history-map').setView([-12.8,28.2],5);addBaseTiles(historyMap,'#history-map-notice');}
  setTimeout(()=>historyMap.invalidateSize(),100);
  async function updateHistory(){
    try{const rows=await api(`/api/devices/${encodeURIComponent(device.id)}/history?hours=${$('#history-hours').value}`);$('#history-list').innerHTML=rows.length?rows.map(r=>`<div class="history-item">${esc(dateText(r.recordedAt))} · ${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)}${r.accuracy==null?'':` · ±${Math.round(r.accuracy)} m`}</div>`).join(''):'No location history for this period.';
      if(historyMap._path){historyMap.removeLayer(historyMap._path);historyMap._path=null;}if(historyMap._pins){historyMap._pins.forEach(p=>p.remove());historyMap._pins=[];}
      if(rows.length){const ordered=[...rows].reverse().map(r=>[r.latitude,r.longitude]);historyMap._path=L.polyline(ordered,{color:'#66e0bd',weight:4}).addTo(historyMap);historyMap._pins=[L.circleMarker(ordered[0],{radius:6,color:'#66e0bd'}).addTo(historyMap),L.circleMarker(ordered.at(-1),{radius:6,color:'#729cff'}).addTo(historyMap)];historyMap.fitBounds(historyMap._path.getBounds(),{padding:[25,25],maxZoom:15});}
    }catch(error){$('#history-list').textContent=error.message;}
  }
  $('#history-hours').onchange=updateHistory;await updateHistory();
}
boot();
