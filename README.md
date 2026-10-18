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
2. Create one script file for each `.gs` file in `apps-script/` (Config, Engine, Summary, Monitor, Api, ArchiveAndClean) and paste in its contents. `Engine.gs` is generated from `js/billing.js` + `js/quality.js` (`node scripts/build-gs.mjs`); never edit it by hand.
3. **Project Settings → Show "appsscript.json"**, then paste in `apps-script/appsscript.json`.
4. **Project Settings → Script Properties**, add: `ENV` = `prod` (or `uat`), `GOOGLE_CLIENT_ID` (from step 1), `SOURCE_ID` and `INVERTER_ID` (the long ID in each logger sheet's URL). The code holds no IDs, so the same files work in every project and nothing secret reaches the public repo. Run `checkConfig` to confirm.
5. Select `setup` and click **Run**, then approve the permissions with every box ticked. This:
   - creates the `PowerPlan_App` spreadsheet (`PowerPlan_App_UAT` in UAT); you are its admin
   - builds hourly history from the whole logger sheet
   - adds your 7 past DHBVN bill dates
   - starts the update timer (every 15 min in prod, 30 min in UAT) and the hourly health check
6. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL ending in `/exec`.
   ("Anyone" only lets the request reach the script. The script still rejects anyone who isn't signed in and listed in Users.)

7. Optional – alerts on Telegram (the same chat the ESP uses): **Admin → Telegram**, enter the bot token and chat ID, Save, then **Send test**. The token is checked with Telegram and never shown again. Without it, alerts are only listed on the Admin page.
8. After every code update run `phase0Check`: it adds any new tabs/columns, makes sure the timers exist, checks the server engine against the 6 DHBVN bills and logs the current cycle.

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

## Deploy without copy-paste (clasp)
`npm run deploy:uat` runs the tests, pushes `apps-script/` to the UAT project, creates a version and moves the existing web-app deployment to it (same `/exec` URL). `npm run deploy:prod -- --promote` does the same for prod and refuses without `--promote`.

One-time setup:
1. Switch on **Google Apps Script API** at https://script.google.com/home/usersettings.
2. `npm install`, then `npx clasp login` (browser sign-in; the token is stored in your user folder, not in this repo).
3. Create the local files (git-ignored, never committed):
   - `.clasp.uat.json` / `.clasp.prod.json`: `{"scriptId": "<Project Settings → Script ID>", "rootDir": "apps-script"}`
   - `deploy-targets.json`: `{"uat": {"deploymentId": "AKfy…"}, "prod": {"deploymentId": "AKfy…"}}` (the id inside each `/exec` URL)

`phase0Check` (and any other editor function) is still run from the Apps Script editor.

## Archive (optional, nightly)
`ArchiveAndClean.gs` moves logger rows older than 60 days to monthly CSVs in Drive and deletes zero-load rows. Run `archiveDryRun` first and check the log. Then run `installArchiveTrigger`, but only once Power BI also reads the archive CSVs. The dashboard is not affected, because its history lives in the Hourly tab.

## Pages and who sees them
| Page | What | Who |
|---|---|---|
| Summary (`index.html`) | Current cycle; any past cycle with the cycle picker (final figures, "vs previous cycle") | everyone on the list; past cycles need **Past cycles** |
| Bills (`bills.html`) | **Breakdown**: the bill laid out like DHBVN's (slabs, components A–C, payable, what would change it). **Uploaded bills** (`#uploads`): upload the DHBVN e-bill PDF → it is read in the browser (pdf.js) → confirm → line-by-line comparison, "Is DHBVN's bill right?", meter calibration | **Bill breakdown** / **Bill documents**; uploading is admin-only |
| Health (`health.html`) | Data arriving, last sync, failures, errors, timers, sheet size, backend version | admins; viewers with **Service health** |
| Admin (`admin.html`) | Billing, who can view (page ticks, requests, invites), Telegram, alerts, data corrections, activity | admins |

Viewers always see the Summary; the admin ticks the other pages per person (Admin → Who can view). The server checks the pages on every request. Someone opening a page they can't see gets **Request access**, which the admin approves or declines. Uploaded bill PDFs live in a private Drive folder ("Power Plan bills (env)") and are only handed out through the app.

After deploying run `phase1Check` in the editor once: it adds new tabs, makes sure the timers exist and logs cycles, uploaded bills, who sees what and the health checks.

## How the numbers are worked out
The bill is calculated **once, on the server** (`Engine.gs`, generated from `js/billing.js` and `js/quality.js`); the page only shows it. `tests/engine-sync.test.js` fails if the server copy is not the browser code.

- **Units since last bill** = cleaned meter energy now − energy at the billing time. The energy at billing is interpolated between hourly snapshots.
- **Growing average** = units since the bill ÷ days since the bill. **7-day average** = the last 7 complete days.
- **Projected bill** = units at the growing average up to the expected next reading (the date set by admin, or the average gap between past bills), priced with the DHBVN rules:
  - band B if the cycle averages more than 3.33 units/day
  - slab rates per day; each slab line rounded to the paisa like the bill
  - fixed charge ₹50/kW/month above 300 units/month (2 kW load)
  - FPPAS 47 p/unit at 200+ units/month
  - municipal tax 2% of (energy + fixed + FPPAS)
  - duty 10 p/unit
  - payable = arrears + charges + sundry, rounded to the rupee (the paisa go to the next bill's arrears)
  - all of it checked line by line against 6 real DHBVN bills (`tests/fixtures/dhbvn-bills.json`, amounts only)
- **Days** are India days wherever the page is opened.
- **Tariff versions** (TariffVersions tab): a cycle that spans a tariff change is billed part by part, units shared by days.
- **Cleaning** (same rules as the Power BI model):
  - drops readings where Current = 0 and Power = 0 (load on the inverter)
  - holds small dips in the energy counter
  - carries real counter resets forward
- **Data quality:** duplicate snapshots are dropped; gaps up to 6 h are spread evenly over the missing hours (totals never change, only which day the units show on); longer gaps are shown as outages. The logger's counter keeps running while it is offline, so a gap never loses units.
- **Corrections** (Admin → Data corrections): ignore readings in a time range, or add/subtract kWh from a time on. Applied when data is read, never written into the raw data; turning one off restores the exact previous numbers. Logged in Activity with the effect on the current cycle.

## Monitoring
- Every background run is logged in the **Jobs** tab, server errors in **Errors**.
- A failed update is retried after 2, 4 and 8 minutes. Only when the retries fail too is an alert sent.
- **watchData** (every minute in prod, every 5 min in UAT) alerts when no new logger reading has arrived for 2 minutes (measured by Google's clock), reminds every 30 minutes while it lasts, and sends one message when data is back. Change both on **Admin → Alerts**, which also shows how many messages were sent in the last 7 days. Quiet checks write nothing.
- The hourly **healthCheck** alerts when the app stops taking in data although the logger sends, and merges duplicate hour rows. Each such problem sends **one** message, and one "back to normal" message when it clears.
- Everything sent is also written to the **Alerts** tab (and Telegram, when set up).

## Files
| Path | What |
|---|---|
| `index.html`, `js/app.js`, `js/cycle.js` | Summary page, cycle picker |
| `bills.html`, `js/bills.js`, `js/bills-upload.js`, `js/billparse.js` | Bills page: breakdown, bill upload + reading + comparison |
| `health.html`, `js/health.js` | Service health page |
| `admin.html`, `js/admin.js` | Admin page (billing, history, viewers) |
| `js/billing.js`, `js/quality.js` | Bill engine and data-quality rules (pure, tested); copied into `apps-script/Engine.gs` |
| `js/api.js`, `js/config.js`, `js/mock.js`, `js/ui.js` | Sign-in, API calls, demo data, shared UI |
| `apps-script/*.gs` | Backend (Api), hourly snapshots (Summary), monitoring (Monitor), generated engine (Engine), archive |
| `scripts/build-gs.mjs` | Generates `apps-script/Engine.gs` |
| `tests/` | `npm test`: real-bill reconciliation, engine sync, data quality, backend (fake Apps Script) |
