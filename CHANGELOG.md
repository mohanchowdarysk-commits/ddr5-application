# Changelog

## 1.2.0 — release hardening
- **Project switcher**: click the project name (top right) to jump to another project, start a new one, or open the full project list.
- **Scans are saved before the tray number is shown.** If the device can't save (storage full, private window), a red **NOT SAVED** message appears instead of a tray number.
- **Team projects keep uploading in the background**, even after switching to another project.
- **Back up all projects** in one file (start screen or Settings). Restoring a backup adds projects and never replaces existing ones.
- **Backup reminder** for device-only projects that haven't been backed up in 24 hours.
- **Data check** on the Dashboard: mixed trays, trays over the limit, serial numbers placed twice, trays outside every member's range.
- **New version banner**: when an update is published, open apps show "Reload now" instead of switching mid-scan.
- **About & diagnostics** in Settings: version, storage used, recent problems, and a "Copy diagnostics" button.
- Automated browser tests run on GitHub for every change.

## 1.1.0
- Start screen: create a project or open an existing one on every visit.
- Deleting a project moves it to **Recently deleted** (restorable); **Delete forever** requires typing the name.
- Team sync through your own Google Sheet; local scans are never dropped when reloading from the sheet.
- Camera rebuilt for real DDR labels (Data Matrix), photo mode, clear camera error messages.
- Colourful Excel export, projects with members, optional tray limit.

## 1.0.0
- First release: scan → tray, trays summary, find, dashboard, log, Excel import/export.
