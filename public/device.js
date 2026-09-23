const $=s=>document.querySelector(s);
const tokenKey='aetrace_device_token',idKey='aetrace_device_id',nameKey='aetrace_device_name';
let watchId=null,heartbeatTimer=null,batteryManager=null,lastSent=0;
function setError(message){$('#device-error').textContent=message;}
async function request(url,body){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem(tokenKey)}`},body:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok){if(response.status===401){localStorage.removeItem(tokenKey);location.reload();}throw new Error(data.error||'Request failed');}return data;}
function batteryPercent(){return batteryManager&&Number.isFinite(batteryManager.level)?Math.round(batteryManager.level*100):null;}
async function heartbeat(){try{await request('/api/device/heartbeat',{battery:batteryPercent()});}catch(error){console.error(error.message);}}
async function init(){
 const token=localStorage.getItem(tokenKey);
 if(!token)return;
 try{const response=await fetch('/api/device/profile',{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error();const profile=await response.json();
  $('#enroll-panel').classList.add('hidden');$('#tracking-panel').classList.remove('hidden');$('#device-name').textContent=profile.name;$('#battery-level').textContent='Unavailable';
  if('getBattery' in navigator){try{batteryManager=await navigator.getBattery();const update=()=>$('#battery-level').textContent=`${Math.round(batteryManager.level*100)}%`;update();batteryManager.addEventListener('levelchange',update);}catch{}}
  await heartbeat();heartbeatTimer=setInterval(heartbeat,45000);
  if(sessionStorage.getItem('aetrace_tracking')==='true')startTracking();
 }catch{localStorage.removeItem(tokenKey);localStorage.removeItem(idKey);localStorage.removeItem(nameKey);}
}
$('#device-enroll').addEventListener('submit',async event=>{
 event.preventDefault();setError('');const formElement=event.currentTarget;const form=new FormData(formElement);
 try{const response=await fetch('/api/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:form.get('code'),name:form.get('name'),platform:form.get('platform')})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not enroll');
  localStorage.setItem(tokenKey,data.deviceToken);localStorage.setItem(idKey,data.deviceId);localStorage.setItem(nameKey,data.name);formElement.reset();await init();
 }catch(error){setError(error.message);}
});
function startTracking(){
 if(!('geolocation'in navigator)){setError('This browser does not support location.');return;}
 setError('');$('#tracking-status').textContent='● Requesting location permission';$('#tracking-status').className='status-chip offline';
 watchId=navigator.geolocation.watchPosition(async position=>{
  const now=Date.now();if(now-lastSent<8000)return;lastSent=now;
  const {latitude,longitude,accuracy}=position.coords;
  $('#last-coordinate').textContent=`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  try{await request('/api/device/location',{latitude,longitude,accuracy,battery:batteryPercent()});$('#last-update').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});$('#tracking-status').textContent='● Sharing location';$('#tracking-status').className='status-chip online';}
  catch(error){$('#tracking-status').textContent='● Connection error';$('#tracking-status').className='status-chip offline';setError(error.message);}
 },error=>{
  $('#tracking-status').textContent='● Location unavailable';$('#tracking-status').className='status-chip offline';
  const errors={1:'Location permission was denied. Allow it in your browser settings.',2:'Your current location could not be determined.',3:'Location request timed out.'};setError(errors[error.code]||'Location could not be read.');
 },{enableHighAccuracy:true,maximumAge:10000,timeout:20000});
 sessionStorage.setItem('aetrace_tracking','true');$('#start-tracking').classList.add('hidden');$('#stop-tracking').classList.remove('hidden');
}
function stopTracking(){if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;sessionStorage.removeItem('aetrace_tracking');$('#tracking-status').textContent='● Not tracking';$('#tracking-status').className='status-chip offline';$('#start-tracking').classList.remove('hidden');$('#stop-tracking').classList.add('hidden');}
$('#start-tracking').addEventListener('click',startTracking);$('#stop-tracking').addEventListener('click',stopTracking);
window.addEventListener('online',heartbeat);window.addEventListener('pagehide',()=>{if(heartbeatTimer)clearInterval(heartbeatTimer);});
init();
