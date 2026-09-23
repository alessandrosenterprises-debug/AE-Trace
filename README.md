# Aetrace fleet tracker

A Supabase-backed fleet tracking MVP for up to 50 authorized company phones. Supabase Auth handles administrator accounts, Supabase Postgres stores devices and location history, Supabase Realtime pushes dashboard changes, and Vercel can host the Express API and the static dashboard.

## Features

- Admin sign-in through Supabase Auth; admin access is granted only to accounts listed in `public.app_admins`.
- Single-use device enrollment codes that expire after 30 minutes; a 50-device fleet limit is enforced in a Postgres transaction.
- Per-device random bearer credentials. Only a SHA-256 hash is stored in the database.
- Live map, online/offline status, battery level when the phone browser provides it, and location history.
- Audit log, device revocation, row-level security policies, and 90-day location retention.
- A mobile browser enrollment/tracking page.

The phone tracker shares location only while its page is active. Browsers may pause it when backgrounded or locked. This is not an EMM/MDM server or a native background app. For managed company devices, provision Android Device Owner or Apple supervised MDM through your EMM/MDM provider; see the enterprise notes below.

## 1. Create and configure Supabase

1. Create a Supabase project and keep its project URL and API keys private as appropriate.
2. In the Supabase SQL Editor, run [`supabase/migrations/202609230001_initial.sql`](supabase/migrations/202609230001_initial.sql) once.
3. In **Authentication → Users**, create or invite the administrator using email/password. Confirm the email if the project's settings require it.
4. Add that user's Auth ID to the administrator allowlist in the SQL Editor:

   ```sql
   insert into public.app_admins (user_id)
   select id from auth.users where email = 'admin@example.com'
   on conflict (user_id) do nothing;
   ```

5. Copy `.env.example` to `.env` and fill in the project's URL, publishable/anon key, and **service-role secret**. The service-role secret is server-only. Never put it in browser code or commit `.env`.

## 2. Run locally

In PowerShell:

```powershell
cd D:\aetrace
npm install
Copy-Item .env.example .env
# Edit .env with the three Supabase values
npm run dev
```

The dashboard is at `http://127.0.0.1:3000/`; the phone page is at `http://127.0.0.1:3000/device.html`. `npm run dev` now works without an `.env` file too, but API calls will report that Supabase needs configuration. To use a phone on the LAN, set `HOST=0.0.0.0`; geolocation on a phone requires HTTPS, so use a temporary HTTPS tunnel or a deployed Vercel preview rather than plain LAN HTTP.

## 3. Deploy on Vercel

1. Push this Git repository to a Git host supported by Vercel, then import it into Vercel. The root `server.js` exports the Express app for Vercel Functions. Vercel serves assets from `public/`.
2. In Vercel **Project → Settings → Environment Variables**, add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only; do not mark as exposed to the browser)
3. Redeploy after setting variables. Add the Vercel production and preview URLs to Supabase Auth's allowed redirect/site URL configuration.
4. Open the deployed site and sign in with the Auth account that is listed in `app_admins`.

The same-origin API uses Supabase service-role access only after it validates the supplied Auth JWT and checks administrator membership. Keep the service-role secret only in Vercel server environment settings and local `.env`. Supabase's publishable/anon key is delivered to the browser; database RLS still limits direct browser reads to authenticated administrators.

## 4. Use the fleet dashboard

1. Sign in, choose **Enroll a device**, and create a labeled one-use enrollment code.
2. Send the code to the authorized device user. On the phone, open the HTTPS `/device.html` link, enter the code, and grant location permission.
3. Leave the tracking page active for location updates. The dashboard receives device and location changes through Supabase Realtime.
4. Use **History** to review up to 7 days at a time. Remove a device to revoke its credential and delete its location points.

Locations older than 90 days are pruned as new location updates arrive. Audit entries remain after device removal. Restrict access to Supabase project settings and database credentials. Review employee notices, company policy, lawful basis, and applicable retention requirements before collecting location data.

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
