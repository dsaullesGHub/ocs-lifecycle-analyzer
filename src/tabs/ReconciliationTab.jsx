// ReconciliationTab - Compare invoiced costs vs WMS-modeled costs by period and location
import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

const CV = { navy: "#2B4170", red: "#E8523F", cream: "#F5EDE0", teal: "#00A3BE", purple: "#7B5EA7", orange: "#F5A623", green: "#4EBC6A", navyLight: "#E8EDF5", creamDark: "#EDE0CE" };
const fmt$ = (v) => v == null ? "---" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtK = (v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : fmt$(v);
const fmtN = (v) => v == null ? "---" : v.toLocaleString();
const mKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function Badge({ bg, color, children }) { return <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: bg, color, whiteSpace: "nowrap" }}>{children}</span>; }
function Card({ children, style }) { return <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px", border: `1px solid ${CV.creamDark}`, ...style }}>{children}</div>; }

const OCS_LOCATIONS = {
  S7: "NACS", S4: "IWI Franklin", S9: "Americold Indy", C3: "Americold Rochelle",
  S: "Americold Atlanta", C1: "US Cold", "7B": "Mesa Cold", O1: "Kingman Interstate",
};

export default function ReconciliationTab({ invoices, lifecycles }) {
  // Build WMS modeled cost by period + location
  const wmsData = useMemo(() => {
    if (!lifecycles) return {};
    const data = {};
    for (const lc of lifecycles) {
      if (lc.preExisting || !lc.entryDate || !lc.hasRates) continue;
      const period = mKey(lc.entryDate);
      const key = `${period}|${lc.loc}`;
      if (!data[key]) data[key] = { period, loc: lc.loc, modeledCost: 0, modeledPallets: 0 };
      data[key].modeledCost += lc.totalCost || 0;
      data[key].modeledPallets++;
    }
    return data;
  }, [lifecycles]);

  // Build invoice cost by period + location
  const invData = useMemo(() => {
    const data = {};
    for (const inv of invoices) {
      const key = `${inv.billingPeriod}|${inv.location}`;
      if (!data[key]) data[key] = { period: inv.billingPeriod, loc: inv.location, invoicedCost: 0, invoicedPallets: 0, invoiceCount: 0 };
      data[key].invoicedCost += inv.invoicedTotal || inv.total || 0;
      data[key].invoicedPallets += inv.palletsBilled || 0;
      data[key].invoiceCount++;
    }
    return data;
  }, [invoices]);

  // Merge into reconciliation rows
  const reconRows = useMemo(() => {
    const allKeys = new Set([...Object.keys(wmsData), ...Object.keys(invData)]);
    const rows = [];
    for (const key of allKeys) {
      const [period, loc] = key.split("|");
      const wms = wmsData[key];
      const inv = invData[key];
      const modeled = wms?.modeledCost || 0;
      const invoiced = inv?.invoicedCost || 0;
      const variance = invoiced > 0 && modeled > 0 ? invoiced - modeled : null;
      const variancePct = invoiced > 0 && modeled > 0 ? ((invoiced - modeled) / modeled * 100) : null;
      rows.push({
        period, loc, locName: OCS_LOCATIONS[loc] || loc,
        modeledCost: modeled, modeledPallets: wms?.modeledPallets || 0,
        invoicedCost: invoiced, invoicedPallets: inv?.invoicedPallets || 0,
        invoiceCount: inv?.invoiceCount || 0,
        variance, variancePct,
        hasWMS: !!wms, hasInvoice: !!inv,
      });
    }
    return rows.sort((a, b) => a.period.localeCompare(b.period) || a.loc.localeCompare(b.loc));
  }, [wmsData, invData]);

  // Summary by location
  const locSummary = useMemo(() => {
    const summary = {};
    for (const r of reconRows) {
      if (!summary[r.loc]) summary[r.loc] = { loc: r.loc, locName: r.locName, modeled: 0, invoiced: 0, periods: 0, modeledPallets: 0, invoicedPallets: 0 };
      summary[r.loc].modeled += r.modeledCost;
      summary[r.loc].invoiced += r.invoicedCost;
      summary[r.loc].modeledPallets += r.modeledPallets;
      summary[r.loc].invoicedPallets += r.invoicedPallets;
      if (r.hasWMS || r.hasInvoice) summary[r.loc].periods++;
    }
    return Object.values(summary).map(s => ({
      ...s,
      variance: s.invoiced > 0 && s.modeled > 0 ? s.invoiced - s.modeled : null,
      variancePct: s.invoiced > 0 && s.modeled > 0 ? ((s.invoiced - s.modeled) / s.modeled * 100) : null,
    })).sort((a, b) => (b.invoiced + b.modeled) - (a.invoiced + a.modeled));
  }, [reconRows]);

  // Chart data by period
  const chartData = useMemo(() => {
    const byPeriod = {};
    for (const r of reconRows) {
      if (!byPeriod[r.period]) byPeriod[r.period] = { period: r.period, invoiced: 0, modeled: 0 };
      byPeriod[r.period].invoiced += r.invoicedCost;
      byPeriod[r.period].modeled += r.modeledCost;
    }
    return Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period)).filter(d => d.invoiced > 0 || d.modeled > 0);
  }, [reconRows]);

  const totalInvoiced = reconRows.reduce((s, r) => s + r.invoicedCost, 0);
  const totalModeled = reconRows.reduce((s, r) => s + r.modeledCost, 0);
  const totalVariance = totalInvoiced > 0 && totalModeled > 0 ? totalInvoiced - totalModeled : null;

  const hasData = invoices.length > 0 || (lifecycles && lifecycles.length > 0);

  if (!hasData) {
    return (
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>Reconciliation</h2>
        <Card style={{ textAlign: "center", padding: "40px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: CV.navy, opacity: 0.4 }}>No data to reconcile</div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 6 }}>Load WMS files (Lifecycle Analyzer) and process invoices (Invoices tab) to see the reconciliation view.</div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>Invoice vs WMS Reconciliation</h2>
      <p style={{ margin: "0 0 16px", fontSize: 12, color: "#888" }}>
        Comparing vendor-invoiced charges against WMS-modeled expected costs by period and location.
        {invoices.length === 0 && " Upload invoices in the Invoices tab to populate the invoice side."}
        {!lifecycles && " Load WMS data to populate the modeled cost side."}
      </p>

      {/* Top-level KPIs */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ flex: "1 0 160px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: CV.navy }}>{fmt$(totalInvoiced)}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase" }}>Total Invoiced</div>
        </div>
        <div style={{ flex: "1 0 160px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: CV.teal }}>{fmt$(totalModeled)}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase" }}>WMS Modeled</div>
        </div>
        <div style={{ flex: "1 0 160px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}`, borderLeft: `4px solid ${totalVariance != null ? (Math.abs(totalVariance) < 100 ? CV.green : CV.red) : "#ccc"}` }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: totalVariance != null ? (totalVariance > 0 ? CV.red : CV.green) : "#ccc" }}>
            {totalVariance != null ? `${totalVariance > 0 ? "+" : ""}${fmt$(totalVariance)}` : "---"}
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase" }}>Variance (Invoice - Modeled)</div>
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, color: CV.navy, textTransform: "uppercase" }}>Monthly: Invoiced vs Modeled</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={CV.creamDark} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
              <Tooltip formatter={v => fmt$(v)} />
              <Legend />
              <Bar dataKey="invoiced" name="Invoiced" fill={CV.red} radius={[3, 3, 0, 0]} />
              <Bar dataKey="modeled" name="WMS Modeled" fill={CV.teal} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Location summary */}
      {locSummary.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, color: CV.navy, textTransform: "uppercase" }}>By Location</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: CV.navy }}>
                  {["Code", "Location", "Invoiced", "Inv Pallets", "Modeled", "Mod Pallets", "Variance", "Var %"].map(h =>
                    <th key={h} style={{ padding: "9px 10px", textAlign: ["Code", "Location"].includes(h) ? "left" : "right", color: "#fff", fontWeight: 700, fontSize: 10 }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {locSummary.map((s, i) => (
                  <tr key={s.loc} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}>
                    <td style={{ padding: "8px 10px", fontWeight: 800, fontFamily: "monospace" }}>{s.loc}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{s.locName}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace", color: s.invoiced > 0 ? CV.navy : "#ccc" }}>{s.invoiced > 0 ? fmtK(s.invoiced) : "---"}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: s.invoicedPallets > 0 ? CV.navy : "#ccc" }}>{s.invoicedPallets > 0 ? fmtN(s.invoicedPallets) : "---"}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace", color: s.modeled > 0 ? CV.teal : "#ccc" }}>{s.modeled > 0 ? fmtK(s.modeled) : "---"}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: s.modeledPallets > 0 ? CV.navy : "#ccc" }}>{s.modeledPallets > 0 ? fmtN(s.modeledPallets) : "---"}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, fontFamily: "monospace", color: s.variance != null ? (s.variance > 0 ? CV.red : CV.green) : "#ccc" }}>
                      {s.variance != null ? `${s.variance > 0 ? "+" : ""}${fmtK(s.variance)}` : "---"}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {s.variancePct != null ? (
                        <Badge bg={Math.abs(s.variancePct) < 5 ? "#E8F8ED" : Math.abs(s.variancePct) < 15 ? "#FEF3E2" : "#FEEEEC"}
                          color={Math.abs(s.variancePct) < 5 ? CV.green : Math.abs(s.variancePct) < 15 ? CV.orange : CV.red}>
                          {s.variancePct > 0 ? "+" : ""}{s.variancePct.toFixed(1)}%
                        </Badge>
                      ) : "---"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Detail rows */}
      {reconRows.length > 0 && (
        <Card>
          <h3 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 700, color: CV.navy, textTransform: "uppercase" }}>Period Detail</h3>
          <div style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead style={{ position: "sticky", top: 0 }}>
                <tr style={{ background: CV.navy }}>
                  {["Period", "Loc", "Name", "Invoiced", "Inv Plts", "Modeled", "Mod Plts", "Variance", "Status"].map(h =>
                    <th key={h} style={{ padding: "8px 8px", textAlign: ["Period", "Loc", "Name"].includes(h) ? "left" : "right", color: "#fff", fontWeight: 700, fontSize: 9 }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {reconRows.filter(r => r.invoicedCost > 0 || r.modeledCost > 0).map((r, i) => (
                  <tr key={`${r.period}-${r.loc}`} style={{ background: i % 2 === 0 ? "#fff" : CV.cream }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace", fontWeight: 600 }}>{r.period}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{r.loc}</td>
                    <td style={{ padding: "6px 8px" }}>{r.locName}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: r.invoicedCost > 0 ? CV.navy : "#ccc" }}>{r.invoicedCost > 0 ? fmt$(r.invoicedCost) : "---"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: r.invoicedPallets > 0 ? CV.navy : "#ccc" }}>{r.invoicedPallets || "---"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: r.modeledCost > 0 ? CV.teal : "#ccc" }}>{r.modeledCost > 0 ? fmt$(r.modeledCost) : "---"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: r.modeledPallets > 0 ? CV.navy : "#ccc" }}>{r.modeledPallets || "---"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, fontFamily: "monospace", color: r.variance != null ? (r.variance > 0 ? CV.red : CV.green) : "#ccc" }}>
                      {r.variance != null ? `${r.variance > 0 ? "+" : ""}${fmt$(r.variance)}` : "---"}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {r.hasWMS && r.hasInvoice ? (
                        <Badge bg={r.variancePct != null && Math.abs(r.variancePct) < 10 ? "#E8F8ED" : "#FEEEEC"}
                          color={r.variancePct != null && Math.abs(r.variancePct) < 10 ? CV.green : CV.red}>
                          {r.variancePct != null && Math.abs(r.variancePct) < 10 ? "Matched" : "Review"}
                        </Badge>
                      ) : !r.hasInvoice ? (
                        <Badge bg="#FEF3E2" color={CV.orange}>No Invoice</Badge>
                      ) : (
                        <Badge bg={CV.navyLight} color={CV.navy}>No WMS</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, padding: "10px 14px", background: CV.navyLight, borderRadius: 8, fontSize: 11, color: CV.navy, lineHeight: 1.5 }}>
            <strong>How to read this:</strong> Positive variance means the vendor invoiced more than the WMS model predicted. Negative means they invoiced less.
            Variances under 10% are expected due to timing differences (assessorials, partial months, rate rounding). Variances over 15% should be investigated.
            "No Invoice" means WMS shows activity for that period/location but no invoice has been processed. "No WMS" means an invoice exists but no WMS lifecycle data is loaded.
          </div>
        </Card>
      )}
    </div>
  );
}
