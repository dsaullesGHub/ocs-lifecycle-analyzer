// NACS Invoice Processor
// Parses text-extracted NACS invoice PDFs (fixed-width text format)
// Handles both real PDF and ZIP archive inputs

import { detectFileType, extractPdfPages } from './pdfUtils.js';

const CONTRACTED_RATES = {
  "Renewal":           { label: "Renewal Storage", category: "storage",     contracted: 13.00 },
  "Initial Storage":   { label: "Initial Storage", category: "storage",     contracted: 13.00 },
  "Handling":          { label: "Handling",         category: "handling",    contracted: 13.25 },
  "BOL":               { label: "B/L Fee",          category: "assessorial", contracted: 2.00 },
  "Stretch Wrap":      { label: "Stretch Wrap",     category: "assessorial", contracted: 3.00 },
  "Freeze":            { label: "Energy/Freeze",    category: "assessorial", contracted: null },
  "Pallet":            { label: "Pallets",          category: "assessorial", contracted: 6.50 },
};

function parseSummaryPage(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  const result = { invoiceNumber: null, invoiceDate: null, selectedThrough: null, summaryCharges: [], invoiceTotal: null };

  for (let i = 0; i < lines.length; i++) {
    if (!result.invoiceNumber && /^\d{4,6}$/.test(lines[i])) result.invoiceNumber = lines[i];
    if (!result.invoiceDate && /^\d{2}\/\d{2}\/\d{4}$/.test(lines[i])) result.invoiceDate = lines[i];
    const stMatch = lines[i].match(/Selected Through:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (stMatch) result.selectedThrough = stMatch[1];

    const chargeMatch = lines[i].match(/^(.+?)\s+([\d,]+)\s+\$\s*([\d,.]+)\s+\$\s*([\d,.]+)\s+\$\s*([\d,.]+)$/);
    if (chargeMatch) {
      const fullDesc = chargeMatch[1].trim();
      let codeKey = null;
      for (const key of Object.keys(CONTRACTED_RATES)) { if (fullDesc.includes(key)) { codeKey = key; break; } }
      result.summaryCharges.push({
        rawDescription: fullDesc, codeKey,
        quantity: parseFloat(chargeMatch[2].replace(/,/g, "")),
        unitRate: parseFloat(chargeMatch[4].replace(/,/g, "")),
        extension: parseFloat(chargeMatch[5].replace(/,/g, "")),
      });
    }
    const totalMatch = lines[i].match(/^\$\s*([\d,]+\.\d{2})$/);
    if (totalMatch && !result.invoiceTotal) result.invoiceTotal = parseFloat(totalMatch[1].replace(/,/g, ""));
  }
  return result;
}

function parseDetailLine(line) {
  const pidMatch = line.match(/\b(F\d{5,8})\b/);
  if (!pidMatch) return null;
  const pidIdx = line.indexOf(pidMatch[1]);
  const before = line.substring(0, pidIdx).trim();
  const after = line.substring(pidIdx + pidMatch[1].length).trim();
  const beforeTokens = before.split(/\s+/);
  if (beforeTokens.length < 4) return null;
  const chargeDate = beforeTokens[0];
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(chargeDate)) return null;
  const itemCode = beforeTokens[1];
  if (!/^\d{5,6}$/.test(itemCode)) return null;
  const expRaw = beforeTokens[beforeTokens.length - 1];
  const expDate = /^\d{8}$/.test(expRaw) ? expRaw : null;
  const descTokens = beforeTokens.slice(2, expDate ? beforeTokens.length - 1 : beforeTokens.length);
  const description = descTokens.join(" ");
  const afterTokens = after.split(/\s+/);
  if (afterTokens.length < 4) return null;
  const extension = parseFloat(afterTokens[afterTokens.length - 1]);
  const rate = parseFloat(afterTokens[afterTokens.length - 2]);
  const codeParts = afterTokens.slice(2, afterTokens.length - 2);
  const chargeCodeRaw = codeParts.join(" ").trim();
  let codeKey = null;
  for (const key of Object.keys(CONTRACTED_RATES)) { if (chargeCodeRaw.startsWith(key) || chargeCodeRaw === key) { codeKey = key; break; } }
  if (isNaN(rate) || isNaN(extension)) return null;
  return { chargeDate, itemCode, description, expirationDate: expDate, pid: pidMatch[1], qty: 1, uom: "PL", chargeCodeRaw, codeKey, rate, extension };
}

