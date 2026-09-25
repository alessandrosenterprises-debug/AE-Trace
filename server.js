require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');
const path = require('node:path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.VERCEL ? 1 : false);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://esm.sh'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'https://api.maptiler.com', 'https://*.supabase.co'],
  connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'], objectSrc: ["'none'"]
} } }));

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }) : null;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const photoUrlCache = new Map();
const now = () => new Date().toISOString();
async function signedPhotoUrl(path) {
  if (!path || !db) return null;
  const cached=photoUrlCache.get(path);
  if(cached&&cached.expiresAt>Date.now())return cached.url;
  const {data,error}=await db.storage.from('rider-photos').createSignedUrl(path,3600);
  if(error){console.error('Could not sign rider photo URL',error.message);return null;}
  const url=data?.signedUrl||null;
  if(url)photoUrlCache.set(path,{url,expiresAt:Date.now()+50*60*1000});
  return url;
}
function needDatabase(_req, res, next) {
  if (!db || !anonKey) return res.status(503).json({ error: 'Supabase is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.' });
  next();
}
function fail(res, error, message = 'Database request failed') {
  if (error) console.error(message, error.message || error);
  return res.status(500).json({ error: message });
}
async function audit(actor, action, deviceId = null, details = {}) {
  const { error } = await db.from('audit_log').insert({ actor, action, device_id: deviceId, details });
  if (error) console.error('Could not write audit event', error.message);
}
async function requireAdmin(req, res, next) {
  try {
    const bearer = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return res.status(401).json({ error: 'Sign in required' });
    const { data: { user }, error: authError } = await db.auth.getUser(bearer);
    if (authError || !user) return res.status(401).json({ error: 'Sign in required' });
    const { data: admin, error } = await db.from('app_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (error) return fail(res, error, 'Could not verify administrator access');
    if (!admin) return res.status(403).json({ error: 'This account is not an AE-Trace administrator' });
    req.admin = user;
    next();
  } catch (error) { return fail(res, error); }
}
async function requireDevice(req, res, next) {
  try {
    const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!raw) return res.status(401).json({ error: 'Device token required' });
    const { data: device, error } = await db.from('devices').select('id,name,platform,rider_id').eq('token_hash', sha(raw)).maybeSingle();
    if (error) return fail(res, error);
    if (!device) return res.status(401).json({ error: 'Invalid device token' });
    req.device = device;
    next();
  } catch (error) { return fail(res, error); }
}
async function requireActiveRider(req,res,next){
  try{
    if(!req.device.rider_id)return next();
    const {data:rider,error}=await db.from('riders').select('status').eq('id',req.device.rider_id).maybeSingle();
    if(error)return fail(res,error);
    if(!rider||rider.status!=='active')return res.status(423).json({error:'Location sharing is paused for this rider. Contact your fleet administrator.'});
    next();
  }catch(error){return fail(res,error);}
}
app.use('/api', needDatabase);
app.post('/api/device/profile-photo',express.json({limit:'1100kb'}),requireDevice,requireActiveRider,async(req,res)=>{
  try{
    if(!req.device.rider_id)return res.status(409).json({error:'This device is not linked to a rider'});
    const encoded=req.body?.photoBase64;
    if(typeof encoded!=='string'||encoded.length>1024*1024||! /^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return res.status(400).json({error:'Choose a valid profile photo'});
    const image=Buffer.from(encoded,'base64');
    if(image.length<4||image.length>768*1024||image[0]!==0xff||image[1]!==0xd8||image[2]!==0xff)return res.status(400).json({error:'Profile photo must be a JPEG smaller than 768 KB'});
    const photoPath=`${req.device.rider_id}/${crypto.randomUUID()}.jpg`;
    const {error:uploadError}=await db.storage.from('rider-photos').upload(photoPath,image,{contentType:'image/jpeg',upsert:false,cacheControl:'3600'});
    if(uploadError)return fail(res,uploadError,'Could not save the profile photo');
    const {data:previous,error:updateError}=await db.from('riders').select('photo_path').eq('id',req.device.rider_id).maybeSingle();
    if(updateError){await db.storage.from('rider-photos').remove([photoPath]);return fail(res,updateError);}
    const {error}=await db.from('riders').update({photo_path:photoPath}).eq('id',req.device.rider_id);
    if(error){await db.storage.from('rider-photos').remove([photoPath]);return fail(res,error);}
    if(previous?.photo_path){await db.storage.from('rider-photos').remove([previous.photo_path]);photoUrlCache.delete(previous.photo_path);}
    const avatarUrl=await signedPhotoUrl(photoPath);
    await audit(`device:${req.device.id}`,'rider_photo_updated',req.device.id,{riderId:req.device.rider_id});
    res.json({ok:true,avatarUrl});
  }catch(error){return fail(res,error);}
});
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, timestamp: now() }));
app.get('/api/config', (_req, res) => res.json({ supabaseUrl, supabaseAnonKey: anonKey, mapTilerKey: process.env.MAPTILER_API_KEY || null }));
app.get('/api/me', requireAdmin, (req, res) => {
  const metadata = req.admin.user_metadata || {};
  const firstName = metadata.first_name || metadata.given_name || metadata.full_name?.trim().split(/\s+/)[0] || metadata.name?.trim().split(/\s+/)[0] || req.admin.email?.split('@')[0]?.split(/[._-]/)[0] || 'Administrator';
  res.json({ username: req.admin.email, firstName, id: req.admin.id });
});
app.get('/api/settings', requireAdmin, async (_req, res) => {
  const { data, error } = await db.from('fleet_settings').select('*').eq('id', 1).maybeSingle();
  if (error) return fail(res, error, 'Could not load fleet settings');
  res.json(data || { id: 1, offline_after_minutes: 2, low_battery_percent: 20, stale_location_minutes: 30, location_interval_seconds: 15 });
});
app.patch('/api/settings', requireAdmin, async (req, res) => {
  const input = req.body || {};
  const integerSetting = (key, min, max) => Number.isInteger(input[key]) && input[key] >= min && input[key] <= max;
  if (!integerSetting('offline_after_minutes', 1, 60) || !integerSetting('low_battery_percent', 5, 50) || !integerSetting('stale_location_minutes', 5, 240) || !integerSetting('location_interval_seconds', 15, 300)) return res.status(400).json({ error: 'Settings are outside the allowed ranges.' });
  const updated = { id: 1, offline_after_minutes: input.offline_after_minutes, low_battery_percent: input.low_battery_percent, stale_location_minutes: input.stale_location_minutes, location_interval_seconds: input.location_interval_seconds, updated_by: req.admin.id, updated_at: now() };
  const { data, error } = await db.from('fleet_settings').upsert(updated).select('*').single();
  if (error) return fail(res, error, 'Could not save fleet settings');
  await audit(req.admin.email || req.admin.id, 'fleet_settings_updated', null, { offlineAfterMinutes: data.offline_after_minutes, lowBatteryPercent: data.low_battery_percent, staleLocationMinutes: data.stale_location_minutes, locationIntervalSeconds: data.location_interval_seconds });
  res.json(data);
});
app.post('/api/login-audit', requireAdmin, async (req, res) => {
  await audit(req.admin.email || req.admin.id, 'login');
  res.json({ ok: true });
});
app.post('/api/logout', requireAdmin, async (req, res) => {
  await audit(req.admin.email || req.admin.id, 'logout');
  res.json({ ok: true });
});

