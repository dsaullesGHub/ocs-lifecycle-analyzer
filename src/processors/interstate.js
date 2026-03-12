// Interstate Warehousing Invoice Processor
// Parses text-extracted Interstate invoice PDFs (receipt format)
// Handles both Franklin (S4) and Kingman (O1) locations

import { extractPdfPages } from './pdfUtils.js';

const LOCATION_MAP = {
  "FRANKLIN": { code: "S4", name: "Interstate Franklin" },
  "KINGMAN": { code: "O1", name: "Interstate Kingman" },
  "GOLDEN VALLEY": { code: "O1", name: "Interstate Kingman" },
};

function detectLocation(fullText) {
  const upper = fullText.toUpperCase();
  if (upper.includes("FRANKLIN")) return LOCATION_MAP["FRANKLIN"];
  if (upper.includes("KINGMAN") || upper.includes("GOLDEN VALLEY")) return LOCATION_MAP["KINGMAN"];
  // Default to Franklin if ambiguous
  return LOCATION_MAP["FRANKLIN"];
}

function parseInterstatePage(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  const result = {
    invoiceNumber: null, invoiceDate: null, receiptNumber: null,
    depositorRef: null, dateReceived: null,
    lineItems: [], totals: { storage: 0, handling: 0, other: 0, total: 0 },
    palletIds: [], pageNum: null,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Invoice number: 10-digit number starting with 03
    if (!result.invoiceNumber) {
      const invMatch = line.match(/\b(03\d{8})\b/);
      if (invMatch) result.invoiceNumber = invMatch[1];
    }

    // Invoice date
    if (!result.invoiceDate) {
      const dateCtx = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
      if (dateCtx.toUpperCase().includes("INVOICE DATE") || dateCtx.toUpperCase().includes("INVOICE")) {
        const dm = line.match(/(\d{2}\/\d{2}\/\d{4})/);
        if (dm) result.invoiceDate = dm[1];
      }
    }

    // Receipt number
    if (!result.receiptNumber) {
      const rcpMatch = line.match(/\b(R\d{5,7}-?\d?)\b/);
      if (rcpMatch) result.receiptNumber = rcpMatch[1];
    }

    // Depositor reference
    if (!result.depositorRef && line.toUpperCase().includes("DEPOSITOR REFERENCE")) {
      // Next non-empty line or same line
      const refMatch = line.match(/DEPOSITOR REFERENCE\s+(\d+)/i);
      if (refMatch) result.depositorRef = refMatch[1];
      else if (i + 1 < lines.length) {
        const nextMatch = lines[i + 1].match(/^(\d{4,8})$/);
        if (nextMatch) result.depositorRef = nextMatch[1];
      }
    }

    // Date received
    if (!result.dateReceived) {
      const drMatch = line.match(/DATE RECEIVED\s+(\d{2}\/\d{2}\/\d{4})/i);
      if (drMatch) result.dateReceived = drMatch[1];
      if (line.toUpperCase() === "DATE RECEIVED" && i + 1 < lines.length) {
        const dm = lines[i + 1].match(/(\d{2}\/\d{2}\/\d{4})/);
        if (dm) result.dateReceived = dm[1];
      }
    }

    // Pallet ID lines: F + 9 digits with charge lines
    const palletMatch = line.match(/\b(F\d{8,10})\b/);
    if (palletMatch) {
      const pid = palletMatch[1];
      result.palletIds.push(pid);

      // Extract charges from this line and possibly the next
      const chargeLines = [line];
      if (i + 1 < lines.length && /^(INITANVSTG|RECEIVING|RENEWAL|OUTBOUND)/i.test(lines[i + 1].trim())) {
        chargeLines.push(lines[i + 1]);
      }

      for (const cl of chargeLines) {
        // Pattern: CHARGE_TYPE PA rate amount
        const chgMatch = cl.match(/(RECEIVING|INITANVSTG|RENEWAL|OUTBOUND|REHANDLING)\s+PA\s+([\d.]+)\s+([\d.]+)/i);
        if (chgMatch) {
          const chargeType = chgMatch[1].toUpperCase();
          const rate = parseFloat(chgMatch[2]);
          const amount = parseFloat(chgMatch[3]);
          const category = chargeType === "RECEIVING" || chargeType === "REHANDLING" ? "handling"
            : chargeType === "INITANVSTG" || chargeType === "RENEWAL" ? "storage"
            : "other";
          result.lineItems.push({ palletId: pid, chargeType, rate, amount, category });
        }
      }
    }

    // Totals
    const storMatch = line.match(/TOTAL STORAGE\s+\$?([\d,.]+)/i);
    if (storMatch) result.totals.storage = parseFloat(storMatch[1].replace(/,/g, ""));
    const handMatch = line.match(/TOTAL HANDLING\s+\$?([\d,.]+)/i);
    if (handMatch) result.totals.handling = parseFloat(handMatch[1].replace(/,/g, ""));
    const othMatch = line.match(/TOTAL OTHER\s+\$?([\d,.]+)/i);
    if (othMatch) result.totals.other = parseFloat(othMatch[1].replace(/,/g, ""));
    const payMatch = line.match(/PLEASE PAY.*?\$\s*([\d,.]+)/i) || line.match(/THIS AMOUNT\s+\$?([\d,.]+)/i);
    if (payMatch) result.totals.total = parseFloat(payMatch[1].replace(/,/g, ""));

    // Page number
    const pgMatch = line.match(/PAGE\s+#?\s*(\d+)\s+OF\s+(\d+)/i);
    if (pgMatch) result.pageNum = parseInt(pgMatch[1]);
  }

  // Compute total from parts if not found
  if (result.totals.total === 0 && (result.totals.storage > 0 || result.totals.handling > 0)) {
    result.totals.total = result.totals.storage + result.totals.handling + result.totals.other;
  }

  return result;
}

export async function parseInterstateInvoice(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  if (onProgress) onProgress("Extracting text from PDF...");
  const extracted = await extractPdfPages(arrayBuffer);

  if (extracted.pages.length === 0) throw new Error("No pages found in PDF.");

  const fullText = extracted.pages.join("\n");
  const location = detectLocation(fullText);

  if (onProgress) onProgress("Parsing invoice pages...");

  // Parse all pages, merge into invoices by invoice number
  const invoiceMap = {};
  for (const pageText of extracted.pages) {
    const parsed = parseInterstatePage(pageText);
    if (!parsed.invoiceNumber) continue;

    const key = parsed.invoiceNumber;
    if (!invoiceMap[key]) {
      invoiceMap[key] = {
        invoiceNumber: parsed.invoiceNumber,
        invoiceDate: parsed.invoiceDate,
        receiptNumber: parsed.receiptNumber,
        depositorRef: parsed.depositorRef,
        dateReceived: parsed.dateReceived,
        lineItems: [],
        palletIds: [],
        totals: { storage: 0, handling: 0, other: 0, total: 0 },
      };
    }
    const inv = invoiceMap[key];
    if (!inv.invoiceDate && parsed.invoiceDate) inv.invoiceDate = parsed.invoiceDate;
    if (!inv.receiptNumber && parsed.receiptNumber) inv.receiptNumber = parsed.receiptNumber;
    if (!inv.depositorRef && parsed.depositorRef) inv.depositorRef = parsed.depositorRef;
    if (!inv.dateReceived && parsed.dateReceived) inv.dateReceived = parsed.dateReceived;
    inv.lineItems.push(...parsed.lineItems);
    inv.palletIds.push(...parsed.palletIds);
    if (parsed.totals.total > inv.totals.total) inv.totals = parsed.totals;
  }

  // Convert to common format
  const results = Object.values(invoiceMap).map(inv => {
    const storage = inv.totals.storage || inv.lineItems.filter(l => l.category === "storage").reduce((s, l) => s + l.amount, 0);
    const handling = inv.totals.handling || inv.lineItems.filter(l => l.category === "handling").reduce((s, l) => s + l.amount, 0);
    const assessorials = inv.totals.other || inv.lineItems.filter(l => l.category === "other").reduce((s, l) => s + l.amount, 0);
    const total = inv.totals.total || (storage + handling + assessorials);

    let billingPeriod = null;
    if (inv.invoiceDate) {
      const parts = inv.invoiceDate.split("/");
      if (parts.length === 3) billingPeriod = `${parts[2]}-${parts[0]}`;
    }

    const uniquePallets = [...new Set(inv.palletIds)];

    return {
      vendor: "Interstate",
      location: location.code,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      receiptNumber: inv.receiptNumber,
      depositorRef: inv.depositorRef,
      dateReceived: inv.dateReceived,
      billingPeriod,
      storage: parseFloat(storage.toFixed(2)),
      handling: parseFloat(handling.toFixed(2)),
      assessorials: parseFloat(assessorials.toFixed(2)),
      total: parseFloat(total.toFixed(2)),
      invoicedTotal: inv.totals.total,
      totalVariance: null,
      palletsBilled: uniquePallets.length,
      lineItems: inv.lineItems.map(l => ({
        chargeCode: l.chargeType,
        label: l.chargeType,
        category: l.category,
        pallets: 1,
        billedRate: l.rate,
        extension: l.amount,
      })),
      detailLines: inv.lineItems.length,
      raw: inv,
    };
  });

  return results;
}
