import { useState, useCallback, useRef, useMemo } from "react";
import * as XLSX from "xlsx";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from "recharts";

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
  const groups = {};
  for (const tx of transactions) { const key = `${tx.pallet}|${tx.loc}`; if (!groups[key]) groups[key] = { entries: [], exits: [] }; if (tx.event === "entry") groups[key].entries.push(tx); else groups[key].exits.push(tx); }
  const lifecycles = [];
  for (const key of Object.keys(groups)) {
    const [pallet, loc] = key.split("|"); const g = groups[key]; g.entries.sort((a, b) => a.ts - b.ts); g.exits.sort((a, b) => a.ts - b.ts);
    let ei = 0, xi = 0;
    while (ei < g.entries.length) {
      const entry = g.entries[ei]; while (xi < g.exits.length && g.exits[xi].ts <= entry.ts) xi++;
      const exit = xi < g.exits.length ? g.exits[xi] : null; const dwell = exit ? daysBetween(entry.ts, exit.ts) : daysBetween(entry.ts, asOfDate);
      lifecycles.push({ pallet, loc, material: entry.material, qty: entry.qty, entryDate: entry.ts, exitDate: exit?.ts || null, entryFrom: entry.whsFrom, exitTo: exit?.whsTo || null, dwell: Math.max(dwell, 0), open: !exit, preExisting: false, mfgLot: entry.mfgLot || "" });
      ei++; if (exit) xi++;
    }
    if (g.exits.length > g.entries.length) { for (let i = 0; i < g.exits.length - g.entries.length; i++) { const exit = g.exits[i]; lifecycles.push({ pallet, loc, material: exit.material, qty: exit.qty, entryDate: null, exitDate: exit.ts, entryFrom: "PRE-EXISTING", exitTo: exit.whsTo, dwell: null, open: false, preExisting: true, mfgLot: exit.mfgLot || "" }); } }
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
  const data = await file.arrayBuffer(); const wb = XLSX.read(data, { cellDates: true });
  for (const sn of wb.SheetNames) {
    if (sn.toLowerCase().includes("log") || sn.toLowerCase().includes("claude")) continue;
    setProgress(`Parsing ${file.name} / ${sn}...`); const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "" }); totalRows += rows.length;
    for (const row of rows) {
      const txn = String(row["Txn. Type"] || "").trim(), whs = String(row["Whs."] || "").trim(), whsTo = String(row["Whs. To"] || "").trim();
      const pallet = String(row["Pallet"] || "").trim(), material = String(row["Material"] || "").trim(), qty = parseInt(row["Qty"]) || 0;
      const mfgLot = String(row["MFG Lot"] || row["Mfg Lot"] || "").trim();
      let ts = row["Timestamp"]; if (ts && !(ts instanceof Date)) { const num = parseFloat(ts); if (!isNaN(num) && num > 10000) ts = parseExcelDate(num); else { ts = new Date(ts); if (isNaN(ts.getTime())) ts = null; } }
      if (!ts || isNaN(ts.getTime()) || !pallet || pallet === "NONE") continue;
      if ((txn === "RCP" || txn === "STG") && OCS_CODES.has(whsTo)) transactions.push({ event: "entry", loc: whsTo, pallet, material, qty, ts, mfgLot, whsFrom: whs, whsTo });
      else if (txn === "SHP" && OCS_CODES.has(whs)) transactions.push({ event: "exit", loc: whs, pallet, material, qty, ts, mfgLot, whsFrom: whs, whsTo });
    }
  }
  return { transactions, totalRows };
}

