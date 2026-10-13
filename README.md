# DDR Tray Scanner

**Live app:** https://mohanchowdarysk-commits.github.io/ddr5-application/

A free web app that replaces the **DDR_MultiScanner** Excel workbook. Scan a memory stick (barcode gun, phone camera, or paste) and it tells you, in big numbers, **which tray it goes in**. It detects the brand, DDR generation, label, serial number and part number the same way the workbook did.

No install and no server to run. It's plain HTML and JavaScript, hosted free on GitHub Pages.

## Why it's better than the shared Excel

| Excel workbook | DDR Tray Scanner |
|---|---|
| One shared file; everyone edits the same sheets and can overwrite formulas | Everyone who opens the link gets their **own private project**, stored in their browser |
| You have to manage share permissions | Just send the URL. If a team wants one shared live view, they use an optional team link |
| Trays recalculate when a row is deleted, so sticks already placed can "move" | A tray number is **fixed when the stick is scanned**. Deleting a scan never moves other sticks |
| "DUPLICATE" only means "same part number" | Real **duplicate serial number** detection across every station |
| Kingston `KSM…` part numbers were tagged Samsung (they contain "M3") | Prefix matching runs first, so brands come out right. Rules can be edited in Settings |
| DDR gen only if the text says "DDR4" | Gen is also **inferred from the part number** (Samsung M393A/B/R, Hynix HMT/HMA/HMC, Micron MTA/MTC, Crucial CT…G4, Kingston KVR/KSM speed). Inferred values show `≈` |
| ~78 MB of formulas, slow | Handles 65,000+ scans instantly and works offline |
| When all trays are full, sticks silently go into the last tray | **"All trays full"** alert. Nothing gets placed in a tray that is already full |

### Features

