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
  const fullText = lines.join(" ");
  const result = { invoiceNumber: null, invoiceDate: null, selectedThrough: null, summaryCharges: [], invoiceTotal: null };

  // Invoice number: 4-6 digit number, try multiple patterns
  // Pattern 1: "Invoice Number" or "Invoice #" or "Invoice No" followed by number
  const invNumMatch = fullText.match(/Invoice\s*(?:Number|#|No\.?)[:\s]*(\d{4,6})/i);
  if (invNumMatch) result.invoiceNumber = invNumMatch[1];
  // Pattern 2: Standalone 4-6 digit number on its own line
  if (!result.invoiceNumber) {
    for (const line of lines) {
      if (/^\d{4,6}$/.test(line.trim())) { result.invoiceNumber = line.trim(); break; }
    }
  }
  // Pattern 3: 4-6 digit number near the top of the page (first 10 lines)
  if (!result.invoiceNumber) {
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const m = lines[i].match(/\b(\d{4,6})\b/);
      if (m && !lines[i].match(/page|total|qty|quantity|rate/i)) { result.invoiceNumber = m[1]; break; }
    }
  }

  // Invoice date: MM/DD/YYYY anywhere in text
  // Pattern 1: Near "Invoice Date" label
  const invDateMatch = fullText.match(/Invoice\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (invDateMatch) result.invoiceDate = invDateMatch[1];
  // Pattern 2: First date found in the first 15 lines
  if (!result.invoiceDate) {
    for (let i = 0; i < Math.min(15, lines.length); i++) {
      const dm = lines[i].match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (dm) { result.invoiceDate = dm[1]; break; }
    }
  }

  // Selected Through
  const stMatch = fullText.match(/Selected\s*Through[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (stMatch) result.selectedThrough = stMatch[1];

  // Charge lines: look for patterns with $ amounts
  for (const line of lines) {
    // Try multiple charge line formats
    // Format 1: Description QTY $ rate $ rate $ extension
    const chargeMatch = line.match(/^(.+?)\s+([\d,]+)\s+\$\s*([\d,.]+)\s+\$\s*([\d,.]+)\s+\$\s*([\d,.]+)$/);
    if (chargeMatch) {
      const fullDesc = chargeMatch[1].trim();
      let codeKey = null;
      for (const key of Object.keys(CONTRACTED_RATES)) { if (fullDesc.includes(key)) { codeKey = key; break; } }
      result.summaryCharges.push({ rawDescription: fullDesc, codeKey, quantity: parseFloat(chargeMatch[2].replace(/,/g, "")), unitRate: parseFloat(chargeMatch[4].replace(/,/g, "")), extension: parseFloat(chargeMatch[5].replace(/,/g, "")) });
      continue;
    }
    // Format 2: Description QTY rate extension (no $ signs, just numbers)
    const altMatch = line.match(/^(.+?)\s+([\d,]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/);
    if (altMatch) {
      const fullDesc = altMatch[1].trim();
      const ext = parseFloat(altMatch[5].replace(/,/g, ""));
      if (ext > 10 && fullDesc.length > 3) {
        let codeKey = null;
        for (const key of Object.keys(CONTRACTED_RATES)) { if (fullDesc.includes(key)) { codeKey = key; break; } }
        result.summaryCharges.push({ rawDescription: fullDesc, codeKey, quantity: parseFloat(altMatch[2].replace(/,/g, "")), unitRate: parseFloat(altMatch[4].replace(/,/g, "")), extension: ext });
      }
    }
  }

  // Invoice total: largest $ amount, or "Total" line, or standalone $ amount
  const totalPatterns = [
    /Total[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Amount\s*Due[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Balance\s*Due[:\s]*\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const pat of totalPatterns) {
    const m = fullText.match(pat);
    if (m) { result.invoiceTotal = parseFloat(m[1].replace(/,/g, "")); break; }
  }
  // Fallback: standalone $ amount line
  if (!result.invoiceTotal) {
    for (const line of lines) {
      const tm = line.match(/^\$\s*([\d,]+\.\d{2})$/);
      if (tm) { result.invoiceTotal = parseFloat(tm[1].replace(/,/g, "")); }
    }
  }

  console.log("[NACS] parseSummaryPage result:", JSON.stringify(result, null, 2));
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
  // A summary page must have BOTH an invoice marker AND charge summary lines
  // Detail pages may have $ amounts but won't have the invoice header markers
  const hasInvMarker = /Selected Through|Invoice\s*(Number|Date|#)|North American Cold Storage/i.test(text);
  
  // Check for summary-style charge lines: description + quantity + $ amounts
  const chargeLinesCount = (text.match(/\$\s*[\d,]+\.\d{2}/g) || []).length;
  const hasChargeTable = chargeLinesCount >= 3; // Summary pages have multiple charge lines
  
  // Detail pages have many PID lines (F + digits)
  const pidCount = (text.match(/\bF\d{5,8}\b/g) || []).length;
  
  // Summary = has invoice markers + charge table + few PIDs
  // Detail = many PIDs, possibly some $ amounts but no invoice markers
  const isSummary = hasInvMarker && hasChargeTable && pidCount < 10;
  
  return isSummary;
}

function buildInvoiceResult(summary, detailLines, parseErrors) {
  // Primary source: summary page charges (rolled-up totals per category)
  // Secondary source: detail lines (pallet-level, used for drill-down only)
  
  let lineItems = [];
  let storageCharge = 0, handlingCharge = 0, assessorialsTotal = 0;
  let palletsBilled = 0;

  if (summary.summaryCharges && summary.summaryCharges.length > 0) {
    // Use summary charges as the authoritative source
    console.log("[NACS] Using summary charges:", summary.summaryCharges.length, "line items");
    for (const sc of summary.summaryCharges) {
      const contracted = sc.codeKey ? CONTRACTED_RATES[sc.codeKey] : null;
      const category = contracted?.category || (sc.rawDescription.match(/storage|renewal|initial/i) ? "storage" : sc.rawDescription.match(/handling/i) ? "handling" : "assessorial");
      
      lineItems.push({
        chargeCode: sc.codeKey || sc.rawDescription,
        label: contracted?.label || sc.rawDescription,
        category,
        pallets: sc.quantity,
        billedRate: sc.unitRate,
        contractedRate: contracted?.contracted ?? null,
        rateVariance: (sc.unitRate != null && contracted?.contracted != null) ? parseFloat((sc.unitRate - contracted.contracted).toFixed(4)) : null,
        extension: sc.extension,
      });

      if (category === "storage") { storageCharge += sc.extension; palletsBilled += sc.quantity; }
      else if (category === "handling") handlingCharge += sc.extension;
      else assessorialsTotal += sc.extension;
    }
  } else if (detailLines.length > 0) {
    // Fallback: aggregate from detail lines
    console.log("[NACS] No summary charges, using", detailLines.length, "detail lines");
    const chargeMap = {};
    for (const dl of detailLines) {
      const key = dl.codeKey || dl.chargeCodeRaw;
      if (!chargeMap[key]) chargeMap[key] = { lines: [], totalExtension: 0, pallets: 0 };
      chargeMap[key].lines.push(dl);
      chargeMap[key].totalExtension += dl.extension;
      chargeMap[key].pallets += dl.qty;
    }

    lineItems = Object.entries(chargeMap).map(([key, data]) => {
      const contracted = CONTRACTED_RATES[key];
      const billedRate = data.lines[0]?.rate ?? null;
      const contractedRate = contracted?.contracted ?? null;
      const rateVariance = (billedRate != null && contractedRate != null) ? parseFloat((billedRate - contractedRate).toFixed(4)) : null;
      return { chargeCode: key, label: contracted?.label ?? key, category: contracted?.category ?? "other", pallets: data.pallets, billedRate, contractedRate, rateVariance, extension: parseFloat(data.totalExtension.toFixed(2)) };
    });

    storageCharge = lineItems.filter(l => l.category === "storage").reduce((s, l) => s + l.extension, 0);
    handlingCharge = lineItems.filter(l => l.category === "handling").reduce((s, l) => s + l.extension, 0);
    assessorialsTotal = lineItems.filter(l => l.category === "assessorial").reduce((s, l) => s + l.extension, 0);
    palletsBilled = lineItems.filter(l => l.category === "storage").reduce((s, l) => s + l.pallets, 0);
  }

  const computedTotal = parseFloat((storageCharge + handlingCharge + assessorialsTotal).toFixed(2));

  let billingPeriod = null;
  if (summary.invoiceDate) {
    const parts = summary.invoiceDate.split("/");
    if (parts.length === 3) billingPeriod = `${parts[2]}-${parts[0].padStart(2, "0")}`;
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
    palletsBilled,
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
