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

function isSummaryPage(text) {
  // Summary pages have charge summary lines with $ and typically contain "Invoice Number" or "Selected Through"
  const hasCharges = /\$\s*[\d,]+\.\d{2}/.test(text);
  const hasInvMarker = /Selected Through|Invoice\s*(Number|Date)/i.test(text);
  const hasDetailLines = (text.match(/^\d{2}\/\d{2}\/\d{4}\s+\d{5}/gm) || []).length;
  // Summary pages have few detail lines (maybe 0), detail pages have many
  return (hasCharges && hasInvMarker) || (hasCharges && hasDetailLines < 3);
}

function buildInvoiceResult(summary, detailLines, parseErrors) {
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

export async function parseNACSInvoice(file, onProgress) {
  console.log("[NACS] Starting parse:", file.name, "size:", file.size);
  const arrayBuffer = await file.arrayBuffer();
  console.log("[NACS] ArrayBuffer read, length:", arrayBuffer.byteLength);

  const fileType = await detectFileType(arrayBuffer);
  console.log("[NACS] File type detected:", fileType);

  let pageTexts = [];

  if (fileType === "pdf") {
    if (onProgress) onProgress(`Extracting text from ${file.name}...`);
    await new Promise(r => setTimeout(r, 30));
    try {
      const extracted = await extractPdfPages(arrayBuffer);
      pageTexts = extracted.pages;
      console.log("[NACS] PDF extracted:", extracted.numPages, "pages");
    } catch (err) {
      console.error("[NACS] PDF extraction failed:", err);
      throw new Error(`PDF extraction failed for ${file.name}: ${err.message}`);
    }
  } else if (fileType === "zip") {
    if (onProgress) onProgress(`Reading ZIP: ${file.name}...`);
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
    console.log("[NACS] ZIP extracted:", pageTexts.length, "pages");
  } else {
    throw new Error(`Unrecognized file format for ${file.name}. Expected NACS PDF or ZIP.`);
  }

  if (pageTexts.length === 0) throw new Error(`No pages found in ${file.name}.`);

  // Log first 200 chars of each page for debugging
  pageTexts.forEach((pt, i) => {
    console.log(`[NACS] Page ${i + 1} (${pt.length} chars): "${pt.substring(0, 200).replace(/\n/g, " | ")}..."`);
  });

  if (onProgress) onProgress(`Parsing ${pageTexts.length} pages from ${file.name}...`);
  await new Promise(r => setTimeout(r, 30));

  // Group pages into invoices: each summary page starts a new invoice
  const invoiceGroups = [];
  let currentGroup = null;

  for (let i = 0; i < pageTexts.length; i++) {
    const isSummary = isSummaryPage(pageTexts[i]);
    console.log(`[NACS] Page ${i + 1}: isSummary=${isSummary}`);
    if (isSummary) {
      if (currentGroup) invoiceGroups.push(currentGroup);
      currentGroup = { summaryPageIdx: i, detailPageIdxs: [] };
    } else if (currentGroup) {
      currentGroup.detailPageIdxs.push(i);
    } else {
      currentGroup = { summaryPageIdx: i, detailPageIdxs: [] };
    }
  }
  if (currentGroup) invoiceGroups.push(currentGroup);

  if (invoiceGroups.length === 0) {
    invoiceGroups.push({ summaryPageIdx: 0, detailPageIdxs: Array.from({ length: pageTexts.length - 1 }, (_, i) => i + 1) });
  }

  console.log("[NACS] Invoice groups:", invoiceGroups.length, invoiceGroups.map(g => `summary:${g.summaryPageIdx} detail:[${g.detailPageIdxs.join(",")}]`));
  if (onProgress) onProgress(`Found ${invoiceGroups.length} invoice(s) in ${file.name}...`);
  await new Promise(r => setTimeout(r, 30));

  // Parse each group
  const results = [];
  for (const group of invoiceGroups) {
    const summary = parseSummaryPage(pageTexts[group.summaryPageIdx]);
    console.log("[NACS] Summary parsed:", JSON.stringify(summary));
    const detailLines = [];
    const parseErrors = [];

    for (const di of group.detailPageIdxs) {
      const lines = pageTexts[di].replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (!/^\d{2}\/\d{2}\/\d{4}/.test(line)) continue;
        if (line.split(/\s+/).length < 6) continue;
        const parsed = parseDetailLine(line);
        if (parsed) detailLines.push(parsed); else parseErrors.push(line);
      }
    }

    const summaryLines = pageTexts[group.summaryPageIdx].replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of summaryLines) {
      if (!/^\d{2}\/\d{2}\/\d{4}/.test(line)) continue;
      if (line.split(/\s+/).length < 6) continue;
      const parsed = parseDetailLine(line);
      if (parsed) detailLines.push(parsed);
    }

    console.log("[NACS] Group result: invNum=", summary.invoiceNumber, "detailLines=", detailLines.length, "parseErrors=", parseErrors.length);
    const result = buildInvoiceResult(summary, detailLines, parseErrors);
    console.log("[NACS] Built result: total=", result.total, "pallets=", result.palletsBilled);
    if (result.invoiceNumber || result.total > 0) results.push(result);
    else console.warn("[NACS] Skipping group: no invoice number and total=0");
  }

  console.log("[NACS] Final results:", results.length, "invoices");
  return results;
}
