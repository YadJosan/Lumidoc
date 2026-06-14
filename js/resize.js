/* =====================================================================
 * resize.js — Lumidoc Resize & Compress (images + PDFs), fully client-side.
 * ===================================================================== */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }
  function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  function toBlob(canvas, type, quality) {
    return new Promise((res) => canvas.toBlob(res, type, quality));
  }
  function scaledCanvas(src, w, h) {
    const c = canvasOf(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const ctx = c.getContext("2d");
    if (/jpeg|jpg/.test(arguments[3] || "")) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* ------------------------------- tabs ---------------------------- */
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".tab-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  }));

  function wireDrop(dropId, inputId, onFile, accept) {
    const dz = $(dropId), input = $(inputId);
    dz.addEventListener("click", (e) => { if (e.target === dz || e.target.classList.contains("dz-inner")) input.click(); });
    input.addEventListener("change", () => input.files[0] && onFile(input.files[0]));
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f && (!accept || accept(f))) onFile(f); });
  }

  /* ============================== IMAGE =========================== */
  const img = { src: null, name: "image", w: 0, h: 0, blob: null };

  function initImage() {
    $("#imgBrowse").addEventListener("click", () => $("#imgInput").click());
    wireDrop("#imgDrop", "#imgInput", loadImage, (f) => f.type.startsWith("image/"));
    $("#imgReset").addEventListener("click", () => { $("#imgInput").click(); });

    $("#imgMode").addEventListener("change", () => {
      const m = $("#imgMode").value;
      $("#imgDimFields").hidden = m !== "dimensions";
      $("#imgPctField").hidden = m !== "percent";
      $("#imgTargetField").hidden = m !== "filesize";
      $("#imgQualityField").hidden = $("#imgFormat").value === "image/png";
      recompute();
    });
    $("#imgFormat").addEventListener("change", () => {
      $("#imgQualityField").hidden = $("#imgFormat").value === "image/png";
      recompute();
    });
    $("#imgQuality").addEventListener("input", () => { $("#imgQVal").textContent = $("#imgQuality").value + "%"; recompute(); });
    $("#imgPct").addEventListener("input", () => { $("#imgPctVal").textContent = $("#imgPct").value + "%"; recompute(); });
    $("#imgTarget").addEventListener("input", recompute);
    $("#imgW").addEventListener("input", () => syncDim("w"));
    $("#imgH").addEventListener("input", () => syncDim("h"));
    $("#imgDownload").addEventListener("click", () => img.blob && download(img.blob, outName()));
  }

  function loadImage(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const im = new Image();
      im.onload = () => {
        img.src = im; img.name = file.name.replace(/\.[^.]+$/, "");
        img.origSize = file.size;
        img.w = im.naturalWidth; img.h = im.naturalHeight;
        $("#imgPreview").src = reader.result;
        $("#imgW").value = img.w; $("#imgH").value = img.h;
        $("#imgDrop").hidden = true; $("#imgWork").hidden = false;
        recompute();
      };
      im.onerror = () => alert("Could not read that image.");
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function syncDim(changed) {
    if ($("#imgLock").checked && img.w && img.h) {
      const ar = img.w / img.h;
      if (changed === "w") $("#imgH").value = Math.max(1, Math.round((+$("#imgW").value || 1) / ar));
      else $("#imgW").value = Math.max(1, Math.round((+$("#imgH").value || 1) * ar));
    }
    recompute();
  }

  function targetDims() {
    const m = $("#imgMode").value;
    if (m === "percent") { const p = (+$("#imgPct").value || 100) / 100; return [img.w * p, img.h * p]; }
    if (m === "dimensions") return [+$("#imgW").value || img.w, +$("#imgH").value || img.h];
    return [img.w, img.h]; // filesize mode starts at full size and downscales as needed
  }

  function outName() {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[$("#imgFormat").value];
    return `${img.name}-resized.${ext}`;
  }

  const recompute = debounce(async () => {
    if (!img.src) return;
    let type = $("#imgFormat").value;
    const readout = $("#imgReadout");
    readout.textContent = "Working…";
    let [w, h] = targetDims();

    let blob;
    if ($("#imgMode").value === "filesize") {
      if (type === "image/png") type = "image/jpeg"; // PNG can't hit a size target by quality
      const targetBytes = (+$("#imgTarget").value || 240) * 1024;
      blob = await compressToTarget(img.src, img.w, img.h, type, targetBytes);
    } else {
      const c = scaledCanvas(img.src, w, h, type);
      const q = type === "image/png" ? undefined : (+$("#imgQuality").value || 85) / 100;
      blob = await toBlob(c, type, q);
    }

    // report the produced image's real dimensions
    const dims = await blobDims(blob);
    img.blob = blob;
    $("#imgDownload").disabled = false;
    readout.textContent = `${dims.w} × ${dims.h}px • ${fmtBytes(blob.size)} • ${type.split("/")[1].toUpperCase()}` +
      (blob.size && img.origSize ? `  (was ${fmtBytes(img.origSize)})` : "");
  }, 180);

  async function compressToTarget(src, ow, oh, type, targetBytes) {
    let scale = 1, best = null;
    for (let attempt = 0; attempt < 9; attempt++) {
      const c = scaledCanvas(src, ow * scale, oh * scale, type);
      let lo = 0.3, hi = 0.95, found = null;
      for (let i = 0; i < 7; i++) {
        const q = (lo + hi) / 2;
        const b = await toBlob(c, type, q);
        if (b.size <= targetBytes) { found = b; lo = q; } else { hi = q; }
      }
      if (!found) { const b = await toBlob(c, type, 0.3); if (b.size <= targetBytes) found = b; }
      if (found) return found;
      scale *= 0.82; // still too big at lowest quality → downscale and retry
    }
    return await toBlob(scaledCanvas(src, ow * scale, oh * scale, type), type, 0.3);
  }

  function blobDims(blob) {
    return new Promise((res) => {
      const u = URL.createObjectURL(blob);
      const i = new Image();
      i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(u); };
      i.onerror = () => { res({ w: 0, h: 0 }); URL.revokeObjectURL(u); };
      i.src = u;
    });
  }

  /* =============================== PDF ============================ */
  const pdf = { doc: null, name: "document", origSize: 0, blob: null };

  function configurePdfJs() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  function initPdf() {
    $("#pdfBrowse").addEventListener("click", () => $("#pdfInput").click());
    wireDrop("#pdfDrop", "#pdfInput", loadPdf, (f) => /pdf/.test(f.type) || /\.pdf$/i.test(f.name));
    $("#pdfReset").addEventListener("click", () => $("#pdfInput").click());
    $("#pdfQuality").addEventListener("input", () => { $("#pdfQVal").textContent = $("#pdfQuality").value + "%"; });
    $("#pdfCompress").addEventListener("click", compressPdf);
    $("#pdfDownload").addEventListener("click", () => pdf.blob && download(pdf.blob, `${pdf.name}-compressed.pdf`));
  }

  async function loadPdf(file) {
    if (typeof pdfjsLib === "undefined") { alert("PDF support failed to load (needs internet)."); return; }
    configurePdfJs();
    pdf.name = file.name.replace(/\.pdf$/i, "");
    pdf.origSize = file.size;
    pdf.blob = null;
    $("#pdfDownload").disabled = true;
    try {
      pdf.doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    } catch (e) { console.error(e); alert("Could not open that PDF."); return; }
    $("#pdfDrop").hidden = true; $("#pdfWork").hidden = false;
    $("#pdfInfo").textContent = `${pdf.doc.numPages} page(s) • original ${fmtBytes(pdf.origSize)}`;
    $("#pdfReadout").textContent = "Set options, then Compress.";
    // small first-page thumbnail
    const page = await pdf.doc.getPage(1);
    const vp = page.getViewport({ scale: Math.min(1, 220 / page.getViewport({ scale: 1 }).width) });
    const c = $("#pdfPreview"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  }

  async function compressPdf() {
    if (!pdf.doc || typeof window.jspdf === "undefined") { alert("PDF tools not loaded."); return; }
    const { jsPDF } = window.jspdf;
    const dpi = +$("#pdfDpi").value, quality = (+$("#pdfQuality").value || 75) / 100;
    const scale = dpi / 72;
    const btn = $("#pdfCompress"); btn.disabled = true; const label = btn.textContent;
    $("#pdfReadout").textContent = "Compressing…";
    try {
      let doc = null;
      for (let i = 1; i <= pdf.doc.numPages; i++) {
        btn.textContent = `Page ${i}/${pdf.doc.numPages}…`;
        const page = await pdf.doc.getPage(i);
        const base = page.getViewport({ scale: 1 });          // points
        const vp = page.getViewport({ scale });
        const c = canvasOf(Math.round(vp.width), Math.round(vp.height));
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const jpeg = c.toDataURL("image/jpeg", quality);
        const wPt = base.width, hPt = base.height;
        if (!doc) doc = new jsPDF({ unit: "pt", format: [wPt, hPt], orientation: wPt > hPt ? "l" : "p" });
        else doc.addPage([wPt, hPt], wPt > hPt ? "l" : "p");
        doc.addImage(jpeg, "JPEG", 0, 0, wPt, hPt);
      }
      const out = doc.output("blob");
      pdf.blob = out;
      $("#pdfDownload").disabled = false;
      const pct = pdf.origSize ? Math.round((1 - out.size / pdf.origSize) * 100) : 0;
      $("#pdfReadout").textContent = `original ${fmtBytes(pdf.origSize)} → ${fmtBytes(out.size)}` +
        (pct > 0 ? `  (${pct}% smaller)` : `  (no reduction — try lower DPI/quality)`);
    } catch (e) {
      console.error(e); $("#pdfReadout").textContent = "Compression failed: " + e.message;
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  /* ------------------------------ boot ----------------------------- */
  initImage();
  initPdf();
})();