function rebuildFromTransactions(allTx, rates) {
  const entryMap = {}, cleanTx = [];
  for (const tx of allTx) { if (tx.event === "entry") { const k = `${tx.pallet}|${tx.loc}|${Math.round(tx.ts.getTime() / 300000)}`; if (!entryMap[k]) entryMap[k] = tx; } else cleanTx.push(tx); }
  for (const tx of Object.values(entryMap)) cleanTx.push(tx);
  return computeCosts(buildLifecycles(cleanTx, new Date()), rates);
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
  const h = ["Pallet", "Location", "Vendor", "Material", "MfgLot", "Qty", "EntryDate", "ExitDate", "DwellDays", "Open", "PreExisting", "EntryFrom", "ExitTo", "Handling", "InitialStorage", "RenewalStorage", "RenewalCycles", "TotalCost"];
  const r = lcs.map(l => [l.pallet, l.loc, OCS_LOCATIONS[l.loc]?.vendor || "", l.material, l.mfgLot, l.qty, fmtISO(l.entryDate), fmtISO(l.exitDate), l.dwell ?? "", l.open ? "Y" : "N", l.preExisting ? "Y" : "N", l.entryFrom || "", l.exitTo || "", l.handling?.toFixed(2) || "0", l.initialStorage?.toFixed(2) || "0", l.renewalStorage?.toFixed(2) || "0", l.renewalCycles ?? 0, l.totalCost?.toFixed(2) || "0"]);
  const csv = [h, ...r].map(x => x.map(c => `"${c}"`).join(",")).join("\n"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "ocs_lifecycle_export.csv"; a.click();
}

function Badge({ bg, color, children }) { return <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: bg, color, whiteSpace: "nowrap" }}>{children}</span>; }
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
      {has && <button onClick={() => setFilters({ dateFrom: "", dateTo: "", vendors: [], locations: [], materialSearch: "", statusFilter: "" })} style={{ padding: "4px 10px", borderRadius: 99, border: `1px solid ${CV.red}`, cursor: "pointer", fontSize: 10, fontWeight: 700, background: "#fff", color: CV.red }}>Clear</button>}
    </div>
  );
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
  const [filters, setFilters] = useState({ dateFrom: "", dateTo: "", vendors: [], locations: [], materialSearch: "", statusFilter: "" });
  const [drillMat, setDrillMat] = useState(null);
  const [drillLoc, setDrillLoc] = useState(null);
  const [ohGran, setOhGran] = useState("week");
  const fileRef = useRef(null);
  const addRef = useRef(null);

  const addFile = useCallback(async (fl, auto = false) => {
    const arr = Array.from(fl).filter(f => f.name.match(/\.xlsx?$/i)); if (!arr.length) return;
    setProcessing(true);
    try {
      let acc = [...rawTx]; const nf = [...loadedFiles];
      for (const file of arr) {
        if (loadedFiles.some(f => f.name === file.name)) { setProgress(`${file.name} already loaded`); await new Promise(r => setTimeout(r, 400)); continue; }
        setProgress(`Reading ${file.name}...`); const res = await parseFileToTransactions(file, setProgress);
        acc = acc.concat(res.transactions); nf.push({ name: file.name, rows: res.totalRows, txCount: res.transactions.length });
      }
      setRawTx(acc); setLoadedFiles(nf);
      if (auto && acc.length > 0) { setProgress("Rebuilding..."); await new Promise(r => setTimeout(r, 50)); setLifecycles(rebuildFromTransactions(acc, rates)); }
      setProgress(""); setProcessing(false);
    } catch (err) { setProgress(`Error: ${err.message}`); setProcessing(false); }
  }, [rawTx, loadedFiles, rates]);
  const reset = useCallback(() => { setLoadedFiles([]); setRawTx([]); setLifecycles(null); setTab("overview"); setProgress(""); setDrillMat(null); setDrillLoc(null); }, []);

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
    return d;
  }, [costed, filters]);

  const locStats = useMemo(() => {
    const s = {};
    for (const loc of Object.keys(OCS_LOCATIONS)) {
      const lcs = filtered.filter(l => l.loc === loc); const valid = lcs.filter(l => !l.preExisting && l.dwell != null); const dwells = valid.map(l => l.dwell);
      s[loc] = { total: lcs.length, valid: valid.length, open: lcs.filter(l => l.open).length, preEx: lcs.filter(l => l.preExisting).length, avgDwell: dwells.length ? dwells.reduce((a, b) => a + b, 0) / dwells.length : null, cost: lcs.reduce((a, l) => a + (l.totalCost || 0), 0), mats: new Set(lcs.map(l => l.material)).size, lcs };
    }
    return s;
  }, [filtered]);

  const actLocs = useMemo(() => Object.entries(locStats).filter(([, s]) => s.total > 0).sort((a, b) => b[1].total - a[1].total), [locStats]);
  const totals = useMemo(() => ({ pallets: actLocs.reduce((s, [, d]) => s + d.total, 0), open: actLocs.reduce((s, [, d]) => s + d.open, 0), cost: actLocs.reduce((s, [, d]) => s + d.cost, 0), preEx: actLocs.reduce((s, [, d]) => s + d.preEx, 0) }), [actLocs]);
  const ohData = useMemo(() => filtered.length ? computeOnHand(filtered, ohGran) : [], [filtered, ohGran]);
  const tpData = useMemo(() => computeThroughput(filtered), [filtered]);
  const clData = useMemo(() => computeCostByLoc(filtered), [filtered]);
  const agData = useMemo(() => computeAging(filtered), [filtered]);
  const vnData = useMemo(() => computeVendors(filtered), [filtered]);
  const mtData = useMemo(() => computeMaterials(filtered), [filtered]);
  const actCodes = useMemo(() => actLocs.map(([c]) => c), [actLocs]);
  const searchRes = useMemo(() => { if (!costed || search.length < 3) return []; const q = search.toUpperCase(); return costed.filter(l => l.pallet.toUpperCase().includes(q) || l.material.toUpperCase().includes(q) || l.mfgLot.toUpperCase().includes(q)).slice(0, 500); }, [costed, search]);

  // Landing
  if (!lifecycles) {
    const exp = ["WMS_1.xlsx", "WMS_2.xlsx", "WMS_DATA_2026YTD.xlsx"];
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', system-ui, sans-serif", background: CV.cream }}>
        <div style={{ maxWidth: 560, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: CV.red, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>OCS Platform</div>
            <h1 style={{ margin: "0 0 8px", fontSize: 28, fontWeight: 800, color: CV.navy }}>Pallet Lifecycle Analyzer</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#888" }}>Load WMS files one at a time.</p>
          </div>
          <Card style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, textTransform: "uppercase", marginBottom: 14 }}>Expected Files</div>
            {exp.map(fn => { const ld = loadedFiles.find(f => f.name === fn); return (
              <div key={fn} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${CV.cream}` }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: ld ? CV.green : CV.creamDark, color: ld ? "#fff" : "#999", fontSize: 12, fontWeight: 800 }}>{ld ? "\u2713" : "\u2022"}</div>
                <div><div style={{ fontSize: 13, fontWeight: 600, color: ld ? CV.navy : "#999", fontFamily: "monospace" }}>{fn}</div>{ld && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{ld.rows.toLocaleString()} rows, {ld.txCount.toLocaleString()} OCS txns</div>}</div>
              </div>); })}
          </Card>
          {loadedFiles.length > 0 && <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>{[{ l: "Files", v: loadedFiles.length }, { l: "Rows", v: loadedFiles.reduce((s, f) => s + f.rows, 0).toLocaleString() }, { l: "OCS Txns", v: rawTx.length.toLocaleString() }].map(s => <div key={s.l} style={{ flex: 1, background: CV.navyLight, borderRadius: 10, padding: "12px 16px", textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: CV.navy }}>{s.v}</div><div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>{s.l.toUpperCase()}</div></div>)}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => { addFile(e.target.files, false); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} disabled={processing} style={{ padding: "12px 28px", borderRadius: 10, border: "none", cursor: processing ? "default" : "pointer", fontSize: 14, fontWeight: 700, color: "#fff", background: processing ? "#999" : CV.navy }}>{processing ? "Processing..." : loadedFiles.length === 0 ? "Load First File" : "Add Next File"}</button>
            {loadedFiles.length > 0 && !processing && <button onClick={reset} style={{ padding: "12px 20px", borderRadius: 10, border: `1px solid ${CV.creamDark}`, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#999", background: "#fff" }}>Start Over</button>}
          </div>
          {progress && <div style={{ marginTop: 16, padding: "12px 16px", background: CV.navyLight, borderRadius: 8, fontSize: 12, color: CV.navy, textAlign: "center" }}>{progress}</div>}
          {loadedFiles.length > 0 && !processing && <div style={{ marginTop: 20, textAlign: "center" }}><button onClick={() => setLifecycles(rebuildFromTransactions(rawTx, rates))} style={{ padding: "12px 28px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#fff", background: CV.green }}>{loadedFiles.length >= 3 ? "Build Lifecycles" : "Analyze What's Loaded"}</button></div>}
        </div>
      </div>
    );
  }

  const TABS = [{ k: "overview", l: "Overview" }, { k: "onhand", l: "On Hand" }, { k: "throughput", l: "Throughput" }, { k: "costs", l: "Cost Trends" }, { k: "aging", l: "Aging" }, { k: "vendors", l: "Vendors" }, { k: "materials", l: "Materials" }, { k: "locations", l: "Locations" }, { k: "search", l: "Search" }, { k: "rates", l: "Rates" }];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif", background: CV.cream, color: CV.navy }}>
      <div style={{ background: CV.navy, padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: CV.red, textTransform: "uppercase" }}>OCS</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>Pallet Lifecycle Analyzer</span>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{loadedFiles.length} files | {fmtN(totals.pallets)} lifecycles</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input ref={addRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => { addFile(e.target.files, true); e.target.value = ""; }} />
          <button onClick={() => addRef.current?.click()} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#fff", background: "transparent" }}>+ File</button>
          <button onClick={() => exportCSV(filtered)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#fff", background: "transparent" }}>CSV</button>
          <button onClick={reset} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.5)", background: "transparent" }}>Reset</button>
        </div>
      </div>
      <div style={{ background: "#fff", padding: "0 24px", borderBottom: `1px solid ${CV.creamDark}`, display: "flex", gap: 0, overflowX: "auto", flexShrink: 0 }}>
        {TABS.map(t => <button key={t.k} onClick={() => { setTab(t.k); setDrillMat(null); setDrillLoc(null); }} style={{ padding: "10px 16px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: "transparent", color: tab === t.k ? CV.navy : "#999", borderBottom: tab === t.k ? `3px solid ${CV.red}` : "3px solid transparent" }}>{t.l}</button>)}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {!["rates", "search"].includes(tab) && costed && <FilterBar filters={filters} setFilters={setFilters} lifecycles={costed} />}

        {tab === "overview" && <>
          <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            <KPI label="Total Lifecycles" value={fmtN(totals.pallets)} /><KPI label="Open" value={fmtN(totals.open)} color={CV.green} /><KPI label="Pre-existing" value={fmtN(totals.preEx)} color={CV.orange} /><KPI label="Modeled Cost" value={totals.cost > 0 ? fmtK(totals.cost) : "---"} color={CV.red} /><KPI label="Locations" value={actLocs.length} color={CV.teal} />
          </div>
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
          <Card><SectionTitle>Pallet Detail</SectionTitle><div style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}><thead><tr style={{ background: CV.navy }}>{["Pallet", "Loc", "Qty", "Entry", "Exit", "Dwell", "Status", "Cost"].map(h => <th key={h} style={{ padding: "8px", textAlign: "left", color: "#fff", fontWeight: 700, fontSize: 9 }}>{h}</th>)}</tr></thead><tbody>{ml.slice(0, 300).map((l, i) => <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}><td style={{ padding: "5px 8px", fontFamily: "monospace", fontWeight: 600 }}>{l.pallet}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.loc}</td><td style={{ padding: "5px 8px" }}>{l.qty}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.entryDate)}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.exitDate)}</td><td style={{ padding: "5px 8px", fontWeight: 600 }}>{l.dwell != null ? `${l.dwell}d` : "---"}</td><td style={{ padding: "5px 8px" }}>{l.open ? <Badge bg="#E8F8ED" color={CV.green}>Open</Badge> : l.preExisting ? <Badge bg="#FEF3E2" color={CV.orange}>Pre-Ex</Badge> : ""}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.totalCost > 0 ? fmt$(l.totalCost) : "---"}</td></tr>)}</tbody></table></div></Card>
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
          {searchRes.length > 0 && <Card style={{ padding: 0, overflow: "hidden" }}><div style={{ padding: "10px 14px", fontSize: 11, color: "#888", borderBottom: `1px solid ${CV.cream}` }}>{searchRes.length >= 500 ? "500+" : searchRes.length} results</div><div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 1000 }}><thead><tr style={{ background: CV.navy }}>{["Pallet", "Loc", "Vendor", "Material", "Lot", "Qty", "Entry", "Exit", "Dwell", "Status", "Cost"].map(h => <th key={h} style={{ padding: "8px", textAlign: "left", color: "#fff", fontWeight: 700, fontSize: 9 }}>{h}</th>)}</tr></thead><tbody>{searchRes.map((l, i) => <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}><td style={{ padding: "5px 8px", fontFamily: "monospace", fontWeight: 600 }}>{l.pallet}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.loc}</td><td style={{ padding: "5px 8px" }}>{OCS_LOCATIONS[l.loc]?.vendor}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.material}</td><td style={{ padding: "5px 8px", fontFamily: "monospace", fontSize: 10 }}>{l.mfgLot}</td><td style={{ padding: "5px 8px" }}>{l.qty}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.entryDate)}</td><td style={{ padding: "5px 8px", fontSize: 10 }}>{fmtD(l.exitDate)}</td><td style={{ padding: "5px 8px", fontWeight: 600 }}>{l.dwell != null ? `${l.dwell}d` : "---"}</td><td style={{ padding: "5px 8px" }}>{l.open ? <Badge bg="#E8F8ED" color={CV.green}>Open</Badge> : l.preExisting ? <Badge bg="#FEF3E2" color={CV.orange}>Pre-Ex</Badge> : <Badge bg="#F0F0F0" color="#999">Closed</Badge>}</td><td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{l.totalCost > 0 ? fmt$(l.totalCost) : "---"}</td></tr>)}</tbody></table></div></Card>}
          {search.length >= 3 && !searchRes.length && <div style={{ padding: 32, textAlign: "center", color: "#aaa" }}>No results</div>}
        </>}

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
