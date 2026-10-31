# BMYF Database 

React app (`client/`) + Express/MongoDB API (`api/`).

## Run locally
1. Install everything once: `npm run setup` (installs the API and the client).
2. Open `.env` and make sure `MONGODB_URI` is your MongoDB address.
3. Start BOTH the API and the website with one command: `npm run dev`. Wait until you see `OK MongoDB connected` and `OK BMYF API running on http://localhost:5000`, then open http://localhost:5173.

## Logins
The home page has three sign-ins: Group Leader, Attendance Officer and Admin. Each account only works on its own login page.
