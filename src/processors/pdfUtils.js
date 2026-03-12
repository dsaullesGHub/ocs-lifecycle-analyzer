// PDF text extraction and file type detection utilities
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export async function detectFileType(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 4));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex.startsWith("504b0304")) return "zip";
  if (hex.startsWith("25504446")) return "pdf";
  return "unknown";
}

export async function extractPdfPages(arrayBuffer) {
  const copy = new Uint8Array(arrayBuffer.slice(0));
  console.log("[pdfUtils] extractPdfPages: buffer size", copy.length);

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: copy }).promise;
  } catch (err) {
    console.error("[pdfUtils] Failed to open PDF:", err);
    throw new Error(`PDF open failed: ${err.message}`);
  }

  console.log("[pdfUtils] PDF opened, pages:", pdf.numPages);
  const pages = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      if (!content.items || content.items.length === 0) {
        console.warn(`[pdfUtils] Page ${i}: no text items found (may be scanned image)`);
        pages.push("");
        continue;
      }

      const items = content.items.map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
      }));
      const lineMap = {};
      for (const item of items) {
        const yKey = Math.round(item.y / 3) * 3;
        if (!lineMap[yKey]) lineMap[yKey] = [];
        lineMap[yKey].push(item);
      }
      const sortedYs = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
      const lineStrings = sortedYs.map(y =>
        lineMap[y].sort((a, b) => a.x - b.x).map(it => it.text).join(" ").trim()
      ).filter(Boolean);

      const pageText = lineStrings.join("\n");
      console.log(`[pdfUtils] Page ${i}: ${content.items.length} items, ${lineStrings.length} lines, ${pageText.length} chars`);
      pages.push(pageText);
    }
  } finally {
    try { pdf.destroy(); } catch (e) { /* ignore */ }
  }

  console.log("[pdfUtils] Extraction complete:", pages.length, "pages,", pages.filter(p => p.length > 0).length, "with content");
  return { numPages: pages.length, pages };
}

export async function renderPdfPageAsBase64(arrayBuffer, pageNum, scale = 2.0) {
  const copy = new Uint8Array(arrayBuffer.slice(0));
  const pdf = await pdfjsLib.getDocument({ data: copy }).promise;
  try {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/png").split(",")[1];
  } finally {
    try { pdf.destroy(); } catch (e) { /* ignore */ }
  }
}

export async function getPdfPageCount(arrayBuffer) {
  const copy = new Uint8Array(arrayBuffer.slice(0));
  const pdf = await pdfjsLib.getDocument({ data: copy }).promise;
  const count = pdf.numPages;
  try { pdf.destroy(); } catch (e) { /* ignore */ }
  return count;
}
