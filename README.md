# UK Bus Tracker

Live map of buses across the UK. Positions come from [bustimes.org](https://bustimes.org/data), which aggregates the Bus Open Data Service (England), TfL, the Welsh Bus Data Service, Stagecoach and other feeds.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually http://localhost:5173). Zoom into a town or city to load vehicles.

To open it on a phone or another computer on the same Wi‑Fi, use the **Network** URL Vite prints (for example `http://192.168.x.x:5173`). If Windows Firewall asks, allow Node.js on private networks.

Search accepts a UK postcode or place name.

## Deploy 24/7 (Railway)

The app needs a Node server (not static hosting) because of the `/api` proxies.

1. Push this repo to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. In **Variables**, add:
   - `BODS_API_KEY` — your BODS key
   - `VITE_DONATE_URL` — `https://paypal.me/OwenJay450` (must be set before/at build time)
4. Deploy. Railway will run `npm ci && npm run build`, then `npm start`.
5. Open **Settings → Networking → Generate Domain** for a public URL.

Alternative: [Render](https://render.com) with the included `render.yaml` (New → Blueprint).

### Production locally

```bash
npm run serve
```

Serves the built site on http://localhost:4173 (or `$PORT`).

## Donations

Set your payment link in `.env` (local) or host env vars (Railway/Render):

```bash
VITE_DONATE_URL=https://paypal.me/OwenJay450
```

Ko-fi / Stripe Payment Links work too. Restart after changing it. The map shows a donate box with £3 / £5 / £10 shortcuts (PayPal.me amounts) plus a main Donate button.
