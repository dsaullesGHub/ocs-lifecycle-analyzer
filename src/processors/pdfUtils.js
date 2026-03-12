// PDF text extraction and file type detection utilities
import * as pdfjsLib from 'pdfjs-dist';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export async function detectFileType(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 4));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex.startsWith("504b0304")) return "zip";
  if (hex.startsWith("25504446")) return "pdf";
  return "unknown";
}

export async function extractPdfPages(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
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
      lineMap[y].sort((a, b) => a.x - b.x).map(i => i.text).join(" ").trim()
    ).filter(Boolean);
    pages.push(lineStrings.join("\n"));
  }
  return { numPages: pdf.numPages, pages };
}

export async function renderPdfPageAsBase64(arrayBuffer, pageNum, scale = 2.0) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png").split(",")[1];
}