app.post('/api/enrollments', requireAdmin, async (req, res) => {
  try {
    const code = randomToken().slice(0, 12).toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
    const { error } = await db.from('enrollments').insert({ code_hash: sha(code), label: 'Rider self-registration', expires_at: expiresAt, created_by: req.admin.id, rider_id: null });
    if (error) return fail(res, error);
    await audit(req.admin.email || req.admin.id, 'enrollment_code_created', null, { expiresAt, type: 'rider_self_registration' });
    res.status(201).json({ code, expiresAt });
  } catch (error) { return fail(res, error); }
});
app.post('/api/enroll', async (req, res) => {
  try {
    const { code, name, platform, deviceModel, fullName, store, phone, appVersion } = req.body || {};
    if (typeof code !== 'string' || typeof name !== 'string' || name.trim().length < 1 || name.length > 100) return res.status(400).json({ error: 'Enter the enrollment code and a device name' });
    const token = randomToken();
    const devicePlatform = ['android', 'ios', 'other'].includes(platform) ? platform : 'other';
    const profileRegistration=typeof fullName==='string'||typeof store==='string'||typeof phone==='string';
    if(profileRegistration&&(!fullName?.trim()||!store?.trim()||!phone?.trim()))return res.status(400).json({error:'Enter your full name, store and phone number'});
    const { data, error } = profileRegistration?await db.rpc('enroll_rider_device',{
      p_code_hash:sha(code.trim().toUpperCase()),p_full_name:fullName.trim().slice(0,120),p_store:store.trim().slice(0,120),p_phone:phone.trim().slice(0,40),p_name:name.trim(),p_platform:devicePlatform,p_token_hash:sha(token),p_device_model:typeof deviceModel==='string'?deviceModel.slice(0,120):null,p_app_version:typeof appVersion==='string'?appVersion.slice(0,40):null,p_battery:Number.isInteger(req.body?.battery)&&req.body.battery>=0&&req.body.battery<=100?req.body.battery:null
    }):await db.rpc('enroll_device',{
      p_code_hash:sha(code.trim().toUpperCase()),p_name:name.trim(),p_platform:devicePlatform,p_token_hash:sha(token),p_device_model:typeof deviceModel==='string'?deviceModel.slice(0,120):null
    });
    if (error) {
      const explanation = error.message || '';
      if (explanation.includes('invalid, expired, or already used')) return res.status(400).json({ error: 'Enrollment code is invalid, expired, or already used' });
      if (explanation.includes('50 device limit')) return res.status(409).json({ error: 'This fleet has reached the 50 device limit' });
      if (explanation.includes('Enter the rider full name')||explanation.includes('Enter the store')||explanation.includes('Enter a valid phone number')) return res.status(400).json({error:explanation});
      return fail(res, error);
    }
    const deviceId=profileRegistration?data?.device_id:data;
    const riderId=profileRegistration?data?.rider_id:null;
    await audit(`device:${deviceId}`, 'device_enrolled', deviceId, { name: name.trim(), platform: devicePlatform,...(riderId?{riderId}:{} ) });
    res.status(201).json({ deviceId, ...(riderId?{riderId}:{}), deviceToken: token, name: name.trim() });
  } catch (error) { return fail(res, error); }
});
app.get('/api/device/profile', requireDevice, async (req, res) => {
  try{
    if(!req.device.rider_id)return res.json({deviceId:req.device.id,name:req.device.name,platform:req.device.platform});
    const {data:rider,error}=await db.from('riders').select('id,full_name,store,phone,status,photo_path').eq('id',req.device.rider_id).maybeSingle();
    if(error)return fail(res,error);
    res.json({deviceId:req.device.id,name:req.device.name,platform:req.device.platform,rider:rider?{id:rider.id,fullName:rider.full_name,store:rider.store,phone:rider.phone,status:rider.status,avatarUrl:await signedPhotoUrl(rider.photo_path)}:null});
  }catch(error){return fail(res,error);}
});
app.get('/api/device/settings', requireDevice, requireActiveRider, async (_req, res) => {
  const { data, error } = await db.from('fleet_settings').select('location_interval_seconds').eq('id', 1).maybeSingle();
  if (error) return fail(res, error, 'Could not load tracking settings');
  res.json({ locationIntervalSeconds: data?.location_interval_seconds || 15 });
});
app.post('/api/device/heartbeat', requireDevice, requireActiveRider, async (req, res) => {
  try {
    const battery = Number.isInteger(req.body?.battery) && req.body.battery >= 0 && req.body.battery <= 100 ? req.body.battery : null;
    const stamp = now();
    const update = { last_seen_at: stamp, status: 'online' };
    if (battery !== null) update.battery = battery;
    if(typeof req.body?.deviceModel==='string')update.device_model=req.body.deviceModel.slice(0,120);
    if(typeof req.body?.appVersion==='string')update.app_version=req.body.appVersion.slice(0,40);
    const { error } = await db.from('devices').update(update).eq('id', req.device.id);
    if (error) return fail(res, error);
    res.json({ ok: true, timestamp: stamp });
  } catch (error) { return fail(res, error); }
});
app.post('/api/device/location', requireDevice, requireActiveRider, async (req, res) => {
  try {
    const { latitude, longitude, accuracy } = req.body || {};
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000))) return res.status(400).json({ error: 'Invalid location coordinates or accuracy' });
    const stamp = now();
    const capturedTime=typeof req.body?.capturedAt==='string'?Date.parse(req.body.capturedAt):NaN;
    const recordedAt=Number.isFinite(capturedTime)&&capturedTime<=Date.now()+5*60000&&capturedTime>=Date.now()-90*86400000?new Date(capturedTime).toISOString():stamp;
    const battery = Number.isInteger(req.body?.battery) && req.body.battery >= 0 && req.body.battery <= 100 ? req.body.battery : null;
    const deviceUpdate = { last_seen_at: stamp, status: 'online' };
    if (battery !== null) deviceUpdate.battery = battery;
    if(typeof req.body?.deviceModel==='string')deviceUpdate.device_model=req.body.deviceModel.slice(0,120);
    if(typeof req.body?.appVersion==='string')deviceUpdate.app_version=req.body.appVersion.slice(0,40);
    const { error: deviceError } = await db.from('devices').update(deviceUpdate).eq('id', req.device.id);
    if (deviceError) return fail(res, deviceError);
    const { error } = await db.from('locations').insert({ device_id: req.device.id, latitude, longitude, accuracy: accuracy ?? null, recorded_at: recordedAt });
    if (error) return fail(res, error);
    await db.from('locations').delete().lt('recorded_at', new Date(Date.now() - 90 * 86400000).toISOString());
    res.status(201).json({ ok: true, timestamp: stamp, recordedAt });
  } catch (error) { return fail(res, error); }
});

