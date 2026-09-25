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
  await heartbeat();heartbeatTimer=setInterval(heartbeat,45000);startTracking();
 }catch{localStorage.removeItem(tokenKey);localStorage.removeItem(idKey);localStorage.removeItem(nameKey);}
}
$('#device-enroll').addEventListener('submit',async event=>{
 event.preventDefault();setError('');const formElement=event.currentTarget;const form=new FormData(formElement);
 try{const platform=/android/i.test(navigator.userAgent)?'android':/iphone|ipad|ipod/i.test(navigator.userAgent)?'ios':'other';let battery=null;if('getBattery'in navigator){try{battery=Math.round((await navigator.getBattery()).level*100);}catch{}}
  const userAgent=navigator.userAgent.slice(0,120)||'Unknown browser';const response=await fetch('/api/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:String(form.get('code')).trim().toUpperCase(),fullName:String(form.get('fullName')).trim(),store:String(form.get('store')).trim(),phone:String(form.get('phone')).trim(),name:platform==='ios'?'Rider iPhone':platform==='android'?'Rider Android phone':'Rider phone',platform,deviceModel:userAgent,appVersion:'1.0.0-web',battery})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not enroll');
  localStorage.setItem(tokenKey,data.deviceToken);localStorage.setItem(idKey,data.deviceId);localStorage.setItem(nameKey,data.name);
  const photo=form.get('photo');if(photo instanceof File&&photo.size){const photoBase64=await readResizedPhoto(photo);await request('/api/device/profile-photo',{photoBase64});}
  formElement.reset();await init();
 }catch(error){setError(error.message);}
});
function readResizedPhoto(file){return new Promise((resolve,reject)=>{if(file.size>8*1024*1024){reject(new Error('Choose an image smaller than 8 MB.'));return;}const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read the photo.'));reader.onload=()=>{const image=new Image();image.onerror=()=>reject(new Error('Choose a valid image file.'));image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const context=canvas.getContext('2d');const side=Math.min(image.width,image.height),sx=(image.width-side)/2,sy=(image.height-side)/2;context.drawImage(image,sx,sy,side,side,0,0,512,512);const data=canvas.toDataURL('image/jpeg',.72).split(',')[1];if(data.length>1024*1024)reject(new Error('That profile photo is too large. Choose another image.'));else resolve(data);};image.src=reader.result;};reader.readAsDataURL(file);});}
function startTracking(){
 if(!('geolocation'in navigator)){setError('This browser does not support location.');return;}
 setError('');$('#tracking-status').textContent='● Requesting location permission';$('#tracking-status').className='status-chip offline';
 watchId=navigator.geolocation.watchPosition(async position=>{
  const now=Date.now();if(now-lastSent<8000)return;lastSent=now;
  const {latitude,longitude,accuracy}=position.coords;
  $('#last-coordinate').textContent=`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  try{await request('/api/device/location',{latitude,longitude,accuracy,battery:batteryPercent()});$('#last-update').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});$('#tracking-status').textContent='● Sharing location';$('#tracking-status').className='status-chip online';}
  catch(error){if(error.message.includes('paused')){navigator.geolocation.clearWatch(watchId);watchId=null;$('#tracking-status').textContent='● Disabled by administrator';}else{$('#tracking-status').textContent='● Connection error';$('#tracking-status').className='status-chip offline';}setError(error.message);}
 },error=>{
  $('#tracking-status').textContent='● Location unavailable';$('#tracking-status').className='status-chip offline';
  const errors={1:'Location permission was denied. Allow it in your browser settings.',2:'Your current location could not be determined.',3:'Location request timed out.'};setError(errors[error.code]||'Location could not be read.');
 },{enableHighAccuracy:true,maximumAge:10000,timeout:20000});
 $('#tracking-status').textContent='● Sharing location';$('#tracking-status').className='status-chip online';
}
window.addEventListener('online',heartbeat);window.addEventListener('pagehide',()=>{if(heartbeatTimer)clearInterval(heartbeatTimer);});
init();
