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
  imgSrc: ["'self'", 'data:', 'https://api.maptiler.com'],
  connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'], objectSrc: ["'none'"]
} } }));
app.use(express.json({ limit: '32kb' }));

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }) : null;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();
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
    if (!admin) return res.status(403).json({ error: 'This account is not an Aetrace administrator' });
    req.admin = user;
    next();
  } catch (error) { return fail(res, error); }
}
async function requireDevice(req, res, next) {
  try {
    const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!raw) return res.status(401).json({ error: 'Device token required' });
    const { data: device, error } = await db.from('devices').select('id,name,platform').eq('token_hash', sha(raw)).maybeSingle();
    if (error) return fail(res, error);
    if (!device) return res.status(401).json({ error: 'Invalid device token' });
    req.device = device;
    next();
  } catch (error) { return fail(res, error); }
}
app.use('/api', needDatabase);
app.get('/api/health', (_req, res) => res.json({ ok: true, timestamp: now() }));
app.get('/api/config', (_req, res) => res.json({ supabaseUrl, supabaseAnonKey: anonKey, mapTilerKey: process.env.MAPTILER_API_KEY || null }));
app.get('/api/me', requireAdmin, (req, res) => res.json({ username: req.admin.email, id: req.admin.id }));
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
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 80) : '';
    if (!label) return res.status(400).json({ error: 'Give this enrollment code a device or team label' });
    const code = randomToken().slice(0, 12).toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
    const { error } = await db.from('enrollments').insert({ code_hash: sha(code), label, expires_at: expiresAt, created_by: req.admin.id });
    if (error) return fail(res, error);
    await audit(req.admin.email || req.admin.id, 'enrollment_code_created', null, { label, expiresAt });
    res.status(201).json({ code, label, expiresAt });
  } catch (error) { return fail(res, error); }
});
app.post('/api/enroll', async (req, res) => {
  try {
    const { code, name, platform } = req.body || {};
    if (typeof code !== 'string' || typeof name !== 'string' || name.trim().length < 1 || name.length > 100) return res.status(400).json({ error: 'Enter the enrollment code and a device name' });
    const token = randomToken();
    const devicePlatform = ['android', 'ios', 'other'].includes(platform) ? platform : 'other';
    const { data: id, error } = await db.rpc('enroll_device', {
      p_code_hash: sha(code.trim().toUpperCase()), p_name: name.trim(), p_platform: devicePlatform, p_token_hash: sha(token)
    });
    if (error) {
      const explanation = error.message || '';
      if (explanation.includes('invalid, expired, or already used')) return res.status(400).json({ error: 'Enrollment code is invalid, expired, or already used' });
      if (explanation.includes('50 device limit')) return res.status(409).json({ error: 'This fleet has reached the 50 device limit' });
      return fail(res, error);
    }
    await audit(`device:${id}`, 'device_enrolled', id, { name: name.trim(), platform: devicePlatform });
    res.status(201).json({ deviceId: id, deviceToken: token, name: name.trim() });
  } catch (error) { return fail(res, error); }
});
app.get('/api/device/profile', requireDevice, (req, res) => res.json({ deviceId: req.device.id, name: req.device.name, platform: req.device.platform }));
app.post('/api/device/heartbeat', requireDevice, async (req, res) => {
  try {
    const battery = Number.isInteger(req.body?.battery) && req.body.battery >= 0 && req.body.battery <= 100 ? req.body.battery : null;
    const stamp = now();
    const update = { last_seen_at: stamp, status: 'online' };
    if (battery !== null) update.battery = battery;
    const { error } = await db.from('devices').update(update).eq('id', req.device.id);
    if (error) return fail(res, error);
    res.json({ ok: true, timestamp: stamp });
  } catch (error) { return fail(res, error); }
});
app.post('/api/device/location', requireDevice, async (req, res) => {
  try {
    const { latitude, longitude, accuracy } = req.body || {};
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000))) return res.status(400).json({ error: 'Invalid location coordinates or accuracy' });
    const stamp = now();
    const battery = Number.isInteger(req.body?.battery) && req.body.battery >= 0 && req.body.battery <= 100 ? req.body.battery : null;
    const deviceUpdate = { last_seen_at: stamp, status: 'online' };
    if (battery !== null) deviceUpdate.battery = battery;
    const { error: deviceError } = await db.from('devices').update(deviceUpdate).eq('id', req.device.id);
    if (deviceError) return fail(res, deviceError);
    const { error } = await db.from('locations').insert({ device_id: req.device.id, latitude, longitude, accuracy: accuracy ?? null, recorded_at: stamp });
    if (error) return fail(res, error);
    await db.from('locations').delete().lt('recorded_at', new Date(Date.now() - 90 * 86400000).toISOString());
    res.status(201).json({ ok: true, timestamp: stamp });
  } catch (error) { return fail(res, error); }
});

app.get('/api/devices', requireAdmin, async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() - 120000).toISOString();
    const { error: statusError } = await db.from('devices').update({ status: 'offline' }).lt('last_seen_at', cutoff);
    if (statusError) return fail(res, statusError);
    const { data: devices, error } = await db.from('devices').select('id,name,platform,created_at,last_seen_at,battery,status').order('name');
    if (error) return fail(res, error);
    const ids = devices.map(device => device.id);
    const { data: locations, error: locationError } = ids.length ? await db.from('device_latest_locations').select('*').in('device_id', ids) : { data: [], error: null };
    if (locationError) return fail(res, locationError);
    const latest = new Map((locations || []).map(row => [row.device_id, row]));
    res.json(devices.map(d => ({ id:d.id,name:d.name,platform:d.platform,enrolledAt:d.created_at,lastSeenAt:d.last_seen_at,battery:d.battery,status:d.status,...(latest.has(d.id)?{latitude:latest.get(d.id).latitude,longitude:latest.get(d.id).longitude,accuracy:latest.get(d.id).accuracy,locationAt:latest.get(d.id).recorded_at}:{latitude:null,longitude:null,accuracy:null,locationAt:null}) })));
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

if (!process.env.VERCEL) app.use(express.static(path.join(__dirname, 'public'), { extensions:['html'] }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error:'Internal server error' }); });

// Vercel deploys this Express app as a Function. Locally, run it as a normal server.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`Aetrace listening at http://${host}:${port}`));
}
module.exports = app;
