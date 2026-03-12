// Mesa Cold Storage Invoice Processor
// Uses Claude Vision API for OCR extraction from invoice PDFs
// Requires an Anthropic API key

import { detectFileType, renderPdfPageAsBase64 } from './pdfUtils.js';
import * as pdfjsLib from 'pdfjs-dist';

const MESA_CHARGE_CODES = {
  INBHAND: { label: "Inbound Handling", category: "handling" },
  INBTRANS: { label: "Inbound Transport", category: "assessorial" },
  INBSTOR: { label: "Initial Storage", category: "storage" },
  OUTBTRANS: { label: "Outbound Transport", category: "assessorial" },
  RTNS: { label: "Returns", category: "assessorial" },
  WKNDINBTRA: { label: "Weekend Inbound", category: "assessorial" },
  BOL: { label: "B/L Fee", category: "assessorial" },
  RENEWAL: { label: "Renewal Storage", category: "storage" },
  STORAGE: { label: "Storage (30-day)", category: "storage" },
};

async function callVisionAPI(apiKey, imageB64, pageNum) {
  const prompt = `Extract all invoice data from this Mesa Cold Storage invoice page. Return ONLY valid JSON with this structure:
{
  "page_type": "FIRST_PAGE" or "CONTINUATION",
  "invoice_number": string or null,
  "invoice_date": "MM/DD/YYYY" or null,
  "due_date": "MM/DD/YYYY" or null,
  "charge_sections": [
    {
      "charge_code": "INBTRANS" or "BOL" or "INBHAND" or "INBSTOR" or "OUTBTRANS" or "RTNS" or "WKNDINBTRA" or "RENEWAL" or "STORAGE",
      "description": string,
      "lines": [
        { "date": "MM/DD/YYYY", "reference": string, "quantity": number, "rate": number, "amount": number }
      ],
      "section_total": number
    }
  ],
  "invoice_total_stated": number or null
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } },
        { type: "text", text: prompt }
      ]}],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  const text = data.content?.find(c => c.type === "text")?.text || "";

  // Parse JSON from response, stripping any markdown fencing
  const clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { page_type: "CONTINUATION", charge_sections: [], _parseError: true, _rawText: text };
  }
}

function aggregateMesaPages(pageResults) {
  const invoiceMap = {};
  let currentInvoice = null;

  for (const page of pageResults) {
    if (page.page_type === "FIRST_PAGE" && page.invoice_number) {
      currentInvoice = page.invoice_number;
      if (!invoiceMap[currentInvoice]) {
        invoiceMap[currentInvoice] = {
          invoiceNumber: page.invoice_number,
          invoiceDate: page.invoice_date,
          dueDate: page.due_date,
          sections: [],
          invoiceTotal: page.invoice_total_stated,
        };
      }
    }
    if (currentInvoice && invoiceMap[currentInvoice]) {
      invoiceMap[currentInvoice].sections.push(...(page.charge_sections || []));
      if (page.invoice_total_stated && !invoiceMap[currentInvoice].invoiceTotal) {
        invoiceMap[currentInvoice].invoiceTotal = page.invoice_total_stated;
      }
    }
  }

  return Object.values(invoiceMap).map(inv => {
    const lineItems = [];
    let storage = 0, handling = 0, assessorials = 0;

    for (const section of inv.sections) {
      const codeInfo = MESA_CHARGE_CODES[section.charge_code] || { label: section.charge_code, category: "other" };
      const sectionTotal = section.section_total || (section.lines || []).reduce((s, l) => s + (l.amount || 0), 0);

      lineItems.push({
        chargeCode: section.charge_code,
        label: codeInfo.label,
        category: codeInfo.category,
        pallets: (section.lines || []).length,
        billedRate: section.lines?.[0]?.rate || null,
        extension: parseFloat(sectionTotal.toFixed(2)),
      });

      if (codeInfo.category === "storage") storage += sectionTotal;
      else if (codeInfo.category === "handling") handling += sectionTotal;
      else assessorials += sectionTotal;
    }

    const total = parseFloat((storage + handling + assessorials).toFixed(2));

    let billingPeriod = null;
    if (inv.invoiceDate) {
      const parts = inv.invoiceDate.split("/");
      if (parts.length === 3) billingPeriod = `${parts[2]}-${parts[0]}`;
    }

    return {
      vendor: "Mesa",
      location: "7B",
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      billingPeriod,
      storage: parseFloat(storage.toFixed(2)),
      handling: parseFloat(handling.toFixed(2)),
      assessorials: parseFloat(assessorials.toFixed(2)),
      total,
      invoicedTotal: inv.invoiceTotal,
      totalVariance: inv.invoiceTotal != null ? parseFloat((total - inv.invoiceTotal).toFixed(2)) : null,
      palletsBilled: lineItems.reduce((s, l) => s + l.pallets, 0),
      lineItems,
      detailLines: inv.sections.reduce((s, sec) => s + (sec.lines || []).length, 0),
      raw: inv,
    };
  });
}

export async function parseMesaInvoice(file, apiKey, onProgress) {
  if (!apiKey) throw new Error("Anthropic API key required for Mesa invoice processing.");

  const arrayBuffer = await file.arrayBuffer();
  const fileType = await detectFileType(arrayBuffer);
  if (fileType !== "pdf") throw new Error("Mesa processor expects PDF files.");

  if (onProgress) onProgress("Loading PDF...");
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  const pageResults = [];
  for (let i = 1; i <= numPages; i++) {
    if (onProgress) onProgress(`OCR page ${i} of ${numPages}...`);
    const imageB64 = await renderPdfPageAsBase64(arrayBuffer, i);
    const result = await callVisionAPI(apiKey, imageB64, i);
    pageResults.push(result);
    // Throttle between pages
    if (i < numPages) await new Promise(r => setTimeout(r, 200));
  }

  if (onProgress) onProgress("Aggregating invoice data...");
  return aggregateMesaPages(pageResults);
}