app.get('/api/devices', requireAdmin, async (_req, res) => {
  try {
    const { data: settings } = await db.from('fleet_settings').select('offline_after_minutes').eq('id', 1).maybeSingle();
    const cutoff = new Date(Date.now() - (settings?.offline_after_minutes || 2) * 60000).toISOString();
    const { error: statusError } = await db.from('devices').update({ status: 'offline' }).eq('status', 'online').lt('last_seen_at', cutoff);
    if (statusError) return fail(res, statusError);
    const { error: onlineError } = await db.from('devices').update({ status: 'online' }).eq('status', 'offline').gte('last_seen_at', cutoff);
    if (onlineError) return fail(res, onlineError);
    const { data: devices, error } = await db.from('devices').select('id,name,platform,created_at,last_seen_at,battery,status,rider_id,device_model,app_version').order('name');
    if (error) return fail(res, error);
    const ids = devices.map(device => device.id);
    const { data: locations, error: locationError } = ids.length ? await db.from('device_latest_locations').select('*').in('device_id', ids) : { data: [], error: null };
    if (locationError) return fail(res, locationError);
    const riderIds=[...new Set(devices.map(d=>d.rider_id).filter(Boolean))];
    const { data:riders,error:riderError }=riderIds.length?await db.from('riders').select('id,full_name,staff_code,team,store,vehicle,status,photo_path').in('id',riderIds):{data:[],error:null};
    if(riderError)return fail(res,riderError);
    const riderProfiles=await Promise.all((riders||[]).map(async r=>({...r,avatarUrl:await signedPhotoUrl(r.photo_path)})));
    const riderMap=new Map(riderProfiles.map(r=>[r.id,r]));
    const latest = new Map((locations || []).map(row => [row.device_id, row]));
    res.json(devices.map(d => ({ id:d.id,name:d.name,platform:d.platform,enrolledAt:d.created_at,lastSeenAt:d.last_seen_at,battery:d.battery,status:d.status,riderId:d.rider_id,rider:riderMap.get(d.rider_id)||null,deviceModel:d.device_model,appVersion:d.app_version,...(latest.has(d.id)?{latitude:latest.get(d.id).latitude,longitude:latest.get(d.id).longitude,accuracy:latest.get(d.id).accuracy,locationAt:latest.get(d.id).recorded_at}:{latitude:null,longitude:null,accuracy:null,locationAt:null}) })));
  } catch (error) { return fail(res, error); }
});
app.get('/api/devices/:id/history', requireAdmin, async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24));
    const { data, error } = await db.from('locations').select('latitude,longitude,accuracy,recorded_at').eq('device_id', req.params.id).gte('recorded_at', new Date(Date.now() - hours * 3600000).toISOString()).order('recorded_at', { ascending:false }).limit(5000);
    if (error) return fail(res, error);
    res.json(data.map(({ recorded_at, ...row }) => ({ ...row, recordedAt: recorded_at })));
  } catch (error) { return fail(res, error); }
});
app.delete('/api/devices/:id', requireAdmin, async (req, res) => {
  try {
    const { data: device, error: selectError } = await db.from('devices').select('id,name').eq('id', req.params.id).maybeSingle();
    if (selectError) return fail(res, selectError);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const { error } = await db.from('devices').delete().eq('id', device.id);
    if (error) return fail(res, error);
    await audit(req.admin.email || req.admin.id, 'device_removed', device.id, { name: device.name });
    res.json({ ok: true });
  } catch (error) { return fail(res, error); }
});
app.get('/api/audit', requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const { data, error } = await db.from('audit_log').select('id,actor,action,device_id,details,created_at').order('id', { ascending:false }).limit(limit);
    if (error) return fail(res, error);
    res.json(data.map(({ device_id, created_at, ...row }) => ({ ...row, deviceId:device_id, createdAt:created_at })));
  } catch (error) { return fail(res, error); }
});
app.get('/api/reports/summary',requireAdmin,async(req,res)=>{
  try{
    const days=Math.max(1,Math.min(90,Number(req.query.days)||30));
    const from=new Date(Date.now()-days*86400000).toISOString();
    const [riderResult,deviceResult,locationResult]=await Promise.all([
      db.from('riders').select('id,status',{count:'exact'}),
      db.from('devices').select('id,status',{count:'exact'}),
      db.from('locations').select('id',{count:'exact',head:true}).gte('recorded_at',from)
    ]);
    for(const result of [riderResult,deviceResult,locationResult])if(result.error)return fail(res,result.error);
    res.json({days,activeRiders:riderResult.data.filter(r=>r.status==='active').length,pausedRiders:riderResult.data.filter(r=>r.status==='paused').length,totalRiders:riderResult.count||0,onlineDevices:deviceResult.data.filter(d=>d.status==='online').length,totalDevices:deviceResult.count||0,locationPoints:locationResult.count||0,from});
  }catch(error){return fail(res,error);}
});
app.get('/api/reports/bike-tracker', requireAdmin, async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  const isoDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!isoDay(from) || !isoDay(to) || from > to) return res.status(400).json({ error: 'Choose a valid report date range.' });
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > 90) return res.status(400).json({ error: 'Report range cannot exceed 90 days.' });
  try {
    const { data, error } = await db.rpc('daily_bike_tracker_report', { p_start_date: from, p_end_date: to });
    if (error) return fail(res, error, 'Could not build Bike Tracker Report');
    res.json(data || []);
  } catch (error) { return fail(res, error, 'Could not build Bike Tracker Report'); }
});

