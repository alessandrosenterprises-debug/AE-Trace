# AE-Trace fleet tracker

A Supabase-backed fleet tracking MVP for up to 50 authorized company phones. Supabase Auth handles administrator accounts, Supabase Postgres stores devices and location history, Supabase Realtime pushes dashboard changes, and Vercel can host the Express API and the static dashboard.

## Features

- Admin sign-in through Supabase Auth; admin access is granted only to accounts listed in `public.app_admins`.
- Single-use device enrollment codes that expire after 30 minutes; a 50-device fleet limit is enforced in a Postgres transaction.
- Per-device random bearer credentials. Only a SHA-256 hash is stored in the database.
- Operations dashboard with rider directory, live map, device assignment, location history, alerts, CSV reports, settings, and audit activity.
- Native Expo rider app for secure enrollment, shift-based foreground location sharing, and device battery reporting.
- Audit log, device revocation, row-level security policies, and 90-day location retention.
- A mobile browser enrollment/tracking page.

The Expo Go rider preview shares location only while the app is open. Background tracking needs a native development build and platform-specific permission setup. This is not an EMM/MDM server. For managed company devices, provision Android Device Owner or Apple supervised MDM through your EMM/MDM provider; see the enterprise notes below.

## 1. Create and configure Supabase

1. Create a Supabase project and keep its project URL and API keys private as appropriate.
2. In the Supabase SQL Editor, run the migrations in order: [`supabase/migrations/202609230001_initial.sql`](supabase/migrations/202609230001_initial.sql), [`supabase/migrations/202609240001_operational_riders.sql`](supabase/migrations/202609240001_operational_riders.sql), [`supabase/migrations/202609240002_rider_registration_photos.sql`](supabase/migrations/202609240002_rider_registration_photos.sql), [`supabase/migrations/202609240003_fleet_settings.sql`](supabase/migrations/202609240003_fleet_settings.sql), and [`supabase/migrations/202609240004_bike_tracker_report.sql`](supabase/migrations/202609240004_bike_tracker_report.sql). These add rider records, private photos, saved management settings, and the daily bike-distance report. If you already applied earlier migrations, run only the new migrations you have not yet applied.
3. In **Authentication → Users**, create or invite the administrator using email/password. Confirm the email if the project's settings require it.
4. Add that user's Auth ID to the administrator allowlist in the SQL Editor:

   ```sql
   insert into public.app_admins (user_id)
   select id from auth.users where email = 'admin@example.com'
   on conflict (user_id) do nothing;
   ```

5. Copy `.env.example` to `.env` and fill in the project's URL, publishable/anon key, **service-role secret**, and a MapTiler API key. The service-role secret is server-only. Never put it in browser code or commit `.env`.

## 2. Run locally

In PowerShell:

```powershell
cd D:\aetrace
npm install
Copy-Item .env.example .env
# Edit .env with your Supabase and MapTiler values
npm run dev
```

The dashboard is at `http://127.0.0.1:3000/`; the browser-based fallback is at `http://127.0.0.1:3000/device.html`. To use the native rider app with Expo Go, follow `rider-app/README.md`. Use your deployed HTTPS app URL in the phone app, or an HTTPS tunnel for local development.

## 3. Deploy on Vercel

1. Push this Git repository to a Git host supported by Vercel, then import it into Vercel. The root `server.js` exports the Express app for Vercel Functions. Vercel serves assets from `public/`.
2. In Vercel **Project → Settings → Environment Variables**, add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only; do not mark as exposed to the browser)
   - `MAPTILER_API_KEY` (map display key; restrict it to your local/deployed site origins in MapTiler)
3. Redeploy after setting variables. Add the Vercel production and preview URLs to Supabase Auth's allowed redirect/site URL configuration.
4. Open the deployed site and sign in with the Auth account that is listed in `app_admins`.

The same-origin API uses Supabase service-role access only after it validates the supplied Auth JWT and checks administrator membership. Keep the service-role secret only in Vercel server environment settings and local `.env`. Supabase's publishable/anon key is delivered to the browser; database RLS still limits direct browser reads to authenticated administrators. MapTiler tiles use a browser-visible key, so restrict that key to the app's website origins.

## 4. Use the fleet dashboard

