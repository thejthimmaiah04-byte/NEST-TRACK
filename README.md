# 🐭 Rodent Breeding Monitor

A clean, offline-first web app to track rodent breeding trays, count individuals by
life-stage (**Pinky → Fuzzy → Hopper → Adult**, fully configurable per species), and
**forecast how many of each stage you'll have in the coming weeks**.

- **Age-based tracking** — you log a litter (birth date + count) into a tray. The app
  automatically ages it through stages using each species' day-thresholds. No manual
  re-counting.
- **Live "right now" totals** per stage, per tray, and per species.
- **Forecast** that projects your current animals forward through their stages.
- **Removals auto-update everything** — when you pull individuals out, the counts and
  forecast update instantly.
- **Works offline.** All data is saved on the device first. It syncs to a **Google
  Sheet** when online, and queued changes upload automatically when the network returns.
- **Multi-device.** Point every phone/laptop at the same Google Sheet and they stay in sync.
- **No build step, no server to run.** Static files → host free on **GitHub Pages**.

---

## Quick look

| Tab | What it's for |
|-----|----------------|
| **Dashboard** | Current totals per stage + a weekly forecast chart. |
| **Trays** | Your shelves and trays. Tap a tray to add litters or log removals. |
| **Species** | Define species and the age (in days) each stage begins. |
| **Settings** | Connect the Google Sheet, sync status, backups. |

The app ships with one example Species (Mouse), one Shelf, and one Tray so it isn't blank
on first run. Edit or delete them freely.

---

## Try it locally first (optional)

Any static file server works. For example, with Node installed:

```bash
npx http-server -p 8080 -c-1 .
```

Then open `http://localhost:8080`. (Opening `index.html` directly as a `file://` also
works for a quick look, but the offline service worker and Google Sheet sync need
`http(s)://`.)

---

## Part A — Create the Google Sheet + sync backend

This is what lets data live in a Sheet and sync across devices. ~5 minutes, one time.

1. Go to **[sheets.new](https://sheets.new)** to create a new Google Sheet. Name it
   anything, e.g. *Rodent Breeding Data*. Leave it empty — the script creates the tabs.
2. In that Sheet, open **Extensions ▸ Apps Script**.
3. Delete any code in the editor, then **paste the entire contents of
   [`apps-script/Code.gs`](apps-script/Code.gs)** from this repo.
4. Click **Save** (💾).
5. Click **Deploy ▸ New deployment**.
   - Click the gear ⚙️ next to *Select type* → choose **Web app**.
   - **Description:** anything.
   - **Execute as:** **Me**.
   - **Who has access:** **Anyone**. *(Required — the app calls it from your browser.
     The URL is unguessable; only people you give it to can reach it. Don't post it publicly.)*
   - Click **Deploy**.
6. Google will ask you to **authorize**. Approve it (you may need to click *Advanced ▸
   Go to (project) ▸ Allow* the first time — this is normal for your own scripts).
7. Copy the **Web app URL**. It looks like:
   `https://script.google.com/macros/s/AKfy…long…/exec`

> Keep this URL. You'll paste it into the app's **Settings** tab.

**If you ever change `Code.gs`,** redeploy with **Deploy ▸ Manage deployments ▸ ✎ Edit ▸
Version: New version ▸ Deploy** so the URL stays the same.

---

## Part B — Host the app live on GitHub Pages

1. Create a new GitHub repository (e.g. `rodent-breeding-monitor`).
2. Upload every file/folder from this project to the repo root:
   `index.html`, `css/`, `js/`, `sw.js`, `manifest.webmanifest`, `apps-script/`, `README.md`.
   (Web upload: **Add file ▸ Upload files**, drag them all in, **Commit**.)
3. In the repo, go to **Settings ▸ Pages**.
4. Under **Build and deployment ▸ Source**, choose **Deploy from a branch**.
5. Branch: **main**, folder: **/ (root)**. **Save**.
6. Wait ~1 minute. Your live URL appears at the top of the Pages settings, like:
   `https://<your-username>.github.io/rodent-breeding-monitor/`

Open that URL on any device. On a phone you can **"Add to Home Screen"** to use it like an app.

---

## Part C — Connect the app to your Sheet

1. Open your live app (or the local one).
2. Go to the **Settings** tab.
3. Paste the **Web app URL** from Part A into **Apps Script Web App URL** and click **Save URL**.
4. It will sync immediately. The dot in the top-right shows status:

| Dot | Meaning |
|-----|---------|
| ⚪ grey | Local only (no URL set) |
| 🟢 green | Synced |
| 🟠 amber | Changes queued, will sync shortly |
| 🔵 blue (pulsing) | Syncing now |
| 🔴 red | Offline — changes are safe locally and upload when back online |

Do the same on every device, using the **same URL**, and they'll all share the data.

---

## How it works

**Data model** (each stored in its own tab of your Sheet):

- **Species** — name + ordered stages, each with a `startDay` (age in days it *enters*
  that stage; `0` = birth).
- **Shelves** and **Trays** — your physical layout. A tray is assigned a species.
- **Cohorts (litters)** — a birth date + starting count, inside a tray.
- **Removals** — each time you pull individuals from a litter (count + date + stage).

**Current stage** of a litter = its age today mapped onto its species' stage thresholds.
Because every animal in a litter shares a birth date, a litter sits in exactly one stage
at a time and moves to the next automatically as it ages.

**"Right now" counts** = for each litter, `startingCount − everything removed so far`,
grouped by stage. Stages with the same name across species are summed together.

**Forecast** = for each future week, the app recomputes every litter's stage on that date
and re-totals. It projects your **current** animals forward (it assumes no further
removals), so you can see, e.g., *"these 40 hoppers become 40 adults in ~10 days."*

**Offline & sync** = every change is written to the device (`localStorage`) instantly and
added to a queue. When online with a URL set, the app pushes queued changes and pulls
others' changes in one request. Conflicts resolve **last-write-wins** by timestamp. The
app shell itself is cached by a service worker, so it opens with no network.

---

## Customizing species / stages

Go to **Species ▸ Add species** (or **Edit**). Give it a name and list its stages with the
day each begins. Examples of sensible starting points (edit to match your colony):

| Species | Pinky | Fuzzy | Hopper | Adult |
|---------|:-----:|:-----:|:------:|:-----:|
| Mouse | 0 | 5 | 10 | 21 |
| Rat | 0 | 8 | 15 | 29 |

You can add more stages (e.g. *Weanling*, *Retired*), rename them, or use different
species entirely — the whole app recalculates from whatever you define.

---

## Backups

**Settings ▸ Export JSON** downloads a full copy of everything on the device. **Import
JSON** restores it. This is separate from the Google Sheet, which is itself a live,
human-readable backup you can open any time.

---

## Troubleshooting

- **"Sync failed"** — Re-check the URL ends in `/exec`. Make sure the deployment's *Who has
  access* is **Anyone**. If you edited `Code.gs`, redeploy a **New version**.
- **Nothing appears on a second device** — confirm both use the exact same URL and are
  online; press **Sync now** in Settings.
- **Changed the app files but the live site looks old** — the service worker caches the
  shell; refresh twice, or bump `CACHE` version in `sw.js` before deploying.
- **Numbers look wrong** — check the litter's birth date and the species' stage day-ranges
  under the **Species** tab.

---

## Privacy note

Your Google Sheet and its Apps Script URL are yours. The app talks only to that URL. Treat
the `/exec` URL like a password — anyone with it can read/write your breeding data — so
share it only with people who should have access, and don't publish it.
