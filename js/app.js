/* =====================================================================
 * app.js — Lumidoc photo tool
 * Pure client-side. Steps: Make Photo → Upload → Crop → Adjust → Download
 * ===================================================================== */
(function () {
  "use strict";

  const MM_PER_INCH = 25.4;
  const SHEET_DPI = 300;

  /* ------------------------------- state --------------------------- */
  const state = {
    step: 0,
    maxReached: 0,
    spec: null,            // selected photo specification
    workingCanvas: null,   // full-res uploaded image (after rotate/flip)
    croppedCanvas: null,   // raw crop at target pixel size
    cutout: null,          // cached transparent-background cutout of the person
    bgCanvas: null,        // crop after optional background replacement
    bgJob: null,           // serializes async background work
    finalCanvas: null,     // crop + bg + filters baked in
    sheetInfo: null,       // { wMM, hMM } physical size of the rendered print sheet
    adjust: { brightness: 100, contrast: 100, saturation: 100 },
    crop: { x: 0, y: 0, w: 0, h: 0 }, // crop box in displayed px
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ------------------------- pixel-size helpers -------------------- */
  function mmToPx(mm, dpi) { return Math.round((mm / MM_PER_INCH) * dpi); }

  // Returns { w, h, dpi, widthMM, heightMM } for one photo at the chosen spec.
  function specPixels(spec) {
    if (spec.custom) {
      const widthMM = clampNum($("#customW").value, 10, 200, 35);
      const heightMM = clampNum($("#customH").value, 10, 200, 45);
      const dpi = clampNum($("#customDpi").value, 72, 1200, 300);
      return { w: mmToPx(widthMM, dpi), h: mmToPx(heightMM, dpi), dpi, widthMM, heightMM };
    }
    if (spec.px) {
      return { w: spec.px.w, h: spec.px.h, dpi: spec.dpi, widthMM: spec.widthMM, heightMM: spec.heightMM };
    }
    return {
      w: mmToPx(spec.widthMM, spec.dpi), h: mmToPx(spec.heightMM, spec.dpi),
      dpi: spec.dpi, widthMM: spec.widthMM, heightMM: spec.heightMM,
    };
  }

  function clampNum(v, min, max, fallback) {
    const n = parseFloat(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /* ============================ STEP 0 ============================= */
  function initStep0() {
    const countrySel = $("#countrySelect");
    Object.keys(PRESETS).forEach((c) => {
      const o = document.createElement("option");
      o.value = c; o.textContent = c;
      countrySel.appendChild(o);
    });
    countrySel.value = "India";
    countrySel.addEventListener("change", renderSpecList);
    // Attach the spec-change listener once (the list node persists across rebuilds).
    $("#specList").addEventListener("change", toggleCustom);
    ["#customW", "#customH", "#customDpi"].forEach((id) =>
      $(id).addEventListener("input", () => { if (state.spec) state.spec = currentSpec(); })
    );
    renderSpecList();
    $("#startBtn").addEventListener("click", () => {
      state.spec = currentSpec();
      goTo(1);
    });
  }

  function currentSpec() {
    const country = $("#countrySelect").value;
    const idx = parseInt($('input[name="spec"]:checked')?.value ?? "0", 10);
    return PRESETS[country][idx];
  }

  function renderSpecList() {
    const country = $("#countrySelect").value;
    const list = $("#specList");
    list.innerHTML = "";
    PRESETS[country].forEach((spec, i) => {
      const id = "spec_" + i;
      const label = document.createElement("label");
      label.innerHTML =
        `<input type="radio" name="spec" id="${id}" value="${i}" ${i === 0 ? "checked" : ""}/>` +
        `<span>${spec.name}</span>`;
      list.appendChild(label);
    });
    toggleCustom();
  }

  function toggleCustom() {
    const spec = currentSpec();
    $("#customFields").hidden = !spec.custom;
  }

  /* ============================ STEP 1 ============================= */
  function initStep1() {
    const dz = $("#dropzone");
    const input = $("#fileInput");
    $("#browseBtn").addEventListener("click", () => input.click());
    dz.addEventListener("click", (e) => { if (e.target === dz || e.target.classList.contains("dz-inner")) input.click(); });
    input.addEventListener("change", () => input.files[0] && loadFile(input.files[0]));

    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
    );
    dz.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    $("#toCropBtn").addEventListener("click", () => goTo(2));
  }

  function loadFile(file) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (isPdf) { loadPdf(file); return; }
    if (!file.type.startsWith("image/")) { alert("Please choose an image (JPG/PNG) or a PDF."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => setWorkingCanvas(img, img.naturalWidth, img.naturalHeight);
      img.onerror = () => alert("Could not read that image.");
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Downscale any image/canvas source and set it as the working canvas.
  function setWorkingCanvas(source, srcW, srcH, numPages) {
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(srcW, srcH));
    const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); // flatten any transparency
    ctx.drawImage(source, 0, 0, w, h);
    state.workingCanvas = c;
    $("#toCropBtn").disabled = false;
    showThumbInDropzone(c, numPages);
  }

  /* ---- PDF input (pdf.js): render the chosen page to the working canvas ---- */
  let _pdfDoc = null, _pdfPage = 1;
  function configurePdfJs() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";
    }
  }
  async function loadPdf(file) {
    if (typeof pdfjsLib === "undefined") {
      alert("PDF support failed to load (needs internet). Please use a JPG or PNG.");
      return;
    }
    configurePdfJs();
    try {
      const buf = await file.arrayBuffer();
      _pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
      _pdfPage = 1;
      await renderPdfPage(_pdfPage);
    } catch (e) {
      console.error(e);
      alert("Could not read that PDF.");
    }
  }
  async function renderPdfPage(num) {
    const page = await _pdfDoc.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1, 1600 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    setWorkingCanvas(c, c.width, c.height, _pdfDoc.numPages);
  }

  function showThumbInDropzone(canvas, numPages) {
    const dz = $("#dropzone");
    const pager = numPages > 1
      ? `<div class="pdf-pager">
           <button class="btn small" id="pgPrev">‹ Prev</button>
           <span>Page ${_pdfPage} of ${numPages}</span>
           <button class="btn small" id="pgNext">Next ›</button>
         </div>`
      : "";
    dz.querySelector(".dz-inner").innerHTML =
      `<img src="${canvas.toDataURL("image/png")}" alt="preview"
            style="max-height:220px;border-radius:8px;box-shadow:var(--shadow)"/>
       ${pager}
       <p style="margin-top:12px">Looks good? <button class="btn small" id="rechoose">Choose another</button></p>`;
    $("#rechoose").addEventListener("click", () => $("#fileInput").click());
    if (numPages > 1) {
      $("#pgPrev").addEventListener("click", () => { if (_pdfPage > 1) { _pdfPage--; renderPdfPage(_pdfPage); } });
      $("#pgNext").addEventListener("click", () => { if (_pdfPage < numPages) { _pdfPage++; renderPdfPage(_pdfPage); } });
    }
  }

  /* ============================ STEP 2 ============================= */
  let cropImg, cropStage, cropBox;

  function initStep2() {
    cropImg = $("#cropImg");
    cropStage = $("#cropStage");
    cropBox = $("#cropBox");

    $("#rotL").addEventListener("click", () => { rotateWorking(-90); setupCrop(); });
    $("#rotR").addEventListener("click", () => { rotateWorking(90); setupCrop(); });
    $("#flipH").addEventListener("click", () => { flipWorking(); setupCrop(); });
    $("#showGuides").addEventListener("change", (e) =>
      $("#guides").classList.toggle("hidden", !e.target.checked)
    );
    $("#toAdjustBtn").addEventListener("click", () => { applyCrop(); goTo(3); });

    enableCropInteractions();
  }

  function rotateWorking(deg) {
    const src = state.workingCanvas;
    const c = document.createElement("canvas");
    if (Math.abs(deg) === 90) { c.width = src.height; c.height = src.width; }
    else { c.width = src.width; c.height = src.height; }
    const ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    state.workingCanvas = c;
  }

  function flipWorking() {
    const src = state.workingCanvas;
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.translate(c.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(src, 0, 0);
    state.workingCanvas = c;
  }

  // Display the working image and reset the crop box to the target aspect.
  function setupCrop() {
    cropImg.src = state.workingCanvas.toDataURL("image/png");
    cropImg.onload = () => {
      const px = specPixels(state.spec);
      const aspect = px.w / px.h;
      const dispW = cropImg.clientWidth;
      const dispH = cropImg.clientHeight;
      // Largest box of the target aspect that fits, at 85% of available space.
      let w = dispW * 0.85;
      let h = w / aspect;
      if (h > dispH * 0.92) { h = dispH * 0.92; w = h * aspect; }
      state.crop = { x: (dispW - w) / 2, y: (dispH - h) / 2, w, h };
      renderCropBox();
    };
  }

  function renderCropBox() {
    const b = state.crop;
    cropBox.style.left = b.x + "px";
    cropBox.style.top = b.y + "px";
    cropBox.style.width = b.w + "px";
    cropBox.style.height = b.h + "px";
  }

  function enableCropInteractions() {
    let mode = null;        // "move" | handle class
    let start = null;       // pointer + box snapshot

    const onDown = (e) => {
      const handle = e.target.classList.contains("handle") ? e.target.classList[1] : null;
      if (!handle && e.target !== cropBox) return;
      e.preventDefault();
      cropStage.setPointerCapture?.(e.pointerId);
      mode = handle || "move";
      const p = pointer(e);
      start = { px: p.x, py: p.y, box: { ...state.crop } };
    };

    const onMove = (e) => {
      if (!mode) return;
      e.preventDefault();
      const p = pointer(e);
      const dx = p.x - start.px, dy = p.y - start.py;
      const imgW = cropImg.clientWidth, imgH = cropImg.clientHeight;
      const px = specPixels(state.spec);
      const aspect = px.w / px.h;
      const b = start.box;

      if (mode === "move") {
        let nx = b.x + dx, ny = b.y + dy;
        nx = Math.max(0, Math.min(nx, imgW - b.w));
        ny = Math.max(0, Math.min(ny, imgH - b.h));
        state.crop = { x: nx, y: ny, w: b.w, h: b.h };
      } else {
        resizeBox(mode, p, b, aspect, imgW, imgH);
      }
      renderCropBox();
    };

    const onUp = () => { mode = null; start = null; };

    cropStage.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resizeBox(handle, p, b, aspect, imgW, imgH) {
    const MIN = 50;
    // Anchor = the fixed opposite corner.
    let anchor;
    if (handle === "se") anchor = { x: b.x, y: b.y };
    else if (handle === "sw") anchor = { x: b.x + b.w, y: b.y };
    else if (handle === "ne") anchor = { x: b.x, y: b.y + b.h };
    else anchor = { x: b.x + b.w, y: b.y + b.h }; // nw

    const growRight = handle === "se" || handle === "ne";
    const growDown = handle === "se" || handle === "sw";

    let w = growRight ? p.x - anchor.x : anchor.x - p.x;
    // Limit width so the box stays inside the image given the anchor + aspect.
    const maxByX = growRight ? imgW - anchor.x : anchor.x;
    const maxByY = (growDown ? imgH - anchor.y : anchor.y) * aspect;
    w = Math.max(MIN, Math.min(w, maxByX, maxByY));
    const h = w / aspect;

    const x = growRight ? anchor.x : anchor.x - w;
    const y = growDown ? anchor.y : anchor.y - h;
    state.crop = { x, y, w, h };
  }

  function pointer(e) {
    const r = cropStage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Map the displayed crop box onto the full-res working canvas → croppedCanvas.
  function applyCrop() {
    const px = specPixels(state.spec);
    const scale = state.workingCanvas.width / cropImg.clientWidth;
    const b = state.crop;
    const out = document.createElement("canvas");
    out.width = px.w; out.height = px.h;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      state.workingCanvas,
      b.x * scale, b.y * scale, b.w * scale, b.h * scale,
      0, 0, px.w, px.h
    );
    state.croppedCanvas = out;
    state.bgCanvas = null; // force background recompute
    state.cutout = null;   // a new crop needs a fresh cutout
  }

  /* ============================ STEP 3 ============================= */
  function initStep3() {
    const sliders = [
      ["#brightness", "#bVal", "brightness", "%"],
      ["#contrast", "#cVal", "contrast", "%"],
      ["#saturation", "#sVal", "saturation", "%"],
    ];
    sliders.forEach(([sl, lbl, key, suffix]) => {
      $(sl).addEventListener("input", (e) => {
        state.adjust[key] = +e.target.value;
        $(lbl).textContent = e.target.value + suffix;
        renderAdjusted($("#adjustCanvas"));
      });
    });

    $("#bgReplace").addEventListener("change", (e) => {
      const on = e.target.checked;
      ["#bgColorField", "#bgSwatches", "#bgHint"].forEach((id) => ($(id).hidden = !on));
      if (!on) setBgStatus("");
      state.bgCanvas = null;
      refreshPreview();
    });
    $("#bgColor").addEventListener("input", () => { state.bgCanvas = null; refreshPreview(); });
    $$("#bgSwatches button").forEach((b) =>
      b.addEventListener("click", () => {
        $("#bgColor").value = b.dataset.color;
        state.bgCanvas = null;
        refreshPreview();
      })
    );
    $("#resetAdjust").addEventListener("click", resetAdjust);
    $("#toDownloadBtn").addEventListener("click", () => goTo(4));
  }

  function resetAdjust() {
    state.adjust = { brightness: 100, contrast: 100, saturation: 100 };
    $("#brightness").value = 100; $("#bVal").textContent = "100%";
    $("#contrast").value = 100; $("#cVal").textContent = "100%";
    $("#saturation").value = 100; $("#sVal").textContent = "100%";
    $("#bgReplace").checked = false;
    ["#bgColorField", "#bgSwatches", "#bgHint"].forEach((id) => ($(id).hidden = true));
    setBgStatus("");
    state.bgCanvas = null;
    refreshPreview();
  }

  function enterStep3() {
    // Default the background colour to the spec's recommendation.
    $("#bgColor").value = state.spec.bg || "#ffffff";
    refreshPreview();
  }

  function setBgStatus(msg) {
    const el = $("#bgStatus");
    if (el) { el.textContent = msg; el.hidden = !msg; }
  }

  // Ensure state.bgCanvas reflects the current background choice. Async because
  // matting downloads/runs an ML model on first use. Serialized via bgJob.
  // The cutout is cached, so changing only the colour re-composites instantly.
  function ensureBackground() {
    state.bgJob = (state.bgJob || Promise.resolve()).then(async () => {
      if (state.bgCanvas) return;
      if (!$("#bgReplace").checked) { state.bgCanvas = state.croppedCanvas; return; }
      if (!state.cutout) {
        try {
          state.cutout = await runMatting(state.croppedCanvas);
        } catch (err) {
          console.warn("Matting unavailable, using edge fill:", err);
          state.bgCanvas = replaceBackground(state.croppedCanvas, $("#bgColor").value, 45);
          setBgStatus("AI model unavailable (offline?) — used a basic edge fill instead.");
          return;
        }
      }
      state.bgCanvas = compositeOnColor(state.cutout, $("#bgColor").value);
      setBgStatus("Background replaced ✓");
    });
    return state.bgJob;
  }

  async function refreshPreview() {
    await ensureBackground();
    applyFilters($("#adjustCanvas"));
  }

  // Draw the active background canvas with brightness/contrast/saturation.
  // Fast + synchronous: slider changes call this without re-segmenting.
  function applyFilters(target) {
    const base = state.bgCanvas || state.croppedCanvas;
    if (!base) return;
    const a = state.adjust;
    const ctx = target.getContext("2d");
    target.width = base.width;
    target.height = base.height;
    ctx.filter = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%)`;
    ctx.drawImage(base, 0, 0);
    ctx.filter = "none";
  }

  /* ---- AI background removal: MediaPipe Selfie Segmentation ----
   * A PERSON-focused model: it segments the whole human (head AND torso),
   * unlike salient-object matting which can drop a low-contrast shirt. Its raw
   * mask is low-res/soft, so we erode + feather it to remove the colour halo.
   * Small (~5 MB) and reliable to fetch; cached after first use. */
  let _segmenter = null;
  function getSegmenter() {
    if (_segmenter) return _segmenter;
    if (typeof SelfieSegmentation === "undefined") throw new Error("SelfieSegmentation script not loaded");
    _segmenter = new SelfieSegmentation({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`,
    });
    _segmenter.setOptions({ modelSelection: 0 }); // 0 = general (square, better for portraits)
    return _segmenter;
  }

  // Returns a full-size canvas of the raw person mask (grayscale: bright = person).
  function rawMask(srcCanvas) {
    return new Promise((resolve, reject) => {
      let seg;
      try { seg = getSegmenter(); } catch (e) { return reject(e); }
      const timer = setTimeout(() => reject(new Error("segmentation timeout")), 30000);
      seg.onResults((res) => {
        clearTimeout(timer);
        const m = document.createElement("canvas");
        m.width = srcCanvas.width; m.height = srcCanvas.height;
        m.getContext("2d").drawImage(res.segmentationMask, 0, 0, m.width, m.height);
        resolve(m);
      });
      setBgStatus("Removing background…");
      seg.send({ image: srcCanvas }).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  /* ISNet matting (@imgly) — crisp, accurate edges. Loaded on demand. */
  const IMGLY_URL = "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
  const IMGLY_DATA = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";
  let _imglyMod = null;
  async function loadImgly() {
    if (!_imglyMod) _imglyMod = await import(/* webpackIgnore: true */ IMGLY_URL);
    return _imglyMod;
  }
  // Returns a canvas with a transparent-background cutout (alpha from ISNet).
  async function isnetCutout(srcCanvas) {
    const mod = await loadImgly();
    const blob = await new Promise((r) => srcCanvas.toBlob(r, "image/png"));
    const out = await mod.removeBackground(blob, {
      publicPath: IMGLY_DATA,
      model: "isnet_fp16",
      output: { format: "image/png", quality: 1 },
      progress: (k, c, t) => {
        if (typeof k === "string" && k.indexOf("fetch") === 0 && t) setBgStatus(`Downloading AI model… ${Math.round((c / t) * 100)}%`);
        else setBgStatus("Removing background…");
      },
    });
    const url = URL.createObjectURL(out);
    try {
      const img = await loadImage(url);
      const c = canvasOf(srcCanvas.width, srcCanvas.height);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("decode failed")); i.src = src; });
  }

  // Self-hosted high-quality server (BiRefNet etc.), if configured.
  // A per-browser localStorage override wins over the page default, so devs can
  // point at a local server without editing index.html.
  function bgServerUrl() {
    return (typeof localStorage !== "undefined" && localStorage.getItem("bgServerUrl")) ||
      (typeof window !== "undefined" && window.BG_SERVER_URL) || "";
  }
  // POST the image to the server and load the returned transparent cutout.
  async function serverCutout(srcCanvas, url) {
    const blob = await new Promise((r) => srcCanvas.toBlob(r, "image/png"));
    const form = new FormData();
    form.append("file", blob, "photo.png");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let resp;
    try {
      resp = await fetch(url, { method: "POST", body: form, signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!resp.ok) throw new Error("server responded " + resp.status);
    const outBlob = await resp.blob();
    const u = URL.createObjectURL(outBlob);
    try {
      const img = await loadImage(u);
      const c = canvasOf(srcCanvas.width, srcCanvas.height);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c; // RGBA cutout (transparent background)
    } finally { URL.revokeObjectURL(u); }
  }

  // Background removal, best source available:
  //   1) self-hosted server (highest quality), if configured & reachable;
  //   2) in-browser hybrid: ISNet crisp edges + MediaPipe body back-fill;
  //   3) whichever single in-browser model loads.
  async function runMatting(srcCanvas) {
    const url = bgServerUrl();
    if (url) {
      // Server configured → use it. On failure, fall back to the SMALL MediaPipe
      // model only (from jsdelivr); never download the large @imgly/staticimgly
      // model when the user has chosen a server.
      try {
        setBgStatus("Removing background (server)…");
        return await serverCutout(srcCanvas, url);
      } catch (e) {
        console.warn("BG server unavailable:", e);
        setBgStatus("Server unreachable — using lightweight in-browser model…");
        const mpc = await rawMask(srcCanvas);
        return buildCutout(srcCanvas, mpc);
      }
    }
    // No server configured → in-browser hybrid (ISNet crisp edges + MediaPipe).
    let isc = null, mpc = null;
    try { isc = await isnetCutout(srcCanvas); } catch (e) { console.warn("ISNet unavailable:", e); }
    try { mpc = await rawMask(srcCanvas); } catch (e) { console.warn("MediaPipe unavailable:", e); }
    if (isc && mpc) return hybridCutout(srcCanvas, isc, mpc);
    if (isc) return isc;
    if (mpc) return buildCutout(srcCanvas, mpc);
    throw new Error("no segmentation available");
  }

  function hybridCutout(srcCanvas, iscCanvas, maskCanvas) {
    const W = srcCanvas.width, H = srcCanvas.height, N = W * H;
    const isAlpha = iscCanvas.getContext("2d").getImageData(0, 0, W, H).data; // ISNet alpha
    const body = buildBodyMask(maskCanvas, W, H);                              // deep-interior person fill
    const out = cloneCanvas(srcCanvas);
    const octx = out.getContext("2d");
    const img = octx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < N; i++) {
      const a = Math.max(isAlpha[i * 4 + 3] / 255, body[i]); // ISNet edge OR backfilled body
      d[i * 4 + 3] = Math.round(a * 255);
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // MediaPipe mask → largest component, hard-eroded to the deep interior so it
  // only fills body the edge-accurate model missed (never adds an edge halo).
  function buildBodyMask(maskCanvas, W, H) {
    const N = W * H;
    const r1 = Math.max(1, Math.round(Math.min(W, H) * 0.01));
    const sm = canvasOf(W, H), smctx = sm.getContext("2d");
    smctx.filter = `blur(${r1}px)`; smctx.drawImage(maskCanvas, 0, 0, W, H); smctx.filter = "none";
    const prob = smctx.getImageData(0, 0, W, H).data;

    const fg = new Uint8Array(N);
    for (let i = 0; i < N; i++) fg[i] = prob[i * 4] >= 140 ? 1 : 0;
    keepLargestComponent(fg, W, H);

    const bin = canvasOf(W, H), bctx = bin.getContext("2d");
    const bimg = bctx.createImageData(W, H);
    for (let i = 0; i < N; i++) { const v = fg[i] ? 255 : 0; bimg.data[i * 4] = v; bimg.data[i * 4 + 1] = v; bimg.data[i * 4 + 2] = v; bimg.data[i * 4 + 3] = 255; }
    bctx.putImageData(bimg, 0, 0);

    const r2 = Math.max(2, Math.round(Math.min(W, H) * 0.018)); // strong blur → strong erosion
    const fbctx = canvasOf(W, H).getContext("2d");
    fbctx.filter = `blur(${r2}px)`; fbctx.drawImage(bin, 0, 0); fbctx.filter = "none";
    const soft = fbctx.getImageData(0, 0, W, H).data;

    const res = new Float32Array(N);
    const LOW = 0.74, HIGH = 0.95;   // only deep interior survives
    for (let i = 0; i < N; i++) { let a = (soft[i * 4] / 255 - LOW) / (HIGH - LOW); res[i] = a < 0 ? 0 : a > 1 ? 1 : a; }
    return res;
  }

  // Turn the coarse mask into a clean cutout:
  //  1. smooth the blocky upscaled mask,
  //  2. keep only the largest connected region (drops stray background blobs),
  //  3. erode + feather the edge (cuts the background-colour halo).
  function buildCutout(srcCanvas, maskCanvas) {
    const W = srcCanvas.width, H = srcCanvas.height, N = W * H;

    // (1) smooth
    const r1 = Math.max(1, Math.round(Math.min(W, H) * 0.01));
    const sm = canvasOf(W, H), smctx = sm.getContext("2d");
    smctx.filter = `blur(${r1}px)`;
    smctx.drawImage(maskCanvas, 0, 0, W, H);
    smctx.filter = "none";
    const prob = smctx.getImageData(0, 0, W, H).data;

    // (2) binary foreground, then keep only the largest connected component
    const fg = new Uint8Array(N);
    for (let i = 0; i < N; i++) fg[i] = prob[i * 4] >= 128 ? 1 : 0;
    keepLargestComponent(fg, W, H);

    // render that binary mask to a canvas and blur it (for erode + feather)
    const bin = canvasOf(W, H), bctx = bin.getContext("2d");
    const bimg = bctx.createImageData(W, H);
    for (let i = 0; i < N; i++) {
      const v = fg[i] ? 255 : 0;
      bimg.data[i * 4] = v; bimg.data[i * 4 + 1] = v; bimg.data[i * 4 + 2] = v; bimg.data[i * 4 + 3] = 255;
    }
    bctx.putImageData(bimg, 0, 0);
    const r2 = Math.max(1, Math.round(Math.min(W, H) * 0.009));
    const fbctx = canvasOf(W, H).getContext("2d");
    fbctx.filter = `blur(${r2}px)`;
    fbctx.drawImage(bin, 0, 0);
    fbctx.filter = "none";
    const soft = fbctx.getImageData(0, 0, W, H).data;

    // (3) alpha: require > LOW (erodes inward past the green fringe), feather to HIGH
    const out = cloneCanvas(srcCanvas);
    const octx = out.getContext("2d");
    const img = octx.getImageData(0, 0, W, H);
    const d = img.data;
    const LOW = 0.62, HIGH = 0.86;
    for (let i = 0; i < N; i++) {
      const m = soft[i * 4] / 255;
      let a = (m - LOW) / (HIGH - LOW);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      d[i * 4 + 3] = Math.round(a * 255);
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

  // Zero every foreground pixel that isn't part of the largest 4-connected blob.
  function keepLargestComponent(fg, W, H) {
    const N = W * H;
    const label = new Int32Array(N);
    const stack = new Int32Array(N);
    let cur = 0, bestLabel = 0, bestSize = 0;
    for (let s = 0; s < N; s++) {
      if (!fg[s] || label[s]) continue;
      cur++;
      let sp = 0, size = 0;
      stack[sp++] = s; label[s] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % W, y = (p / W) | 0;
        if (x > 0) { const q = p - 1; if (fg[q] && !label[q]) { label[q] = cur; stack[sp++] = q; } }
        if (x < W - 1) { const q = p + 1; if (fg[q] && !label[q]) { label[q] = cur; stack[sp++] = q; } }
        if (y > 0) { const q = p - W; if (fg[q] && !label[q]) { label[q] = cur; stack[sp++] = q; } }
        if (y < H - 1) { const q = p + W; if (fg[q] && !label[q]) { label[q] = cur; stack[sp++] = q; } }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    for (let i = 0; i < N; i++) if (label[i] !== bestLabel) fg[i] = 0;
  }

  // Composite a transparent cutout over a solid background colour.
  function compositeOnColor(cutoutCanvas, hex) {
    const out = document.createElement("canvas");
    out.width = cutoutCanvas.width; out.height = cutoutCanvas.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(cutoutCanvas, 0, 0);
    return out;
  }

  function cloneCanvas(src) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  // Region-grow flood fill from the four edges; replace matched pixels.
  function replaceBackground(src, hex, tol) {
    const c = cloneCanvas(src);
    const ctx = c.getContext("2d");
    const W = c.width, H = c.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const target = hexToRgb(hex);

    // Reference colour = average of the four corners.
    const corners = [0, (W - 1) * 4, (H - 1) * W * 4, ((H - 1) * W + (W - 1)) * 4];
    let rr = 0, gg = 0, bb = 0;
    corners.forEach((i) => { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; });
    const ref = { r: rr / 4, g: gg / 4, b: bb / 4 };
    const tol2 = tol * tol;

    const visited = new Uint8Array(W * H);
    const stack = [];
    const pushIf = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const p = y * W + x;
      if (visited[p]) return;
      visited[p] = 1;
      const i = p * 4;
      const dr = d[i] - ref.r, dg = d[i + 1] - ref.g, db = d[i + 2] - ref.b;
      if (dr * dr + dg * dg + db * db <= tol2) {
        d[i] = target.r; d[i + 1] = target.g; d[i + 2] = target.b; d[i + 3] = 255;
        stack.push(p);
      }
    };
    for (let x = 0; x < W; x++) { pushIf(x, 0); pushIf(x, H - 1); }
    for (let y = 0; y < H; y++) { pushIf(0, y); pushIf(W - 1, y); }
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      pushIf(x + 1, y); pushIf(x - 1, y); pushIf(x, y + 1); pushIf(x, y - 1);
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /* ============================ STEP 4 ============================= */
  function initStep4() {
    const sel = $("#paperSelect");
    PAPERS.forEach((p, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.addEventListener("change", renderSheet);
    $("#dlSingle").addEventListener("click", () => downloadCanvas($("#finalCanvas"), "id-photo.jpg"));
    $("#dlSheet").addEventListener("click", () => downloadCanvas($("#sheetCanvas"), "id-photo-sheet.jpg"));
    $("#dlSinglePdf").addEventListener("click", () => {
      const px = specPixels(state.spec);
      downloadPdf($("#finalCanvas"), px.widthMM, px.heightMM, "id-photo.pdf");
    });
    $("#dlSheetPdf").addEventListener("click", () => {
      const s = state.sheetInfo || { wMM: 152.4, hMM: 101.6 };
      downloadPdf($("#sheetCanvas"), s.wMM, s.hMM, "id-photo-sheet.pdf");
    });
    $("#startOver").addEventListener("click", () => location.reload());
  }

  async function enterStep4() {
    await ensureBackground();        // make sure background work is finished
    applyFilters($("#finalCanvas")); // bake final single photo
    state.finalCanvas = $("#finalCanvas");
    const px = specPixels(state.spec);
    $("#finalMeta").textContent =
      `${px.w} × ${px.h} px • ${px.widthMM} × ${px.heightMM} mm • ${px.dpi} dpi`;
    renderSheet();
  }

  function renderSheet() {
    const paper = PAPERS[+$("#paperSelect").value || 0];
    const spec = specPixels(state.spec);
    const sheet = $("#sheetCanvas");
    const ctx = sheet.getContext("2d");

    const photoW = mmToPx(spec.widthMM, SHEET_DPI);
    const photoH = mmToPx(spec.heightMM, SHEET_DPI);
    let paperW = mmToPx(paper.widthMM, SHEET_DPI);
    let paperH = mmToPx(paper.heightMM, SHEET_DPI);
    let paperWmm = paper.widthMM, paperHmm = paper.heightMM;

    // Orient paper landscape/portrait to fit the most photos.
    const fitA = countFit(paperW, paperH, photoW, photoH);
    const fitB = countFit(paperH, paperW, photoW, photoH);
    if (fitB.total > fitA.total) {
      [paperW, paperH] = [paperH, paperW];
      [paperWmm, paperHmm] = [paperHmm, paperWmm];
    }
    state.sheetInfo = { wMM: paperWmm, hMM: paperHmm }; // exact physical size for PDF

    sheet.width = paperW; sheet.height = paperH;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, paperW, paperH);

    const margin = mmToPx(4, SHEET_DPI);
    const gap = mmToPx(3, SHEET_DPI);
    const cols = Math.max(1, Math.floor((paperW - margin * 2 + gap) / (photoW + gap)));
    const rows = Math.max(1, Math.floor((paperH - margin * 2 + gap) / (photoH + gap)));
    const gridW = cols * photoW + (cols - 1) * gap;
    const gridH = rows * photoH + (rows - 1) * gap;
    const offX = (paperW - gridW) / 2;
    const offY = (paperH - gridH) / 2;

    ctx.imageSmoothingQuality = "high";
    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        const x = offX + cI * (photoW + gap);
        const y = offY + r * (photoH + gap);
        ctx.drawImage(state.finalCanvas, x, y, photoW, photoH);
        ctx.strokeStyle = "#c8c8c8";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, photoW, photoH);
      }
    }
    $("#sheetMeta").textContent =
      `${cols * rows} photos on ${paper.name} • ${SHEET_DPI} dpi`;
  }

  function countFit(pw, ph, w, h) {
    const margin = mmToPx(4, SHEET_DPI), gap = mmToPx(3, SHEET_DPI);
    const cols = Math.max(0, Math.floor((pw - margin * 2 + gap) / (w + gap)));
    const rows = Math.max(0, Math.floor((ph - margin * 2 + gap) / (h + gap)));
    return { cols, rows, total: cols * rows };
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/jpeg", 0.92);
  }

  // Export a canvas as a PDF whose page is exactly wMM × hMM, so it prints at
  // true physical size (print at 100% / "Actual size", not "Fit to page").
  function downloadPdf(canvas, wMM, hMM, filename) {
    const JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) { alert("PDF export failed to load (needs internet)."); return; }
    const doc = new JsPDF({ orientation: wMM >= hMM ? "l" : "p", unit: "mm", format: [wMM, hMM] });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    doc.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, pw, ph);
    doc.save(filename);
  }

  /* ========================== navigation =========================== */
  function goTo(n) {
    // Prerequisite guards.
    if (n >= 1 && !state.spec) return;
    if (n >= 2 && !state.workingCanvas) { goTo(1); return; }
    if (n >= 3 && !state.croppedCanvas) { goTo(2); return; }

    state.step = n;
    state.maxReached = Math.max(state.maxReached, n);

    $$(".step").forEach((s) => (s.hidden = +s.dataset.step !== n));
    $$("#stepsNav a").forEach((a) => {
      const t = +a.dataset.goto;
      a.classList.toggle("active", t === n);
      a.classList.toggle("disabled", t > state.maxReached);
    });

    if (n === 2) setupCrop();
    if (n === 3) enterStep3();
    if (n === 4) enterStep4();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initNav() {
    $$("[data-goto]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.preventDefault();
        goTo(+el.dataset.goto);
      })
    );
  }

  /* ----------------------------- boot ------------------------------ */
  document.addEventListener("DOMContentLoaded", () => {
    initStep0();
    initStep1();
    initStep2();
    initStep3();
    initStep4();
    initNav();
    goTo(0);
  });
})();
