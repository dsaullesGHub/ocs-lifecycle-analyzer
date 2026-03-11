# OCS Pallet Lifecycle Analyzer

Local build of the Cafe Valley OCS pallet lifecycle tracking and cost modeling tool.

Processes WMS transaction data (Megatrak exports) across all Company B OCS warehouse locations, builds pallet-level lifecycles from entry to exit, and applies contracted storage/handling rates to model expected costs.

## Requirements

- **Node.js** (v18 or newer): https://nodejs.org
  - If you don't have Node installed, download the LTS version from the link above and run the installer. That's it.

## Setup (one time)

Open a terminal (Command Prompt, PowerShell, or Terminal) and navigate to this folder:

```
cd ocs-lifecycle-analyzer
npm install
```

This downloads the dependencies (React, SheetJS, Vite). Takes about 30 seconds.

## Run

```
npm run dev
```

This starts a local dev server and opens your browser automatically. The app runs at `http://localhost:5173`.

To stop the server, press `Ctrl+C` in the terminal.

## Usage

1. Load WMS Excel files one at a time (WMS_1.xlsx, WMS_2.xlsx, WMS_DATA_2026YTD.xlsx)
2. Click "Build Lifecycles" when all files are loaded
3. Use the dashboard to analyze lifecycle data, dwell times, and modeled costs
4. Edit rate cards in the "Rate Cards" tab if rates change
5. Export pallet-level data to CSV via the "Export CSV" button

## What's Inside

- `src/App.jsx` -- the full application (lifecycle engine, cost model, dashboard)
- `package.json` -- project dependencies
- `vite.config.js` -- build configuration

## Data Files

The tool expects Megatrak WMS exports in .xlsx format with these columns:
Txn. Type, Whs., Whs. To, Pallet, Material, Qty, Timestamp, MFG Lot, Description

## OCS Locations Covered (Company B WMS)

| Code | Location | Vendor | Status |
|------|----------|--------|--------|
| S7 | NACS - Fort Wayne, IN | NACS | Active |
| S4 | Interstate - Franklin, IN | Interstate | Active |
| S9 | Americold - Indianapolis, IN | Americold | Active |
| C3 | Americold - Rochelle, IL | Americold | Active |
| S | Americold - Atlanta, GA | Americold | Winding Down |
| C1 | US Cold - McDonough, GA | USCS | Closed |
| S1 | P&B Cold Storage | P&B | Closed |
| S2 | Americold - Gouldsboro, PA | Americold | Closed |
| S5 | Americold - Hatfield, PA | Americold | Closed |
| S8 | Americold - Allentown, PA | Americold | Closed |
| S6 | Americold - Perryville, MD | Americold | Closed |

## Rate Card Notes

- S4 (Interstate Franklin): Rate varies by pallet height. Default uses 44" rate ($12.46/plt storage).
- S8 (Americold Allentown): Storage was a flat $79,000/month, not per-pallet. Only handling ($17.50/plt) is modeled.
- C1 (US Cold): Uses semi-monthly billing, not 30-day anniversary. Modeled as 30-day for now.
- S2 (Americold Wakefern) and S1 (P&B): No contract rates available in OCS Matrix.

## Build for Deployment

To create a static build you can host or share:

```
npm run build
```

Output goes to the `dist/` folder. Open `dist/index.html` in any browser -- no server needed.

## No External Dependencies at Runtime

This tool runs entirely in the browser. No data leaves your machine. No API calls. No internet required after the initial `npm install`.
