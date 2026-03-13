import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import * as XLSX from "xlsx";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from "recharts";
import InvoicesTab from "./tabs/InvoicesTab.jsx";
import ReconciliationTab from "./tabs/ReconciliationTab.jsx";
import AIAgentTab from "./tabs/AIAgentTab.jsx";

// ── IndexedDB Persistence ────────────────────────────────────────────────────
const DB_NAME = "ocs-lifecycle-db";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const CURRENT_KEY = "current";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveProject(data) {
  try {
    const db = await openDB();
    const serialized = {
      ...data,
      rawTx: data.rawTx.map(tx => ({ ...tx, ts: tx.ts.getTime() })),
      savedAt: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const txn = db.transaction(STORE_NAME, "readwrite");
      txn.objectStore(STORE_NAME).put(serialized, CURRENT_KEY);
      txn.oncomplete = () => resolve(true);
      txn.onerror = () => reject(txn.error);
    });
  } catch (e) { console.warn("Save failed:", e); return false; }
}

async function loadProject() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const txn = db.transaction(STORE_NAME, "readonly");
      const req = txn.objectStore(STORE_NAME).get(CURRENT_KEY);
      req.onsuccess = () => {
        const data = req.result;
        if (!data) return resolve(null);
        resolve({
          ...data,
          rawTx: data.rawTx.map(tx => ({ ...tx, ts: new Date(tx.ts) })),
        });
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) { console.warn("Load failed:", e); return null; }
}

async function clearProject() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const txn = db.transaction(STORE_NAME, "readwrite");
      txn.objectStore(STORE_NAME).delete(CURRENT_KEY);
      txn.oncomplete = () => resolve(true);
      txn.onerror = () => reject(txn.error);
    });
  } catch (e) { console.warn("Clear failed:", e); return false; }
}

function exportProjectFile(rawTx, loadedFiles, rates, invoices) {
  const data = {
    version: 3,
    exportedAt: new Date().toISOString(),
    loadedFiles,
    rates,
    invoices: invoices || [],
    rawTx: rawTx.map(tx => ({ ...tx, ts: tx.ts.getTime() })),
  };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ocs-project-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

async function importProjectFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data.rawTx || !data.loadedFiles) throw new Error("Invalid project file");
  return {
    loadedFiles: data.loadedFiles,
    rates: data.rates || { ...DEFAULT_RATES },
    invoices: data.invoices || [],
    rawTx: data.rawTx.map(tx => ({ ...tx, ts: new Date(tx.ts) })),
  };
}

const CV = { navy: "#2B4170", red: "#E8523F", cream: "#F5EDE0", teal: "#00A3BE", purple: "#7B5EA7", orange: "#F5A623", green: "#4EBC6A", navyLight: "#E8EDF5", creamDark: "#EDE0CE" };
const LOC_COLORS = [CV.navy, CV.red, CV.teal, CV.purple, CV.orange, CV.green, "#D4619C", "#8B6914", "#3D8B6E", "#AA4444", "#6666AA"];

const OCS_LOCATIONS = {
  S7: { name: "NACS", fullName: "North American Cold Storage", vendor: "NACS", city: "Fort Wayne, IN", status: "active" },
  S4: { name: "IWI Franklin", fullName: "Interstate Warehousing - Franklin", vendor: "Interstate", city: "Franklin, IN", status: "active" },
  S9: { name: "Americold Indy", fullName: "Americold - Indianapolis", vendor: "Americold", city: "Indianapolis, IN", status: "active" },
  C3: { name: "Americold Rochelle", fullName: "Americold - Rochelle", vendor: "Americold", city: "Rochelle, IL", status: "active" },
  S: { name: "Americold Atlanta", fullName: "Americold - Atlanta", vendor: "Americold", city: "Atlanta, GA", status: "winding-down" },
  C1: { name: "US Cold Storage", fullName: "US Cold Storage", vendor: "USCS", city: "McDonough, GA", status: "closed" },
  S1: { name: "P&B Cold Storage", fullName: "P&B Cold Storage", vendor: "P&B", city: "Unknown", status: "closed" },
  S2: { name: "Americold Wakefern", fullName: "Americold - Wakefern", vendor: "Americold", city: "Gouldsboro, PA", status: "closed" },
  S5: { name: "Americold Hatfield", fullName: "Americold - Hatfield", vendor: "Americold", city: "Hatfield, PA", status: "closed" },
  S8: { name: "Americold Allentown", fullName: "Americold - Allentown", vendor: "Americold", city: "Allentown, PA", status: "closed" },
  S6: { name: "Americold Perryville", fullName: "Americold - Perryville", vendor: "Americold", city: "Perryville, MD", status: "closed" },
};
const OCS_CODES = new Set(Object.keys(OCS_LOCATIONS));
const DEFAULT_RATES = {
  S7: { handling: 13.25, initialStorage: 13.00, renewalStorage: 13.00, cycleDays: 30 },
  S4: { handling: 16.59, initialStorage: 12.46, renewalStorage: 12.46, cycleDays: 30 },
  S9: { handling: 21.50, initialStorage: 19.00, renewalStorage: 19.00, cycleDays: 30 },
  C3: { handling: 16.47, initialStorage: 15.87, renewalStorage: 15.87, cycleDays: 30 },
  S: { handling: 20.44, initialStorage: 16.38, renewalStorage: 16.38, cycleDays: 30 },
  C1: { handling: 19.22, initialStorage: 19.78, renewalStorage: 19.78, cycleDays: 30 },
  S1: { handling: 0, initialStorage: 0, renewalStorage: 0, cycleDays: 30 },
  S2: { handling: 0, initialStorage: 0, renewalStorage: 0, cycleDays: 30 },
  S5: { handling: 22.06, initialStorage: 20.42, renewalStorage: 20.42, cycleDays: 30 },
  S8: { handling: 17.50, initialStorage: 0, renewalStorage: 0, cycleDays: 30 },
  S6: { handling: 23.10, initialStorage: 24.15, renewalStorage: 23.10, cycleDays: 30 },
};

