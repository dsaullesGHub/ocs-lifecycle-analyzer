import { useState, useCallback, useRef, useMemo } from "react";
import * as XLSX from "xlsx";

// ── Brand ────────────────────────────────────────────────────────────────────
const CV = {
  navy: "#2B4170", red: "#E8523F", cream: "#F5EDE0", teal: "#00A3BE",
  purple: "#7B5EA7", orange: "#F5A623", green: "#4EBC6A",
  navyLight: "#E8EDF5", creamDark: "#EDE0CE",
};

// ── OCS Location Master ──────────────────────────────────────────────────────
const OCS_LOCATIONS = {
  S7:  { name: "NACS", fullName: "North American Cold Storage", vendor: "NACS", city: "Fort Wayne, IN", status: "active" },
  S4:  { name: "IWI Franklin", fullName: "Interstate Warehousing - Franklin", vendor: "Interstate", city: "Franklin, IN", status: "active" },
  S9:  { name: "Americold Indy", fullName: "Americold - Indianapolis", vendor: "Americold", city: "Indianapolis, IN", status: "active" },
  C3:  { name: "Americold Rochelle", fullName: "Americold - Rochelle", vendor: "Americold", city: "Rochelle, IL", status: "active" },
  S:   { name: "Americold Atlanta", fullName: "Americold - Atlanta", vendor: "Americold", city: "Atlanta, GA", status: "winding-down" },
  C1:  { name: "US Cold Storage", fullName: "US Cold Storage", vendor: "USCS", city: "McDonough, GA", status: "closed" },
  S1:  { name: "P&B Cold Storage", fullName: "P&B Cold Storage", vendor: "P&B", city: "Unknown", status: "closed" },
  S2:  { name: "Americold Wakefern", fullName: "Americold - Wakefern", vendor: "Americold", city: "Gouldsboro, PA", status: "closed" },
  S5:  { name: "Americold Hatfield", fullName: "Americold - Hatfield", vendor: "Americold", city: "Hatfield, PA", status: "closed" },
  S8:  { name: "Americold Allentown", fullName: "Americold - Allentown", vendor: "Americold", city: "Allentown, PA", status: "closed" },
  S6:  { name: "Americold Perryville", fullName: "Americold - Perryville", vendor: "Americold", city: "Perryville, MD", status: "closed" },
};

const OCS_CODES = new Set(Object.keys(OCS_LOCATIONS));

// ── Default Rate Cards (from OCS Matrix 05/05/25) ────────────────────────────
// Notes on special cases:
//   S4: Rate varies by pallet height ($8.05 for 30" / $12.46 for 44"). Using 44" rate.
//   S8: Storage is $79,000/month flat rate (not per-pallet). Handling is $17.50/plt. Modeled as per-pallet here using 0 for storage -- flag for manual review.
//   C1: Semi-monthly billing. Full month if received 1st-15th, half if 16th-31st. Modeled as 30-day cycle -- flag for manual review.
//   S2, S1: No rates in OCS Matrix.
const DEFAULT_RATES = {
  S7:  { handling: 13.25, initialStorage: 13.00, renewalStorage: 13.00, cycleDays: 30 },
  S4:  { handling: 16.59, initialStorage: 12.46, renewalStorage: 12.46, cycleDays: 30 },
  S9:  { handling: 21.50, initialStorage: 19.00, renewalStorage: 19.00, cycleDays: 30 },
  C3:  { handling: 16.47, initialStorage: 15.87, renewalStorage: 15.87, cycleDays: 30 },
  S:   { handling: 20.44, initialStorage: 16.38, renewalStorage: 16.38, cycleDays: 30 },
  C1:  { handling: 19.22, initialStorage: 19.78, renewalStorage: 19.78, cycleDays: 30 },
  S1:  { handling: 0, initialStorage: 0, renewalStorage: 0, cycleDays: 30 },
  S2:  { handling: 0, initialStorage: 0, renewalStorage: 0, cycleDays: 30 },
  S5:  { handling: 22.06, initialStorage: 20.42, renewalStorage: 20.42, cycleDays: 30 },
  S8:  { handling: 17.50, initialStorage: 0, renewalStorage: 0, cycleDays: 30 },
  S6:  { handling: 23.10, initialStorage: 24.15, renewalStorage: 23.10, cycleDays: 30 },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt$ = (v) => v == null ? "---" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (v) => v == null ? "---" : v.toLocaleString();
const fmtD = (d) => d ? `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}` : "---";
const daysBetween = (a, b) => Math.round((b - a) / 86400000);

const EXCEL_EPOCH = new Date(1899, 11, 30);
function parseExcelDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const d = new Date(EXCEL_EPOCH.getTime() + v * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ── Lifecycle Engine ─────────────────────────────────────────────────────────
function buildLifecycles(transactions, asOfDate) {
  // Group by pallet + location
  const groups = {};
  for (const tx of transactions) {
    const key = `${tx.pallet}|${tx.loc}`;
    if (!groups[key]) groups[key] = { entries: [], exits: [] };
    if (tx.event === "entry") groups[key].entries.push(tx);
    else groups[key].exits.push(tx);
  }

  const lifecycles = [];
  for (const key of Object.keys(groups)) {
    const [pallet, loc] = key.split("|");
    const g = groups[key];
    g.entries.sort((a, b) => a.ts - b.ts);
    g.exits.sort((a, b) => a.ts - b.ts);

    let ei = 0, xi = 0;
    // Match entries to exits chronologically
    while (ei < g.entries.length) {
      const entry = g.entries[ei];
      // Find the next exit that occurs after this entry
      while (xi < g.exits.length && g.exits[xi].ts <= entry.ts) xi++;
      const exit = xi < g.exits.length ? g.exits[xi] : null;

      const entryDate = entry.ts;
      const exitDate = exit ? exit.ts : null;
      const dwell = exitDate ? daysBetween(entryDate, exitDate) : daysBetween(entryDate, asOfDate);

      lifecycles.push({
        pallet, loc, material: entry.material, qty: entry.qty,
        entryDate, exitDate,
        entryFrom: entry.whsFrom,
        exitTo: exit ? exit.whsTo : null,
        dwell: Math.max(dwell, 0),
        open: !exit,
        preExisting: false,
        mfgLot: entry.mfgLot || "",
      });
      ei++;
      if (exit) xi++;
    }

    // Unmatched exits = pre-existing inventory
    const matchedExitCount = Math.min(g.entries.length, g.exits.length);
    // Reset xi and find unmatched exits
    const allExits = [...g.exits];
    // Simple approach: if more exits than entries, the earliest unmatched exits are pre-existing
    if (g.exits.length > g.entries.length) {
      const unmatched = g.exits.length - g.entries.length;
      for (let i = 0; i < unmatched; i++) {
        const exit = g.exits[i];
        lifecycles.push({
          pallet, loc, material: exit.material, qty: exit.qty,
          entryDate: null, exitDate: exit.ts,
          entryFrom: "PRE-EXISTING",
          exitTo: exit.whsTo,
          dwell: null,
          open: false,
          preExisting: true,
          mfgLot: exit.mfgLot || "",
        });
      }
    }
  }

  return lifecycles;
}

function computeCosts(lifecycles, rates) {
  return lifecycles.map(lc => {
    const r = rates[lc.loc];
    if (!r || lc.preExisting || lc.dwell == null) {
      return { ...lc, handling: 0, initialStorage: 0, renewalStorage: 0, totalCost: 0, renewalCycles: 0, hasRates: false };
    }
    const handling = r.handling;
    const initialStorage = r.initialStorage;
    const cycleDays = r.cycleDays || 30;
    const renewalCycles = Math.max(0, Math.ceil(lc.dwell / cycleDays) - 1);
    const renewalStorage = renewalCycles * r.renewalStorage;
    const totalCost = handling + initialStorage + renewalStorage;
    const hasRates = r.handling > 0 || r.initialStorage > 0 || r.renewalStorage > 0;
    return { ...lc, handling, initialStorage, renewalStorage, totalCost, renewalCycles, hasRates };
  });
}

// ── Status colors ────────────────────────────────────────────────────────────
const STATUS_STYLE = {
  active: { bg: "#E8F8ED", color: CV.green },
  "winding-down": { bg: "#FEF3E2", color: CV.orange },
  closed: { bg: "#F0F0F0", color: "#999" },
};

function Badge({ bg, color, children, style: extraStyle }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99,
      background: bg, color, letterSpacing: "0.03em", whiteSpace: "nowrap", ...extraStyle }}>
      {children}
    </span>
  );
}