- **Scan tab**: pick your station, then scan. You get a huge tray number, a fill bar (`12 / 50`), and a different beep for *add to tray*, *new tray* and *problem*. It can also speak "Tray 37". **Undo last** (Ctrl+Z) and **Bulk paste** (paste a column from Excel). Keystrokes from a USB/Bluetooth scanner are captured even when the box isn't focused. A phone or tablet camera can scan QR codes and barcodes too.
- **Trays tab** (the workbook's Master Summary): a live card or table view of all 1,300 trays, filtered by station, brand, gen or fill state. Mixed-part trays are flagged. Click a tray to see every serial in it, remove a stick, download the list, or **mark it shipped**, which frees the tray number for reuse and keeps the history.
- **Find tab**: type or scan a part number or serial number to see which tray(s) hold it.
- **Dashboard**: sticks by brand, generation and station, the top part numbers, scans today, and what needs attention.
- **Log**: every scan with search and filters. You can edit a note, move a stick to another tray manually, or delete a scan. Exports to **CSV** or **Excel**.
- **Projects**: click the project name (top right) → **+ New project**. Give it a name, list the **members** (one per line), choose **trays per member**, and set **sticks per tray**, or tick **No limit** so every stick of a part number goes into one tray. Each member automatically gets their own tray range (e.g. Ashu 1–100, Ronny 101–200), so two people never fill the same tray. You can keep many projects (one per batch, shipment or customer) and switch between them.
- **Settings**: rename the project, add/rename members and change tray ranges, the tray limit, the duplicate-serial policy and brand rules. You can **import the original Excel workbook** and back up or restore to JSON.
- **Colourful Excel export**: a **Tray Summary** that lists only trays that hold sticks (no empty rows), with colour-coded brand, DDR gen and FULL/partial status and a totals row. Also a **Members** sheet (trays used, full trays, sticks, problems per member), **Part Totals** (sticks per part number and the trays they're in), and one sheet per member with every scan. Every sheet has filter buttons.
- **Offline & installable**: it works without internet after the first visit. On a phone, use "Add to Home Screen".

## Where is the data saved?

- **On the device, instantly.** Every scan is written to the browser's built-in database (IndexedDB) *before* the tray number appears. If the tab or browser is closed by accident, the PC crashes or the power goes, nothing is lost: open the same link on the same device and browser and it's all there. The app also asks the browser to mark the data as *persistent* so it isn't cleaned up automatically. **Settings → Where is my data saved?** shows the status.
- It is lost only if someone clears the browser's site data, uses a private/incognito window, or moves to a different device or browser. To protect against that, use **Export Excel** or **Download backup** at the end of the day, or use a team project (below), which also stores every scan in the cloud.

## Put it online (free, about 2 minutes)

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**. Pick branch **`main`** and folder **`/ (root)`**, then click **Save**.
3. Wait about a minute. Your link appears at the top of that page:
   `https://mohanchowdarysk-commits.github.io/ddr5-application/`

Share that link with anyone. Each person gets their own project and nobody's scans mix with anyone else's.

> Run it locally instead: `python3 -m http.server 8080` in this folder, then open http://localhost:8080.

## Optional: one live project for a whole team (free)

Use this when several scanner stations should feed **one** Master Summary live, like the shared Excel but without anyone breaking formulas.

1. Create a free project at [supabase.com](https://supabase.com). No credit card is needed.
2. In the project, open **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.
4. In the app, go to **Settings → Team sharing**, paste both values, and click **Share this project with my team**.
5. Copy the **team link** and send it to your team. Opening it asks them to join, and from then on everyone sees the same trays in real time.

How it behaves:

- Each device keeps a full local copy. If Wi-Fi drops, scanning keeps working and changes upload automatically when the connection returns. The badge in the top bar shows **Live / Syncing / Offline**.
- Each station has its own tray range, so two stations never compete for the same tray.
- The free Supabase tier (500 MB database) holds millions of scans. A free project pauses after a week with no activity; click **Restore** in the Supabase dashboard to wake it.

### Security

The team link contains the project ID and the Supabase *anon* key, which is meant to be public. **Anyone with the team link can view and edit that project**, so share it the way you would share an edit link to a Google Sheet. The project ID is a random 16-character code that nobody can guess. For stricter control (named logins), turn on Supabase Auth and replace the two `using (true)` policies in `schema.sql` with per-user rules.

Local (non-team) projects never leave the browser.

## How trays are assigned

For each scan at a station (range `trayStart…trayEnd`, capacity *N*, default 50):

1. **No part number found** → `No part # detected`, not placed.
2. **Serial number already placed** anywhere in the project → `Duplicate serial`, not placed. On screen you can choose *Place anyway* or *Remove*.
3. There is an **open tray in this station's range already holding this part** with fewer than *N* sticks → add it there (the lowest tray number first).
4. Otherwise → the **lowest empty tray** in the range (`New part → Tray X`, or `Tray full → New Tray X`).
5. No empty tray left → `All trays full`.

Parsing (same as the workbook's formulas):

- **Part #**: the text after `(P)`, up to `(M)` or the first space. If there is no `(P)`, it's the first word, or the second word when the first word is only 1–2 characters. `©MLCC` is ignored.
- **Label**: the text after `(L)`, up to `(S)` or `(P)`.
- **Serial**: the text after `(S)`, up to `(P)`.
- **Brand**: from the part number using the rules in Settings: Samsung `M3/M4/M5/K4`, SK Hynix `HMT/HMA/HMCG/HX`, Micron `MT`, Crucial `CT` (or "crucial" in the scan), Kingston `KVR/KSM/KF`.
- **Gen**: `DDR5`, `DDR3` or `DDR4` in the scan or part number, or else inferred from the part number.

## Development

No build step. The code is ES modules in `js/`, with third-party libraries bundled in `vendor/` so the app doesn't depend on any CDN:

| File | Purpose |
|---|---|
| `js/parser.js` | scan → part / brand / gen / label / serial |
| `js/trays.js` | tray placement, the summary, and range checks (pure functions) |
| `js/store.js` | IndexedDB persistence and the sync outbox |
| `js/sync.js` | optional Supabase team sync (offline-first outbox and realtime) |
| `js/excel.js` | Excel import/export (SheetJS) and CSV |
| `js/app.js` | UI |
| `sw.js` | offline cache |

Run the tests with `npm test` (Node 18+; there are no dependencies to install).

Bundled libraries: [SheetJS](https://sheetjs.com) 0.18.5 (Apache-2.0), [html5-qrcode](https://github.com/mebjas/html5-qrcode) 2.3.8 (Apache-2.0), [supabase-js](https://github.com/supabase/supabase-js) 2.45.4 (MIT). Their licenses are in `vendor/`.

## License

MIT
