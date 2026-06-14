# Lumidoc

**Lumidoc** is a browser-based passport / visa photo maker (inspired by
IDPhotoDIY.com), plus a PDF fill-and-sign editor and a resize/compress tool. Pick
a country and document type, upload a photo, crop it to the exact required
dimensions with face-positioning guides, fine-tune it, and download a single
print-ready photo plus a tiled print sheet (4×6, 5×7, A4, or Letter).

**Everything runs client-side** — the photo never leaves the browser. No server,
no build step, no dependencies.

## Run it

Just open `index.html` in a modern browser, or serve the folder over HTTP
(recommended, so the file picker and downloads behave consistently):

```bash
# Python
python -m http.server 8000
# then visit http://localhost:8000

# …or Node
npx serve .
```

## Flow

| Step | What it does |
|------|--------------|
| **Make Photo** | Choose country + document size (or a fully custom size in mm/dpi). |
| **Upload** | Drag & drop or browse to a JPG/PNG **or PDF** (PDF pages are rendered with pdf.js; multi-page PDFs get a page picker). Large images are downscaled for speed. |
| **Crop** | Drag/resize a fixed-aspect crop box; rotate/flip; oval + eye-line face guides. |
| **Adjustment** | Brightness / contrast / saturation sliders, plus optional edge flood-fill background replacement. |
| **Download** | Print-ready single photo (exact px/mm/dpi) and a tiled sheet on the chosen paper. Each is downloadable as **JPG or PDF** — the PDF page is sized to exact physical millimetres (jsPDF), so printing at 100% / "Actual size" yields correctly-sized photos. |

## PDF Editor (fill & sign)

A second tool at **pdf-editor.html** (linked from the photo tool's header) lets you
**open a full PDF, fill in the blanks, add a signature, and download the edited
PDF** — useful for forms like a name-change affidavit:

- **Open** any PDF (multi-page); each page is rendered with pdf.js.
- **＋ Text** — click on a page to drop a text box, type to fill a blank, drag to
  move, set font size and colour. Double-click an existing box to re-edit.
- **＋ Image / Sign** — drop in a signature or stamp image; drag and resize it.
- **Download PDF** — [pdf-lib](https://pdf-lib.js.org/) writes your text/images
  onto the **original** PDF, so the document's existing text stays crisp (vector,
  not a flattened image) and the page count/size are preserved.

Notes: text uses the standard Helvetica font (Latin characters; common smart
quotes/dashes are normalised automatically). pdf.js and pdf-lib load from a CDN,
so the editor needs internet; your document is never uploaded anywhere.

## Resize & Compress (resize.html)

A utility at **resize.html** (linked from every page's header) for hitting the
dimension and file-size limits that visa/passport portals impose — all in the
browser, no upload:

- **Images** — resize by exact dimensions (with aspect-ratio lock) or by
  percentage, convert between JPEG / PNG / WebP, set quality, or **compress to a
  target file size** (e.g. "under 240 KB" — it binary-searches quality and
  downscales as needed). Shows the resulting dimensions and size.
- **PDFs** — shrink the file by re-rendering each page at a chosen resolution
  (72–150 DPI) and JPEG quality, then rebuilding with jsPDF. Reports the
  before → after size. Best for oversized scans; selectable text is flattened.

## Project layout

```
lumidoc/
├── index.html            # photo tool — single-page UI, five steps
├── pdf-editor.html       # PDF editor — open, fill/sign, download
├── resize.html           # resize & compress — images and PDFs
├── css/styles.css        # shared styling (blue Lumidoc theme)
├── js/
│   ├── presets.js        # country/document specs + paper sizes
│   ├── app.js            # photo tool: upload, crop, adjust, sheet, download
│   ├── pdfeditor.js      # PDF editor: render, text/image overlays, export
│   └── resize.js         # resize/compress: images + PDF rasterise-rebuild
├── backend/              # optional high-quality background-removal service
│   ├── app.py            # FastAPI + rembg/BiRefNet
│   ├── requirements.txt
│   └── Dockerfile
├── deploy/
│   ├── Dockerfile.web    # nginx image serving the static front-end
│   └── nginx.conf        # static + /api reverse proxy + gzip + caching
├── docker-compose.yml    # one-command prod stack (web + backend)
└── .env.example          # deployment configuration
```

## Deploy to production

The whole stack runs with one command — nginx serves the static front-end and
**reverse-proxies `/api/*` to the backend**, so the browser talks to a single
origin (no CORS) and the background-removal server is never exposed directly.

```bash
cp .env.example .env          # tweak WEB_PORT, BG_MODEL, etc.
docker compose up --build     # first build downloads the model (~1 GB)
# → open http://localhost:8080
```

- **Front-end** is built into an `nginx` image ([deploy/Dockerfile.web](deploy/Dockerfile.web)) —
  only `index.html`, `pdf-editor.html`, `css/`, `js/` ship; backend source/docs never do.
- **Backend** runs as a **non-root** user, loads the model once at startup, runs
  inference **off the event loop** in a worker thread, **caps concurrency**
  (`MAX_CONCURRENCY`), and exposes `/health` (liveness) + `/ready` (readiness)
  for health checks / k8s probes.
- **Front-end → API** is the same-origin path `/api/remove-bg` (set in
  [index.html](index.html)). If the API is down, the tool transparently falls
  back to the in-browser models.

Behind a public domain, terminate TLS at your load balancer / an ingress in
front of nginx, and set `CORS_ORIGINS` to your domain. To scale, run more
`backend` replicas behind the proxy (each holds its own model copy in RAM).

For running the background service on its own (without Docker), see
[backend/README.md](backend/README.md).

## Notes & limits

- **Background replacement** has a graceful quality ladder:
  1. **Self-hosted server** (best — BiRefNet, see [backend/](backend/)) when a
     server URL is configured and reachable;
  2. **In-browser hybrid** otherwise — [ISNet matting](https://github.com/danielgatis/rembg)
     for crisp edges + [MediaPipe Selfie Segmentation](https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/)
     to keep the whole body, then largest-component cleanup + erode/feather;
  3. **Edge flood-fill** as a last resort if no model loads.
  The cutout is cached, so changing the background colour or the sliders is
  instant. Models load from a CDN on first use; once a server is configured the
  large in-browser model is never downloaded.
- Specs are sensible defaults for common documents — always confirm exact
  requirements with the issuing authority before submitting.

## Customizing

Add or edit document specs in [js/presets.js](js/presets.js). Each entry takes a
physical size (`widthMM`/`heightMM`) plus either an explicit pixel size (`px`) or
a `dpi`, an optional recommended background colour (`bg`), and head-height guide
percentages (`head`).
