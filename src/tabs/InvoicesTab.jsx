// InvoicesTab - Upload, process, and review OCS vendor invoices
import { useState, useRef, useCallback } from "react";
import { parseNACSInvoice } from "../processors/nacs.js";
import { parseInterstateInvoice } from "../processors/interstate.js";
import { parseMesaInvoice } from "../processors/mesa.js";

const CV = { navy: "#2B4170", red: "#E8523F", cream: "#F5EDE0", teal: "#00A3BE", purple: "#7B5EA7", orange: "#F5A623", green: "#4EBC6A", navyLight: "#E8EDF5", creamDark: "#EDE0CE" };
const fmt$ = (v) => v == null ? "---" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (v) => v == null ? "---" : v.toLocaleString();

function Badge({ bg, color, children }) { return <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: bg, color, whiteSpace: "nowrap" }}>{children}</span>; }
function Card({ children, style }) { return <div style={{ background: "#fff", borderRadius: 12, padding: "20px 24px", border: `1px solid ${CV.creamDark}`, ...style }}>{children}</div>; }

export default function InvoicesTab({ invoices, setInvoices, apiKey, onApiKeyChange }) {
  const [vendor, setVendor] = useState("auto");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selectedInv, setSelectedInv] = useState(null);
  const fileRef = useRef(null);

  const detectVendor = (fileName) => {
    const n = fileName.toUpperCase();
    if (n.includes("NACS") || n.includes("NOR107")) return "NACS";
    if (n.includes("INTERSTATE") || n.includes("IWI") || n.includes("FRANKLIN") || n.includes("KINGMAN")) return "Interstate";
    if (n.includes("MESA") || n.includes("MES100")) return "Mesa";
    return null;
  };

  const processFile = useCallback(async (file, vendorOverride) => {
    const v = vendorOverride || detectVendor(file.name);
    if (!v) throw new Error(`Cannot detect vendor for "${file.name}". Please select vendor manually.`);

    if (v === "NACS") {
      return await parseNACSInvoice(file, setProgress);
    } else if (v === "Interstate") {
      return await parseInterstateInvoice(file, setProgress);
    } else if (v === "Mesa") {
      if (!apiKey) throw new Error("Enter your Anthropic API key to process Mesa invoices.");
      return await parseMesaInvoice(file, apiKey, setProgress);
    }
    throw new Error(`Unknown vendor: ${v}`);
  }, [apiKey]);

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter(f => f.name.match(/\.(pdf|zip)$/i));
    if (!files.length) { setError("No PDF or ZIP files found."); return; }
    setProcessing(true); setError(""); setProgress("");

    const newInvoices = [...invoices];
    let processed = 0, errors = 0, totalInvFound = 0;

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      try {
        setProgress(`File ${fi + 1} of ${files.length}: ${file.name}...`);
        await new Promise(r => setTimeout(r, 50)); // yield to UI
        const v = vendor !== "auto" ? vendor : null;
        const results = await processFile(file, v);
        const resultArray = Array.isArray(results) ? results : [results];
        for (const inv of resultArray) {
          const exists = newInvoices.some(e => e.invoiceNumber === inv.invoiceNumber && e.vendor === inv.vendor);
          if (!exists) { newInvoices.push({ ...inv, sourceFile: file.name }); totalInvFound++; }
        }
        processed++;
        setProgress(`${file.name}: ${resultArray.length} invoice(s) found`);
        await new Promise(r => setTimeout(r, 200)); // brief pause to show result
      } catch (err) {
        errors++;
        console.error(`Invoice processing error for ${file.name}:`, err);
        setError(prev => prev ? `${prev}\n${file.name}: ${err.message}` : `${file.name}: ${err.message}`);
        await new Promise(r => setTimeout(r, 100));
      }
    }

    setInvoices(newInvoices);
    setProgress(`Complete: ${processed} file${processed !== 1 ? "s" : ""}, ${totalInvFound} invoice${totalInvFound !== 1 ? "s" : ""} added${errors > 0 ? `, ${errors} error${errors !== 1 ? "s" : ""}` : ""}`);
    setProcessing(false);
  }, [invoices, setInvoices, vendor, processFile]);

  const clearInvoices = () => { setInvoices([]); setSelectedInv(null); setError(""); setProgress(""); };

  const totalInvoiced = invoices.reduce((s, inv) => s + (inv.invoicedTotal || inv.total || 0), 0);
  const byVendor = {};
  for (const inv of invoices) {
    if (!byVendor[inv.vendor]) byVendor[inv.vendor] = { count: 0, total: 0 };
    byVendor[inv.vendor].count++;
    byVendor[inv.vendor].total += inv.invoicedTotal || inv.total || 0;
  }

  const vendorColors = { NACS: CV.navy, Interstate: CV.teal, Mesa: CV.purple };

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>Invoice Processing</h2>
      <p style={{ margin: "0 0 16px", fontSize: 12, color: "#888" }}>Upload OCS vendor invoices. NACS and Interstate process locally. Mesa requires an Anthropic API key for OCR.</p>

      {/* Upload area */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy, marginBottom: 4 }}>VENDOR</div>
            <select value={vendor} onChange={e => setVendor(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${CV.creamDark}`, fontSize: 12 }}>
              <option value="auto">Auto-detect</option>
              <option value="NACS">NACS</option>
              <option value="Interstate">Interstate</option>
              <option value="Mesa">Mesa</option>
            </select>
          </div>

          {(vendor === "Mesa" || vendor === "auto") && (
            <div style={{ flex: "1 0 250px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy, marginBottom: 4 }}>ANTHROPIC API KEY (Mesa only)</div>
              <input type="password" value={apiKey} onChange={e => onApiKeyChange(e.target.value)}
                placeholder="sk-ant-..."
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: `1px solid ${CV.creamDark}`, fontSize: 12, fontFamily: "monospace" }} />
            </div>
          )}
        </div>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragEnter={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={e => { e.preventDefault(); setDragging(false); }}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
          style={{
            padding: "28px 16px", borderRadius: 10,
            border: `2px dashed ${dragging ? CV.teal : CV.creamDark}`,
            background: dragging ? "rgba(0,163,190,0.05)" : "transparent",
            textAlign: "center", cursor: "pointer",
          }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: dragging ? CV.teal : CV.navy }}>
            {dragging ? "Drop invoice PDFs here" : "Drag and drop invoice PDFs, or click to browse"}
          </div>
          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>Accepts PDF and ZIP files. Multiple files supported.</div>
        </div>
        <input ref={fileRef} type="file" accept=".pdf,.zip" multiple style={{ display: "none" }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />

        {(progress || processing) && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: CV.navyLight, borderRadius: 8, fontSize: 12, color: CV.navy, display: "flex", alignItems: "center", gap: 10 }}>
            {processing && <div style={{ width: 16, height: 16, border: `2px solid ${CV.creamDark}`, borderTopColor: CV.navy, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />}
            <span>{progress}</span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {error && <div style={{ marginTop: 8, padding: "10px 14px", background: "#FEEEEC", borderRadius: 8, fontSize: 12, color: CV.red, whiteSpace: "pre-wrap" }}>{error}</div>}
      </Card>

      {/* Summary */}
      {invoices.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ flex: "1 0 130px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: CV.navy }}>{invoices.length}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase" }}>Invoices</div>
            </div>
            <div style={{ flex: "1 0 130px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: CV.red }}>{fmt$(totalInvoiced)}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#999", textTransform: "uppercase" }}>Total Invoiced</div>
            </div>
            {Object.entries(byVendor).map(([v, d]) => (
              <div key={v} style={{ flex: "1 0 130px", background: "#fff", borderRadius: 10, padding: "14px 16px", border: `1px solid ${CV.creamDark}` }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: vendorColors[v] || CV.navy }}>{d.count}</div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#999" }}>{v} ({fmt$(d.total)})</div>
              </div>
            ))}
            <button onClick={clearInvoices} style={{ alignSelf: "center", padding: "8px 14px", borderRadius: 8, border: `1px solid ${CV.creamDark}`, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#999", background: "#fff" }}>Clear All</button>
          </div>

          {/* Invoice table */}
          <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: CV.navy }}>
                    {["Vendor", "Loc", "Invoice #", "Date", "Period", "Storage", "Handling", "Assess.", "Total", "Pallets", "Variance"].map(h =>
                      <th key={h} style={{ padding: "9px 10px", textAlign: ["Vendor", "Loc", "Invoice #", "Date", "Period"].includes(h) ? "left" : "right", color: "#fff", fontWeight: 700, fontSize: 10 }}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {invoices.sort((a, b) => (a.billingPeriod || "").localeCompare(b.billingPeriod || "")).map((inv, i) => (
                    <tr key={`${inv.vendor}-${inv.invoiceNumber}`} style={{ background: i % 2 === 0 ? "#fff" : CV.cream, cursor: "pointer" }}
                      onClick={() => setSelectedInv(selectedInv?.invoiceNumber === inv.invoiceNumber ? null : inv)}>
                      <td style={{ padding: "8px 10px" }}><Badge bg={`${vendorColors[inv.vendor]}20`} color={vendorColors[inv.vendor]}>{inv.vendor}</Badge></td>
                      <td style={{ padding: "8px 10px", fontFamily: "monospace", fontWeight: 700 }}>{inv.location}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "monospace" }}>{inv.invoiceNumber}</td>
                      <td style={{ padding: "8px 10px" }}>{inv.invoiceDate}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "monospace" }}>{inv.billingPeriod}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace" }}>{fmt$(inv.storage)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace" }}>{fmt$(inv.handling)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace" }}>{fmt$(inv.assessorials)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, fontFamily: "monospace", color: CV.navy }}>{fmt$(inv.invoicedTotal || inv.total)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>{fmtN(inv.palletsBilled)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace", color: inv.totalVariance ? (Math.abs(inv.totalVariance) < 0.01 ? CV.green : CV.red) : "#ccc" }}>
                        {inv.totalVariance != null ? fmt$(inv.totalVariance) : "---"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Selected invoice detail */}
          {selectedInv && (
            <Card>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <h3 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700 }}>
                    {selectedInv.vendor} Invoice #{selectedInv.invoiceNumber}
                  </h3>
                  <div style={{ fontSize: 12, color: "#888" }}>
                    {selectedInv.invoiceDate} | {selectedInv.location} | {selectedInv.palletsBilled} pallets
                    {selectedInv.sourceFile && <span> | Source: {selectedInv.sourceFile}</span>}
                  </div>
                </div>
                <button onClick={() => setSelectedInv(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#999" }}>x</button>
              </div>

              {/* Charge breakdown */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${CV.creamDark}` }}>
                    {["Charge Code", "Category", "Pallets", "Billed Rate", "Extension"].map(h =>
                      <th key={h} style={{ padding: "6px 10px", textAlign: h === "Charge Code" || h === "Category" ? "left" : "right", fontWeight: 700, fontSize: 10, color: CV.navy }}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(selectedInv.lineItems || []).map((li, idx) => (
                    <tr key={idx} style={{ borderBottom: `1px solid ${CV.cream}` }}>
                      <td style={{ padding: "7px 10px", fontWeight: 600 }}>{li.label || li.chargeCode}</td>
                      <td style={{ padding: "7px 10px" }}><Badge bg={li.category === "storage" ? "#E8F8ED" : li.category === "handling" ? CV.navyLight : "#FEF3E2"} color={li.category === "storage" ? CV.green : li.category === "handling" ? CV.navy : CV.orange}>{li.category}</Badge></td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{li.pallets}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "monospace" }}>{li.billedRate != null ? fmt$(li.billedRate) : "---"}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600, fontFamily: "monospace" }}>{fmt$(li.extension)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: CV.navyLight, fontWeight: 700 }}>
                    <td colSpan={4} style={{ padding: "10px" }}>Total</td>
                    <td style={{ padding: "10px", textAlign: "right", fontFamily: "monospace", fontSize: 14 }}>{fmt$(selectedInv.total)}</td>
                  </tr>
                </tbody>
              </table>

              {selectedInv.invoicedTotal != null && (
                <div style={{ display: "flex", gap: 16 }}>
                  <div style={{ padding: "10px 14px", background: CV.cream, borderRadius: 8, flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy }}>Computed Total</div>
                    <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace" }}>{fmt$(selectedInv.total)}</div>
                  </div>
                  <div style={{ padding: "10px 14px", background: CV.cream, borderRadius: 8, flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy }}>Invoice Stated Total</div>
                    <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace" }}>{fmt$(selectedInv.invoicedTotal)}</div>
                  </div>
                  <div style={{ padding: "10px 14px", background: selectedInv.totalVariance && Math.abs(selectedInv.totalVariance) > 0.01 ? "#FEEEEC" : "#E8F8ED", borderRadius: 8, flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: CV.navy }}>Variance</div>
                    <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: selectedInv.totalVariance && Math.abs(selectedInv.totalVariance) > 0.01 ? CV.red : CV.green }}>
                      {fmt$(selectedInv.totalVariance)}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {invoices.length === 0 && !processing && (
        <Card style={{ textAlign: "center", padding: "40px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: CV.navy, opacity: 0.4 }}>No invoices processed yet</div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 6 }}>Upload vendor invoice PDFs to begin. Supported: NACS (PDF/ZIP), Interstate (PDF), Mesa (PDF with API key).</div>
        </Card>
      )}
    </div>
  );
}
