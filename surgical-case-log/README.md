# Surgical Case Log

Offline, installable (PWA) logbook for a general surgeon. It is plain HTML/CSS/JS with no build step and no server. Data is stored in the browser's IndexedDB on your device.

## Features
- Fast case entry with tap buttons. The app remembers your last hospital and role and suggests procedures and diagnoses you've entered before.
- Case list with search and filters (date range, category, role, hospital).
- Dashboard: total cases, cases per month, and breakdowns by category, role, approach, hospital and Clavien-Dindo grade, plus complication rates.
- Export to Excel (.xlsx, with Cases and Summary sheets) and a PDF logbook (A4 landscape, summary table and signature block). Both exports respect the active filters.
- Edit and delete (with confirmation), backup to JSON, and restore by merge or replace.
- Import old cases from Excel or CSV. Column names are matched automatically, title rows are skipped, and dates in dd/mm/yyyy, ISO, "15 Aug 2024" or Excel format are read. Missing category and approach are guessed from the procedure name. Duplicates are skipped, and a preview is shown before saving. A blank template is available on the Export tab.

## Run locally
```
cd surgical-case-log
python3 -m http.server 8000
# open http://localhost:8000
```
A service worker needs http(s), so opening `index.html` directly as a file won't install the PWA.

## Deploy (GitHub Pages)
Settings → Pages → Source: *Deploy from a branch* → choose the branch and `/ (root)`.
The app will be at `https://<user>.github.io/<repo>/surgical-case-log/`.

## Updating
The service worker serves cached files and refreshes them in the background, so after you deploy a change, reopen the app twice to get it.
If you change the list of files, bump `VERSION` in `sw.js`.

## Libraries (vendored for offline use)
SheetJS `xlsx` 0.18.5 (mini build), jsPDF 2.5.1, jspdf-autotable 3.8.2.