const fmt$ = (v) => v == null ? "---" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtK = (v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : fmt$(v);
const fmtN = (v) => v == null ? "---" : v.toLocaleString();
const fmtD = (d) => d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : "---";
const fmtISO = (d) => d ? d.toISOString().slice(0, 10) : "";
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const mKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const EXCEL_EPOCH = new Date(1899, 11, 30);
function parseExcelDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") { const d = new Date(EXCEL_EPOCH.getTime() + v * 86400000); return isNaN(d.getTime()) ? null : d; }
  if (typeof v === "string") { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  return null;
}

function buildLifecycles(transactions, asOfDate) {
  // ── Balance-tracking lifecycle builder ──
  // Groups all transactions by pallet+loc, replays in timestamp order,
  // maintains running balance, detects lifecycle open/close boundaries.
  const groups = {};
  for (const tx of transactions) {
    const key = `${tx.pallet}|${tx.loc}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(tx);
  }
  const lifecycles = [];
  for (const key of Object.keys(groups)) {
    const [pallet, loc] = key.split("|");
    const txns = groups[key].sort((a, b) => a.ts - b.ts);
    let balance = 0, cur = null;

    for (const tx of txns) {
      const delta = tx.balanceDelta ?? (tx.event === "entry" ? tx.qty : -Math.abs(tx.qty));
      const prevBal = balance;
      balance += delta;

      // Lifecycle opens: balance goes from <=0 to positive
      if (prevBal <= 0 && balance > 0 && !cur) {
        cur = {
          pallet, loc, material: tx.material, qty: balance,
          entryDate: tx.ts, entryFrom: tx.whsFrom || "", entryType: tx.eventType || tx.event,
          mfgLot: tx.mfgLot || "", peakQty: balance,
          exitEvents: [], qtyPicked: 0, qtyAdjusted: 0, qtyShipped: 0, qtyTransferred: 0,
        };
      }

      // Track peak qty
      if (cur && balance > cur.peakQty) cur.peakQty = balance;

      // Track depleting events
      if (cur && delta < 0) {
        cur.exitEvents.push(tx);
        const absD = Math.abs(delta);
        if (tx.eventType === "case-pick") cur.qtyPicked += absD;
        else if (tx.eventType === "adjustment") cur.qtyAdjusted += absD;
        else if (tx.eventType === "exit-ship") cur.qtyShipped += absD;
        else if (tx.eventType === "exit-transfer") cur.qtyTransferred += absD;
      }

      // Lifecycle closes: balance returns to 0 or below
      if (balance <= 0 && cur) {
        const exitTx = cur.exitEvents.length > 0 ? cur.exitEvents[cur.exitEvents.length - 1] : tx;
        const dwell = daysBetween(cur.entryDate, exitTx.ts);
        // Classify exit reason
        const eTypes = new Set(cur.exitEvents.map(e => e.eventType));
        let exitReason = "unknown";
        if (eTypes.has("exit-ship")) exitReason = "shipped";
        else if (eTypes.has("exit-transfer")) exitReason = "transferred";
        else if (eTypes.has("case-pick") || eTypes.has("adjustment")) exitReason = "depleted";

        lifecycles.push({
          ...cur, exitDate: exitTx.ts, exitTo: exitTx.whsTo || exitTx.whsFrom || "",
          exitType: exitTx.eventType || "", exitReason,
          dwell: Math.max(dwell, 0), open: false, preExisting: false,
        });
        cur = null; balance = 0; // reset for potential re-entry
      }
    }

    // Still open at end of data window
    if (cur) {
      const dwell = daysBetween(cur.entryDate, asOfDate);
      lifecycles.push({
        ...cur, exitDate: null, exitTo: null, exitType: null, exitReason: null,
        dwell: Math.max(dwell, 0), open: true, preExisting: false,
      });
    }

    // Pre-existing: if first transaction is depleting with no prior entry, balance starts negative
    // This means exits happened before any entry in our data window
    if (txns.length > 0 && txns[0].event === "exit" && !lifecycles.some(l => l.pallet === pallet && l.loc === loc && !l.preExisting)) {
      // Collect all exit events that had no matching entry
      const preExTxns = [];
      let preBal = 0;
      for (const tx of txns) {
        const delta = tx.balanceDelta ?? (tx.event === "entry" ? tx.qty : -Math.abs(tx.qty));
        preBal += delta;
        if (preBal < 0 && tx.event === "exit") preExTxns.push(tx);
        if (preBal >= 0) break;
      }
      if (preExTxns.length > 0) {
        const lastExit = preExTxns[preExTxns.length - 1];
        lifecycles.push({
          pallet, loc, material: lastExit.material, qty: lastExit.qty, mfgLot: lastExit.mfgLot || "",
          entryDate: null, exitDate: lastExit.ts, entryFrom: "PRE-EXISTING", exitTo: lastExit.whsTo || "",
          entryType: null, exitType: lastExit.eventType || "", exitReason: "pre-existing",
          dwell: null, open: false, preExisting: true, peakQty: 0,
          exitEvents: [], qtyPicked: 0, qtyAdjusted: 0, qtyShipped: 0, qtyTransferred: 0,
        });
      }
    }
  }
  return lifecycles;
}

function computeCosts(lifecycles, rates) {
  return lifecycles.map(lc => {
    const r = rates[lc.loc]; if (!r || lc.preExisting || lc.dwell == null) return { ...lc, handling: 0, initialStorage: 0, renewalStorage: 0, totalCost: 0, renewalCycles: 0, hasRates: false };
    const renewalCycles = Math.max(0, Math.ceil(lc.dwell / (r.cycleDays || 30)) - 1);
    return { ...lc, handling: r.handling, initialStorage: r.initialStorage, renewalStorage: renewalCycles * r.renewalStorage, totalCost: r.handling + r.initialStorage + renewalCycles * r.renewalStorage, renewalCycles, hasRates: r.handling > 0 || r.initialStorage > 0 };
  });
}

async function parseFileToTransactions(file, setProgress) {
  const transactions = []; let totalRows = 0;
  setProgress(`Reading ${file.name} into memory...`);
  await new Promise(r => setTimeout(r, 50));
  const data = await file.arrayBuffer();
  setProgress(`Parsing ${file.name} workbook...`);
  await new Promise(r => setTimeout(r, 50));
  const wb = XLSX.read(data, { cellDates: true });
  for (const sn of wb.SheetNames) {
    if (sn.toLowerCase().includes("log") || sn.toLowerCase().includes("claude")) continue;
    setProgress(`Extracting rows from ${file.name} / ${sn}...`);
    await new Promise(r => setTimeout(r, 30));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "" }); totalRows += rows.length;
    setProgress(`Processing ${rows.length.toLocaleString()} rows from ${sn}...`);
    await new Promise(r => setTimeout(r, 30));
    for (const row of rows) {
      const txn = String(row["Txn. Type"] || "").trim(), whs = String(row["Whs."] || "").trim(), whsTo = String(row["Whs. To"] || "").trim();
      const pallet = String(row["Pallet"] || "").trim(), material = String(row["Material"] || "").trim(), qty = parseInt(row["Qty"]) || 0;
      const mfgLot = String(row["MFG Lot"] || row["Mfg Lot"] || "").trim();
      const palletTo = String(row["Pallet To"] || "").trim();
      const order = String(row["Order#"] || "").trim();
      let ts = row["Timestamp"]; if (ts && !(ts instanceof Date)) { const num = parseFloat(ts); if (!isNaN(num) && num > 10000) ts = parseExcelDate(num); else { ts = new Date(ts); if (isNaN(ts.getTime())) ts = null; } }
      if (!ts || isNaN(ts.getTime()) || !pallet || pallet === "NONE") continue;
      const base = { pallet, material, qty, ts, mfgLot, whsFrom: whs, whsTo, palletTo, order };
      const whsIsOCS = OCS_CODES.has(whs), whsToIsOCS = OCS_CODES.has(whsTo);

      // RCP/STG into OCS location = entry
      if ((txn === "RCP" || txn === "STG") && whsToIsOCS) {
        transactions.push({ ...base, event: "entry", eventType: "entry", loc: whsTo, balanceDelta: qty });
      }
      // SHP from OCS location = exit (whole pallet ship)
      else if (txn === "SHP" && whsIsOCS) {
        transactions.push({ ...base, event: "exit", eventType: "exit-ship", loc: whs, balanceDelta: -Math.abs(qty) });
      }
      // MOV from OCS to non-OCS = exit-transfer (e.g., C1 to hold warehouse I)
      else if (txn === "MOV" && whsIsOCS && !whsToIsOCS && whsTo && whs !== whsTo) {
        transactions.push({ ...base, event: "exit", eventType: "exit-transfer", loc: whs, balanceDelta: -Math.abs(qty) });
      }
      // MOV from non-OCS to OCS = entry-transfer (e.g., hold I back to C1)
      else if (txn === "MOV" && !whsIsOCS && whsToIsOCS && whs !== whsTo) {
        transactions.push({ ...base, event: "entry", eventType: "entry-transfer", loc: whsTo, balanceDelta: qty });
      }
      // PCK at OCS where Pallet To is a DIFFERENT pallet = case pick (depletion)
      else if (txn === "PCK" && whsIsOCS && palletTo && palletTo !== pallet && palletTo !== "NONE" && palletTo !== "NOBREAK") {
        transactions.push({ ...base, event: "exit", eventType: "case-pick", loc: whs, balanceDelta: -Math.abs(qty) });
      }
      // ADJ at OCS location = inventory adjustment (signed qty)
      else if (txn === "ADJ" && whsIsOCS) {
        transactions.push({ ...base, event: qty < 0 ? "exit" : "entry", eventType: "adjustment", loc: whs, balanceDelta: qty });
      }
    }
  }
  return { transactions, totalRows };
}

function rebuildFromTransactions(allTx, rates) {
  // ── STEP 1: Cross-file entry dedup at DAY level ──
  // Catches both cross-file overlaps AND STG+BATCH pairs on the same pallet/loc/date.
  const entryMap = {};
  for (const tx of allTx) {
    if (tx.event !== "entry") continue;
    const dayKey = `${tx.pallet}|${tx.loc}|${Math.floor(tx.ts.getTime() / 86400000)}`;
    if (!entryMap[dayKey]) entryMap[dayKey] = tx;
    else if (tx.ts < entryMap[dayKey].ts) entryMap[dayKey] = tx;
  }
  const dedupedEntries = Object.values(entryMap);
  const entryDupsRemoved = allTx.filter(t => t.event === "entry").length - dedupedEntries.length;

  // ── STEP 2: Cross-file exit dedup at MINUTE level ──
  // Only dedup SHP and exit-transfer (cross-file duplicate risk).
  // Case-picks and adjustments are NOT deduped: multiple PCK/ADJ in the same
  // minute are legitimate separate transactions (e.g., 3 cases + 28 cases).
  const exitMap = {};
  const exitKeep = [];
  for (const tx of allTx) {
    if (tx.event !== "exit") continue;
    if (tx.eventType === "exit-ship" || tx.eventType === "exit-transfer") {
      const minKey = `${tx.pallet}|${tx.loc}|${tx.eventType}|${Math.floor(tx.ts.getTime() / 60000)}`;
      if (!exitMap[minKey]) exitMap[minKey] = tx;
    } else {
      exitKeep.push(tx); // case-pick, adjustment: keep all
    }
  }
  const dedupedExits = [...Object.values(exitMap), ...exitKeep];
  const exitDupsRemoved = allTx.filter(t => t.event === "exit").length - dedupedExits.length;

  // ── Build lifecycles from clean transactions ──
  const cleanTx = [...dedupedEntries, ...dedupedExits];
  const lifecycles = computeCosts(buildLifecycles(cleanTx, new Date()), rates);

  // ── Attach dedup stats to the result for UI display ──
  lifecycles._dedupStats = {
    rawEntries: allTx.filter(t => t.event === "entry").length,
    rawExits: allTx.filter(t => t.event === "exit").length,
    cleanEntries: dedupedEntries.length,
    cleanExits: dedupedExits.length,
    entryDupsRemoved,
    exitDupsRemoved,
    totalRemoved: entryDupsRemoved + exitDupsRemoved,
    phantomsEliminated: entryDupsRemoved,
  };
  return lifecycles;
}

// Analytics
function computeOnHand(lifecycles, gran) {
  const events = [];
  for (const lc of lifecycles) { if (lc.preExisting) continue; if (lc.entryDate) events.push({ d: lc.entryDate, delta: 1, loc: lc.loc }); if (lc.exitDate) events.push({ d: lc.exitDate, delta: -1, loc: lc.loc }); }
  events.sort((a, b) => a.d - b.d); if (events.length === 0) return [];
  const ms = 86400000, pMs = gran === "month" ? ms * 30 : ms * 7;
  const buckets = {}, counts = {}; let ei = 0, cur = new Date(events[0].d);
  while (cur <= events[events.length - 1].d) {
    const pe = new Date(cur.getTime() + pMs);
    while (ei < events.length && events[ei].d < pe) { counts[events[ei].loc] = (counts[events[ei].loc] || 0) + events[ei].delta; ei++; }
    const k = gran === "month" ? mKey(cur) : fmtISO(cur); const entry = { period: k, total: Object.values(counts).reduce((s, v) => s + Math.max(0, v), 0) };
    for (const loc of Object.keys(counts)) entry[loc] = Math.max(0, counts[loc]); buckets[k] = entry; cur = pe;
  }
  return Object.values(buckets);
}

function computeThroughput(lcs) {
  const m = {};
  for (const lc of lcs) {
    if (lc.preExisting) continue;
    if (lc.entryDate) { const k = mKey(lc.entryDate); if (!m[k]) m[k] = { period: k, entries: 0, exits: 0, cost: 0 }; m[k].entries++; m[k].cost += lc.totalCost || 0; }
    if (lc.exitDate) { const k = mKey(lc.exitDate); if (!m[k]) m[k] = { period: k, entries: 0, exits: 0, cost: 0 }; m[k].exits++; }
  }
  return Object.values(m).sort((a, b) => a.period.localeCompare(b.period));
}

function computeCostByLoc(lcs) {
  const m = {};
  for (const lc of lcs) { if (lc.preExisting || !lc.entryDate || !lc.hasRates) continue; const k = mKey(lc.entryDate); if (!m[k]) m[k] = { period: k }; m[k][lc.loc] = (m[k][lc.loc] || 0) + lc.totalCost; }
  return Object.values(m).sort((a, b) => a.period.localeCompare(b.period));
}

function computeAging(lcs) {
  const b = [{ label: "0-15d", min: 0, max: 15, count: 0, cost: 0, color: CV.green }, { label: "16-30d", min: 16, max: 30, count: 0, cost: 0, color: CV.teal }, { label: "31-60d", min: 31, max: 60, count: 0, cost: 0, color: CV.navy }, { label: "61-90d", min: 61, max: 90, count: 0, cost: 0, color: CV.orange }, { label: "91-180d", min: 91, max: 180, count: 0, cost: 0, color: CV.purple }, { label: "181-365d", min: 181, max: 365, count: 0, cost: 0, color: CV.red }, { label: "365d+", min: 366, max: 99999, count: 0, cost: 0, color: "#880000" }];
  for (const lc of lcs.filter(l => l.open && !l.preExisting)) { for (const bk of b) { if (lc.dwell >= bk.min && lc.dwell <= bk.max) { bk.count++; bk.cost += lc.totalCost || 0; break; } } }
  return b;
}

function computeVendors(lcs) {
  const v = {};
  for (const lc of lcs) {
    const vn = OCS_LOCATIONS[lc.loc]?.vendor || "Unknown";
    if (!v[vn]) v[vn] = { vendor: vn, total: 0, open: 0, cost: 0, dwells: [], locs: new Set(), mats: new Set() };
    v[vn].total++; if (lc.open) v[vn].open++; v[vn].cost += lc.totalCost || 0; if (lc.dwell != null) v[vn].dwells.push(lc.dwell); v[vn].locs.add(lc.loc); v[vn].mats.add(lc.material);
  }
  return Object.values(v).map(x => ({ ...x, avgDwell: x.dwells.length ? x.dwells.reduce((a, b) => a + b, 0) / x.dwells.length : null, locCount: x.locs.size, matCount: x.mats.size })).sort((a, b) => b.total - a.total);
}

function computeMaterials(lcs) {
  const m = {};
  for (const lc of lcs) {
    if (!m[lc.material]) m[lc.material] = { material: lc.material, total: 0, open: 0, cost: 0, dwells: [], locs: new Set(), qty: 0 };
    m[lc.material].total++; if (lc.open) m[lc.material].open++; m[lc.material].cost += lc.totalCost || 0; if (lc.dwell != null) m[lc.material].dwells.push(lc.dwell); m[lc.material].locs.add(lc.loc); m[lc.material].qty += lc.qty || 0;
  }
  return Object.values(m).map(x => ({ ...x, avgDwell: x.dwells.length ? x.dwells.reduce((a, b) => a + b, 0) / x.dwells.length : null, locList: [...x.locs] })).sort((a, b) => b.total - a.total);
}

function exportCSV(lcs) {
  const h = ["Pallet", "Location", "Vendor", "Material", "MfgLot", "Qty", "PeakQty", "EntryDate", "ExitDate", "DwellDays", "Open", "PreExisting", "ExitReason", "EntryFrom", "ExitTo", "Handling", "InitialStorage", "RenewalStorage", "RenewalCycles", "TotalCost", "QtyShipped", "QtyPicked", "QtyAdjusted", "QtyTransferred"];
  const r = lcs.map(l => [l.pallet, l.loc, OCS_LOCATIONS[l.loc]?.vendor || "", l.material, l.mfgLot, l.qty, l.peakQty ?? "", fmtISO(l.entryDate), fmtISO(l.exitDate), l.dwell ?? "", l.open ? "Y" : "N", l.preExisting ? "Y" : "N", l.exitReason || "", l.entryFrom || "", l.exitTo || "", l.handling?.toFixed(2) || "0", l.initialStorage?.toFixed(2) || "0", l.renewalStorage?.toFixed(2) || "0", l.renewalCycles ?? 0, l.totalCost?.toFixed(2) || "0", l.qtyShipped ?? "", l.qtyPicked ?? "", l.qtyAdjusted ?? "", l.qtyTransferred ?? ""]);
  const csv = [h, ...r].map(x => x.map(c => `"${c}"`).join(",")).join("\n"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "ocs_lifecycle_export.csv"; a.click();
}

function Badge({ bg, color, children }) { return <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: bg, color, whiteSpace: "nowrap" }}>{children}</span>; }
function StatusBadge({ lc }) {
  if (lc.open) return <Badge bg="#E8F8ED" color={CV.green}>Open</Badge>;
  if (lc.preExisting) return <Badge bg="#FEF3E2" color={CV.orange}>Pre-Ex</Badge>;
  if (lc.exitReason === "depleted") return <Badge bg="#FDE8E8" color="#B44">Depleted</Badge>;
  if (lc.exitReason === "transferred") return <Badge bg="#E0F6FA" color={CV.teal}>Transferred</Badge>;
  if (lc.exitReason === "shipped") return <Badge bg="#F0F0F0" color="#999">Shipped</Badge>;
  return <Badge bg="#F0F0F0" color="#999">Closed</Badge>;
}
function Card({ children, style }) { return <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px", border: `1px solid ${CV.creamDark}`, ...style }}>{children}</div>; }
function SectionTitle({ children }) { return <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, color: CV.navy, textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</h3>; }
function KPI({ label, value, color, sub }) { return (<div style={{ flex: "1 0 130px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}><div style={{ fontSize: 22, fontWeight: 800, color: color || CV.navy }}>{value}</div><div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase", marginTop: 2 }}>{label}</div>{sub && <div style={{ fontSize: 10, color: "#bbb", marginTop: 2 }}>{sub}</div>}</div>); }

function FilterBar({ filters, setFilters, lifecycles }) {
  const vendors = useMemo(() => [...new Set(lifecycles.map(l => OCS_LOCATIONS[l.loc]?.vendor).filter(Boolean))].sort(), [lifecycles]);
  const locs = useMemo(() => [...new Set(lifecycles.map(l => l.loc))].sort(), [lifecycles]);
  const inp = { padding: "5px 8px", borderRadius: 6, border: `1px solid ${CV.creamDark}`, fontSize: 11, fontFamily: "monospace" };
  const pill = (on) => ({ padding: "4px 10px", borderRadius: 99, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 700, background: on ? CV.navy : CV.cream, color: on ? "#fff" : CV.navy });
  const has = filters.dateFrom || filters.dateTo || filters.vendors.length > 0 || filters.locations.length > 0 || filters.materialSearch || filters.statusFilter;
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: "12px 16px", border: `1px solid ${CV.creamDark}`, marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy, textTransform: "uppercase", letterSpacing: "0.05em" }}>Filters</div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, color: "#888" }}>From</span><input type="date" value={filters.dateFrom} onChange={e => setFilters({ ...filters, dateFrom: e.target.value })} style={inp} />
        <span style={{ fontSize: 10, color: "#888" }}>To</span><input type="date" value={filters.dateTo} onChange={e => setFilters({ ...filters, dateTo: e.target.value })} style={inp} />
      </div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>{vendors.map(v => <button key={v} style={pill(filters.vendors.includes(v))} onClick={() => setFilters({ ...filters, vendors: filters.vendors.includes(v) ? filters.vendors.filter(x => x !== v) : [...filters.vendors, v] })}>{v}</button>)}</div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>{locs.map(l => <button key={l} style={{ ...pill(filters.locations.includes(l)), fontSize: 9, padding: "3px 7px" }} onClick={() => setFilters({ ...filters, locations: filters.locations.includes(l) ? filters.locations.filter(x => x !== l) : [...filters.locations, l] })}>{l}</button>)}</div>
      <input type="text" placeholder="Material #" value={filters.materialSearch} onChange={e => setFilters({ ...filters, materialSearch: e.target.value })} style={{ ...inp, width: 90 }} />
      <button style={pill(filters.statusFilter === "open")} onClick={() => setFilters({ ...filters, statusFilter: filters.statusFilter === "open" ? "" : "open" })}>Open</button>
      <button style={pill(filters.statusFilter === "closed")} onClick={() => setFilters({ ...filters, statusFilter: filters.statusFilter === "closed" ? "" : "closed" })}>Closed</button>
      <button style={pill(filters.statusFilter === "depleted")} onClick={() => setFilters({ ...filters, statusFilter: filters.statusFilter === "depleted" ? "" : "depleted" })}>Depleted</button>
      <button style={pill(filters.statusFilter === "transferred")} onClick={() => setFilters({ ...filters, statusFilter: filters.statusFilter === "transferred" ? "" : "transferred" })}>Transferred</button>
      {has && <button onClick={() => setFilters({ dateFrom: "", dateTo: "", vendors: [], locations: [], materialSearch: "", statusFilter: "" })} style={{ padding: "4px 10px", borderRadius: 99, border: `1px solid ${CV.red}`, cursor: "pointer", fontSize: 10, fontWeight: 700, background: "#fff", color: CV.red }}>Clear</button>}
    </div>
  );
}

// ── Opportunities Engine ──────────────────────────────────────────────────────

function computeOpportunities(lifecycles, rates) {
  const opps = [];

  // Helper: group lifecycles by month using a date field
  const byMonth = (items, dateFn) => {
    const m = {};
    for (const lc of items) {
      const d = dateFn(lc); if (!d) continue;
      const k = mKey(d);
      if (!m[k]) m[k] = { period: k, count: 0, cost: 0 };
      m[k].count++;
      m[k].cost += lc.totalCost || 0;
    }
    return Object.values(m).sort((a, b) => a.period.localeCompare(b.period));
  };

  // 1. Short-dwell pallets (<=7 days) - why was this in OCS?
  const shortDwell = lifecycles.filter(lc => !lc.preExisting && !lc.open && lc.dwell != null && lc.dwell <= 7);
  if (shortDwell.length > 0) {
    const costWasted = shortDwell.reduce((s, lc) => s + (lc.totalCost || 0), 0);
    const byLoc = {};
    for (const lc of shortDwell) { byLoc[lc.loc] = (byLoc[lc.loc] || 0) + 1; }
    const trend = byMonth(shortDwell, lc => lc.exitDate);
    opps.push({
      id: "short-dwell", severity: "high", category: "Avoidable Cost",
      title: `${shortDwell.length.toLocaleString()} pallets left OCS within 7 days`,
      subtitle: "Product that enters and exits within a week may not need outside storage. Each pallet incurs full handling + initial storage charges regardless of dwell time.",
      metric: costWasted, metricLabel: "handling + storage charged",
      detail: shortDwell, byLoc, trend,
      recommendation: "Evaluate whether these materials could ship direct from F7 or use a cross-dock arrangement to avoid the initial storage charge.",
    });
  }

  // 2. Pallets crossing renewal thresholds by 1-3 days
  const nearMiss = lifecycles.filter(lc => !lc.preExisting && !lc.open && lc.dwell != null && lc.renewalCycles > 0 && (lc.dwell % (rates[lc.loc]?.cycleDays || 30)) <= 3);
  if (nearMiss.length > 0) {
    const extraCost = nearMiss.reduce((s, lc) => s + (rates[lc.loc]?.renewalStorage || 0), 0);
    const trend = byMonth(nearMiss, lc => lc.exitDate).map(t => {
      // Recalculate avoidable cost per month
      const monthItems = nearMiss.filter(lc => lc.exitDate && mKey(lc.exitDate) === t.period);
      return { ...t, cost: monthItems.reduce((s, lc) => s + (rates[lc.loc]?.renewalStorage || 0), 0) };
    });
    opps.push({
      id: "cycle-threshold", severity: "medium", category: "Timing Optimization",
      title: `${nearMiss.length.toLocaleString()} pallets crossed a renewal cycle by 1-3 days`,
      subtitle: "These pallets triggered an additional 30-day storage cycle because they stayed just slightly past the threshold. Earlier pull could have avoided the renewal charge.",
      metric: extraCost, metricLabel: "in avoidable renewal charges",
      detail: nearMiss, byLoc: {}, trend,
      recommendation: "Prioritize pull-forward on pallets approaching cycle boundaries. A 2-3 day earlier shipment would save the full renewal fee per pallet.",
    });
  }

  // 3. Stale open inventory (>90 days)
  const stale = lifecycles.filter(lc => lc.open && !lc.preExisting && lc.dwell > 90);
  if (stale.length > 0) {
    const staleCost = stale.reduce((s, lc) => s + (lc.totalCost || 0), 0);
    const byMat = {};
    for (const lc of stale) { byMat[lc.material] = (byMat[lc.material] || 0) + 1; }
    // Stale trend: by entry month (when did these stale pallets arrive?)
    const trend = byMonth(stale, lc => lc.entryDate);
    opps.push({
      id: "stale-inventory", severity: "high", category: "Inventory Velocity",
      title: `${stale.length.toLocaleString()} open pallets with 90+ day dwell`,
      subtitle: "Industry benchmark for frozen distribution is 30-45 day average dwell. Pallets beyond 90 days are accumulating renewal cycles and may indicate demand planning gaps.",
      metric: staleCost, metricLabel: "accrued cost on stale pallets",
      detail: stale, byLoc: {}, trend,
      recommendation: "Review materials with high stale counts. Consider markdown, reallocation, or write-off to stop the renewal bleed.",
      topMaterials: Object.entries(byMat).sort((a, b) => b[1] - a[1]).slice(0, 10),
    });
  }

  // 4. Vendor cost comparison - same material at different locations
  const matLocs = {};
  for (const lc of lifecycles.filter(l => !l.preExisting && l.dwell != null && l.hasRates)) {
    if (!matLocs[lc.material]) matLocs[lc.material] = {};
    if (!matLocs[lc.material][lc.loc]) matLocs[lc.material][lc.loc] = { count: 0, totalCost: 0, dwells: [] };
    matLocs[lc.material][lc.loc].count++;
    matLocs[lc.material][lc.loc].totalCost += lc.totalCost;
    matLocs[lc.material][lc.loc].dwells.push(lc.dwell);
  }
  const multiLocMats = Object.entries(matLocs).filter(([, locs]) => Object.keys(locs).length > 1);
  if (multiLocMats.length > 0) {
    const comparisons = multiLocMats.map(([mat, locs]) => {
      const entries = Object.entries(locs).map(([loc, d]) => ({
        loc, count: d.count, avgCost: d.totalCost / d.count, avgDwell: d.dwells.reduce((a, b) => a + b, 0) / d.dwells.length,
      })).sort((a, b) => a.avgCost - b.avgCost);
      const savings = entries.length >= 2 ? (entries[entries.length - 1].avgCost - entries[0].avgCost) * entries[entries.length - 1].count : 0;
      return { material: mat, entries, savings };
    }).filter(c => c.savings > 100).sort((a, b) => b.savings - a.savings);

    if (comparisons.length > 0) {
      opps.push({
        id: "vendor-arbitrage", severity: "medium", category: "Vendor Optimization",
        title: `${comparisons.length} materials stored at multiple locations with cost variance`,
        subtitle: "Same product stored at different vendors incurs different costs per pallet. Consolidating to the lower-cost location where operationally feasible reduces total spend.",
        metric: comparisons.reduce((s, c) => s + c.savings, 0), metricLabel: "potential savings from consolidation",
        comparisons: comparisons.slice(0, 15),
      });
    }
  }

  // 5. Forward cost projection on open inventory
  const openPallets = lifecycles.filter(lc => lc.open && !lc.preExisting && lc.dwell != null);
  if (openPallets.length > 0) {
    const projections = [30, 60, 90].map(days => {
      let projCost = 0;
      for (const lc of openPallets) {
        const r = rates[lc.loc]; if (!r || !lc.hasRates) continue;
        const futureDwell = lc.dwell + days;
        const futureCycles = Math.max(0, Math.ceil(futureDwell / (r.cycleDays || 30)) - 1);
        const futureTotal = r.handling + r.initialStorage + futureCycles * r.renewalStorage;
        projCost += futureTotal;
      }
      return { days, cost: projCost, delta: projCost - openPallets.reduce((s, lc) => s + (lc.totalCost || 0), 0) };
    });
    const currentCost = openPallets.reduce((s, lc) => s + (lc.totalCost || 0), 0);
    opps.push({
      id: "forward-projection", severity: "info", category: "Cost Projection",
      title: `${openPallets.length.toLocaleString()} open pallets accruing storage`,
      subtitle: "If current open inventory stays in OCS storage, here is the projected cost trajectory.",
      metric: currentCost, metricLabel: "current accrued cost",
      projections, palletCount: openPallets.length,
    });
  }

  // 6. Dwell benchmarking by location (with monthly trend)
  const benchmarks = [];
  const dwellTrend = {};
  for (const loc of Object.keys(OCS_LOCATIONS)) {
    const locLCs = lifecycles.filter(lc => lc.loc === loc && !lc.preExisting && lc.dwell != null && !lc.open);
    if (locLCs.length < 10) continue;
    const dwells = locLCs.map(lc => lc.dwell).sort((a, b) => a - b);
    const median = dwells[Math.floor(dwells.length / 2)];
    const p90 = dwells[Math.floor(dwells.length * 0.9)];
    const under30 = dwells.filter(d => d <= 30).length;
    const over60 = dwells.filter(d => d > 60).length;
    benchmarks.push({ loc, name: OCS_LOCATIONS[loc]?.name, median, p90, total: dwells.length, under30, under30Pct: (under30 / dwells.length * 100).toFixed(1), over60, over60Pct: (over60 / dwells.length * 100).toFixed(1) });

    // Monthly median dwell for this location
    const byMo = {};
    for (const lc of locLCs) {
      if (!lc.exitDate) continue;
      const k = mKey(lc.exitDate);
      if (!byMo[k]) byMo[k] = [];
      byMo[k].push(lc.dwell);
    }
    for (const [k, dwArr] of Object.entries(byMo)) {
      dwArr.sort((a, b) => a - b);
      if (!dwellTrend[k]) dwellTrend[k] = { period: k };
      dwellTrend[k][loc] = dwArr[Math.floor(dwArr.length / 2)];
    }
  }
  if (benchmarks.length > 0) {
    opps.push({
      id: "dwell-benchmark", severity: "info", category: "Benchmarking",
      title: "Dwell time benchmarks by location",
      subtitle: "Industry target for frozen distribution: median dwell under 30 days, 90th percentile under 60 days. Locations exceeding these thresholds have inventory velocity issues.",
      benchmarks: benchmarks.sort((a, b) => b.median - a.median),
      dwellTrend: Object.values(dwellTrend).sort((a, b) => a.period.localeCompare(b.period)),
      trendLocs: benchmarks.map(b => b.loc),
    });
  }

  return opps.sort((a, b) => {
    const sev = { high: 0, medium: 1, info: 2 };
    return (sev[a.severity] || 9) - (sev[b.severity] || 9);
  });
}

export default function App() {
  const [loadedFiles, setLoadedFiles] = useState([]);
  const [rawTx, setRawTx] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [lifecycles, setLifecycles] = useState(null);
  const [rates, setRates] = useState({ ...DEFAULT_RATES });
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [invoiceData, setInvoiceData] = useState([]);
  const [apiKey, setApiKey] = useState("");
  const [filters, setFilters] = useState({ dateFrom: "", dateTo: "", vendors: [], locations: [], materialSearch: "", statusFilter: "" });
  const [drillMat, setDrillMat] = useState(null);
  const [drillLoc, setDrillLoc] = useState(null);
  const [ohGran, setOhGran] = useState("week");
  const [savedProject, setSavedProject] = useState(null);
  const [lastSaved, setLastSaved] = useState(null);
  const [checkedDB, setCheckedDB] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const addRef = useRef(null);
  const importRef = useRef(null);
  const dropRef = useRef(null);

  // Check for saved project on mount
  useEffect(() => {
    loadProject().then(data => {
      if (data && data.rawTx && data.rawTx.length > 0) setSavedProject(data);
      setCheckedDB(true);
    }).catch(() => setCheckedDB(true));
  }, []);

  // Auto-save whenever raw transactions or rates change (debounced)
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!rawTx.length || !loadedFiles.length) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveProject({ rawTx, loadedFiles, rates, invoices: invoiceData }).then(ok => {
        if (ok) setLastSaved(new Date());
      });
    }, 2000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [rawTx, loadedFiles, rates, invoiceData]);

  const restoreSaved = useCallback(() => {
    if (!savedProject) return;
    setRawTx(savedProject.rawTx);
    setLoadedFiles(savedProject.loadedFiles);
    if (savedProject.rates) setRates(savedProject.rates);
    if (savedProject.invoices) setInvoiceData(savedProject.invoices);
    setLifecycles(rebuildFromTransactions(savedProject.rawTx, savedProject.rates || rates));
    setSavedProject(null);
  }, [savedProject, rates]);

  const handleImport = useCallback(async (fileList) => {
    const file = fileList[0];
    if (!file) return;
    setProcessing(true); setProgress("Importing project...");
    try {
      const data = await importProjectFile(file);
      setRawTx(data.rawTx); setLoadedFiles(data.loadedFiles); setRates(data.rates);
      if (data.invoices) setInvoiceData(data.invoices);
      setProgress("Building lifecycles..."); await new Promise(r => setTimeout(r, 50));
      setLifecycles(rebuildFromTransactions(data.rawTx, data.rates));
      setProgress(""); setProcessing(false);
    } catch (err) { setProgress(`Import error: ${err.message}`); setProcessing(false); }
  }, []);

  const addFile = useCallback(async (fl, auto = false) => {
    const arr = Array.from(fl).filter(f => f.name.match(/\.xlsx?$/i)); if (!arr.length) return;
    setProcessing(true);
    try {
      let acc = [...rawTx]; const nf = [...loadedFiles];
      for (let i = 0; i < arr.length; i++) {
        const file = arr[i];
        if (loadedFiles.some(f => f.name === file.name)) { setProgress(`${file.name} already loaded, skipping...`); await new Promise(r => setTimeout(r, 400)); continue; }
        setProgress(`File ${i + 1} of ${arr.length}: ${file.name}...`);
        await new Promise(r => setTimeout(r, 50));
        const res = await parseFileToTransactions(file, setProgress);
        acc = acc.concat(res.transactions);
        nf.push({ name: file.name, rows: res.totalRows, txCount: res.transactions.length });
        setProgress(`${file.name} complete: ${res.totalRows.toLocaleString()} rows, ${res.transactions.length.toLocaleString()} OCS transactions`);
        await new Promise(r => setTimeout(r, 300));
      }
      setRawTx(acc); setLoadedFiles(nf);
      if (auto && acc.length > 0) { setProgress("Building lifecycles from all transactions..."); await new Promise(r => setTimeout(r, 100)); setLifecycles(rebuildFromTransactions(acc, rates)); }
      setProgress(""); setProcessing(false);
    } catch (err) { setProgress(`Error: ${err.message}`); setProcessing(false); }
  }, [rawTx, loadedFiles, rates]);
  const reset = useCallback(() => { setLoadedFiles([]); setRawTx([]); setLifecycles(null); setInvoiceData([]); setTab("overview"); setProgress(""); setDrillMat(null); setDrillLoc(null); setLastSaved(null); clearProject(); }, []);

  const costed = useMemo(() => lifecycles ? computeCosts(lifecycles, rates) : null, [lifecycles, rates]);
  const filtered = useMemo(() => {
    if (!costed) return []; let d = costed;
    if (filters.dateFrom) { const dt = new Date(filters.dateFrom); d = d.filter(l => (l.entryDate && l.entryDate >= dt) || (l.exitDate && l.exitDate >= dt)); }
    if (filters.dateTo) { const dt = new Date(filters.dateTo); dt.setDate(dt.getDate() + 1); d = d.filter(l => (l.entryDate && l.entryDate < dt) || (!l.entryDate && l.exitDate && l.exitDate < dt)); }
    if (filters.vendors.length) d = d.filter(l => filters.vendors.includes(OCS_LOCATIONS[l.loc]?.vendor));
    if (filters.locations.length) d = d.filter(l => filters.locations.includes(l.loc));
    if (filters.materialSearch) { const q = filters.materialSearch.toUpperCase(); d = d.filter(l => l.material.toUpperCase().includes(q)); }
    if (filters.statusFilter === "open") d = d.filter(l => l.open);
    if (filters.statusFilter === "closed") d = d.filter(l => !l.open && !l.preExisting);
    if (filters.statusFilter === "depleted") d = d.filter(l => l.exitReason === "depleted");
    if (filters.statusFilter === "transferred") d = d.filter(l => l.exitReason === "transferred");
    return d;
  }, [costed, filters]);

  const locStats = useMemo(() => {
    const s = {};
    for (const loc of Object.keys(OCS_LOCATIONS)) {
      const lcs = filtered.filter(l => l.loc === loc); const valid = lcs.filter(l => !l.preExisting && l.dwell != null); const dwells = valid.map(l => l.dwell);
      s[loc] = { total: lcs.length, valid: valid.length, open: lcs.filter(l => l.open).length, preEx: lcs.filter(l => l.preExisting).length, depleted: lcs.filter(l => l.exitReason === "depleted").length, transferred: lcs.filter(l => l.exitReason === "transferred").length, avgDwell: dwells.length ? dwells.reduce((a, b) => a + b, 0) / dwells.length : null, cost: lcs.reduce((a, l) => a + (l.totalCost || 0), 0), mats: new Set(lcs.map(l => l.material)).size, lcs };
    }
    return s;
  }, [filtered]);

  const actLocs = useMemo(() => Object.entries(locStats).filter(([, s]) => s.total > 0).sort((a, b) => b[1].total - a[1].total), [locStats]);
  const totals = useMemo(() => ({ pallets: actLocs.reduce((s, [, d]) => s + d.total, 0), open: actLocs.reduce((s, [, d]) => s + d.open, 0), cost: actLocs.reduce((s, [, d]) => s + d.cost, 0), preEx: actLocs.reduce((s, [, d]) => s + d.preEx, 0), depleted: actLocs.reduce((s, [, d]) => s + d.depleted, 0), transferred: actLocs.reduce((s, [, d]) => s + d.transferred, 0) }), [actLocs]);
  const ohData = useMemo(() => filtered.length ? computeOnHand(filtered, ohGran) : [], [filtered, ohGran]);
  const tpData = useMemo(() => computeThroughput(filtered), [filtered]);
  const clData = useMemo(() => computeCostByLoc(filtered), [filtered]);
  const agData = useMemo(() => computeAging(filtered), [filtered]);
  const vnData = useMemo(() => computeVendors(filtered), [filtered]);
  const mtData = useMemo(() => computeMaterials(filtered), [filtered]);
  const actCodes = useMemo(() => actLocs.map(([c]) => c), [actLocs]);
  const searchRes = useMemo(() => { if (!costed || search.length < 3) return []; const q = search.toUpperCase(); return costed.filter(l => l.pallet.toUpperCase().includes(q) || l.material.toUpperCase().includes(q) || l.mfgLot.toUpperCase().includes(q)).slice(0, 500); }, [costed, search]);
  const oppsData = useMemo(() => costed ? computeOpportunities(costed, rates) : [], [costed, rates]);

  // Landing
  if (!lifecycles) {
    const exp = ["WMS_1.xlsx", "WMS_2.xlsx", "WMS_DATA_2026YTD.xlsx"];
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', system-ui, sans-serif", background: CV.cream }}>
        <div style={{ maxWidth: 560, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: CV.red, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>OCS Platform</div>
            <h1 style={{ margin: "0 0 8px", fontSize: 28, fontWeight: 800, color: CV.navy }}>Pallet Lifecycle Analyzer</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#888" }}>Load WMS files, import a saved project, or resume your last session.</p>
          </div>

          {/* Saved project banner */}
          {checkedDB && savedProject && !loadedFiles.length && (
            <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px", border: `2px solid ${CV.green}`, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: CV.green, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800 }}>{"\u21BB"}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: CV.navy }}>Resume Last Session</div>
                  <div style={{ fontSize: 11, color: "#888" }}>
                    {savedProject.loadedFiles.length} file{savedProject.loadedFiles.length !== 1 ? "s" : ""} loaded,{" "}
                    {savedProject.rawTx.length.toLocaleString()} transactions
                    {savedProject.savedAt && <span> (saved {new Date(savedProject.savedAt).toLocaleDateString()})</span>}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                {savedProject.loadedFiles.map(f => (
                  <Badge key={f.name} bg={CV.navyLight} color={CV.navy}>{f.name}</Badge>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={restoreSaved} style={{ padding: "10px 24px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#fff", background: CV.green }}>Resume</button>
                <button onClick={() => { setSavedProject(null); clearProject(); }} style={{ padding: "10px 16px", borderRadius: 8, border: `1px solid ${CV.creamDark}`, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#999", background: "#fff" }}>Discard</button>
              </div>
            </div>
          )}

          <Card style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, textTransform: "uppercase", marginBottom: 14 }}>Load WMS Files</div>
            {exp.map(fn => { const ld = loadedFiles.find(f => f.name === fn); return (
              <div key={fn} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${CV.cream}` }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: ld ? CV.green : CV.creamDark, color: ld ? "#fff" : "#999", fontSize: 12, fontWeight: 800 }}>{ld ? "\u2713" : "\u2022"}</div>
                <div><div style={{ fontSize: 13, fontWeight: 600, color: ld ? CV.navy : "#999", fontFamily: "monospace" }}>{fn}</div>{ld && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{ld.rows.toLocaleString()} rows, {ld.txCount.toLocaleString()} OCS txns</div>}</div>
              </div>); })}

            {/* Drag and drop zone */}
            <div ref={dropRef}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
              onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
              onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
              onDrop={e => {
                e.preventDefault(); e.stopPropagation(); setDragging(false);
                const files = e.dataTransfer.files;
                // Check if it's a JSON project file
                if (files.length === 1 && files[0].name.endsWith(".json")) { handleImport(files); }
                else { addFile(files, false); }
              }}
              style={{
                marginTop: 16, padding: "24px 16px", borderRadius: 10,
                border: `2px dashed ${dragging ? CV.teal : CV.creamDark}`,
                background: dragging ? "rgba(0,163,190,0.05)" : "transparent",
                textAlign: "center", cursor: "pointer", transition: "all 0.2s",
              }}
              onClick={() => fileRef.current?.click()}
            >
              <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.4 }}>{dragging ? "\u2B07" : "\u2193"}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: dragging ? CV.teal : CV.navy }}>
                {dragging ? "Drop files here" : "Drag and drop WMS files here"}
              </div>
              <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>or click to browse. Select multiple files at once.</div>
            </div>
          </Card>
          {loadedFiles.length > 0 && <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>{[{ l: "Files", v: loadedFiles.length }, { l: "Rows", v: loadedFiles.reduce((s, f) => s + f.rows, 0).toLocaleString() }, { l: "OCS Txns", v: rawTx.length.toLocaleString() }].map(s => <div key={s.l} style={{ flex: 1, background: CV.navyLight, borderRadius: 10, padding: "12px 16px", textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: CV.navy }}>{s.v}</div><div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>{s.l.toUpperCase()}</div></div>)}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple style={{ display: "none" }} onChange={e => { addFile(e.target.files, false); e.target.value = ""; }} />

            <input ref={importRef} type="file" accept=".json" style={{ display: "none" }} onChange={e => { handleImport(e.target.files); e.target.value = ""; }} />
            <button onClick={() => importRef.current?.click()} disabled={processing} style={{ padding: "12px 20px", borderRadius: 10, border: `1px solid ${CV.creamDark}`, cursor: processing ? "default" : "pointer", fontSize: 13, fontWeight: 600, color: CV.navy, background: "#fff" }}>Import Project (.json)</button>

            {loadedFiles.length > 0 && !processing && <button onClick={reset} style={{ padding: "12px 20px", borderRadius: 10, border: `1px solid ${CV.creamDark}`, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#999", background: "#fff" }}>Start Over</button>}
          </div>
          {(progress || processing) && <div style={{ marginTop: 16, padding: "16px 20px", background: CV.navyLight, borderRadius: 10, fontSize: 13, color: CV.navy, textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
              {processing && <div style={{ width: 20, height: 20, border: `3px solid ${CV.creamDark}`, borderTopColor: CV.navy, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />}
              <span>{progress || "Processing..."}</span>
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>}
          {loadedFiles.length > 0 && !processing && <div style={{ marginTop: 20, textAlign: "center" }}><button onClick={async () => { setProcessing(true); setProgress("Building lifecycles from all transactions..."); await new Promise(r => setTimeout(r, 100)); setLifecycles(rebuildFromTransactions(rawTx, rates)); setProcessing(false); setProgress(""); }} style={{ padding: "12px 28px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#fff", background: CV.green }}>{loadedFiles.length >= 3 ? "Build Lifecycles" : "Analyze What's Loaded"}</button></div>}
        </div>
      </div>
    );
  }

  const TABS = [{ k: "overview", l: "Overview" }, { k: "onhand", l: "On Hand" }, { k: "throughput", l: "Throughput" }, { k: "costs", l: "Cost Trends" }, { k: "aging", l: "Aging" }, { k: "opportunities", l: "Opportunities" }, { k: "invoices", l: "Invoices" }, { k: "reconciliation", l: "Reconciliation" }, { k: "agent", l: "AI Agent" }, { k: "vendors", l: "Vendors" }, { k: "materials", l: "Materials" }, { k: "locations", l: "Locations" }, { k: "search", l: "Search" }, { k: "rates", l: "Rates" }];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif", background: CV.cream, color: CV.navy }}>
      <div style={{ background: CV.navy, padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: CV.red, textTransform: "uppercase" }}>OCS</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>Pallet Lifecycle Analyzer</span>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{loadedFiles.length} files | {fmtN(totals.pallets)} lifecycles</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input ref={addRef} type="file" accept=".xlsx,.xls" multiple style={{ display: "none" }} onChange={e => { addFile(e.target.files, true); e.target.value = ""; }} />
          <button onClick={() => addRef.current?.click()} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#fff", background: "transparent" }}>+ File</button>
          <button onClick={() => exportCSV(filtered)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#fff", background: "transparent" }}>CSV</button>
          <button onClick={() => exportProjectFile(rawTx, loadedFiles, rates, invoiceData)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#fff", background: "transparent" }}>Save Project</button>
          <button onClick={reset} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.5)", background: "transparent" }}>Reset</button>
          {lastSaved && <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", alignSelf: "center" }}>auto-saved {lastSaved.toLocaleTimeString()}</span>}
        </div>
      </div>
      <div style={{ background: "#fff", padding: "0 24px", borderBottom: `1px solid ${CV.creamDark}`, display: "flex", gap: 0, overflowX: "auto", flexShrink: 0 }}>
        {TABS.map(t => <button key={t.k} onClick={() => { setTab(t.k); setDrillMat(null); setDrillLoc(null); }} style={{ padding: "10px 16px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: "transparent", color: tab === t.k ? CV.navy : "#999", borderBottom: tab === t.k ? `3px solid ${CV.red}` : "3px solid transparent" }}>{t.l}</button>)}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {!["rates", "search", "invoices", "reconciliation", "agent"].includes(tab) && costed && <FilterBar filters={filters} setFilters={setFilters} lifecycles={costed} />}

        {tab === "overview" && <>
          <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            <KPI label="Total Lifecycles" value={fmtN(totals.pallets)} /><KPI label="Open" value={fmtN(totals.open)} color={CV.green} /><KPI label="Depleted" value={fmtN(totals.depleted)} color="#B44" sub="case pick + adj" /><KPI label="Pre-existing" value={fmtN(totals.preEx)} color={CV.orange} /><KPI label="Modeled Cost" value={totals.cost > 0 ? fmtK(totals.cost) : "---"} color={CV.red} /><KPI label="Locations" value={actLocs.length} color={CV.teal} />
          </div>
          {lifecycles?._dedupStats?.totalRemoved > 0 && (() => { const ds = lifecycles._dedupStats; return (
            <div style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "12px 18px", border: `1px solid ${CV.creamDark}`, borderLeft: `3px solid ${CV.teal}`, display: "flex", alignItems: "center", gap: 16, fontSize: 11 }}>
              <span style={{ fontWeight: 700, color: CV.teal, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Dedup Active</span>
              <span style={{ color: "#666" }}>
                {fmtN(ds.entryDupsRemoved)} duplicate inbound + {fmtN(ds.exitDupsRemoved)} duplicate outbound records removed across {loadedFiles.length} files.
                {ds.entryDupsRemoved > 0 && ` Prevents ~${fmtN(ds.entryDupsRemoved)} phantom open records from appearing in search and aging.`}
              </span>
            </div>
          ); })()}
          <Card style={{ marginBottom: 16 }}><SectionTitle>Location Summary</SectionTitle><div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ background: CV.navy }}>{["Code", "Location", "Vendor", "Total", "Open", "Avg Dwell", "Mats", "Cost", "$/Plt"].map(h => <th key={h} style={{ padding: "9px 10px", textAlign: ["Code", "Location", "Vendor"].includes(h) ? "left" : "right", color: "#fff", fontWeight: 700, fontSize: 10 }}>{h}</th>)}</tr></thead>
              <tbody>{actLocs.map(([loc, d], i) => { const info = OCS_LOCATIONS[loc]; const cpp = d.valid > 0 && d.cost > 0 ? d.cost / d.valid : null; return (
                <tr key={loc} style={{ background: i % 2 === 0 ? "#fff" : CV.cream, cursor: "pointer" }} onClick={() => { setDrillLoc(loc); setTab("locations"); }}>
                  <td style={{ padding: "8px 10px", fontWeight: 800, fontFamily: "monospace" }}>{loc}</td><td style={{ padding: "8px 10px", fontWeight: 600 }}>{info?.name}</td><td style={{ padding: "8px 10px", color: "#666" }}>{info?.vendor}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>{fmtN(d.total)}</td><td style={{ padding: "8px 10px", textAlign: "right", color: d.open > 0 ? CV.green : "#999" }}>{fmtN(d.open)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace" }}>{d.avgDwell != null ? `${d.avgDwell.toFixed(0)}d` : "---"}</td><td style={{ padding: "8px 10px", textAlign: "right" }}>{d.mats}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600, fontFamily: "monospace", color: d.cost > 0 ? CV.navy : "#ccc" }}>{d.cost > 0 ? fmtK(d.cost) : "---"}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace", color: cpp ? CV.red : "#ccc" }}>{cpp ? fmt$(cpp) : "---"}</td>
                </tr>); })}</tbody>
            </table></div>
          </Card>
          {tpData.length > 0 && <Card><SectionTitle>Monthly Entries vs Exits</SectionTitle><ResponsiveContainer width="100%" height={220}><BarChart data={tpData}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="entries" name="In" fill={CV.green} radius={[3, 3, 0, 0]} /><Bar dataKey="exits" name="Out" fill={CV.red} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></Card>}
        </>}

        {tab === "onhand" && <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Pallets On Hand Over Time</h2>
            <div style={{ display: "flex", gap: 4 }}>{["week", "month"].map(g => <button key={g} onClick={() => setOhGran(g)} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, background: ohGran === g ? CV.navy : "#fff", color: ohGran === g ? "#fff" : CV.navy }}>{g === "week" ? "Weekly" : "Monthly"}</button>)}</div>
          </div>
          {ohData.length > 0 && <><Card style={{ marginBottom: 16 }}><SectionTitle>Total On Hand</SectionTitle><ResponsiveContainer width="100%" height={300}><AreaChart data={ohData}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 9 }} interval={ohGran === "week" ? 3 : 0} angle={-45} textAnchor="end" height={50} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Area type="monotone" dataKey="total" stroke={CV.navy} fill={CV.navyLight} strokeWidth={2} /></AreaChart></ResponsiveContainer></Card>
          <Card><SectionTitle>By Location (Stacked)</SectionTitle><ResponsiveContainer width="100%" height={300}><AreaChart data={ohData}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 9 }} interval={ohGran === "week" ? 3 : 0} angle={-45} textAnchor="end" height={50} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Legend />{actCodes.map((loc, i) => <Area key={loc} type="monotone" dataKey={loc} name={`${loc}`} stackId="1" stroke={LOC_COLORS[i % LOC_COLORS.length]} fill={LOC_COLORS[i % LOC_COLORS.length]} fillOpacity={0.7} />)}</AreaChart></ResponsiveContainer></Card></>}
        </>}

        {tab === "throughput" && tpData.length > 0 && <>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Throughput</h2>
          <Card style={{ marginBottom: 16 }}><SectionTitle>Entries vs Exits</SectionTitle><ResponsiveContainer width="100%" height={280}><BarChart data={tpData}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Legend /><Bar dataKey="entries" name="In" fill={CV.green} radius={[3, 3, 0, 0]} /><Bar dataKey="exits" name="Out" fill={CV.red} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></Card>
          <Card style={{ marginBottom: 16 }}><SectionTitle>Net Change</SectionTitle><ResponsiveContainer width="100%" height={200}><BarChart data={tpData.map(d => ({ ...d, net: d.entries - d.exits }))}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="net" name="Net">{tpData.map((d, i) => <Cell key={i} fill={d.entries - d.exits >= 0 ? CV.green : CV.red} />)}</Bar></BarChart></ResponsiveContainer></Card>
          <Card><SectionTitle>Detail</SectionTitle><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>{["Month", "In", "Out", "Net", "Cum. Net", "Cost"].map(h => <th key={h} style={{ padding: "6px 10px", textAlign: h === "Month" ? "left" : "right", fontWeight: 700, fontSize: 10, color: CV.navy }}>{h}</th>)}</tr></thead><tbody>{(() => { let cn = 0; return tpData.map((d, i) => { const n = d.entries - d.exits; cn += n; return <tr key={d.period} style={{ borderBottom: `1px solid ${CV.cream}` }}><td style={{ padding: "7px 10px", fontWeight: 600, fontFamily: "monospace" }}>{d.period}</td><td style={{ padding: "7px 10px", textAlign: "right", color: CV.green, fontWeight: 600 }}>{fmtN(d.entries)}</td><td style={{ padding: "7px 10px", textAlign: "right", color: CV.red, fontWeight: 600 }}>{fmtN(d.exits)}</td><td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: n >= 0 ? CV.green : CV.red }}>{n > 0 ? "+" : ""}{fmtN(n)}</td><td style={{ padding: "7px 10px", textAlign: "right", color: cn >= 0 ? CV.teal : CV.orange }}>{cn > 0 ? "+" : ""}{fmtN(cn)}</td><td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>{d.cost > 0 ? fmtK(d.cost) : "---"}</td></tr>; }); })()}</tbody></table></div></Card>
        </>}

        {tab === "costs" && clData.length > 0 && <>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Cost Trends</h2>
          <Card style={{ marginBottom: 16 }}><SectionTitle>Monthly Cost by Location</SectionTitle><ResponsiveContainer width="100%" height={300}><BarChart data={clData}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} /><Tooltip formatter={v => fmt$(v)} /><Legend />{actCodes.filter(l => clData.some(d => d[l] > 0)).map((l, i) => <Bar key={l} dataKey={l} name={l} stackId="a" fill={LOC_COLORS[i % LOC_COLORS.length]} />)}</BarChart></ResponsiveContainer></Card>
          <Card><SectionTitle>Total Cost Trend</SectionTitle><ResponsiveContainer width="100%" height={200}><LineChart data={tpData}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} /><Tooltip formatter={v => fmt$(v)} /><Line type="monotone" dataKey="cost" name="Total" stroke={CV.red} strokeWidth={2} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></Card>
        </>}

        {tab === "aging" && <>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Inventory Aging</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Card style={{ flex: "2 0 400px" }}><SectionTitle>Distribution</SectionTitle><ResponsiveContainer width="100%" height={250}><BarChart data={agData.filter(b => b.count > 0)} layout="vertical"><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis type="number" tick={{ fontSize: 10 }} /><YAxis dataKey="label" type="category" tick={{ fontSize: 10 }} width={80} /><Tooltip /><Bar dataKey="count" name="Pallets">{agData.filter(b => b.count > 0).map((b, i) => <Cell key={i} fill={b.color} />)}</Bar></BarChart></ResponsiveContainer></Card>
            <Card style={{ flex: "1 0 250px" }}><SectionTitle>Summary</SectionTitle><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>{["Bucket", "Plts", "Cost"].map(h => <th key={h} style={{ padding: "6px 8px", textAlign: h === "Bucket" ? "left" : "right", fontWeight: 700, fontSize: 10, color: CV.navy }}>{h}</th>)}</tr></thead><tbody>{agData.map(b => <tr key={b.label} style={{ borderBottom: `1px solid ${CV.cream}`, opacity: b.count === 0 ? 0.3 : 1 }}><td style={{ padding: "6px 8px" }}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: b.color, marginRight: 6 }} />{b.label}</td><td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700 }}>{fmtN(b.count)}</td><td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace" }}>{b.cost > 0 ? fmt$(b.cost) : "---"}</td></tr>)}<tr style={{ background: CV.navyLight, fontWeight: 700 }}><td style={{ padding: "8px" }}>Total</td><td style={{ padding: "8px", textAlign: "right" }}>{fmtN(agData.reduce((s, b) => s + b.count, 0))}</td><td style={{ padding: "8px", textAlign: "right", fontFamily: "monospace" }}>{fmt$(agData.reduce((s, b) => s + b.cost, 0))}</td></tr></tbody></table></Card>
          </div>
        </>}

        {tab === "opportunities" && <>
          <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>Opportunities and Benchmarking</h2>
          <p style={{ margin: "0 0 20px", fontSize: 12, color: "#888", lineHeight: 1.5 }}>
            Automated analysis of waste patterns, cost avoidance opportunities, and benchmarks against industry standards.
            {oppsData.length > 0 && ` ${oppsData.filter(o => o.severity === "high").length} high-priority items identified.`}
          </p>

          {oppsData.map(opp => {
            const sevColors = { high: { bg: "#FEEEEC", border: CV.red, badge: CV.red }, medium: { bg: "#FEF3E2", border: CV.orange, badge: CV.orange }, info: { bg: CV.navyLight, border: CV.navy, badge: CV.teal } };
            const sc = sevColors[opp.severity] || sevColors.info;
            return (
              <Card key={opp.id} style={{ marginBottom: 16, borderLeft: `4px solid ${sc.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <Badge bg={sc.bg} color={sc.badge}>{opp.severity.toUpperCase()}</Badge>
                  <Badge bg={CV.navyLight} color={CV.navy}>{opp.category}</Badge>
                </div>
                <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 700, color: CV.navy }}>{opp.title}</h3>
                <p style={{ margin: "0 0 12px", fontSize: 12, color: "#666", lineHeight: 1.6 }}>{opp.subtitle}</p>

                {opp.metric != null && (
                  <div style={{ display: "inline-flex", alignItems: "baseline", gap: 6, background: sc.bg, padding: "8px 14px", borderRadius: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 20, fontWeight: 800, color: sc.badge, fontFamily: "monospace" }}>{fmt$(opp.metric)}</span>
                    <span style={{ fontSize: 11, color: "#888" }}>{opp.metricLabel}</span>
                  </div>
                )}

                {opp.recommendation && (
                  <div style={{ background: CV.cream, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy, textTransform: "uppercase", marginBottom: 4 }}>Recommendation</div>
                    <div style={{ fontSize: 12, color: CV.navy, lineHeight: 1.5 }}>{opp.recommendation}</div>
                  </div>
                )}

                {/* Monthly trend chart - shows for any opp with trend data */}
                {opp.trend && opp.trend.length > 1 && (
                  <div style={{ marginTop: 16, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, marginBottom: 8 }}>
                      Monthly Trend {opp.id === "stale-inventory" ? "(by entry month of stale pallets)" : "(by exit month)"}
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ flex: "1 0 300px" }}>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={opp.trend}>
                            <CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} />
                            <XAxis dataKey="period" tick={{ fontSize: 9 }} angle={-45} textAnchor="end" height={40} />
                            <YAxis tick={{ fontSize: 10 }} />
                            <Tooltip />
                            <Bar dataKey="count" name="Pallets" fill={opp.severity === "high" ? CV.red : CV.orange} radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ flex: "1 0 300px" }}>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={opp.trend}>
                            <CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} />
                            <XAxis dataKey="period" tick={{ fontSize: 9 }} angle={-45} textAnchor="end" height={40} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
                            <Tooltip formatter={v => fmt$(v)} />
                            <Bar dataKey="cost" name="Avoidable Cost" fill={CV.navy} radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    {opp.trend.length >= 3 && (() => {
                      const last3 = opp.trend.slice(-3);
                      const first3 = opp.trend.slice(0, 3);
                      const recentAvg = last3.reduce((s, t) => s + t.count, 0) / last3.length;
                      const earlyAvg = first3.reduce((s, t) => s + t.count, 0) / first3.length;
                      const direction = recentAvg < earlyAvg ? "improving" : recentAvg > earlyAvg ? "worsening" : "stable";
                      const pctChange = earlyAvg > 0 ? ((recentAvg - earlyAvg) / earlyAvg * 100).toFixed(0) : 0;
                      return (
                        <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6,
                          background: direction === "improving" ? "#E8F8ED" : direction === "worsening" ? "#FEEEEC" : CV.navyLight }}>
                          <span style={{ fontSize: 12, fontWeight: 700,
                            color: direction === "improving" ? CV.green : direction === "worsening" ? CV.red : CV.navy }}>
                            {direction === "improving" ? "\u2193" : direction === "worsening" ? "\u2191" : "\u2192"} Trend: {direction}
                          </span>
                          <span style={{ fontSize: 11, color: "#666", marginLeft: 8 }}>
                            Last 3 months avg: {recentAvg.toFixed(0)}/mo vs early avg: {earlyAvg.toFixed(0)}/mo ({pctChange > 0 ? "+" : ""}{pctChange}%)
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Short dwell breakdown */}
                {opp.id === "short-dwell" && opp.byLoc && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    {Object.entries(opp.byLoc).sort((a, b) => b[1] - a[1]).map(([loc, cnt]) => (
                      <div key={loc} style={{ background: "#fff", border: `1px solid ${CV.creamDark}`, borderRadius: 6, padding: "6px 10px" }}>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, marginRight: 4 }}>{loc}</span>
                        <span style={{ fontSize: 11, color: "#888" }}>{cnt} pallets</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Stale inventory top materials */}
                {opp.id === "stale-inventory" && opp.topMaterials && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, marginBottom: 6 }}>Top Materials (by stale pallet count)</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {opp.topMaterials.map(([mat, cnt]) => (
                        <div key={mat} style={{ background: "#fff", border: `1px solid ${CV.creamDark}`, borderRadius: 6, padding: "4px 8px", cursor: "pointer" }} onClick={() => { setDrillMat(mat); setTab("materials"); }}>
                          <span style={{ fontFamily: "monospace", fontWeight: 600, fontSize: 11, marginRight: 4 }}>{mat}</span>
                          <span style={{ fontSize: 10, color: CV.red }}>{cnt}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Vendor cost comparisons */}
                {opp.id === "vendor-arbitrage" && opp.comparisons && (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>{["Material", "Cheapest Loc", "$/Plt", "Expensive Loc", "$/Plt", "Potential Savings"].map(h => <th key={h} style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, fontSize: 10, color: CV.navy }}>{h}</th>)}</tr></thead>
                      <tbody>{opp.comparisons.slice(0, 10).map((c, i) => (
                        <tr key={c.material} style={{ borderBottom: `1px solid ${CV.cream}` }}>
                          <td style={{ padding: "5px 8px", fontFamily: "monospace", fontWeight: 600 }}>{c.material}</td>
                          <td style={{ padding: "5px 8px", color: CV.green }}>{c.entries[0].loc} ({OCS_LOCATIONS[c.entries[0].loc]?.name})</td>
                          <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{fmt$(c.entries[0].avgCost)}</td>
                          <td style={{ padding: "5px 8px", color: CV.red }}>{c.entries[c.entries.length - 1].loc} ({OCS_LOCATIONS[c.entries[c.entries.length - 1].loc]?.name})</td>
                          <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{fmt$(c.entries[c.entries.length - 1].avgCost)}</td>
                          <td style={{ padding: "5px 8px", fontWeight: 700, fontFamily: "monospace", color: CV.green }}>{fmt$(c.savings)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}

                {/* Forward cost projection */}
                {opp.id === "forward-projection" && opp.projections && (
                  <div>
                    <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                      {opp.projections.map(p => (
                        <div key={p.days} style={{ flex: "1 0 140px", background: "#fff", border: `1px solid ${CV.creamDark}`, borderRadius: 8, padding: "12px 14px" }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>If held {p.days} more days</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: CV.red, fontFamily: "monospace" }}>{fmtK(p.cost)}</div>
                          <div style={{ fontSize: 10, color: CV.orange }}>+{fmtK(p.delta)} from today</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: "#888" }}>{opp.palletCount.toLocaleString()} open pallets included in projection. Assumes no additional entries or exits.</div>
                  </div>
                )}

                {/* Dwell benchmarks */}
                {opp.id === "dwell-benchmark" && opp.benchmarks && (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead><tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>{["Code", "Location", "Median Dwell", "90th %ile", "Under 30d", "Over 60d", "Assessment"].map(h => <th key={h} style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, fontSize: 10, color: CV.navy }}>{h}</th>)}</tr></thead>
                      <tbody>{opp.benchmarks.map(b => {
                        const good = b.median <= 30; const ok = b.median <= 45;
                        return (
                          <tr key={b.loc} style={{ borderBottom: `1px solid ${CV.cream}` }}>
                            <td style={{ padding: "6px 8px", fontWeight: 800, fontFamily: "monospace" }}>{b.loc}</td>
                            <td style={{ padding: "6px 8px", fontWeight: 600 }}>{b.name}</td>
                            <td style={{ padding: "6px 8px", fontWeight: 700, color: good ? CV.green : ok ? CV.orange : CV.red }}>{b.median}d</td>
                            <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{b.p90}d</td>
                            <td style={{ padding: "6px 8px", color: CV.green }}>{b.under30Pct}%</td>
                            <td style={{ padding: "6px 8px", color: b.over60Pct > 20 ? CV.red : "#888" }}>{b.over60Pct}%</td>
                            <td style={{ padding: "6px 8px" }}>
                              <Badge bg={good ? "#E8F8ED" : ok ? "#FEF3E2" : "#FEEEEC"} color={good ? CV.green : ok ? CV.orange : CV.red}>
                                {good ? "On target" : ok ? "Needs improvement" : "Over benchmark"}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                    <div style={{ marginTop: 12, fontSize: 11, color: "#888", lineHeight: 1.5 }}>
                      Industry benchmarks for frozen distribution: Median dwell target is under 30 days. 90th percentile should be under 60 days. Over 20% of pallets exceeding 60 days indicates an inventory velocity problem.
                    </div>
                    {opp.dwellTrend && opp.dwellTrend.length > 1 && (
                      <div style={{ marginTop: 20 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, marginBottom: 8 }}>Monthly Median Dwell by Location (days)</div>
                        <ResponsiveContainer width="100%" height={250}>
                          <LineChart data={opp.dwellTrend.map(d => ({ ...d, target30: 30 }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} />
                            <XAxis dataKey="period" tick={{ fontSize: 9 }} angle={-45} textAnchor="end" height={40} />
                            <YAxis tick={{ fontSize: 10 }} />
                            <Tooltip />
                            <Legend />
                            <Line type="monotone" dataKey="target30" name="30d target" stroke="#ccc" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                            {opp.trendLocs.map((loc, i) => (
                              <Line key={loc} type="monotone" dataKey={loc} name={`${loc} (${OCS_LOCATIONS[loc]?.name})`} stroke={LOC_COLORS[i % LOC_COLORS.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}

          {oppsData.length === 0 && <Card><div style={{ padding: "32px", textAlign: "center", color: "#aaa" }}>Load data and build lifecycles to see opportunities.</div></Card>}
        </>}

        {tab === "vendors" && <>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Vendor Rollup</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>{vnData.map(v => <Card key={v.vendor} style={{ flex: "1 0 280px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}><h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{v.vendor}</h3><Badge bg={CV.navyLight} color={CV.navy}>{v.locCount} loc{v.locCount > 1 ? "s" : ""}</Badge></div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}><KPI label="Total" value={fmtN(v.total)} /><KPI label="Open" value={fmtN(v.open)} color={CV.green} /><KPI label="Avg Dwell" value={v.avgDwell ? `${v.avgDwell.toFixed(0)}d` : "---"} color={CV.teal} /></div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderTop: `1px solid ${CV.cream}` }}><span style={{ fontSize: 12, color: "#666" }}>Cost</span><span style={{ fontSize: 14, fontWeight: 700, fontFamily: "monospace", color: v.cost > 0 ? CV.red : "#ccc" }}>{v.cost > 0 ? fmtK(v.cost) : "---"}</span></div>
          </Card>)}</div>
        </>}

        {tab === "materials" && !drillMat && <>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Materials</h2>
          <Card><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ background: CV.navy }}>{["Material", "Count", "Open", "Avg Dwell", "Locs", "Qty", "Cost"].map(h => <th key={h} style={{ padding: "9px 10px", textAlign: h === "Material" ? "left" : "right", color: "#fff", fontWeight: 700, fontSize: 10 }}>{h}</th>)}</tr></thead>
            <tbody>{mtData.slice(0, 50).map((m, i) => <tr key={m.material} style={{ background: i % 2 === 0 ? "#fff" : CV.cream, cursor: "pointer" }} onClick={() => setDrillMat(m.material)}><td style={{ padding: "8px 10px", fontWeight: 700, fontFamily: "monospace" }}>{m.material}</td><td style={{ padding: "8px 10px", textAlign: "right" }}>{fmtN(m.total)}</td><td style={{ padding: "8px 10px", textAlign: "right", color: m.open > 0 ? CV.green : "#999" }}>{m.open}</td><td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace" }}>{m.avgDwell ? `${m.avgDwell.toFixed(0)}d` : "---"}</td><td style={{ padding: "8px 10px", textAlign: "right" }}>{m.locList.join(", ")}</td><td style={{ padding: "8px 10px", textAlign: "right" }}>{fmtN(m.qty)}</td><td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace", color: m.cost > 0 ? CV.navy : "#ccc" }}>{m.cost > 0 ? fmtK(m.cost) : "---"}</td></tr>)}</tbody></table></div></Card>
        </>}

        {tab === "materials" && drillMat && (() => { const ml = filtered.filter(l => l.material === drillMat); const mo = ml.filter(l => l.open); const md = ml.filter(l => l.dwell != null).map(l => l.dwell); const mc = ml.reduce((s, l) => s + (l.totalCost || 0), 0); return <>
          <button onClick={() => setDrillMat(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: CV.teal, fontWeight: 600, marginBottom: 12, padding: 0 }}>Back</button>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Material: <span style={{ fontFamily: "monospace" }}>{drillMat}</span></h2>
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}><KPI label="Lifecycles" value={fmtN(ml.length)} /><KPI label="Open" value={fmtN(mo.length)} color={CV.green} /><KPI label="Avg Dwell" value={md.length ? `${(md.reduce((a, b) => a + b, 0) / md.length).toFixed(0)}d` : "---"} color={CV.teal} /><KPI label="Cost" value={mc > 0 ? fmtK(mc) : "---"} color={CV.red} /></div>
          <Card><SectionTitle>Pallet Detail</SectionTitle><div style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}><thead><tr style={{ background: CV.navy }}>{["Pallet", "Loc", "Qty", "Entry", "Exit", "Dwell", "Status", "Cost"].map(h => <th key={h} style={{ padding: "8px", textAlign: "left", color: "#fff", fontWeight: 700, fontSize: 9 }}>{h}</th>)}</tr></thead><tbody>{ml.slice(0, 300).map((l, i) => <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}><td style={{ padding: "5px 8px", fontFamily: "monospace", fontWeight: 600 }}>{l.pallet}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.loc}</td><td style={{ padding: "5px 8px" }}>{l.qty}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.entryDate)}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.exitDate)}</td><td style={{ padding: "5px 8px", fontWeight: 600 }}>{l.dwell != null ? `${l.dwell}d` : "---"}</td><td style={{ padding: "5px 8px" }}><StatusBadge lc={l} /></td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.totalCost > 0 ? fmt$(l.totalCost) : "---"}</td></tr>)}</tbody></table></div></Card>
        </>; })()}

        {tab === "locations" && !drillLoc && <>
          <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 800 }}>Locations</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{actLocs.map(([loc, d]) => { const info = OCS_LOCATIONS[loc]; const sc = { active: CV.green, "winding-down": CV.orange, closed: "#999" }[info?.status] || "#999"; return <div key={loc} onClick={() => setDrillLoc(loc)} style={{ flex: "1 0 220px", background: "#fff", borderRadius: 10, padding: "16px", border: `1px solid ${CV.creamDark}`, cursor: "pointer", borderLeft: `4px solid ${sc}` }}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><span style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace" }}>{loc}</span><span style={{ fontSize: 12, fontWeight: 600 }}>{info?.name}</span></div><div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>{info?.city}</div><div style={{ display: "flex", gap: 12, fontSize: 11 }}><span><strong>{fmtN(d.total)}</strong> total</span><span style={{ color: CV.green }}><strong>{d.open}</strong> open</span><span><strong>{d.avgDwell?.toFixed(0) || "---"}</strong>d avg</span></div>{d.cost > 0 && <div style={{ fontSize: 13, fontWeight: 700, color: CV.red, marginTop: 6 }}>{fmtK(d.cost)}</div>}</div>; })}</div>
        </>}

        {tab === "locations" && drillLoc && locStats[drillLoc] && (() => { const d = locStats[drillLoc]; const lt = computeThroughput(d.lcs); const la = computeAging(d.lcs); const lm = computeMaterials(d.lcs); const tH = d.lcs.filter(l => l.hasRates && !l.preExisting).reduce((s, l) => s + l.handling, 0); const tI = d.lcs.filter(l => l.hasRates && !l.preExisting).reduce((s, l) => s + l.initialStorage, 0); const tR = d.lcs.filter(l => l.hasRates && !l.preExisting).reduce((s, l) => s + l.renewalStorage, 0); return <>
          <button onClick={() => setDrillLoc(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: CV.teal, fontWeight: 600, marginBottom: 12, padding: 0 }}>Back</button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}><span style={{ fontSize: 28, fontWeight: 800, fontFamily: "monospace" }}>{drillLoc}</span><div><div style={{ fontSize: 16, fontWeight: 600 }}>{OCS_LOCATIONS[drillLoc]?.fullName}</div><div style={{ fontSize: 12, color: "#888" }}>{OCS_LOCATIONS[drillLoc]?.city}</div></div></div>
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}><KPI label="Lifecycles" value={fmtN(d.total)} /><KPI label="Open" value={fmtN(d.open)} color={CV.green} /><KPI label="Avg Dwell" value={d.avgDwell ? `${d.avgDwell.toFixed(1)}d` : "---"} color={CV.teal} /><KPI label="Pre-existing" value={fmtN(d.preEx)} color={CV.orange} /><KPI label="Cost" value={d.cost > 0 ? fmtK(d.cost) : "---"} color={CV.red} /><KPI label="Materials" value={d.mats} color={CV.purple} /></div>
          <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
            <Card style={{ flex: "1 0 350px" }}><SectionTitle>Monthly</SectionTitle>{lt.length > 0 && <ResponsiveContainer width="100%" height={200}><BarChart data={lt}><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis dataKey="period" tick={{ fontSize: 9 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="entries" name="In" fill={CV.green} radius={[3, 3, 0, 0]} /><Bar dataKey="exits" name="Out" fill={CV.red} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>}</Card>
            <Card style={{ flex: "1 0 250px" }}><SectionTitle>Cost Breakdown</SectionTitle>{(tH + tI + tR) > 0 ? <>{[{ l: "Handling", v: tH, c: CV.teal }, { l: "Initial Stg", v: tI, c: CV.navy }, { l: "Renewal Stg", v: tR, c: CV.red }].map(r => <div key={r.l} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${CV.cream}` }}><span style={{ fontSize: 12, color: "#666" }}>{r.l}</span><span style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: r.c }}>{fmt$(r.v)}</span></div>)}<div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0" }}><span style={{ fontWeight: 800 }}>Total</span><span style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: CV.red }}>{fmt$(tH + tI + tR)}</span></div></> : <div style={{ padding: "24px 0", textAlign: "center", color: "#aaa", fontSize: 12 }}>No rates for {drillLoc}.</div>}</Card>
          </div>
          <Card style={{ marginBottom: 16 }}><SectionTitle>Aging</SectionTitle>{la.some(b => b.count > 0) ? <ResponsiveContainer width="100%" height={160}><BarChart data={la.filter(b => b.count > 0)} layout="vertical"><CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} /><XAxis type="number" tick={{ fontSize: 10 }} /><YAxis dataKey="label" type="category" tick={{ fontSize: 10 }} width={80} /><Tooltip /><Bar dataKey="count" name="Pallets">{la.filter(b => b.count > 0).map((b, i) => <Cell key={i} fill={b.color} />)}</Bar></BarChart></ResponsiveContainer> : <div style={{ padding: "16px", textAlign: "center", color: "#aaa" }}>No open pallets</div>}</Card>
          <Card><SectionTitle>Top Materials</SectionTitle><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>{["Material", "Count", "Open", "Dwell", "Cost"].map(h => <th key={h} style={{ padding: "6px 10px", textAlign: h === "Material" ? "left" : "right", fontWeight: 700, fontSize: 10, color: CV.navy }}>{h}</th>)}</tr></thead><tbody>{lm.slice(0, 20).map(m => <tr key={m.material} style={{ borderBottom: `1px solid ${CV.cream}`, cursor: "pointer" }} onClick={() => { setDrillMat(m.material); setTab("materials"); }}><td style={{ padding: "7px 10px", fontWeight: 600, fontFamily: "monospace" }}>{m.material}</td><td style={{ padding: "7px 10px", textAlign: "right" }}>{fmtN(m.total)}</td><td style={{ padding: "7px 10px", textAlign: "right", color: m.open > 0 ? CV.green : "#999" }}>{m.open}</td><td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>{m.avgDwell ? `${m.avgDwell.toFixed(0)}d` : "---"}</td><td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>{m.cost > 0 ? fmtK(m.cost) : "---"}</td></tr>)}</tbody></table></Card>
        </>; })()}

        {tab === "search" && <>
          <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>Pallet Search</h2>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "#888" }}>Min 3 chars. Searches unfiltered data.</p>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Pallet, material, or lot..." style={{ width: "100%", maxWidth: 400, padding: "10px 14px", borderRadius: 8, border: `1px solid ${CV.creamDark}`, fontSize: 13, marginBottom: 16, fontFamily: "monospace" }} />
          {searchRes.length > 0 && <Card style={{ padding: 0, overflow: "hidden" }}><div style={{ padding: "10px 14px", fontSize: 11, color: "#888", borderBottom: `1px solid ${CV.cream}` }}>{searchRes.length >= 500 ? "500+" : searchRes.length} results</div><div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 1000 }}><thead><tr style={{ background: CV.navy }}>{["Pallet", "Loc", "Vendor", "Material", "Lot", "Qty", "Entry", "Exit", "Dwell", "Status", "Cost"].map(h => <th key={h} style={{ padding: "8px", textAlign: "left", color: "#fff", fontWeight: 700, fontSize: 9 }}>{h}</th>)}</tr></thead><tbody>{searchRes.map((l, i) => <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}><td style={{ padding: "5px 8px", fontFamily: "monospace", fontWeight: 600 }}>{l.pallet}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.loc}</td><td style={{ padding: "5px 8px" }}>{OCS_LOCATIONS[l.loc]?.vendor}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.material}</td><td style={{ padding: "5px 8px", fontFamily: "monospace", fontSize: 10 }}>{l.mfgLot}</td><td style={{ padding: "5px 8px" }}>{l.qty}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.entryDate)}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.exitDate)}</td><td style={{ padding: "5px 8px", fontWeight: 600 }}>{l.dwell != null ? `${l.dwell}d` : "---"}</td><td style={{ padding: "5px 8px" }}><StatusBadge lc={l} /></td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.totalCost > 0 ? fmt$(l.totalCost) : "---"}</td></tr>)}</tbody></table></div></Card>}
          {search.length >= 3 && !searchRes.length && <div style={{ padding: 32, textAlign: "center", color: "#aaa" }}>No results</div>}
        </>}

        {tab === "invoices" && <InvoicesTab invoices={invoiceData} setInvoices={setInvoiceData} apiKey={apiKey} onApiKeyChange={setApiKey} />}

        {tab === "reconciliation" && <ReconciliationTab invoices={invoiceData} lifecycles={costed} />}

        {tab === "agent" && <AIAgentTab lifecycles={costed} invoices={invoiceData} rates={rates} locStats={locStats} oppsData={oppsData} apiKey={apiKey} onApiKeyChange={setApiKey} />}

        {tab === "rates" && <>
          <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>Rate Cards</h2>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "#888" }}>Edit rates. Changes recalculate instantly.</p>
          <Card><SectionTitle>Rates by Location</SectionTitle><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ background: CV.navy }}>{["Code", "Location", "Handling", "Initial Stg", "Renewal Stg", "Days"].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "#fff", fontWeight: 700, fontSize: 10 }}>{h}</th>)}</tr></thead><tbody>{Object.entries(rates).map(([loc, r], i) => <tr key={loc} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}><td style={{ padding: "6px 10px", fontWeight: 800, fontFamily: "monospace" }}>{loc}</td><td style={{ padding: "6px 10px", fontWeight: 600 }}>{OCS_LOCATIONS[loc]?.name}{!r.handling && !r.initialStorage && <span style={{ color: CV.red, fontSize: 10, marginLeft: 6 }}>needs rates</span>}</td>{["handling", "initialStorage", "renewalStorage", "cycleDays"].map(f => <td key={f} style={{ padding: "4px 6px" }}><input type="number" step={f === "cycleDays" ? 1 : 0.01} value={r[f]} onChange={e => { const n = parseFloat(e.target.value); setRates({ ...rates, [loc]: { ...r, [f]: isNaN(n) ? 0 : n } }); }} style={{ width: "100%", padding: "4px 6px", border: `1px solid ${CV.creamDark}`, borderRadius: 4, fontSize: 12, fontFamily: "monospace", background: r[f] > 0 ? "#fff" : "#FEF3E2" }} /></td>)}</tr>)}</tbody></table></div></Card>
          <div style={{ marginTop: 16, background: CV.navyLight, borderRadius: 12, padding: "16px 20px", borderLeft: `4px solid ${CV.navy}` }}><p style={{ margin: 0, fontSize: 12, color: CV.navy, opacity: 0.8, lineHeight: 1.6 }}>Per pallet: Handling (one-time) + Initial Storage (1st cycle) + Renewal x additional cycles. Cycle = 30d default.</p></div>
        </>}
      </div>
    </div>
  );
}
