# Power Plan – bill cycle dashboard

A phone-friendly summary of the current DHBVN bill cycle: units since the last meter reading, the growing average and 7-day average units per day, how charges are building up, and a projected bill at the next reading. An admin page records each billing date and time and manages who can view.

```
Browser ──► GitHub Pages (this repo: static HTML/JS, public, contains no data)
   │  Google Sign-In → ID token
   ▼
Apps Script web app (apps-script/, runs as you) ── checks the token + Users tab
   │
   ▼
Google Sheets: PZEM_Data (logger, read-only) + PowerPlan_App (Hourly | Bills | Config | Users)
```

The site is public because GitHub Pages always is, so it holds no data. Every request is checked against your Google sign-in, and only emails in the `Users` tab get an answer.

## Try it locally (demo data)

```
python -m http.server 8765
```
Open http://127.0.0.1:8765. While `apiUrl` in `js/config.js` is empty, the app runs on synthetic demo data.

Tests: `npm test`. The tariff engine reproduces all six real DHBVN bills.

## Setup (one time)

### 1. Google OAuth client ID (about 5 min, free)
1. Go to https://console.cloud.google.com, create a project (e.g. "power-plan").
2. **APIs & Services → OAuth consent screen**: External, app name "Power Plan", your email. Add your own email and your family's emails as test users.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorised JavaScript origins: `https://<your-github-username>.github.io` and `http://127.0.0.1:8765`
4. Copy the client ID (`….apps.googleusercontent.com`).

### 2. Backend (Apps Script)
1. Go to https://script.google.com and create a **New project** called "Power Plan".
2. Create one script file for each `.gs` file in `apps-script/` (Config, Summary, Api, ArchiveAndClean) and paste in its contents.
3. **Project Settings → Show "appsscript.json"**, then paste in `apps-script/appsscript.json`.
4. **Project Settings → Script Properties**, add: `ENV` = `prod` (or `uat`), `GOOGLE_CLIENT_ID` (from step 1), `SOURCE_ID` and `INVERTER_ID` (the long ID in each logger sheet's URL). The code holds no IDs, so the same files work in every project and nothing secret reaches the public repo. Run `checkConfig` to confirm.
5. Select `setup` and click **Run**, then approve the permissions with every box ticked. This:
   - creates the `PowerPlan_App` spreadsheet (`PowerPlan_App_UAT` in UAT); you are its admin
   - builds hourly history from the whole logger sheet
   - adds your 7 past DHBVN bill dates
   - starts the update timer (every 15 min in prod, 30 min in UAT)
6. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL ending in `/exec`.
   ("Anyone" only lets the request reach the script. The script still rejects anyone who isn't signed in and listed in Users.)

### 3. Frontend
1. In `js/config.js`, set `clientId` and the `/exec` URL under `BACKENDS.prod` (and `BACKENDS.uat`).
2. Push this repo to GitHub. Then go to **Settings → Pages → Source: GitHub Actions** (`.github/workflows/pages.yml` publishes it).
3. Open `https://<your-github-username>.github.io/power-plan-web/`, sign in, then go to **Admin** and set the last billing date and time.

### 4. Lock down the sheets (after Power BI uses Google sign-in)
Set PZEM_Data and Pzem_Elec_DayData to **Share → General access → Restricted**. The app keeps working, because the script runs as you.

## Prod and UAT

| | Prod | UAT |
|---|---|---|
| Address | `…/power-plan-web/` | `…/power-plan-web/uat/` (orange UAT badge) |
| Branch | `main` | `uat` |
| Apps Script project | "Power Plan" (`ENV=prod`) | "Power Plan UAT" (`ENV=uat`) |
| App sheet | `PowerPlan_App` | `PowerPlan_App_UAT` |

- Every push to `main` or `uat` runs the tests and republishes both (about 1 min). A failing test publishes nothing.
- `js/config.js` is the same on both branches; the page address picks the backend.
- UAT reads the real logger sheets but never writes to them: the archive refuses to run unless `ENV=prod`.
- **Release:** change and test on `uat` → merge `uat` into `main` → tag `vX.Y.Z`. If `.gs` files changed, paste them into the prod project, then **Deploy → Manage deployments → ✏️ → New version**. (Timers run the latest saved code, so prod's `.gs` files change only at release.)
- **Rollback:** website – revert the merge on `main` (or reset to the last tag) and push. Backend – paste the previous `.gs` files back and pick the previous version in Manage deployments.

## Archive (optional, nightly)
`ArchiveAndClean.gs` moves logger rows older than 60 days to monthly CSVs in Drive and deletes zero-load rows. Run `archiveDryRun` first and check the log. Then run `installArchiveTrigger`, but only once Power BI also reads the archive CSVs. The dashboard is not affected, because its history lives in the Hourly tab.

## How the numbers are worked out
- **Units since last bill** = cleaned meter energy now − energy at the billing time. The energy at billing is interpolated between hourly snapshots.
- **Growing average** = units since the bill ÷ days since the bill. **7-day average** = the last 7 complete days.
- **Projected bill** = units at the growing average up to the expected next reading (the date set by admin, or the average gap between past bills), priced with the DHBVN rules:
  - band B if the cycle averages more than 3.33 units/day
  - slab rates per day
  - FPPAS 47 p/unit at 200+ units/month
  - municipal tax 2% of (energy + FPPAS)
  - duty 10 p/unit
- **Cleaning** (same rules as the Power BI model):
  - drops readings where Current = 0 and Power = 0 (load on the inverter)
  - holds small dips in the energy counter
  - carries real counter resets forward

## Files
| Path | What |
|---|---|
| `index.html`, `js/app.js` | Summary page |
| `admin.html`, `js/admin.js` | Admin page (billing, history, viewers) |
| `js/billing.js` | Tariff + projection engine (pure, tested) |
| `js/api.js`, `js/config.js`, `js/mock.js`, `js/ui.js` | Sign-in, API calls, demo data, shared UI |
| `apps-script/*.gs` | Backend, hourly snapshots, archive |
| `tests/billing.test.js` | `npm test` |