app.get('/api/riders', requireAdmin, async (_req,res)=>{
  try{
    const {data,error}=await db.from('riders').select('id,full_name,email,phone,staff_code,team,store,vehicle,status,photo_path,created_at,updated_at,devices(id,name,platform,status,last_seen_at,battery,device_model,app_version)').order('full_name');
    if(error)return fail(res,error);
    res.json(await Promise.all(data.map(async r=>({...r,fullName:r.full_name,staffCode:r.staff_code,avatarUrl:await signedPhotoUrl(r.photo_path),createdAt:r.created_at,updatedAt:r.updated_at,devices:(r.devices||[]).map(d=>({...d,lastSeenAt:d.last_seen_at,deviceModel:d.device_model,appVersion:d.app_version}))}))));
  }catch(error){return fail(res,error);}
});
app.post('/api/riders',requireAdmin,async(req,res)=>{
  try{
    const fullName=typeof req.body?.fullName==='string'?req.body.fullName.trim().slice(0,120):'';
    if(!fullName)return res.status(400).json({error:'Rider name is required'});
    const row={full_name:fullName,email:typeof req.body.email==='string'?req.body.email.trim().slice(0,254)||null:null,phone:typeof req.body.phone==='string'?req.body.phone.trim().slice(0,40)||null:null,staff_code:typeof req.body.staffCode==='string'?req.body.staffCode.trim().slice(0,40)||null:null,team:typeof req.body.team==='string'?req.body.team.trim().slice(0,80)||null:null,store:typeof req.body.store==='string'?req.body.store.trim().slice(0,120)||null:null,vehicle:typeof req.body.vehicle==='string'?req.body.vehicle.trim().slice(0,80)||null:null};
    const {data,error}=await db.from('riders').insert(row).select('id,full_name,email,phone,staff_code,team,store,vehicle,status,created_at').single();
    if(error){if(error.code==='23505')return res.status(409).json({error:'That staff ID is already in use'});return fail(res,error);}
    await audit(req.admin.email||req.admin.id,'rider_created',null,{riderId:data.id,name:data.full_name});
    res.status(201).json({...data,fullName:data.full_name,staffCode:data.staff_code,createdAt:data.created_at,devices:[]});
  }catch(error){return fail(res,error);}
});
app.patch('/api/riders/:id',requireAdmin,async(req,res)=>{
  try{
    const update={};
    for(const [input,column,max] of [['fullName','full_name',120],['email','email',254],['phone','phone',40],['staffCode','staff_code',40],['team','team',80],['store','store',120],['vehicle','vehicle',80]])if(typeof req.body?.[input]==='string')update[column]=req.body[input].trim().slice(0,max)||null;
    if('full_name'in update&&!update.full_name)return res.status(400).json({error:'Rider name cannot be empty'});
    if(typeof req.body?.status==='string'){if(!['active','paused','archived'].includes(req.body.status))return res.status(400).json({error:'Invalid rider status'});update.status=req.body.status;}
    if(!Object.keys(update).length)return res.status(400).json({error:'No rider changes supplied'});
    const {data,error}=await db.from('riders').update(update).eq('id',req.params.id).select('id,full_name,email,phone,staff_code,team,store,vehicle,status').maybeSingle();
    if(error){if(error.code==='23505')return res.status(409).json({error:'That staff ID is already in use'});return fail(res,error);}
    if(!data)return res.status(404).json({error:'Rider not found'});
    await audit(req.admin.email||req.admin.id,'rider_updated',null,{riderId:data.id,changes:Object.keys(update)});
    res.json({...data,fullName:data.full_name,staffCode:data.staff_code});
  }catch(error){return fail(res,error);}
});
app.patch('/api/devices/:id',requireAdmin,async(req,res)=>{
  try{
    const update={};
    if(typeof req.body?.name==='string'){const name=req.body.name.trim().slice(0,100);if(!name)return res.status(400).json({error:'Device name cannot be empty'});update.name=name;}
    if(req.body&&Object.hasOwn(req.body,'riderId')){
      const riderId=typeof req.body.riderId==='string'&&req.body.riderId?req.body.riderId:null;
      if(riderId){const {data:rider,error:riderError}=await db.from('riders').select('id,status').eq('id',riderId).maybeSingle();if(riderError)return fail(res,riderError);if(!rider||rider.status!=='active')return res.status(400).json({error:'Choose an active rider'});}
      update.rider_id=riderId;
    }
    if(!Object.keys(update).length)return res.status(400).json({error:'No device changes supplied'});
    const {data,error}=await db.from('devices').update(update).eq('id',req.params.id).select('id,name,rider_id').maybeSingle();
    if(error)return fail(res,error);if(!data)return res.status(404).json({error:'Device not found'});
    await audit(req.admin.email||req.admin.id,'device_updated',data.id,{changes:Object.keys(update)});
    res.json({id:data.id,name:data.name,riderId:data.rider_id});
  }catch(error){return fail(res,error);}
});

// Vercel serves files in /public as CDN assets and does not run Express static
// middleware there. Serve the dashboard document explicitly so GET / works
// when the Express app is deployed as a Vercel Function.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (!process.env.VERCEL) app.use(express.static(path.join(__dirname, 'public'), { extensions:['html'] }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error:'Internal server error' }); });

// Vercel deploys this Express app as a Function. Locally, run it as a normal server.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`AE-Trace listening at http://${host}:${port}`));
}
module.exports = app;
