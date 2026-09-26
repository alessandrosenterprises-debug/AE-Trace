import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

export const LOCATION_TASK = 'ae-trace-company-device-location';
const TOKEN_KEY = 'aetrace.deviceToken';
const URL_KEY = 'aetrace.apiUrl';
const MAX_QUEUED_POINTS = 2000;
const APP_VERSION = Constants.expoConfig?.version || '1.0.0';
const DEVICE_MODEL = Device.modelName || Device.deviceName || 'Rider phone';
let databasePromise;

async function database() {
  if (!databasePromise) databasePromise = SQLite.openDatabaseAsync('aetrace-location-queue.db');
  const db = await databasePromise;
  await db.execAsync('CREATE TABLE IF NOT EXISTS pending_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL, captured_at TEXT NOT NULL, battery INTEGER)');
  return db;
}

async function enqueue(db, location, battery) {
  await db.runAsync('INSERT INTO pending_locations (latitude, longitude, accuracy, captured_at, battery) VALUES (?, ?, ?, ?, ?)', location.coords.latitude, location.coords.longitude, location.coords.accuracy ?? null, new Date(location.timestamp || Date.now()).toISOString(), battery);
  await db.runAsync('DELETE FROM pending_locations WHERE id NOT IN (SELECT id FROM pending_locations ORDER BY id DESC LIMIT ?)', MAX_QUEUED_POINTS);
}

async function postLocation(base, token, location) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/api/device/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy, battery: location.battery, capturedAt: location.capturedAt, deviceModel: location.deviceModel, appVersion: location.appVersion }),
      signal: controller.signal,
    });
    if (response.ok) return;
    const error = new Error(`Location service returned ${response.status}`);
    error.status = response.status;
    throw error;
  } finally { clearTimeout(timeout); }
}

async function stopForAdminAction() {
  try { if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK); } catch { /* OS may already have stopped it. */ }
}

export async function stopManagedLocationUpdates() { await stopForAdminAction(); }

async function flushQueue(db, base, token) {
  const pending = await db.getAllAsync('SELECT id, latitude, longitude, accuracy, captured_at, battery FROM pending_locations ORDER BY id ASC LIMIT 25');
  for (const point of pending) {
    try {
      await postLocation(base, token, { latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy, capturedAt: point.captured_at, battery: point.battery, deviceModel: DEVICE_MODEL, appVersion: APP_VERSION });
      await db.runAsync('DELETE FROM pending_locations WHERE id = ?', point.id);
    } catch (error) {
      if ([401, 423].includes(error.status)) await stopForAdminAction();
      throw error;
    }
  }
}

if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    const base = await SecureStore.getItemAsync(URL_KEY);
    if (!token || !base) return;
    const db = await database();
    const batteryLevel = await Battery.getBatteryLevelAsync().catch(() => -1);
    const battery = batteryLevel >= 0 ? Math.round(batteryLevel * 100) : null;
    try { await flushQueue(db, base, token); }
    catch (flushError) {
      if ([401, 423].includes(flushError.status)) return;
      for (const location of data.locations) await enqueue(db, location, battery);
      return;
    }
    for (const location of data.locations) {
      const point = { latitude: location.coords.latitude, longitude: location.coords.longitude, accuracy: location.coords.accuracy ?? null, capturedAt: new Date(location.timestamp || Date.now()).toISOString(), battery, deviceModel: DEVICE_MODEL, appVersion: APP_VERSION };
      try { await postLocation(base, token, point); }
      catch (sendError) {
        if ([401, 423].includes(sendError.status)) { await stopForAdminAction(); return; }
        await enqueue(db, location, battery);
      }
    }
  });
}

export async function startManagedLocationUpdates(intervalSeconds = 5) {
  const foreground = await Location.getForegroundPermissionsAsync();
  const foregroundPermission = foreground.status === 'granted' ? foreground : await Location.requestForegroundPermissionsAsync();
  if (foregroundPermission.status !== 'granted') return { status: 'permission-needed', detail: 'Allow location access in the phone settings to share this company phone location.' };
  if (!(await TaskManager.isAvailableAsync())) return { status: 'preview-only', detail: 'Foreground tracking is active in Expo Go. Install the managed AE-Trace build for background tracking.' };
  const background = await Location.getBackgroundPermissionsAsync();
  const backgroundPermission = background.status === 'granted' ? background : await Location.requestBackgroundPermissionsAsync();
  if (backgroundPermission.status !== 'granted') return { status: 'foreground-only', detail: 'Background location is not enabled. This phone shares location only while AE-Trace is open.' };
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    distanceInterval: 0,
    timeInterval: Math.max(5000, Math.min(300000, intervalSeconds * 1000)),
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'AE-Trace location sharing is active',
      notificationBody: 'This company phone is sharing its location with the fleet administrator.',
      notificationColor: '#65dcb9',
      killServiceOnDestroy: false,
    },
  });
  return { status: 'active', detail: 'Continuous location sharing is active on this enrolled company phone.' };
}
