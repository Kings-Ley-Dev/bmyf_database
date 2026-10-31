# BMYF Database

React app (`client/`) + Express/MongoDB API (`api/`). Needs Node 22 (the version Vercel is set to use).

## Run locally
1. Install everything once: `npm run setup` (installs the API and the client).
2. Open `.env` and make sure `MONGODB_URI` is your MongoDB address.
3. Start BOTH the API and the website with one command: `npm run dev`. Wait until you see `OK MongoDB connected` and `OK BMYF API running on http://localhost:5000`, then open http://localhost:5173.

### Troubleshooting
- **`http proxy error ... ECONNREFUSED` in the client window:** the API is not running. Start it with `npm run dev` in the project folder (not only in `client`).
- **`X MongoDB connection failed`:** check `MONGODB_URI`. With MongoDB Atlas, add your IP address under Network Access (or allow 0.0.0.0/0 while testing) and check the database user's password.
- **Port 5000 already in use:** set `PORT=5001` in `.env` and change the proxy target in `client/vite.config.js` to match.

## Super Admin
There is no seeded account and the sign-up page is not linked anywhere on the site. Two private pages, whose URLs are set in `client/.env`:
- **Sign up (one time):** `VITE_SUPER_ADMIN_SIGNUP_PATH` (default http://localhost:5173/bmyfsuperadminsignup). Open it, enter your name, email and password.
  It works only until a Super Admin exists, then it shows "Already set up". To also require a secret key, set `SUPER_ADMIN_SETUP_KEY` in `.env`
  (strongly recommended once the site is online, so nobody else can claim the account before you).
- **Sign in:** `VITE_SUPER_ADMIN_PATH` (currently the value in your `client/.env`).
Sign in there, then use Administration > Staff to create Admins, Group Leaders and Attendance Officers. Restart the client after changing these paths.

## Logins
The home page has three sign-ins: Group Leader, Attendance Officer and Admin. Each account only works on its own login page.

## Executive Body photos
Put photos in `client/public/executives/` named `01.jpg` to `10.jpg` (in card order). Until a photo exists, a placeholder is shown.
Edit names and positions in `client/src/App.jsx` (the `EXEC` list).

## Deploy: GitHub, then Vercel, then your own domain
**Before the first push.** `.env` and `client/.env` are in `.gitignore` and are not in this package. Never commit them. If a `.env` was ever pushed to GitHub, change the MongoDB password and `JWT_SECRET` straight away.

1. **MongoDB Atlas.** Network Access > Add IP Address > *Allow access from anywhere* (`0.0.0.0/0`). Vercel has no fixed IP, so this is required. Keep the database user's password strong.
2. **GitHub.** Create an empty private repository, upload/push the contents of this folder (the folder that holds `package.json` and `vercel.json` must be the repository root).
3. **Vercel.** Add New > Project > import the repository. Leave the framework as *Other*; `vercel.json` already sets the build and output. Before pressing Deploy, open *Environment Variables* and add (Production):

| Name | Value |
|---|---|
| `MONGODB_URI` | your Atlas connection string, ending with a database name such as `/bmyf` |
| `JWT_SECRET` | a long random text (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `CLIENT_URL` | the live address with no trailing slash, e.g. `https://yourdomain.com` (use the `https://xxx.vercel.app` address first if you like, then change it) |
| `SUPER_ADMIN_SETUP_KEY` | a secret key; the one-time Super Admin sign-up form will ask for it |
| `VITE_SUPER_ADMIN_PATH` | your private Super Admin sign-in path, starting with `/` (copy it from your local `client/.env`) |
| `VITE_SUPER_ADMIN_SIGNUP_PATH` | your private one-time sign-up path, starting with `/` |
| `APP_TIMEZONE` | `Africa/Accra` (optional, this is the default) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional, for emailing temporary passwords and reset links |

   The two `VITE_` values are built into the website, so set them **before** the first deploy and redeploy after any change. If they are missing, the guessable defaults are used.
4. **Deploy**, then open `https://<your-address>/api/health`. You should see `{"success":true,"ok":true,...}`. If the home page loads but sign-in says the database cannot be reached, recheck `MONGODB_URI` and the Atlas Network Access step.
5. **Create the Super Admin (once).** Open your private sign-up path, enter your details and the `SUPER_ADMIN_SETUP_KEY`. After that it shows "Already set up". Sign in on your private sign-in path and create the other staff from Administration > Staff.
6. **Your own domain.** Vercel > Project > Settings > Domains > add the domain and set the DNS records Vercel shows you. Then set `CLIENT_URL` to `https://yourdomain.com` and redeploy so password-reset links and CORS use the real address. Sign-in cookies are Secure and need `https`, which Vercel provides.

Notes: the chat refreshes by polling because Vercel has no websockets. The login and message rate limits are kept per server instance, which is fine for a church-sized site. Every push to the main branch redeploys automatically.

## Email (optional)
Set the SMTP_* variables (see `.env.example`) to email password resets, new-staff logins and contact-form messages.
Without them, reset links are logged and admins see temporary passwords on screen. The Contact page, the "Website enquiries" tab and the `/api/contact` endpoint are commented out for now. To bring them back, uncomment the contact block in `api/index.js`, the Contact page/route/nav link and Enquiries tab in `client/src/App.jsx`, and the contact test in `test/smoke.js`.

## Birthdays, follow-ups and staff chat
- **Birthdays.** The dashboard box lists only the rest of the current month; a birthday disappears the day after. The red number on the Birthdays menu counts birthdays still to come in the current Sunday-to-Saturday week (today included). It goes down as each birthday passes, resets on Sunday, and disappears when none are left. On the Birthdays page, anyone celebrating today is highlighted with a "Birthday today" flag, every member on their own day. "Today" follows `APP_TIMEZONE` (default `Africa/Accra`).
- **Follow-ups.** The red Follow Ups number = members to check on + Pending + In Progress follow-ups. Setting a follow-up to Completed removes it from the number and from "Members to Check On" and counts it only as Completed. A member is flagged again only after 3 new consecutive absences after that follow-up. Group Leaders see and edit follow-ups for their own group only.
- **Messages.** Staff chat for Super Admin, Admin, Group Leaders and Attendance Officers: one-to-one conversations plus an "All staff" channel, unread badge on the menu, delete your own messages. It refreshes every few seconds (no websockets, so it works on Vercel). The "Website enquiries" tab is commented out together with the Contact page (see below).

## Deleting staff
Only the Super Admin sees a Delete button on the Staff page (Admins, Group Leaders and Attendance Officers). It removes the account for good: they are signed out and cannot sign in again, their one-to-one chats are removed, and follow-ups assigned to them become Unassigned. You cannot delete yourself or a Super Admin, and the deletion is recorded in the audit log. To stop someone's access but keep the account, set it to inactive instead.

## Testing
Use a TEST database. Start the API against it, then run `npm test` (the first run creates a test Super Admin, admin@test.local / TestPass123!, through the sign-up endpoint).
For the screens: `cd client && npm test` (set `API_ORIGIN` if the API is not on :5000). The login limit is 10 attempts per 15 minutes; set `LOGIN_RATE_LIMIT` higher when running the API tests. The contact form (when restored) allows 5 messages per 15 minutes; set `CONTACT_RATE_LIMIT` higher when re-running tests.
