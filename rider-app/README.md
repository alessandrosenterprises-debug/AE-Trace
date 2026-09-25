# AE-Trace Rider (Expo Go preview)

This native app enrolls authorized company phones with a one-time admin code and automatically shares location after registration. Device credentials are stored in the platform secure store. Location points are buffered locally during network outages and uploaded with their capture times when connectivity returns. The app reports location, battery, model, and app version to the AE-Trace backend.

## Start the preview

1. Install [Expo Go](https://expo.dev/go) on an Android or iPhone.
2. From PowerShell, run:

   ```powershell
   cd D:\aetrace\rider-app
   npm install
   Copy-Item .env.example .env
   npx expo start -c
   ```

3. Scan the QR code with Expo Go on Android. On iPhone, use the Camera app to open the link in Expo Go.
4. In AE-Trace admin, choose **Generate one-time code**. The admin generator only creates a code; it does not ask for a rider or device label. Codes are single use and expire after 30 minutes.
5. The rider preview and installed builds use the deployed `https://ae-trace.vercel.app` backend. The app does not infer an API address from the development computer, and it replaces an older saved local address at startup. Riders never enter a server address.
6. The rider enters the one-time code, full names, store/branch, and phone number. Submitting the code creates their rider profile and registers the phone automatically. The app collects the phone model, OS, AE-Trace version and battery level. The rider can optionally pick a square profile image; it is resized and uploaded to private storage, then a short-lived image URL is shown beside their name on the fleet map. The rider acknowledges the location notice and grants the operating system's location permissions. Tracking begins automatically after enrollment; there are no in-app pause, stop, or remove controls.

The checked-in Expo build profiles set `EXPO_PUBLIC_API_URL` to the deployed Vercel URL. To test against a development server intentionally, set `EXPO_PUBLIC_API_URL` explicitly in your local `.env`; never use an Expo host address as the production API.

After changing `.env`, restart Expo with its cache cleared:

```powershell
npx expo start -c
```

Apply all SQL files in `D:\aetrace\supabase\migrations` to the Supabase project before enrollment. The rider photo migration creates a private `rider-photos` bucket. Admin map photo URLs are signed and expire periodically; refreshing fleet data obtains a current URL.

## Location behavior and company management

Expo Go supports foreground preview only. Always-on background updates require a development/production native build because Expo Go does not provide background execution for location tasks. Android shows an ongoing AE-Trace foreground-service notification; iOS can show its system location indicator. Location collection remains visible and depends on system permissions. If a rider is offline, up to 2,000 recent points are held in the app's private local database and sent when the connection returns.

Background location continues when the app is minimized, but mobile operating systems can stop an app that a user force-quits or terminates; Android vendors may also apply battery restrictions. Do not claim uninterrupted tracking from Expo Go. To control installation, app removal, app permissions, and kiosk access on company phones, enroll them with Android Enterprise as fully managed/Device Owner or with Apple Business Manager and a supervised MDM. AE-Trace itself does not hide tracking, suppress OS indicators, or bypass operating-system security. An administrator can pause a rider or revoke a device from the dashboard; the app responds to that server-side action.

## Revoke an enrolled phone

Use **Devices → Revoke** in the admin dashboard to invalidate the phone's device token and remove its saved location history. **Remove this phone from the app** only clears its local credential; an administrator should revoke the device record too.