export async function parseNACSInvoice(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const fileType = await detectFileType(arrayBuffer);
  let pageTexts = [];

  if (fileType === "pdf") {
    if (onProgress) onProgress("Extracting text from PDF...");
    const extracted = await extractPdfPages(arrayBuffer);
    pageTexts = extracted.pages;
  } else if (fileType === "zip") {
    if (onProgress) onProgress("Reading ZIP archive...");
    // Dynamic import JSZip from CDN
    if (!window.JSZip) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
      });
    }
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const manifestRaw = await zip.file("manifest.json")?.async("string");
    if (manifestRaw) {
      const manifest = JSON.parse(manifestRaw);
      for (const pg of manifest.pages) {
        const txtFile = zip.file(pg.text?.path);
        const text = txtFile ? await txtFile.async("string") : "";
        pageTexts.push(text);
      }
    }
  } else {
    throw new Error("Unrecognized file format. Expected NACS PDF or ZIP.");
  }

  if (pageTexts.length === 0) throw new Error("No pages found in file.");

  if (onProgress) onProgress("Parsing invoice structure...");
  const summary = parseSummaryPage(pageTexts[0]);
  const detailLines = [];
  const parseErrors = [];

  for (let i = 1; i < pageTexts.length; i++) {
    const lines = pageTexts[i].replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!/^\d{2}\/\d{2}\/\d{4}/.test(line)) continue;
      if (line.split(/\s+/).length < 6) continue;
      const parsed = parseDetailLine(line);
      if (parsed) detailLines.push(parsed); else parseErrors.push(line);
    }
  }

  // Aggregate charges
  const chargeMap = {};
  for (const dl of detailLines) {
    const key = dl.codeKey || dl.chargeCodeRaw;
    if (!chargeMap[key]) chargeMap[key] = { lines: [], totalExtension: 0, pallets: 0 };
    chargeMap[key].lines.push(dl);
    chargeMap[key].totalExtension += dl.extension;
    chargeMap[key].pallets += dl.qty;
  }

  const lineItems = Object.entries(chargeMap).map(([key, data]) => {
    const contracted = CONTRACTED_RATES[key];
    const billedRate = data.lines[0]?.rate ?? null;
    const contractedRate = contracted?.contracted ?? null;
    const rateVariance = (billedRate != null && contractedRate != null) ? parseFloat((billedRate - contractedRate).toFixed(4)) : null;
    return { chargeCode: key, label: contracted?.label ?? key, category: contracted?.category ?? "other", pallets: data.pallets, billedRate, contractedRate, rateVariance, extension: parseFloat(data.totalExtension.toFixed(2)) };
  });

  const storageCharge = lineItems.filter(l => l.category === "storage").reduce((s, l) => s + l.extension, 0);
  const handlingCharge = lineItems.filter(l => l.category === "handling").reduce((s, l) => s + l.extension, 0);
  const assessorialsTotal = lineItems.filter(l => l.category === "assessorial").reduce((s, l) => s + l.extension, 0);
  const computedTotal = parseFloat((storageCharge + handlingCharge + assessorialsTotal).toFixed(2));

  // Determine billing period from invoice date
  let billingPeriod = null;
  if (summary.invoiceDate) {
    const parts = summary.invoiceDate.split("/");
    if (parts.length === 3) billingPeriod = `${parts[2]}-${parts[0]}`;
  }

  return {
    vendor: "NACS",
    location: "S7",
    invoiceNumber: summary.invoiceNumber,
    invoiceDate: summary.invoiceDate,
    selectedThrough: summary.selectedThrough,
    billingPeriod,
    storage: parseFloat(storageCharge.toFixed(2)),
    handling: parseFloat(handlingCharge.toFixed(2)),
    assessorials: parseFloat(assessorialsTotal.toFixed(2)),
    total: computedTotal,
    invoicedTotal: summary.invoiceTotal,
    totalVariance: summary.invoiceTotal != null ? parseFloat((computedTotal - summary.invoiceTotal).toFixed(2)) : null,
    palletsBilled: (chargeMap["Renewal"]?.pallets ?? 0) + (chargeMap["Initial Storage"]?.pallets ?? 0),
    lineItems,
    detailLines: detailLines.length,
    parseErrors: parseErrors.length,
    raw: { summary, detailLineCount: detailLines.length, parseErrorCount: parseErrors.length },
  };
}
