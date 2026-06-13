# Background-removal server (self-hosted, near remove.bg quality)

A small [FastAPI](https://fastapi.tiangolo.com/) service that runs an open
matting model ([BiRefNet](https://github.com/ZhengPeng7/BiRefNet) via
[`rembg`](https://github.com/danielgatis/rembg)) and returns a PNG cutout with a
transparent background. The photo tool uploads the cropped photo here and
composites the result onto the chosen background colour locally.

## Why this is more accurate than the in-browser version

It runs a much larger model at full resolution on the server, with **alpha
matting** for soft hair-level edges and **colour decontamination** baked into the
model — the things that make remove.bg-class results possible (and that a small
in-browser model can't match).

## Run locally

```bash
cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate     |  macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 7000
```

> Use `python -m uvicorn …` (not bare `uvicorn`) so it works even when the
> Scripts folder isn't on your PATH (common with `pip install --user`).

The first request downloads the model weights (BiRefNet is large, ~1 GB; cached
afterwards). Test it:

```bash
curl -F "file=@some-photo.jpg" http://localhost:7000/remove-bg --output cutout.png
```

## Run with Docker

```bash
cd backend
docker build -t lumidoc-bg .          # downloads model at build time
docker run -p 7000:7000 lumidoc-bg
```

## Point the photo tool at it

The front-end uses the server when `window.BG_SERVER_URL` is set. In
[`../index.html`](../index.html) there is an editable config line near the
bottom — set it to your server:

```html
<script>window.BG_SERVER_URL = "http://localhost:7000/remove-bg";</script>
```

You can also set it at runtime from the browser console without editing files:

```js
localStorage.setItem("bgServerUrl", "http://localhost:7000/remove-bg");
```

If the server is unreachable, the tool automatically falls back to the
in-browser models, so nothing breaks when it's offline.

## Configuration (environment variables)

| Var | Default | Notes |
|-----|---------|-------|
| `BG_MODEL` | `birefnet-general` | Try `birefnet-portrait` (best for people/ID photos) or `isnet-general-use` (lighter/faster, ~170 MB). |
| `ALPHA_MATTING` | `1` | Soft hair-edge refinement. Set `0` for faster CPU-only runs. |
| `MAX_CONCURRENCY` | `2` | Max concurrent model inferences (protects CPU/RAM). |
| `MAX_UPLOAD_BYTES` | `20971520` | Max upload size (20 MB). |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins. Restrict in production. |
| `LOG_LEVEL` | `INFO` | Python log level. |

## Endpoints

- `GET /health` → `{ "status": "ok" }` — **liveness** (process up).
- `GET /ready`  → `{ "status": "ready", "model": ... }` — **readiness** (model loaded; 503 until then).
- `POST /remove-bg` (multipart `file`) → `image/png` (RGBA, transparent background).

## Notes

- **GPU:** for much faster inference, install `onnxruntime-gpu` instead of
  `onnxruntime` and run on a CUDA host.
- **Privacy:** images are processed in memory and not stored. If you host this
  publicly, restrict `CORS_ORIGINS` and put it behind HTTPS/auth.
