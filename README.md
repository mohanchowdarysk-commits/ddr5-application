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

- **Scan tab**: pick your station, then scan. You get a huge tray number, a fill bar (`12 / 50`), and a different beep for *add to tray*, *new tray* and *problem*. It can also speak "Tray 37". **Undo last** (Ctrl+Z) and **Bulk paste** (paste a column from Excel). Keystrokes from a USB/Bluetooth scanner are captured even when the box isn't focused. **📷 Camera** scans QR codes, Data Matrix and barcodes live. It uses the phone's built-in barcode reader when there is one, otherwise ZXing-C++ (bundled, works offline), and reads the small square code (Data Matrix) on module labels, which holds the part number, serial and size in one read. Once a label is read, the app ignores its other codes (the long barcode, the tiny codes on the chips) until you show the next stick, and it shows the tray number big on the camera picture. The brand comes from the serial number's maker code (`80CE` Samsung, `802C` Micron, `80AD` SK Hynix…), and the DDR generation comes from `PC5`/`PC4`/`PC3` on the label. For checkout speed, use a 2D handheld scanner (USB/Bluetooth, keyboard mode). **📸 Photo** reads a sharp photo from the phone's camera app, which is the most reliable way to read tiny labels. If the camera is blocked, the app explains why (permission, or a link opened inside WhatsApp or Instagram) and how to fix it.
- **Trays tab** (the workbook's Master Summary): a live card or table view of all 1,300 trays, filtered by station, brand, gen or fill state. Mixed-part trays are flagged. Click a tray to see every serial in it, remove a stick, download the list, or **mark it shipped**, which frees the tray number for reuse and keeps the history.
- **Find tab**: type or scan a part number or serial number to see which tray(s) hold it.
- **Dashboard**: sticks by brand, generation and station, the top part numbers, scans today, and what needs attention.
- **Log**: every scan with search and filters. You can edit a note, move a stick to another tray manually, or delete a scan. Exports to **CSV** or **Excel**.
- **Project switcher**: click the project name (top right) to jump to another project, create one, or open the full list.
- **Reliability**: a scan is saved on the device *before* its tray number appears, and if saving fails you see a red **NOT SAVED**. Team projects keep uploading in the background after you switch away. You can **back up all projects** in one file, and device-only projects remind you to back up daily. The Dashboard **data check** flags mixed trays, over-full trays and serials placed twice. A **new-version banner** offers a reload, and **About & diagnostics** shows the version, storage and recent problems. See [CHANGELOG.md](CHANGELOG.md).
- **Start screen**: every time the app opens it asks you to **create a new project** or **open an existing one**, with scan counts and when each project was last opened. Nothing is opened or created automatically.
- **Safe deleting**: projects are never deleted automatically. **Delete this project…** shows a warning with the scan count and offers a backup first, then moves the project to **Recently deleted** on the start screen, where it can be restored at any time. Removing it for good needs **Delete forever** and typing the project's name. When a team project reloads from the Google Sheet, any scan on the device that the sheet doesn't have yet is kept and uploaded, never dropped.
- **Projects**: on the start screen (or the project button at the top right), choose **＋ Create new project**. Give it a name, list the **members** (one per line), choose **trays per member**, and set **sticks per tray**, or tick **No limit** so every stick of a part number goes into one tray. Each member automatically gets their own tray range (e.g. Ashu 1–100, Ronny 101–200), so two people never fill the same tray. You can keep many projects (one per batch, shipment or customer) and switch between them.
- **Settings**: rename the project, add/rename members and change tray ranges, the tray limit, the duplicate-serial policy and brand rules. You can **import the original Excel workbook** and back up or restore to JSON.
- **Colourful Excel export**: a **Tray Summary** that lists only trays that hold sticks (no empty rows), with colour-coded brand, DDR gen and FULL/partial status and a totals row. Also a **Members** sheet (trays used, full trays, sticks, problems per member), **Part Totals** (sticks per part number and the trays they're in), and one sheet per member with every scan. Every sheet has filter buttons.
- **Offline & installable**: it works without internet after the first visit. On a phone, use "Add to Home Screen".

## Where is the data saved?

- **On the device, instantly.** Every scan is written to the browser's built-in database (IndexedDB) *before* the tray number appears. If the tab or browser is closed by accident, the PC crashes or the power goes, nothing is lost: open the same link on the same device and browser and it's all there. The app also asks the browser to mark the data as *persistent* so it isn't cleaned up automatically. **Settings → Where is my data saved?** shows the status.
- It is lost only if someone clears the browser's site data, uses a private/incognito window, or moves to a different device or browser. To protect against that, use **Export Excel** or **Download backup** at the end of the day, or use a team project (below), which also stores every scan in your own Google Sheet.

## Put it online (free, about 2 minutes)

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**. Pick branch **`main`** and folder **`/ (root)`**, then click **Save**.
3. Wait about a minute. Your link appears at the top of that page:
   `https://mohanchowdarysk-commits.github.io/ddr5-application/`

Share that link with anyone. Each person gets their own project and nobody's scans mix with anyone else's.

> Run it locally instead: `python3 -m http.server 8080` in this folder, then open http://localhost:8080.

## Optional: one live project for a whole team, in your own Google Sheet (free)

Use this when several people should feed **one** Tray Summary live, like the shared Excel but without anyone breaking formulas. The shared copy lives in a **Google Sheet in your own Google Drive**. You own it, you can open it like Excel at any time, and no extra service or account is needed beyond a normal Gmail account.

1. In the app, open **Settings → Team sharing** and click **Copy setup script**. The script already contains your private secret.
2. Create a Google Sheet at [sheet.new](https://sheet.new), then open **Extensions → Apps Script**. Delete the code that's there, paste the script, and click **Save**.
3. Click **Deploy → New deployment → ⚙ Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**. Authorize it: pick your account → *Advanced* → *Go to … (unsafe)* → *Allow*. Google shows that warning for any script you write yourself.
4. Copy the **Web app URL**, paste it into the app, and click **Connect & share this project**.
5. Copy the **team link** and send it to your team. Opening it asks them to join.

How it behaves:

- **Every scan is saved on the scanning device first**, then uploaded. If the internet or Google is down, scanning keeps working, changes queue up, and they upload automatically later. The top bar shows **Live / Syncing / Offline**.
- Other members' scans show up within about 8 seconds (about 60 seconds when the app is in the background).
- Each member scans into their own tray range, so nobody collides. Duplicate serial numbers are caught across all devices.
- Your Google Sheet gets three tabs: **Scans** (one readable row per scan: tray, part, brand, gen, serial, status, operator…), **Projects**, and **Log** (the change history the app syncs from; don't edit it by hand). One sheet can hold many projects.
- Capacity: a Google Sheet holds 10 million cells, which is roughly 400,000 scans. When it gets full, create a new sheet for new projects.

### Why Google Sheet and not a database service

No outside company can promise "free forever", and that includes Google. This design is built so a rule change can't cost you data:

1. Every device keeps a full copy of its projects, and the app never depends on the cloud to work.
2. The shared copy is an ordinary spreadsheet file **you own**. You can download it (File → Download → .xlsx) whenever you like, and nothing is locked inside a vendor's database.
3. The sync script is under 200 lines of plain code in `gsheet/Code.gs` and could be moved to another backend if ever needed.

### Security

The team link contains the Web app URL and the secret. **Anyone with the team link can view and edit that project**, so share it the way you'd share an edit link to a Google Sheet. Requests without the secret are refused. To lock everyone out, open Apps Script and click **Deploy → Manage deployments → Archive** (or change the secret and redeploy). The Google Sheet itself stays private to your Google account unless you share it.

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
| `js/sync.js` | optional team sync through your Google Sheet (offline-first outbox + polling) |
| `gsheet/Code.gs` | the Apps Script that runs inside your Google Sheet |
| `js/excel.js` | Excel import/export (SheetJS) and CSV |
| `js/app.js` | UI |
| `sw.js` | offline cache |

Run the logic tests with `npm test` (Node 18+, no dependencies). The browser tests (`npm run e2e`, 27 checks of the real app in headless Chromium) need `npm install --no-save playwright && npx playwright install chromium`. GitHub runs both on every push.

Bundled libraries: [xlsx-js-style](https://github.com/gitbrent/xlsx-js-style) 1.2.0 (SheetJS with cell styles, Apache-2.0), [barcode-detector](https://github.com/Sec-ant/barcode-detector) 3.2.2 + [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.3 (MIT). Their licenses are in `vendor/`.

## License

MIT
