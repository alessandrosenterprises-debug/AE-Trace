import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import * as Battery from 'expo-battery';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { startManagedLocationUpdates, stopManagedLocationUpdates } from '../services/backgroundTracking';

const KEYS = { url: 'aetrace.apiUrl', token: 'aetrace.deviceToken', name: 'aetrace.deviceName', id: 'aetrace.deviceId' };
const version = Constants.expoConfig?.version || '1.0.0';
function resolveApiUrl(){const configured=process.env.EXPO_PUBLIC_API_URL||Constants.expoConfig?.extra?.apiBaseUrl||'https://ae-trace.vercel.app';return configured.trim().replace(/\/+$/,'');}

export default function RiderHome() {
  const insets = useSafeAreaInsets();
  const watch = useRef(null);
  const timer = useRef(null);
  const [apiUrl, setApiUrl] = useState(resolveApiUrl);
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [enrolledFullName, setEnrolledFullName] = useState('');
  const [store, setStore] = useState('');
  const [phone, setPhone] = useState('');
  const [photo, setPhoto] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [token, setToken] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [trackingStatus, setTrackingStatus] = useState('starting');
  const [trackingDetail, setTrackingDetail] = useState('Location sharing starts automatically after enrollment.');
  const [busy, setBusy] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [battery, setBattery] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [consent, setConsent] = useState(false);

  const cleanUrl = value => value.trim().replace(/\/+$/, '');
  const request = useCallback(async (path, body, authToken = token, base = apiUrl) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(`${cleanUrl(base)}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) }, body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The AE-Trace server did not respond. Check the phone’s internet connection and try again.');
      throw new Error(`Could not connect to AE-Trace. Check the backend address and network connection. ${error.message || ''}`.trim());
    } finally { clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status})`); error.status = response.status; throw error; }
    return result;
  }, [apiUrl, token]);

  useEffect(() => {
    (async () => {
      try {
        const [savedUrl, savedToken, savedName, savedId] = await Promise.all(Object.values(KEYS).map(key => SecureStore.getItemAsync(key)));
        const serviceUrl=resolveApiUrl();
        setApiUrl(serviceUrl);
        if(savedToken&&savedUrl!==serviceUrl)await SecureStore.setItemAsync(KEYS.url,serviceUrl).catch(()=>{});
        if (savedToken) {
          setToken(savedToken); setDeviceName(savedName || Device.deviceName || Device.modelName || 'Rider phone'); setDeviceId(savedId || '');
          if(serviceUrl){try{const response=await fetch(`${cleanUrl(serviceUrl)}/api/device/profile`,{headers:{Authorization:`Bearer ${savedToken}`}});if(response.ok){const profile=await response.json();if(profile.rider?.avatarUrl)setAvatarUrl(profile.rider.avatarUrl);if(profile.rider?.fullName)setEnrolledFullName(profile.rider.fullName);if(profile.rider?.store)setStore(profile.rider.store);if(profile.rider?.phone)setPhone(profile.rider.phone);}}catch{/* Keep the saved device ready for retry when offline. */}}
        }
        try { const level = await Battery.getBatteryLevelAsync(); if (level >= 0) setBattery(Math.round(level * 100)); } catch { /* battery status may be unavailable */ }
      } finally { setBusy(false); }
    })();
    return () => { watch.current?.remove(); clearInterval(timer.current); };
  }, []);

  const sendLocation = useCallback(async position => {
    const level = await Battery.getBatteryLevelAsync().catch(() => -1);
    const pct = level >= 0 ? Math.round(level * 100) : null;
    if (pct !== null) setBattery(pct);
    await request('/api/device/location', { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, capturedAt: new Date(position.timestamp || Date.now()).toISOString(), battery: pct, deviceModel: Device.modelName || Device.deviceName || 'Unknown', appVersion: version });
    setLastUpdate(new Date()); setMessage('Location sent securely to your fleet.');
  }, [request]);

  const choosePhoto = async () => {
    try {
      const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images'],allowsEditing:true,aspect:[1,1],quality:.82});
      if(result.canceled||!result.assets?.[0]?.uri)return;
      const context=ImageManipulator.manipulate(result.assets[0].uri);context.resize({width:512,height:512});
      const rendered=await context.renderAsync();
      const optimized=await rendered.saveAsync({format:SaveFormat.JPEG,compress:.72,base64:true});
      if(!optimized.base64||optimized.base64.length>1024*1024){setMessage('That photo is too large. Choose a smaller image.');return;}
      setPhoto({uri:optimized.uri,base64:optimized.base64});setMessage('Profile photo ready. It will appear on the fleet map after registration.');
    }catch(error){setMessage(error.message||'Could not load the profile photo.');}
  };

  const savePhoto = async (image=photo,accessToken=token,base=apiUrl) => {
    if(!image?.base64)throw new Error('Choose a profile photo first.');
    const result=await request('/api/device/profile-photo',{photoBase64:image.base64},accessToken,base);
    if(result.avatarUrl)setAvatarUrl(result.avatarUrl);
    return result;
  };

  const uploadPhoto = async (image=photo,accessToken=token,base=apiUrl) => {
    if(!image?.base64)return;
    try{await savePhoto(image,accessToken,base);setPhoto(null);setMessage('Profile photo updated and visible on the fleet map.');}
    catch(error){setMessage(`Phone enrolled, but photo upload failed: ${error.message}`);}
  };

  useEffect(() => {
    if (!token || !apiUrl || busy) return undefined;
    let active = true;
    (async () => {
      try {
        let intervalSeconds=15;
        try { const config=await fetch(`${cleanUrl(apiUrl)}/api/device/settings`,{headers:{Authorization:`Bearer ${token}`}});if(config.ok){const policy=await config.json();if(Number.isInteger(policy.locationIntervalSeconds))intervalSeconds=Math.max(15,Math.min(300,policy.locationIntervalSeconds));} } catch { /* Continue with the safe 15-second default when policy is unavailable. */ }
        const result = await startManagedLocationUpdates(intervalSeconds);
        if (!active) return;
        setTrackingStatus(result.status);
        setTrackingDetail(result.detail);
        if (result.status === 'permission-needed') return;
        const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        await sendLocation(current);
        if (result.status !== 'active') {
          watch.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: intervalSeconds * 1000 }, position => { if (active) sendLocation(position).catch(error => { if ([401, 423].includes(error.status)) { watch.current?.remove(); watch.current = null; stopManagedLocationUpdates(); setTrackingStatus('admin-managed'); setTrackingDetail('Your fleet administrator has disabled tracking for this device.'); } setMessage(error.message); }); });
        }
        timer.current = setInterval(async () => {
          try { const level = await Battery.getBatteryLevelAsync().catch(() => -1); await request('/api/device/heartbeat', { battery: level >= 0 ? Math.round(level * 100) : null, deviceModel: Device.modelName || Device.deviceName || 'Unknown', appVersion: version }); }
          catch (error) { if ([401, 423].includes(error.status)) { watch.current?.remove(); watch.current = null; stopManagedLocationUpdates(); setTrackingStatus('admin-managed'); setTrackingDetail('Your fleet administrator has disabled tracking for this device.'); } setMessage(error.message); }
        }, 45000);
      } catch (error) {
        if (active) { setTrackingStatus('error'); setTrackingDetail('Automatic location sharing could not start. Contact your fleet administrator.'); setMessage(error.message || 'Could not start location sharing.'); }
      }
    })();
    return () => { active = false; watch.current?.remove(); watch.current = null; clearInterval(timer.current); };
  }, [apiUrl, busy, request, sendLocation, token]);

  const enroll = async () => {
    const base = cleanUrl(apiUrl);
    if (!base) { setMessage('AE-Trace is not configured for this preview. Ask your administrator to set up the rider app connection.'); return; }
    if (code.trim().length < 6) { setMessage('Enter the one-time code from your administrator.'); return; }
    if (!fullName.trim() || !store.trim() || !phone.trim()) { setMessage('Enter your full name, store and phone number.'); return; }
    if (!consent) { setMessage('Please acknowledge automatic location sharing on this enrolled company phone.'); return; }
    setWorking(true); setMessage('');
    try {
      const model=Device.modelName||Device.deviceName||'Unknown device';
      const level=await Battery.getBatteryLevelAsync().catch(()=>-1);
      const result = await request('/api/enroll', { code: code.trim().toUpperCase(), fullName:fullName.trim(), store:store.trim(), phone:phone.trim(), name:Device.deviceName||model, platform:Platform.OS, deviceModel:model, appVersion:version, battery:level>=0?Math.round(level*100):null }, '', base);
      await Promise.all([SecureStore.setItemAsync(KEYS.url, base), SecureStore.setItemAsync(KEYS.token, result.deviceToken), SecureStore.setItemAsync(KEYS.name, result.name), SecureStore.setItemAsync(KEYS.id, result.deviceId)]);
      setApiUrl(base); setToken(result.deviceToken); setDeviceName(result.name); setDeviceId(result.deviceId);setEnrolledFullName(fullName.trim());setMessage('This company phone is enrolled. Location sharing is starting automatically.');
      if(photo?.base64)await uploadPhoto(photo,result.deviceToken,base);
    } catch (error) { setMessage(error.message); } finally { setWorking(false); }
  };

  if (busy) return <View style={s.loading}><ActivityIndicator color="#66dfbd" /></View>;
  const trackingActive=['active','preview-only','foreground-only'].includes(trackingStatus);
  return <ScrollView style={s.screen} contentContainerStyle={[s.container, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 34 }]} keyboardShouldPersistTaps="handled">
    <View style={s.brandRow}><Image source={require('../../assets/ae-trace-logo.png')} style={s.brandLogo} accessibilityLabel="AE-Trace logo" /><View><Text style={s.brand}>AE-Trace</Text><Text style={s.brandSub}>RIDER APP</Text></View><View style={s.secure}><View style={s.secureDot} /><Text style={s.secureText}>SECURE</Text></View></View>
    <View style={s.hero}><Text style={s.eyebrow}>COMPANY DEVICE MANAGEMENT</Text><Text style={s.title}>{token ? 'Managed and connected.' : 'Welcome to your fleet.'}</Text><Text style={s.subtitle}>{token?'This enrolled company phone shares its location automatically while location permission and device connectivity are available.':'Register this company phone using the one-time code from your fleet administrator.'}</Text></View>
    {token ? <>
      <View style={s.card}><View style={s.cardHead}><View><Text style={s.cardEyebrow}>DEVICE STATUS</Text><Text style={s.cardTitle}>{enrolledFullName||deviceName}</Text><Text style={s.profileStore}>{store}</Text></View><View style={[s.statusPill, trackingActive ? s.statusOn : s.statusOff]}><View style={[s.statusDot, trackingActive && s.statusDotOn]} /><Text style={trackingActive ? s.statusOnText : s.statusOffText}>{trackingStatus==='active'?'ALWAYS ON':trackingStatus==='preview-only'?'FOREGROUND PREVIEW':trackingStatus==='foreground-only'?'FOREGROUND ONLY':trackingStatus==='permission-needed'?'PERMISSION NEEDED':'STARTING'}</Text></View></View>
        <View style={s.profilePhotoRow}><View style={s.profilePhoto}>{avatarUrl?<Image source={{uri:avatarUrl}} style={s.profilePhotoImage}/>:<Text style={s.profileInitial}>{(enrolledFullName||'R').slice(0,1).toUpperCase()}</Text>}</View><View style={{flex:1}}><Text style={s.photoTitle}>Rider profile</Text><Text style={s.photoHint}>{enrolledFullName} · {store}</Text></View></View>
        <Text accessibilityLiveRegion="polite" style={s.trackingHint}>{trackingDetail}</Text>
        <View style={s.divider} /><View style={s.infoRow}><Text style={s.infoLabel}>Device</Text><Text style={s.infoValue}>{Device.modelName || Device.deviceName || Platform.OS}</Text></View><View style={s.infoRow}><Text style={s.infoLabel}>Battery</Text><Text style={s.infoValue}>{battery == null ? 'Unavailable' : `${battery}%`}</Text></View><View style={s.infoRow}><Text style={s.infoLabel}>Last update</Text><Text style={s.infoValue}>{lastUpdate ? lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Waiting for location'}</Text></View>
        <Text style={s.deviceRef}>DEVICE ID · {deviceId.slice(0, 8).toUpperCase()}</Text>
        </View>
      <View style={s.privacy}><Text style={s.privacyIcon}>i</Text><Text style={s.privacyText}>This company device shares location automatically while enrolled. Location is queued securely during network outages and sent when connectivity returns. Your administrator manages tracking and device access. The operating system may display a persistent location indicator or notification.</Text></View>
    </> : <View style={s.card}><Text style={s.cardEyebrow}>RIDER REGISTRATION</Text><Text style={s.cardTitle}>Enter your details</Text><Text style={s.formHelp}>Ask your fleet administrator for your one-time registration code. Your phone details are collected automatically when you register.</Text>
      <Text style={s.label}>ONE-TIME CODE</Text><TextInput style={[s.input, s.codeInput]} value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="ENTER ADMIN CODE" placeholderTextColor="#65748b" />
      <Text style={s.label}>FULL NAMES</Text><TextInput style={s.input} value={fullName} onChangeText={setFullName} autoCapitalize="words" autoComplete="name" placeholder="Your full names" placeholderTextColor="#65748b" />
      <Text style={s.label}>STORE YOU OPERATE FROM</Text><TextInput style={s.input} value={store} onChangeText={setStore} autoCapitalize="words" placeholder="Store or branch" placeholderTextColor="#65748b" />
      <Text style={s.label}>PHONE</Text><TextInput style={s.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="Your phone number" placeholderTextColor="#65748b" />
      <Pressable style={s.profilePhotoRow} onPress={choosePhoto}><View style={s.profilePhoto}>{photo?.uri?<Image source={{uri:photo.uri}} style={s.profilePhotoImage}/>:<Text style={s.profileInitial}>{(fullName||'R').slice(0,1).toUpperCase()}</Text>}</View><View style={{flex:1}}><Text style={s.photoTitle}>{photo?'Photo selected':'Add a profile photo'}</Text><Text style={s.photoHint}>A small rider image will appear on the tracking map</Text></View><Text style={s.choosePhotoText}>Choose</Text></Pressable>
      <Pressable style={s.consentRow} onPress={() => setConsent(!consent)}><View style={[s.checkbox, consent && s.checkboxOn]}>{consent && <Text style={s.checkmark}>✓</Text>}</View><Text style={s.consentText}>I understand this company phone shares location automatically after registration, including when AE-Trace is in the background, subject to phone permissions and network access.</Text></Pressable>
      <Pressable style={[s.primary, working && s.disabled]} onPress={enroll} disabled={working}>{working ? <ActivityIndicator color="#071b16" /> : <Text style={s.primaryText}>Enroll this phone</Text>}</Pressable>
    </View>}
    {!!message && <Text accessibilityLiveRegion="polite" style={s.message}>{message}</Text>}
    <View style={s.footer}><Text style={s.footerBrand}>AE-TRACE FLEET OPERATIONS</Text><Text style={s.footerText}>Your fleet&apos;s location services are managed by your organization.</Text><Text style={s.version}>VERSION {version}</Text></View>
  </ScrollView>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#08111f' }, container: { paddingHorizontal: 22, maxWidth: 560, width: '100%', alignSelf: 'center' }, loading: { flex: 1, backgroundColor: '#08111f', alignItems: 'center', justifyContent: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11 }, brandLogo: { width: 42, height: 42 }, brand: { color: '#eef4fb', fontWeight: '800', fontSize: 18 }, brandSub: { color: '#8292a9', fontSize: 9, fontWeight: '700', letterSpacing: 2, marginTop: 2 }, secure: { marginLeft: 'auto', borderWidth: 1, borderColor: '#294052', borderRadius: 20, flexDirection: 'row', gap: 7, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 7 }, secureDot: { width: 6, height: 6, borderRadius: 5, backgroundColor: '#71e6c5' }, secureText: { color: '#8ea3b9', fontSize: 9, letterSpacing: 1.2, fontWeight: '700' },
  hero: { marginTop: 36, marginBottom: 23 }, eyebrow: { color: '#72dabc', fontSize: 10, fontWeight: '800', letterSpacing: 1.8 }, title: { color: '#f2f6fb', fontSize: 30, lineHeight: 36, fontWeight: '800', marginTop: 9 }, subtitle: { color: '#9aa9bd', fontSize: 14, lineHeight: 21, marginTop: 9 }, card: { backgroundColor: '#111e30', borderColor: '#263850', borderWidth: 1, borderRadius: 19, padding: 21, shadowColor: '#000', shadowOpacity: .18, shadowRadius: 20, elevation: 5 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 9 }, cardEyebrow: { color: '#8496ad', fontWeight: '800', fontSize: 9, letterSpacing: 1.4 }, cardTitle: { color: '#f0f5fc', fontWeight: '700', fontSize: 20, marginTop: 7 }, profileStore: { color: '#8c9cb2', fontSize: 12, marginTop: 4 },
  profilePhotoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 17, padding: 11, backgroundColor: '#0c1828', borderRadius: 13, borderWidth: 1, borderColor: '#263850' }, profilePhoto: { width: 48, height: 48, borderRadius: 24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#20354a' }, profilePhotoImage: { width: '100%', height: '100%' }, profileInitial: { color: '#78e3c2', fontWeight: '800', fontSize: 18 }, photoTitle: { color: '#e8f0f8', fontWeight: '700', fontSize: 12 }, photoHint: { color: '#8798ad', fontSize: 10, lineHeight: 14, marginTop: 3 }, choosePhotoText: { color: '#75dec0', fontSize: 11, fontWeight: '700' }, photoUpload: { paddingVertical: 11, alignItems: 'center' }, photoUploadText: { color: '#83e5c6', fontWeight: '700', fontSize: 12 }, trackingHint: { color: '#8c9cb2', fontSize: 11, lineHeight: 17, marginTop: 14 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 9 }, statusOn: { backgroundColor: '#153b33' }, statusOff: { backgroundColor: '#273246' }, statusDot: { width: 6, height: 6, borderRadius: 5, backgroundColor: '#8a98aa' }, statusDotOn: { backgroundColor: '#70e2c1' }, statusOnText: { color: '#8be7ca', fontSize: 9, fontWeight: '800', letterSpacing: .7 }, statusOffText: { color: '#b1bdcb', fontSize: 9, fontWeight: '800', letterSpacing: .7 }, divider: { height: 1, backgroundColor: '#26364c', marginVertical: 17 }, infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9 }, infoLabel: { color: '#92a2b7', fontSize: 12 }, infoValue: { color: '#dce6f2', fontSize: 12, fontWeight: '600' }, shareRow: { marginTop: 12, paddingTop: 17, borderTopWidth: 1, borderTopColor: '#26364c', flexDirection: 'row', alignItems: 'center' }, shareTitle: { color: '#f0f5fb', fontSize: 14, fontWeight: '700' }, shareHint: { color: '#8b9bb0', fontSize: 11, marginTop: 4 }, primary: { backgroundColor: '#6ce0bd', borderRadius: 11, minHeight: 49, alignItems: 'center', justifyContent: 'center', marginTop: 18 }, primaryText: { color: '#08221a', fontSize: 14, fontWeight: '800' }, stopButton: { backgroundColor: '#2b3546', borderRadius: 11, minHeight: 47, alignItems: 'center', justifyContent: 'center', marginTop: 17, borderWidth: 1, borderColor: '#43516a' }, stopText: { color: '#e0e7f0', fontWeight: '700', fontSize: 13 }, deviceRef: { textAlign: 'center', color: '#63748c', fontSize: 9, letterSpacing: 1.1, marginTop: 18 },
  privacy: { backgroundColor: '#0d1928', borderWidth: 1, borderColor: '#1d3045', padding: 14, borderRadius: 12, flexDirection: 'row', gap: 10, marginTop: 15 }, privacyIcon: { color: '#77d9ba', borderWidth: 1, borderColor: '#477c71', width: 18, height: 18, textAlign: 'center', borderRadius: 9, overflow: 'hidden', fontWeight: '700', fontSize: 11 }, privacyText: { color: '#8c9cb2', fontSize: 11, lineHeight: 17, flex: 1 }, textButton: { alignSelf: 'center', padding: 15 }, textButtonText: { color: '#8999af', fontSize: 12, textDecorationLine: 'underline' }, formHelp: { color: '#91a2b7', fontSize: 12, lineHeight: 18, marginTop: 7, marginBottom: 14 }, label: { color: '#a9b8ca', fontSize: 9, fontWeight: '800', letterSpacing: 1.1, marginTop: 14, marginBottom: 7 }, input: { minHeight: 48, borderWidth: 1, borderColor: '#34465e', borderRadius: 9, paddingHorizontal: 13, color: '#eff5fc', backgroundColor: '#0a1525', fontSize: 14 }, codeInput: { letterSpacing: 2, fontWeight: '700' }, consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 18 }, checkbox: { width: 20, height: 20, borderWidth: 1, borderColor: '#51627a', borderRadius: 5, alignItems: 'center', justifyContent: 'center' }, checkboxOn: { backgroundColor: '#65dcb9', borderColor: '#65dcb9' }, checkmark: { color: '#08221a', fontSize: 13, fontWeight: '800' }, consentText: { color: '#9baabd', flex: 1, fontSize: 11, lineHeight: 16 }, disabled: { opacity: .65 }, message: { color: '#d1dfed', fontSize: 12, lineHeight: 18, marginTop: 13, textAlign: 'center' }, footer: { alignItems: 'center', marginTop: 30 }, footerBrand: { color: '#74859b', fontSize: 9, letterSpacing: 1.5, fontWeight: '700' }, footerText: { color: '#65768b', fontSize: 10, textAlign: 'center', marginTop: 7 }, version: { color: '#52637b', fontSize: 9, letterSpacing: 1, marginTop: 12 }
});