1. Sign in and use **Generate enrollment** on **Devices** to create a one-time code. The generator does not require a rider or device label.
2. Give the code to the authorized rider. In the preconfigured rider app or browser fallback at `/device.html`, the rider enters the code and their full names, store, and phone. AE-Trace creates the rider profile and links the phone automatically.
3. Location starts automatically after device registration. Recent locations are buffered locally during network outages and synced when connectivity returns. The admin dashboard receives device and location changes through Supabase Realtime.
4. Use **Trips & history** to review up to 7 days at a time. **Alerts** flags offline, stale, low-battery, and unenrolled riders. **Reports** exports fleet status to CSV.

Locations older than 90 days are pruned as new location updates arrive. Audit entries remain after device removal. The Bike Tracker Report groups GPS distance by Africa/Lusaka calendar day and the rider's store/site and vehicle/bike-registration fields. Set the site and Bike Reg on each rider profile for accurate report columns. It sums distances between consecutive points with GPS accuracy of 100 m or better and ignores jumps above 180 km/h; totals are estimates and can be lower when GPS samples are missing. The map uses MapTiler's `streets-v4` raster tiles, with MapTiler and OpenStreetMap attribution; add the `MAPTILER_API_KEY` or the dashboard will explain that map tiles are not configured. Obtain a key from [MapTiler Cloud](https://cloud.maptiler.com/) and restrict it to your website origins. The app no longer requests basemap tiles from OpenStreetMap's volunteer tile server. Restrict access to Supabase project settings and database credentials. Review employee notices, company policy, lawful basis, and applicable retention requirements before collecting location data.

## Native rider app preview

See [`rider-app/README.md`](rider-app/README.md) for Expo Go setup. Expo Go supports the foreground preview; it does not provide reliable background location tracking. A development build is required for background location behavior.

## Git and local configuration

The `.gitignore` excludes `.env`, dependencies, and local data. Commit `.env.example`, never the populated `.env` file. After the first dependency install, use `npm ci` for repeatable installs.

## Android and Apple management

This app does not prevent uninstall or silently enroll phones. For Android company-owned phones, provision fully managed / Device Owner status during setup through Android Enterprise and an EMM. A future native Android companion may use allowed `DevicePolicyManager` policies under that management relationship. For Apple devices, use Apple Business Manager and a supervised MDM service; app removal and device policy remain under MDM controls. This MVP is not itself an Android Enterprise or Apple MDM server.

## API endpoints

Admin APIs require `Authorization: Bearer <Supabase access token>` and administrator allowlisting. Phone update APIs use their device-specific bearer token.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health`, `GET /api/config`, `GET /api/me` | Health, public Supabase client settings, current admin |
| `POST /api/logout` | Write logout audit event |
| `POST /api/enrollments`, `POST /api/enroll` | Create code; exchange it on a phone |
| `POST /api/device/location`, `POST /api/device/heartbeat` | Authenticated phone updates |
| `GET /api/devices`, `GET /api/devices/:id/history?hours=24` | Fleet status and location history |
| `DELETE /api/devices/:id`, `GET /api/audit` | Revoke device; read audit log |

## References

- [Vercel: Express on Vercel](https://vercel.com/docs/frameworks/backend/express) explains Express deployment and notes that Vercel serves `public/` assets separately.
- [Supabase: JavaScript `getUser`](https://supabase.com/docs/reference/javascript/auth-getuser) documents server-side validation of an access token.
- [Supabase Auth and RLS](https://supabase.com/docs/guides/auth) describes using Auth tokens with row-level database authorization.


### Rider app registration and preview

The rider app asks for the admin-generated one-time code, full name, store/branch, phone number, and an optional profile photo. Device model, platform, app version, and current battery are collected on enrollment. Set EXPO_PUBLIC_API_URL in the Expo app environment before starting/building the app; the rider does not enter the backend address. For Expo Go on a local network, set HOST=0.0.0.0 in the backend environment and keep the phone and development computer on the same network. Apply all Supabase migrations before using rider self-registration, photos, or saved fleet settings. Admin Settings lets an administrator set the display name, change password, tune offline/battery/stale-location alert thresholds, and set the rider app's location update interval. Rider app interval changes take effect on the next app start.

See [rider-app/README.md](rider-app/README.md) for Expo preview and location-sharing limits.
