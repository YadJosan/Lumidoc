"""
Lumidoc — background-removal microservice.

Runs a high-quality open matting model (BiRefNet by default, via `rembg`) and
returns a PNG cutout with a transparent background. The browser tool POSTs the
cropped photo here and composites the result onto the chosen background colour
locally (so colour changes stay instant).

Production notes:
  * The model call is CPU-heavy and blocking, so it runs in a worker thread
    (never on the event loop) and is gated by a concurrency semaphore.
  * The model is loaded once at startup (lifespan); /health is liveness and
    /ready reports model readiness for orchestrators.
  * Configuration is environment-driven (see the constants below).
"""
import asyncio
import io
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError
from rembg import new_session, remove
from starlette.concurrency import run_in_threadpool

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("lumidoc")

# ── Configuration (environment-driven) ──────────────────────────────────────
# Model options: birefnet-general (best general), birefnet-portrait (people/ID
# photos), isnet-general-use (lighter/faster, ~170 MB).
MODEL = os.environ.get("BG_MODEL", "birefnet-general")
ALPHA_MATTING = os.environ.get("ALPHA_MATTING", "1") not in ("0", "false", "False")
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
MAX_CONCURRENCY = max(1, int(os.environ.get("MAX_CONCURRENCY", "2")))

_state = {"session": None, "sem": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log.info("loading model '%s' (alpha_matting=%s)…", MODEL, ALPHA_MATTING)
    _state["session"] = await run_in_threadpool(new_session, MODEL)
    _state["sem"] = asyncio.Semaphore(MAX_CONCURRENCY)
    log.info("model ready (max_concurrency=%d, max_upload=%d bytes)", MAX_CONCURRENCY, MAX_BYTES)
    yield
    log.info("shutting down")


app = FastAPI(title="Lumidoc — BG Remover", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """Liveness: the process is up."""
    return {"status": "ok"}


@app.get("/ready")
def ready():
    """Readiness: the model is loaded and we can serve requests."""
    if _state["session"] is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {"status": "ready", "model": MODEL, "alpha_matting": ALPHA_MATTING}


def _process(data: bytes) -> bytes:
    """Blocking model inference — always called inside a worker thread."""
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    out = remove(
        img,
        session=_state["session"],
        alpha_matting=ALPHA_MATTING,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=10,
        alpha_matting_erode_size=5,
        post_process_mask=True,
    )
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


@app.post("/remove-bg")
async def remove_bg(file: UploadFile = File(...)):
    if _state["session"] is None:
        raise HTTPException(status_code=503, detail="model still loading, retry shortly")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    async with _state["sem"]:                       # cap concurrent inferences
        try:
            png = await run_in_threadpool(_process, data)
        except UnidentifiedImageError:
            raise HTTPException(status_code=400, detail="could not read image")
        except Exception:
            log.exception("inference failed")
            raise HTTPException(status_code=500, detail="background removal failed")

    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})
