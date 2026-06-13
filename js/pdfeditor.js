/* =====================================================================
 * pdfeditor.js — open a PDF, add text/signature overlays, export edited PDF.
 *   • pdf.js renders pages for viewing.
 *   • Overlay elements (text boxes, images) are positioned over each page.
 *   • pdf-lib loads the ORIGINAL PDF and draws the overlays onto it, so the
 *     document's existing text stays crisp (not rasterised).
 * ===================================================================== */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";

  const state = {
    file: null,        // original File (re-read at export so bytes aren't detached)
    pdfDoc: null,      // pdf.js document
    pages: [],         // { wrapper, displayWidth, displayHeight, pdfWidth, pdfHeight }
    elements: [],      // overlay objects (see addTextElement / addImageElement)
    selected: null,
    mode: null,        // null | "addText"
    seq: 0,
  };

  /* ------------------------------- boot ---------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#openBtn").addEventListener("click", () => $("#pdfInput").click());
    $("#browsePdf").addEventListener("click", () => $("#pdfInput").click());
    $("#pdfInput").addEventListener("change", (e) => e.target.files[0] && openPdf(e.target.files[0]));

    const drop = $("#pdfDrop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) openPdf(f); });

    $("#addTextBtn").addEventListener("click", () => setMode(state.mode === "addText" ? null : "addText"));
    $("#whiteoutBtn").addEventListener("click", () => setMode(state.mode === "addRect" ? null : "addRect"));
    $("#addImageBtn").addEventListener("click", () => $("#imageInput").click());
    $("#imageInput").addEventListener("change", (e) => { if (e.target.files[0]) loadImageFile(e.target.files[0]); e.target.value = ""; });

    $("#fontSize").addEventListener("input", () => {
      const o = selectedObj();
      if (o && o.type === "text") { o.fontSize = clampInt($("#fontSize").value, 6, 96, 14); o.el.style.fontSize = o.fontSize + "px"; }
    });
    $("#fontColor").addEventListener("input", () => {
      const o = selectedObj();
      if (!o) return;
      if (o.type === "text") { o.color = $("#fontColor").value; o.el.style.color = o.color; }
      else if (o.type === "rect") { o.color = $("#fontColor").value; o.el.style.background = o.color; }
    });
    $("#boldBtn").addEventListener("click", () => {
      const o = selectedObj();
      if (o && o.type === "text") {
        o.bold = !o.bold;
        o.el.style.fontWeight = o.bold ? "700" : "400";
        $("#boldBtn").classList.toggle("armed", o.bold);
      }
    });
    $("#deleteBtn").addEventListener("click", deleteSelected);
    $("#downloadBtn").addEventListener("click", download);

    document.addEventListener("keydown", (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedObj() && !selectedObj().el.isContentEditable) {
        e.preventDefault(); deleteSelected();
      }
    });
  });

  function configurePdfJs() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }
  }

  /* ------------------------------ open ----------------------------- */
  async function openPdf(file) {
    if (typeof pdfjsLib === "undefined") { alert("PDF viewer failed to load (needs internet)."); return; }
    if (!/pdf/.test(file.type) && !/\.pdf$/i.test(file.name)) { alert("Please choose a PDF file."); return; }
    configurePdfJs();
    state.file = file;
    try {
      const buf = await file.arrayBuffer();
      state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch (e) { console.error(e); alert("Could not open that PDF."); return; }
    await renderAllPages();
    ["#addTextBtn", "#addImageBtn", "#whiteoutBtn", "#downloadBtn"].forEach((id) => ($(id).disabled = false));
    $("#emptyState").style.display = "none";
  }

  async function renderAllPages() {
    const container = $("#pages");
    container.innerHTML = "";
    state.pages = []; state.elements = []; state.selected = null;
    const maxW = Math.min(820, (container.clientWidth || 820) - 8);
    const dpr = window.devicePixelRatio || 1;

    for (let i = 1; i <= state.pdfDoc.numPages; i++) {
      const page = await state.pdfDoc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const displayScale = Math.min(1.5, maxW / base.width);
      const vp = page.getViewport({ scale: displayScale * dpr });
      const dispW = base.width * displayScale, dispH = base.height * displayScale;

      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page";
      wrapper.style.width = dispW + "px";
      wrapper.style.height = dispH + "px";
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = dispW + "px";
      canvas.style.height = dispH + "px";
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);

      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

      const idx = i - 1;
      state.pages.push({ wrapper, displayWidth: dispW, displayHeight: dispH, pdfWidth: base.width, pdfHeight: base.height });
      wrapper.addEventListener("pointerdown", (e) => onPagePointerDown(e, idx));
    }
  }

  function onPagePointerDown(e, idx) {
    const onBackground = e.target.classList.contains("pdf-page") || e.target.tagName === "CANVAS";
    if (!onBackground) return;
    if (state.mode === "addText") {
      e.preventDefault();   // don't let the click move focus off the new box
      const r = state.pages[idx].wrapper.getBoundingClientRect();
      addTextElement(idx, e.clientX - r.left, e.clientY - r.top);
      setMode(null);
    } else if (state.mode === "addRect") {
      e.preventDefault();
      const r = state.pages[idx].wrapper.getBoundingClientRect();
      startRectDraw(idx, e.clientX - r.left, e.clientY - r.top);
    } else {
      deselect();
    }
  }

  /* ----------------- white-out rectangle (cover text) -------------- */
  function startRectDraw(pageIndex, startX, startY) {
    const pg = state.pages[pageIndex];
    const id = ++state.seq;
    const color = "#ffffff";
    const el = document.createElement("div");
    el.className = "pdf-el rectbox";
    el.dataset.id = id;
    el.style.left = startX + "px"; el.style.top = startY + "px";
    el.style.width = "0px"; el.style.height = "0px";
    el.style.background = color;
    el.innerHTML = `<span class="rsz"></span>`;
    pg.wrapper.appendChild(el);

    const obj = { id, type: "rect", pageIndex, x: startX, y: startY, w: 0, h: 0, color, el };
    state.elements.push(obj);

    const rect = pg.wrapper.getBoundingClientRect();
    const move = (e) => {
      const cx = Math.min(Math.max(e.clientX - rect.left, 0), pg.displayWidth);
      const cy = Math.min(Math.max(e.clientY - rect.top, 0), pg.displayHeight);
      obj.x = Math.min(startX, cx); obj.y = Math.min(startY, cy);
      obj.w = Math.abs(cx - startX); obj.h = Math.abs(cy - startY);
      el.style.left = obj.x + "px"; el.style.top = obj.y + "px";
      el.style.width = obj.w + "px"; el.style.height = obj.h + "px";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (obj.w < 6 || obj.h < 6) removeObj(obj);   // ignore tiny accidental drags
      else { wireRect(obj); select(id); }
      setMode(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function wireRect(obj) {
    const el = obj.el, rsz = el.querySelector(".rsz");
    let drag = false, sx, sy, ox, oy;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("rsz")) return;
      e.stopPropagation(); select(obj.id);
      drag = true; sx = e.clientX; sy = e.clientY; ox = obj.x; oy = obj.y;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      obj.x = Math.max(0, ox + (e.clientX - sx));
      obj.y = Math.max(0, oy + (e.clientY - sy));
      el.style.left = obj.x + "px"; el.style.top = obj.y + "px";
    });
    el.addEventListener("pointerup", (e) => { drag = false; try { el.releasePointerCapture(e.pointerId); } catch (_) {} });

    let rz = false, rx, ry, rw, rh;
    rsz.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); select(obj.id);
      rz = true; rx = e.clientX; ry = e.clientY; rw = obj.w; rh = obj.h;
      try { rsz.setPointerCapture(e.pointerId); } catch (_) {}
    });
    rsz.addEventListener("pointermove", (e) => {
      if (!rz) return;
      obj.w = Math.max(8, rw + (e.clientX - rx)); obj.h = Math.max(6, rh + (e.clientY - ry));
      el.style.width = obj.w + "px"; el.style.height = obj.h + "px";
    });
    rsz.addEventListener("pointerup", (e) => { rz = false; try { rsz.releasePointerCapture(e.pointerId); } catch (_) {} });
  }

  /* --------------------------- text element ------------------------ */
  function addTextElement(pageIndex, x, y) {
    const id = ++state.seq;
    const el = document.createElement("div");
    el.className = "pdf-el textbox";
    el.dataset.id = id;
    el.style.left = x + "px"; el.style.top = y + "px";
    el.contentEditable = "false";
    el.spellcheck = false;
    const fontSize = clampInt($("#fontSize").value, 6, 96, 14);
    const color = $("#fontColor").value || "#111111";
    el.style.fontSize = fontSize + "px";
    el.style.color = color;
    el.textContent = "Text";
    state.pages[pageIndex].wrapper.appendChild(el);

    const obj = { id, type: "text", pageIndex, x, y, fontSize, color, bold: false, text: "Text", el };
    state.elements.push(obj);
    wireText(obj);
    select(id);
    // Defer so the placing click finishes before we grab focus for editing.
    setTimeout(() => enterEdit(obj), 0);
  }

  function wireText(obj) {
    const el = obj.el;
    let drag = false, sx, sy, ox, oy;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      select(obj.id);
      if (el.isContentEditable) return;       // editing → allow caret placement
      drag = true; sx = e.clientX; sy = e.clientY; ox = obj.x; oy = obj.y;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      obj.x = Math.max(0, ox + (e.clientX - sx));
      obj.y = Math.max(0, oy + (e.clientY - sy));
      el.style.left = obj.x + "px"; el.style.top = obj.y + "px";
    });
    el.addEventListener("pointerup", (e) => { drag = false; try { el.releasePointerCapture(e.pointerId); } catch (_) {} });
    el.addEventListener("dblclick", (e) => { e.stopPropagation(); enterEdit(obj); });
    el.addEventListener("input", () => { obj.text = el.innerText; });
    el.addEventListener("blur", () => {
      el.contentEditable = "false";
      obj.text = el.innerText.replace(/\n$/, "");
      if (!obj.text.trim()) removeObj(obj);     // drop empty boxes
    });
  }

  function enterEdit(obj) {
    const el = obj.el;
    el.contentEditable = "true";
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  /* --------------------------- image element ----------------------- */
  function loadImageFile(file) {
    if (!file.type.startsWith("image/")) { alert("Please choose an image."); return; }
    const reader = new FileReader();
    reader.onload = () => addImageElement(reader.result, file.type);
    reader.readAsDataURL(file);
  }

  function addImageElement(dataUrl, imgType) {
    const img = new Image();
    img.onload = () => {
      const pageIndex = currentPageInView();
      const pg = state.pages[pageIndex];
      const scale = Math.min(1, (pg.displayWidth * 0.32) / img.naturalWidth);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      const x = (pg.displayWidth - w) / 2, y = (pg.displayHeight - h) / 2;
      const id = ++state.seq;
      const el = document.createElement("div");
      el.className = "pdf-el imgbox";
      el.dataset.id = id;
      el.style.left = x + "px"; el.style.top = y + "px";
      el.style.width = w + "px"; el.style.height = h + "px";
      el.innerHTML = `<img src="${dataUrl}" draggable="false" alt="overlay"/><span class="rsz"></span>`;
      pg.wrapper.appendChild(el);

      const obj = { id, type: "image", pageIndex, x, y, w, h, imgDataUrl: dataUrl, imgType: imgType || "image/png", el };
      state.elements.push(obj);
      wireImage(obj);
      select(id);
    };
    img.src = dataUrl;
  }

  function wireImage(obj) {
    const el = obj.el, pic = el.querySelector("img"), rsz = el.querySelector(".rsz");
    let drag = false, sx, sy, ox, oy;
    pic.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); select(obj.id);
      drag = true; sx = e.clientX; sy = e.clientY; ox = obj.x; oy = obj.y;
      try { pic.setPointerCapture(e.pointerId); } catch (_) {}
    });
    pic.addEventListener("pointermove", (e) => {
      if (!drag) return;
      obj.x = Math.max(0, ox + (e.clientX - sx));
      obj.y = Math.max(0, oy + (e.clientY - sy));
      el.style.left = obj.x + "px"; el.style.top = obj.y + "px";
    });
    pic.addEventListener("pointerup", (e) => { drag = false; try { pic.releasePointerCapture(e.pointerId); } catch (_) {} });

    let rz = false, rx, rw, asp;
    rsz.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); select(obj.id);
      rz = true; rx = e.clientX; rw = obj.w; asp = obj.w / obj.h;
      try { rsz.setPointerCapture(e.pointerId); } catch (_) {}
    });
    rsz.addEventListener("pointermove", (e) => {
      if (!rz) return;
      obj.w = Math.max(20, rw + (e.clientX - rx)); obj.h = obj.w / asp;
      el.style.width = obj.w + "px"; el.style.height = obj.h + "px";
    });
    rsz.addEventListener("pointerup", (e) => { rz = false; try { rsz.releasePointerCapture(e.pointerId); } catch (_) {} });
  }

  /* ----------------------------- selection ------------------------- */
  function selectedObj() { return state.elements.find((o) => o.id === state.selected) || null; }

  function select(id) {
    state.selected = id;
    state.elements.forEach((o) => o.el.classList.toggle("selected", o.id === id));
    const o = selectedObj();
    const isText = !!o && o.type === "text";
    const isRect = !!o && o.type === "rect";
    $("#fontSize").disabled = !isText;
    $("#boldBtn").disabled = !isText;
    $("#fontColor").disabled = !(isText || isRect);
    $("#deleteBtn").disabled = !o;
    if (isText) {
      $("#fontSize").value = o.fontSize;
      $("#fontColor").value = o.color;
      $("#boldBtn").classList.toggle("armed", !!o.bold);
    } else {
      $("#boldBtn").classList.remove("armed");
      if (isRect) $("#fontColor").value = o.color;
    }
  }

  function deselect() {
    state.selected = null;
    state.elements.forEach((o) => o.el.classList.remove("selected"));
    $("#fontSize").disabled = true; $("#fontColor").disabled = true;
    $("#boldBtn").disabled = true; $("#boldBtn").classList.remove("armed");
    $("#deleteBtn").disabled = true;
  }

  function removeObj(obj) {
    obj.el.remove();
    state.elements = state.elements.filter((o) => o.id !== obj.id);
    if (state.selected === obj.id) deselect();
  }
  function deleteSelected() { const o = selectedObj(); if (o) removeObj(o); }

  function setMode(m) {
    state.mode = m;
    $("#addTextBtn").classList.toggle("armed", m === "addText");
    $("#whiteoutBtn").classList.toggle("armed", m === "addRect");
    $("#pages").classList.toggle("placing", m === "addText" || m === "addRect");
    $("#editorHint").textContent =
      m === "addText" ? "Click on the page where you want the text box."
      : m === "addRect" ? "Drag over the existing text you want to cover / clear."
      : "Double-click a box to type; drag to move; use the corner to resize.";
  }

  function currentPageInView() {
    const mid = window.innerHeight / 2;
    let best = 0, bestDist = Infinity;
    state.pages.forEach((pg, i) => {
      const r = pg.wrapper.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - mid);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  /* ------------------------------ export --------------------------- */
  // Helvetica (a StandardFont) only encodes WinAnsi; map common Unicode
  // punctuation to ASCII and drop anything else so drawText never throws.
  function sanitize(s) {
    return (s || "")
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/…/g, "...")
      .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "?");
  }

  async function download() {
    if (typeof PDFLib === "undefined") { alert("PDF editor library failed to load (needs internet)."); return; }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // commit edits
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const btn = $("#downloadBtn"); const label = btn.textContent; btn.disabled = true; btn.textContent = "Saving…";
    try {
      const bytes = await state.file.arrayBuffer();
      const pdf = await PDFDocument.load(bytes);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const pages = pdf.getPages();

      for (const obj of state.elements) {
        const page = pages[obj.pageIndex];
        const pg = state.pages[obj.pageIndex];
        const sc = page.getSize().width / pg.displayWidth; // PDF points per display px
        const ph = page.getSize().height;

        if (obj.type === "text") {
          if (!obj.text || !obj.text.trim()) continue;
          const sizePt = obj.fontSize * sc;
          const c = hexToRgb01(obj.color);
          const useFont = obj.bold ? fontBold : font;
          const lineH = sizePt * 1.18;
          let baseline = ph - obj.y * sc - sizePt; // top of box → first baseline
          for (const raw of obj.text.split("\n")) {
            const line = sanitize(raw);
            if (line.length) page.drawText(line, { x: obj.x * sc, y: baseline, size: sizePt, font: useFont, color: rgb(c.r, c.g, c.b) });
            baseline -= lineH;
          }
        } else if (obj.type === "rect") {
          const c = hexToRgb01(obj.color);
          page.drawRectangle({ x: obj.x * sc, y: ph - (obj.y + obj.h) * sc, width: obj.w * sc, height: obj.h * sc, color: rgb(c.r, c.g, c.b) });
        } else if (obj.type === "image") {
          const embedded = obj.imgType === "image/png"
            ? await pdf.embedPng(obj.imgDataUrl)
            : await pdf.embedJpg(obj.imgDataUrl);
          page.drawImage(embedded, { x: obj.x * sc, y: ph - (obj.y + obj.h) * sc, width: obj.w * sc, height: obj.h * sc });
        }
      }

      const out = await pdf.save();
      const blob = new Blob([out], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (state.file.name || "document").replace(/\.pdf$/i, "") + "-edited.pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      console.error(e); alert("Could not save the edited PDF: " + e.message);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  function hexToRgb01(hex) {
    const n = parseInt((hex || "#111111").replace("#", ""), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  function clampInt(v, min, max, fb) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return fb;
    return Math.min(max, Math.max(min, n));
  }
})();