// ── Rate Editor ──────────────────────────────────────────────────────────────
function RateEditor({ rates, onChange }) {
  const handleChange = (loc, field, val) => {
    const num = parseFloat(val);
    onChange({ ...rates, [loc]: { ...rates[loc], [field]: isNaN(num) ? 0 : num } });
  };
  const ratedCount = Object.entries(rates).filter(([, r]) => r.handling > 0 || r.initialStorage > 0).length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: CV.navy }}>Rate Cards by Location</h3>
        <Badge bg={ratedCount === Object.keys(rates).length ? "#E8F8ED" : "#FEF3E2"}
          color={ratedCount === Object.keys(rates).length ? CV.green : CV.orange}>
          {ratedCount}/{Object.keys(rates).length} configured
        </Badge>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: CV.navy }}>
              {["Code","Location","Handling $/plt","Initial Storage $/plt","Renewal $/plt","Cycle Days"].map(h => (
                <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "#fff",
                  fontWeight: 700, fontSize: 10 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(rates).map(([loc, r], i) => {
              const info = OCS_LOCATIONS[loc];
              const hasRates = r.handling > 0 || r.initialStorage > 0;
              return (
                <tr key={loc} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}>
                  <td style={{ padding: "6px 10px", fontWeight: 800, fontFamily: "monospace" }}>{loc}</td>
                  <td style={{ padding: "6px 10px", fontWeight: 600 }}>
                    {info?.name}
                    {!hasRates && <span style={{ color: CV.red, fontSize: 10, marginLeft: 6 }}>needs rates</span>}
                  </td>
                  {["handling","initialStorage","renewalStorage","cycleDays"].map(field => (
                    <td key={field} style={{ padding: "4px 6px" }}>
                      <input type="number" step={field === "cycleDays" ? 1 : 0.01}
                        value={r[field]} onChange={e => handleChange(loc, field, e.target.value)}
                        style={{ width: "100%", padding: "4px 6px", border: `1px solid ${CV.creamDark}`,
                          borderRadius: 4, fontSize: 12, fontFamily: "monospace",
                          background: r[field] > 0 ? "#fff" : "#FEF3E2" }} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Location Summary Card ────────────────────────────────────────────────────
function LocCard({ loc, data, onClick, isSelected }) {
  const info = OCS_LOCATIONS[loc];
  const ss = STATUS_STYLE[info?.status] || STATUS_STYLE.closed;
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", textAlign: "left",
      padding: "12px 14px", borderRadius: 10, border: "none", cursor: "pointer",
      marginBottom: 4, transition: "all 0.12s",
      background: isSelected ? CV.navy : "#fff",
      color: isSelected ? "#fff" : CV.navy,
      borderLeft: `3px solid ${isSelected ? CV.red : ss.color}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}>{loc}</span>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{info?.name}</span>
        </div>
        <Badge bg={isSelected ? "rgba(255,255,255,0.15)" : ss.bg}
          color={isSelected ? "#ccc" : ss.color}>
          {info?.status === "winding-down" ? "Wind Down" : info?.status === "active" ? "Active" : "Closed"}
        </Badge>
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11, opacity: 0.7 }}>
        <span>{fmtN(data.totalPallets)} pallets</span>
        <span>{fmtN(data.openPallets)} open</span>
        <span>Avg {data.avgDwell?.toFixed(0) || "---"} days</span>
      </div>
      {data.totalCost > 0 && (
        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4,
          color: isSelected ? CV.orange : CV.red }}>
          {fmt$(data.totalCost)} total modeled cost
        </div>
      )}
    </button>
  );
}

// ── Dwell Distribution Chart ─────────────────────────────────────────────────
function DwellChart({ lifecycles }) {
  const buckets = [
    { label: "0-15d", min: 0, max: 15 },
    { label: "16-30d", min: 16, max: 30 },
    { label: "31-60d", min: 31, max: 60 },
    { label: "61-90d", min: 61, max: 90 },
    { label: "91-120d", min: 91, max: 120 },
    { label: "121-180d", min: 121, max: 180 },
    { label: "181-365d", min: 181, max: 365 },
    { label: "365d+", min: 366, max: 99999 },
  ];

  const counts = buckets.map(b => ({
    ...b,
    count: lifecycles.filter(lc => !lc.preExisting && lc.dwell != null && lc.dwell >= b.min && lc.dwell <= b.max).length,
  }));
  const maxCount = Math.max(...counts.map(c => c.count), 1);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120, padding: "0 4px" }}>
      {counts.map((b, i) => (
        <div key={b.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: CV.navy }}>{b.count > 0 ? b.count : ""}</span>
          <div style={{
            width: "100%", borderRadius: "4px 4px 0 0",
            height: `${Math.max((b.count / maxCount) * 90, b.count > 0 ? 4 : 0)}px`,
            background: i < 2 ? CV.green : i < 4 ? CV.teal : i < 6 ? CV.orange : CV.red,
            transition: "height 0.3s",
          }} />
          <span style={{ fontSize: 8, color: "#888", textAlign: "center", lineHeight: 1.1 }}>{b.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Monthly Trend ────────────────────────────────────────────────────────────
function MonthlyTrend({ lifecycles }) {
  const months = {};
  for (const lc of lifecycles) {
    if (lc.preExisting) continue;
    if (lc.entryDate) {
      const mk = `${lc.entryDate.getFullYear()}-${String(lc.entryDate.getMonth()+1).padStart(2,"0")}`;
      if (!months[mk]) months[mk] = { entries: 0, exits: 0, cost: 0 };
      months[mk].entries++;
    }
    if (lc.exitDate) {
      const mk = `${lc.exitDate.getFullYear()}-${String(lc.exitDate.getMonth()+1).padStart(2,"0")}`;
      if (!months[mk]) months[mk] = { entries: 0, exits: 0, cost: 0 };
      months[mk].exits++;
    }
    // Attribute cost to entry month
    if (lc.entryDate && lc.totalCost > 0) {
      const mk = `${lc.entryDate.getFullYear()}-${String(lc.entryDate.getMonth()+1).padStart(2,"0")}`;
      months[mk].cost += lc.totalCost;
    }
  }

  const sorted = Object.entries(months).sort((a, b) => a[0].localeCompare(b[0]));
  if (sorted.length === 0) return <div style={{ fontSize: 12, color: "#999" }}>No data</div>;

  const maxVal = Math.max(...sorted.map(([, v]) => Math.max(v.entries, v.exits)), 1);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>
            <th style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, fontSize: 10, color: CV.navy }}>Month</th>
            <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: 10, color: CV.green }}>Entries</th>
            <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: 10, color: CV.red }}>Exits</th>
            <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: 10, color: CV.navy }}>Net</th>
            <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: 10, color: CV.teal }}>Modeled Cost</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(([month, v], i) => {
            const net = v.entries - v.exits;
            return (
              <tr key={month} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}>
                <td style={{ padding: "6px 8px", fontWeight: 600, fontFamily: "monospace" }}>{month}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: CV.green, fontWeight: 600 }}>{fmtN(v.entries)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: CV.red, fontWeight: 600 }}>{fmtN(v.exits)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700,
                  color: net > 0 ? CV.green : net < 0 ? CV.red : "#999" }}>
                  {net > 0 ? "+" : ""}{fmtN(net)}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace",
                  color: v.cost > 0 ? CV.navy : "#ccc" }}>
                  {v.cost > 0 ? fmt$(v.cost) : "---"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV(lifecycles) {
  const headers = ["Pallet","Location","Vendor","Material","MfgLot","Qty","EntryDate","ExitDate","DwellDays","Open","PreExisting","EntryFrom","ExitTo","Handling","InitialStorage","RenewalStorage","RenewalCycles","TotalCost"];
  const rows = lifecycles.map(lc => [
    lc.pallet, lc.loc, OCS_LOCATIONS[lc.loc]?.vendor || "", lc.material, lc.mfgLot, lc.qty,
    lc.entryDate ? lc.entryDate.toISOString().slice(0,10) : "",
    lc.exitDate ? lc.exitDate.toISOString().slice(0,10) : "",
    lc.dwell ?? "", lc.open ? "Y" : "N", lc.preExisting ? "Y" : "N",
    lc.entryFrom || "", lc.exitTo || "",
    lc.handling?.toFixed(2) || "0", lc.initialStorage?.toFixed(2) || "0",
    lc.renewalStorage?.toFixed(2) || "0", lc.renewalCycles ?? 0,
    lc.totalCost?.toFixed(2) || "0",
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "ocs_lifecycle_export.csv"; a.click();
  URL.revokeObjectURL(url);
}

// ── Parse a single file into OCS transactions ────────────────────────────────
async function parseFileToTransactions(file, setProgress) {
  const transactions = [];
  let totalRows = 0;

  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { cellDates: true });

  for (const sheetName of wb.SheetNames) {
    if (sheetName.toLowerCase().includes("log") || sheetName.toLowerCase().includes("claude")) continue;

    setProgress(`Parsing ${file.name} / ${sheetName}...`);
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    totalRows += rows.length;

    for (const row of rows) {
      const txn = String(row["Txn. Type"] || "").trim();
      const whs = String(row["Whs."] || "").trim();
      const whsTo = String(row["Whs. To"] || "").trim();
      const pallet = String(row["Pallet"] || "").trim();
      const material = String(row["Material"] || "").trim();
      const qty = parseInt(row["Qty"]) || 0;
      const mfgLot = String(row["MFG Lot"] || row["Mfg Lot"] || "").trim();

      let ts = row["Timestamp"];
      if (ts && !(ts instanceof Date)) {
        const num = parseFloat(ts);
        if (!isNaN(num) && num > 10000) {
          ts = parseExcelDate(num);
        } else {
          ts = new Date(ts);
          if (isNaN(ts.getTime())) ts = null;
        }
      }
      if (!ts || isNaN(ts.getTime())) continue;
      if (!pallet || pallet === "NONE") continue;

      if ((txn === "RCP" || txn === "STG") && OCS_CODES.has(whsTo)) {
        transactions.push({
          event: "entry", loc: whsTo, pallet, material, qty, ts, mfgLot,
          whsFrom: whs, whsTo,
        });
      } else if (txn === "SHP" && OCS_CODES.has(whs)) {
        transactions.push({
          event: "exit", loc: whs, pallet, material, qty, ts, mfgLot,
          whsFrom: whs, whsTo,
        });
      }
    }
  }
  return { transactions, totalRows };
}

// ── Deduplicate and build lifecycles from accumulated transactions ────────────
function rebuildFromTransactions(allTransactions, rates) {
  const entryMap = {};
  const cleanTx = [];
  for (const tx of allTransactions) {
    if (tx.event === "entry") {
      const key = `${tx.pallet}|${tx.loc}|${Math.round(tx.ts.getTime() / 300000)}`;
      if (!entryMap[key]) entryMap[key] = tx;
    } else {
      cleanTx.push(tx);
    }
  }
  for (const tx of Object.values(entryMap)) cleanTx.push(tx);
  const raw = buildLifecycles(cleanTx, new Date());
  return computeCosts(raw, rates);
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function LifecycleAnalyzer() {
  const [loadedFiles, setLoadedFiles] = useState([]);   // { name, rows, txCount, ts }
  const [rawTransactions, setRawTransactions] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [lifecycles, setLifecycles] = useState(null);
  const [rates, setRates] = useState({ ...DEFAULT_RATES });
  const [selectedLoc, setSelectedLoc] = useState(null);
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const fileRef = useRef(null);
  const addFileRef = useRef(null);

  const handleAddFile = useCallback(async (fileList, autoBuild = false) => {
    const arr = Array.from(fileList).filter(f => f.name.match(/\.xlsx?$/i));
    if (arr.length === 0) return;
    setProcessing(true);

    try {
      let accumulated = [...rawTransactions];
      const newFileRecords = [...loadedFiles];

      for (const file of arr) {
        // Skip if already loaded
        if (loadedFiles.some(f => f.name === file.name)) {
          setProgress(`${file.name} already loaded, skipping...`);
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        setProgress(`Reading ${file.name}...`);
        const result = await parseFileToTransactions(file, setProgress);
        accumulated = accumulated.concat(result.transactions);
        newFileRecords.push({
          name: file.name,
          rows: result.totalRows,
          txCount: result.transactions.length,
          ts: new Date(),
        });
      }

      setRawTransactions(accumulated);
      setLoadedFiles(newFileRecords);

      if (autoBuild && accumulated.length > 0) {
        setProgress(`Rebuilding lifecycles from ${accumulated.length.toLocaleString()} OCS transactions...`);
        await new Promise(r => setTimeout(r, 50));
        const costed = rebuildFromTransactions(accumulated, rates);
        setLifecycles(costed);
      }

      setProgress("");
      setProcessing(false);
    } catch (err) {
      setProgress(`Error: ${err.message}`);
      setProcessing(false);
    }
  }, [rawTransactions, loadedFiles, rates]);

  const handleReset = useCallback(() => {
    setLoadedFiles([]);
    setRawTransactions([]);
    setLifecycles(null);
    setSelectedLoc(null);
    setTab("overview");
    setProgress("");
  }, []);

  // Recompute costs when rates change
  const costedLifecycles = useMemo(() => {
    if (!lifecycles) return null;
    return computeCosts(lifecycles, rates);
  }, [lifecycles, rates]);

  // Aggregate stats per location
  const locStats = useMemo(() => {
    if (!costedLifecycles) return {};
    const stats = {};
    for (const loc of Object.keys(OCS_LOCATIONS)) {
      const lcs = costedLifecycles.filter(lc => lc.loc === loc);
      const valid = lcs.filter(lc => !lc.preExisting && lc.dwell != null);
      const open = lcs.filter(lc => lc.open);
      const preEx = lcs.filter(lc => lc.preExisting);
      const dwells = valid.map(lc => lc.dwell);
      const avgDwell = dwells.length > 0 ? dwells.reduce((a,b) => a+b, 0) / dwells.length : null;
      const totalCost = lcs.reduce((s, lc) => s + (lc.totalCost || 0), 0);
      const hasRates = lcs.some(lc => lc.hasRates);
      const uniqueMaterials = new Set(lcs.map(lc => lc.material)).size;

      stats[loc] = {
        totalPallets: lcs.length,
        validPallets: valid.length,
        openPallets: open.length,
        preExisting: preEx.length,
        avgDwell, totalCost, hasRates, uniqueMaterials,
        lifecycles: lcs,
      };
    }
    return stats;
  }, [costedLifecycles]);

  // Active locations (have data)
  const activeLocs = useMemo(() => {
    return Object.entries(locStats)
      .filter(([, s]) => s.totalPallets > 0)
      .sort((a, b) => b[1].totalPallets - a[1].totalPallets);
  }, [locStats]);

  const totalPallets = activeLocs.reduce((s, [, d]) => s + d.totalPallets, 0);
  const totalOpen = activeLocs.reduce((s, [, d]) => s + d.openPallets, 0);
  const totalCost = activeLocs.reduce((s, [, d]) => s + d.totalCost, 0);
  const totalPreEx = activeLocs.reduce((s, [, d]) => s + d.preExisting, 0);

  // Search
  const searchResults = useMemo(() => {
    if (!costedLifecycles || search.length < 3) return [];
    const q = search.toUpperCase();
    return costedLifecycles.filter(lc =>
      lc.pallet.toUpperCase().includes(q) ||
      lc.material.toUpperCase().includes(q) ||
      lc.mfgLot.toUpperCase().includes(q)
    ).slice(0, 200);
  }, [costedLifecycles, search]);

  // ── Render ──
  // Show loader page until at least one file is loaded and lifecycles built
  if (!lifecycles) {
    const expectedFiles = ["WMS_1.xlsx", "WMS_2.xlsx", "WMS_DATA_2026YTD.xlsx"];
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Segoe UI', system-ui, sans-serif", background: CV.cream }}>
        <div style={{ maxWidth: 560, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: CV.red, textTransform: "uppercase",
              letterSpacing: "0.1em", marginBottom: 8 }}>OCS Platform</div>
            <h1 style={{ margin: "0 0 8px", fontSize: 28, fontWeight: 800, color: CV.navy }}>
              Pallet Lifecycle Analyzer
            </h1>
            <p style={{ margin: 0, fontSize: 13, color: "#888", lineHeight: 1.6 }}>
              Load WMS files one at a time. Each file is parsed and accumulated.
            </p>
          </div>

          {/* File status checklist */}
          <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px",
            border: `1px solid ${CV.creamDark}`, marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, textTransform: "uppercase",
              letterSpacing: "0.06em", marginBottom: 14 }}>Expected Files</div>
            {expectedFiles.map(fname => {
              const loaded = loadedFiles.find(f => f.name === fname);
              return (
                <div key={fname} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 0", borderBottom: `1px solid ${CV.cream}` }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: loaded ? CV.green : CV.creamDark,
                    color: loaded ? "#fff" : "#999", fontSize: 12, fontWeight: 800 }}>
                    {loaded ? "\u2713" : "\u2022"}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: loaded ? CV.navy : "#999",
                      fontFamily: "monospace" }}>{fname}</div>
                    {loaded && (
                      <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                        {loaded.rows.toLocaleString()} rows, {loaded.txCount.toLocaleString()} OCS transactions
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Show any extra files loaded that aren't in the expected list */}
            {loadedFiles.filter(f => !expectedFiles.includes(f.name)).map(f => (
              <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 10,
                padding: "10px 0", borderBottom: `1px solid ${CV.cream}` }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: CV.green, color: "#fff", fontSize: 12, fontWeight: 800 }}>{"\u2713"}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: CV.navy, fontFamily: "monospace" }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                    {f.rows.toLocaleString()} rows, {f.txCount.toLocaleString()} OCS transactions
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Accumulated totals */}
          {loadedFiles.length > 0 && (
            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1, background: CV.navyLight, borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: CV.navy }}>{loadedFiles.length}</div>
                <div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>FILES LOADED</div>
              </div>
              <div style={{ flex: 1, background: CV.navyLight, borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: CV.navy }}>
                  {loadedFiles.reduce((s, f) => s + f.rows, 0).toLocaleString()}
                </div>
                <div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>TOTAL ROWS</div>
              </div>
              <div style={{ flex: 1, background: CV.navyLight, borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: CV.teal }}>
                  {rawTransactions.length.toLocaleString()}
                </div>
                <div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>OCS TRANSACTIONS</div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={e => { handleAddFile(e.target.files, false); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()}
              disabled={processing}
              style={{
                padding: "12px 28px", borderRadius: 10, border: "none", cursor: processing ? "default" : "pointer",
                fontSize: 14, fontWeight: 700, color: "#fff",
                background: processing ? "#999" : CV.navy,
              }}>
              {processing ? "Processing..." : loadedFiles.length === 0 ? "Load First File" : "Add Next File"}
            </button>

            {loadedFiles.length > 0 && !processing && (
              <button onClick={handleReset}
                style={{
                  padding: "12px 20px", borderRadius: 10, border: `1px solid ${CV.creamDark}`,
                  cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#999",
                  background: "#fff",
                }}>
                Start Over
              </button>
            )}
          </div>

          {/* Progress indicator */}
          {progress && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: CV.navyLight,
              borderRadius: 8, fontSize: 12, color: CV.navy, textAlign: "center" }}>
              {progress}
            </div>
          )}

          {/* Ready to analyze prompt */}
          {loadedFiles.length > 0 && !processing && (
            <div style={{ marginTop: 20, textAlign: "center" }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
                {loadedFiles.length < 3
                  ? `${3 - loadedFiles.length} file${3 - loadedFiles.length > 1 ? "s" : ""} remaining. Add the next file, or analyze what's loaded so far.`
                  : "All files loaded. Ready to analyze."}
              </div>
              <button onClick={() => {
                const costed = rebuildFromTransactions(rawTransactions, rates);
                setLifecycles(costed);
              }} style={{
                padding: "12px 28px", borderRadius: 10, border: "none", cursor: "pointer",
                fontSize: 14, fontWeight: 700, color: "#fff", background: CV.green,
              }}>
                {loadedFiles.length >= 3 ? "Build Lifecycles" : "Analyze What's Loaded So Far"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const selData = selectedLoc ? locStats[selectedLoc] : null;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif",
      background: CV.cream, color: CV.navy }}>

      {/* Sidebar */}
      <div style={{ width: 260, flexShrink: 0, background: "#fff",
        borderRight: `1px solid ${CV.creamDark}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 14px 10px", borderBottom: `1px solid ${CV.cream}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: CV.red, textTransform: "uppercase",
            letterSpacing: "0.08em", marginBottom: 4 }}>OCS Platform</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: CV.navy }}>Lifecycle Analyzer</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input ref={addFileRef} type="file" accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={e => { handleAddFile(e.target.files, true); e.target.value = ""; }} />
            <button onClick={() => addFileRef.current?.click()} style={{
              padding: "3px 8px", borderRadius: 6, border: `1px solid ${CV.creamDark}`,
              cursor: "pointer", fontSize: 10, fontWeight: 600, color: CV.teal, background: "#fff",
            }}>+ Add File</button>
            <button onClick={handleReset} style={{
              padding: "3px 8px", borderRadius: 6, border: `1px solid ${CV.creamDark}`,
              cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#999", background: "#fff",
            }}>Reset</button>
          </div>
          <div style={{ fontSize: 10, color: "#aaa", marginTop: 4 }}>
            {loadedFiles.length} file{loadedFiles.length !== 1 ? "s" : ""} loaded: {loadedFiles.map(f => f.name.replace(/\.xlsx?$/i, "")).join(", ")}
          </div>
        </div>

        {/* Global stats */}
        <div style={{ padding: "10px 14px", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "Lifecycles", value: fmtN(totalPallets), color: CV.navy },
            { label: "Open", value: fmtN(totalOpen), color: CV.green },
            { label: "Pre-existing", value: fmtN(totalPreEx), color: CV.orange },
          ].map(s => (
            <div key={s.label} style={{ flex: "1 0 30%", background: CV.cream, borderRadius: 8, padding: "6px 8px" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 8, fontWeight: 600, color: "#999", textTransform: "uppercase" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Location list */}
        <div style={{ padding: "4px 8px 0" }}>
          <button onClick={() => { setSelectedLoc(null); setTab("overview"); }} style={{
            display: "block", width: "100%", textAlign: "left",
            padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
            marginBottom: 4, fontWeight: 700, fontSize: 12,
            background: !selectedLoc ? CV.navy : "transparent",
            color: !selectedLoc ? "#fff" : CV.navy,
          }}>All Locations Overview</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 16px" }}>
          {activeLocs.map(([loc, data]) => (
            <LocCard key={loc} loc={loc} data={data}
              isSelected={selectedLoc === loc}
              onClick={() => { setSelectedLoc(loc); setTab("detail"); }} />
          ))}
          {/* Locations with no data */}
          {Object.entries(locStats).filter(([, s]) => s.totalPallets === 0).map(([loc]) => (
            <div key={loc} style={{ padding: "6px 14px", fontSize: 11, color: "#ccc", fontFamily: "monospace" }}>
              {loc} - no activity in data
            </div>
          ))}
        </div>
      </div>

      {/* Main panel */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
        {/* Tab bar */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap" }}>
          {[
            ["overview", "Overview"],
            ...(selectedLoc ? [["detail", `${selectedLoc} Detail`]] : []),
            ["rates", "Rate Cards"],
            ["search", "Pallet Search"],
          ].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer",
              fontSize: 12, fontWeight: 700,
              background: tab === k ? CV.navy : "#fff", color: tab === k ? "#fff" : CV.navy,
            }}>{l}</button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={() => exportCSV(costedLifecycles)} style={{
            padding: "7px 14px", borderRadius: 8, border: `1px solid ${CV.creamDark}`,
            cursor: "pointer", fontSize: 11, fontWeight: 700,
            background: "#fff", color: CV.navy,
          }}>Export CSV</button>
        </div>

        {/* ── Overview Tab ── */}
        {tab === "overview" && (
          <div>
            <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800 }}>Cross-Location Overview</h2>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#888" }}>
              {fmtN(totalPallets)} total pallet lifecycles across {activeLocs.length} OCS locations.
              {totalCost > 0 && ` ${fmt$(totalCost)} total modeled cost (where rates configured).`}
            </p>

            {/* Summary table */}
            <div style={{ background: "#fff", borderRadius: 12, overflow: "hidden",
              border: `1px solid ${CV.creamDark}`, marginBottom: 20 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: CV.navy }}>
                    {["Code","Location","Vendor","Total","Open","Pre-Ex","Avg Dwell","Materials","Modeled Cost","Cost/Pallet"].map(h => (
                      <th key={h} style={{ padding: "9px 10px", textAlign: h === "Code" || h === "Location" || h === "Vendor" ? "left" : "right",
                        color: "#fff", fontWeight: 700, fontSize: 10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeLocs.map(([loc, d], i) => {
                    const info = OCS_LOCATIONS[loc];
                    const costPerPallet = d.validPallets > 0 && d.totalCost > 0 ? d.totalCost / d.validPallets : null;
                    return (
                      <tr key={loc} style={{ background: i % 2 === 0 ? "#fff" : CV.cream, cursor: "pointer" }}
                        onClick={() => { setSelectedLoc(loc); setTab("detail"); }}>
                        <td style={{ padding: "8px 10px", fontWeight: 800, fontFamily: "monospace" }}>{loc}</td>
                        <td style={{ padding: "8px 10px", fontWeight: 600 }}>{info?.name}</td>
                        <td style={{ padding: "8px 10px", color: "#666" }}>{info?.vendor}</td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>{fmtN(d.totalPallets)}</td>
                        <td style={{ padding: "8px 10px", textAlign: "right", color: d.openPallets > 0 ? CV.green : "#999" }}>
                          {fmtN(d.openPallets)}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right", color: d.preExisting > 0 ? CV.orange : "#999" }}>
                          {fmtN(d.preExisting)}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace" }}>
                          {d.avgDwell != null ? `${d.avgDwell.toFixed(0)}d` : "---"}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right" }}>{d.uniqueMaterials}</td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600, fontFamily: "monospace",
                          color: d.totalCost > 0 ? CV.navy : "#ccc" }}>
                          {d.totalCost > 0 ? fmt$(d.totalCost) : "no rates"}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace",
                          color: costPerPallet ? CV.red : "#ccc" }}>
                          {costPerPallet ? fmt$(costPerPallet) : "---"}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Totals row */}
                  <tr style={{ background: CV.navyLight, fontWeight: 700 }}>
                    <td colSpan={3} style={{ padding: "10px 10px", fontSize: 11, textTransform: "uppercase" }}>Total</td>
                    <td style={{ padding: "10px 10px", textAlign: "right" }}>{fmtN(totalPallets)}</td>
                    <td style={{ padding: "10px 10px", textAlign: "right", color: CV.green }}>{fmtN(totalOpen)}</td>
                    <td style={{ padding: "10px 10px", textAlign: "right", color: CV.orange }}>{fmtN(totalPreEx)}</td>
                    <td colSpan={2} />
                    <td style={{ padding: "10px 10px", textAlign: "right", fontFamily: "monospace", color: CV.navy }}>
                      {totalCost > 0 ? fmt$(totalCost) : "---"}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Dwell distribution - all locations */}
            <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px",
              border: `1px solid ${CV.creamDark}` }}>
              <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700 }}>
                Dwell Distribution (All Locations)
              </h3>
              <DwellChart lifecycles={costedLifecycles} />
            </div>
          </div>
        )}

        {/* ── Location Detail Tab ── */}
        {tab === "detail" && selectedLoc && selData && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <span style={{ fontSize: 28, fontWeight: 800, fontFamily: "monospace" }}>{selectedLoc}</span>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{OCS_LOCATIONS[selectedLoc]?.fullName}</div>
                <div style={{ fontSize: 12, color: "#888" }}>{OCS_LOCATIONS[selectedLoc]?.city}</div>
              </div>
            </div>

            {/* KPIs */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              {[
                { label: "Total Lifecycles", value: fmtN(selData.totalPallets), color: CV.navy },
                { label: "Currently Open", value: fmtN(selData.openPallets), color: CV.green },
                { label: "Avg Dwell Days", value: selData.avgDwell ? selData.avgDwell.toFixed(1) : "---", color: CV.teal },
                { label: "Pre-existing", value: fmtN(selData.preExisting), color: CV.orange },
                { label: "Modeled Cost", value: selData.totalCost > 0 ? fmt$(selData.totalCost) : "no rates", color: CV.red },
                { label: "Unique Materials", value: selData.uniqueMaterials, color: CV.purple },
              ].map(k => (
                <div key={k.label} style={{ flex: "1 0 140px", background: "#fff", borderRadius: 10,
                  padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.value}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase", marginTop: 2 }}>{k.label}</div>
                </div>
              ))}
            </div>

            {/* Dwell chart for this location */}
            <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
              <div style={{ flex: "1 0 280px", background: "#fff", borderRadius: 12, padding: "20px 24px",
                border: `1px solid ${CV.creamDark}` }}>
                <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700 }}>Dwell Distribution</h3>
                <DwellChart lifecycles={selData.lifecycles} />
              </div>
              <div style={{ flex: "1 0 280px", background: "#fff", borderRadius: 12, padding: "20px 24px",
                border: `1px solid ${CV.creamDark}` }}>
                <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700 }}>Cost Breakdown</h3>
                {(() => {
                  const valid = selData.lifecycles.filter(lc => lc.hasRates && !lc.preExisting);
                  if (valid.length === 0) return (
                    <div style={{ padding: "24px 0", textAlign: "center", color: "#aaa", fontSize: 12 }}>
                      No rates configured for {selectedLoc}. Set rates in the Rate Cards tab.
                    </div>
                  );
                  const tHandling = valid.reduce((s, lc) => s + lc.handling, 0);
                  const tInitial = valid.reduce((s, lc) => s + lc.initialStorage, 0);
                  const tRenewal = valid.reduce((s, lc) => s + lc.renewalStorage, 0);
                  const total = tHandling + tInitial + tRenewal;
                  return (
                    <div>
                      {[
                        { label: "Inbound Handling", value: tHandling, color: CV.teal },
                        { label: "Initial Storage", value: tInitial, color: CV.navy },
                        { label: "Renewal Storage", value: tRenewal, color: CV.red },
                      ].map(row => (
                        <div key={row.label} style={{ display: "flex", justifyContent: "space-between",
                          padding: "8px 0", borderBottom: `1px solid ${CV.cream}` }}>
                          <span style={{ fontSize: 12, color: "#666" }}>{row.label}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: row.color }}>
                            {fmt$(row.value)}
                          </span>
                        </div>
                      ))}
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", marginTop: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 800 }}>Total Modeled Cost</span>
                        <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: CV.red }}>
                          {fmt$(total)}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>
                        Based on {fmtN(valid.length)} pallets with rates applied.
                        Cost per pallet: {fmt$(total / valid.length)}.
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Monthly trend */}
            <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px",
              border: `1px solid ${CV.creamDark}`, marginBottom: 20 }}>
              <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700 }}>Monthly Activity</h3>
              <MonthlyTrend lifecycles={selData.lifecycles} />
            </div>

            {/* Top materials */}
            <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px",
              border: `1px solid ${CV.creamDark}` }}>
              <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700 }}>Top Materials</h3>
              {(() => {
                const matCounts = {};
                for (const lc of selData.lifecycles) {
                  if (!matCounts[lc.material]) matCounts[lc.material] = { count: 0, cost: 0, dwell: [], open: 0 };
                  matCounts[lc.material].count++;
                  matCounts[lc.material].cost += lc.totalCost || 0;
                  if (lc.dwell != null) matCounts[lc.material].dwell.push(lc.dwell);
                  if (lc.open) matCounts[lc.material].open++;
                }
                const sorted = Object.entries(matCounts).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
                return (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>
                        {["Material","Lifecycles","Open","Avg Dwell","Modeled Cost"].map(h => (
                          <th key={h} style={{ padding: "6px 10px", textAlign: h === "Material" ? "left" : "right",
                            fontWeight: 700, fontSize: 10, color: CV.navy, textTransform: "uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(([mat, d], i) => {
                        const avg = d.dwell.length > 0 ? d.dwell.reduce((a,b)=>a+b,0)/d.dwell.length : null;
                        return (
                          <tr key={mat} style={{ borderBottom: `1px solid ${CV.cream}` }}>
                            <td style={{ padding: "7px 10px", fontWeight: 600, fontFamily: "monospace" }}>{mat}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right" }}>{fmtN(d.count)}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right", color: d.open > 0 ? CV.green : "#ccc" }}>{d.open}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>
                              {avg != null ? `${avg.toFixed(0)}d` : "---"}
                            </td>
                            <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace",
                              color: d.cost > 0 ? CV.navy : "#ccc" }}>
                              {d.cost > 0 ? fmt$(d.cost) : "---"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </div>
          </div>
        )}

        {/* ── Rate Cards Tab ── */}
        {tab === "rates" && (
          <div>
            <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800 }}>Cost Model Rate Cards</h2>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#888", lineHeight: 1.6 }}>
              Edit rates per location. Changes recalculate costs instantly.
              Locations with $0 rates will show lifecycle data without cost modeling.
            </p>
            <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px",
              border: `1px solid ${CV.creamDark}`, marginBottom: 20 }}>
              <RateEditor rates={rates} onChange={setRates} />
            </div>
            <div style={{ background: CV.navyLight, borderRadius: 12, padding: "16px 20px",
              borderLeft: `4px solid ${CV.navy}` }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: CV.navy }}>Cost Calculation Method</h4>
              <p style={{ margin: 0, fontSize: 12, color: CV.navy, opacity: 0.8, lineHeight: 1.6 }}>
                Per pallet: Handling (one-time on entry) + Initial Storage (first cycle) + Renewal Storage x number of additional cycles.
                Cycle length defaults to 30 days. A pallet with 45 dwell days incurs 1 initial + 1 renewal cycle.
                A pallet with 60 dwell days incurs 1 initial + 1 renewal. 61 dwell days triggers a second renewal.
                Pre-existing pallets (no entry date in data) are excluded from cost modeling.
              </p>
            </div>
          </div>
        )}

        {/* ── Pallet Search Tab ── */}
        {tab === "search" && (
          <div>
            <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800 }}>Pallet Search</h2>
            <p style={{ margin: "0 0 16px", fontSize: 12, color: "#888" }}>
              Search by pallet ID, material number, or MFG lot. Minimum 3 characters.
            </p>
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search pallet ID, material, or lot..."
              style={{ width: "100%", maxWidth: 400, padding: "10px 14px", borderRadius: 8,
                border: `1px solid ${CV.creamDark}`, fontSize: 13, marginBottom: 16,
                fontFamily: "monospace" }} />

            {searchResults.length > 0 && (
              <div style={{ background: "#fff", borderRadius: 12, overflow: "hidden",
                border: `1px solid ${CV.creamDark}` }}>
                <div style={{ padding: "10px 14px", fontSize: 11, color: "#888", borderBottom: `1px solid ${CV.cream}` }}>
                  {searchResults.length >= 200 ? "200+ results (showing first 200)" : `${searchResults.length} results`}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 900 }}>
                    <thead>
                      <tr style={{ background: CV.navy }}>
                        {["Pallet","Loc","Vendor","Material","Qty","Entry","Exit","Dwell","Open","Pre-Ex","Cost"].map(h => (
                          <th key={h} style={{ padding: "8px 8px", textAlign: "left",
                            color: "#fff", fontWeight: 700, fontSize: 9 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {searchResults.map((lc, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}>
                          <td style={{ padding: "6px 8px", fontFamily: "monospace", fontWeight: 600 }}>{lc.pallet}</td>
                          <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{lc.loc}</td>
                          <td style={{ padding: "6px 8px" }}>{OCS_LOCATIONS[lc.loc]?.vendor}</td>
                          <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{lc.material}</td>
                          <td style={{ padding: "6px 8px" }}>{lc.qty}</td>
                          <td style={{ padding: "6px 8px", fontSize: 10 }}>{fmtD(lc.entryDate)}</td>
                          <td style={{ padding: "6px 8px", fontSize: 10 }}>{fmtD(lc.exitDate)}</td>
                          <td style={{ padding: "6px 8px", fontWeight: 600 }}>{lc.dwell != null ? `${lc.dwell}d` : "---"}</td>
                          <td style={{ padding: "6px 8px" }}>
                            {lc.open && <Badge bg="#E8F8ED" color={CV.green}>Open</Badge>}
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            {lc.preExisting && <Badge bg="#FEF3E2" color={CV.orange}>Pre-Ex</Badge>}
                          </td>
                          <td style={{ padding: "6px 8px", fontFamily: "monospace",
                            color: lc.totalCost > 0 ? CV.navy : "#ccc" }}>
                            {lc.totalCost > 0 ? fmt$(lc.totalCost) : "---"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {search.length >= 3 && searchResults.length === 0 && (
              <div style={{ padding: "32px", textAlign: "center", color: "#aaa", fontSize: 13 }}>
                No results found for "{search}"
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
