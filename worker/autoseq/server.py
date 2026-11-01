"""Analysis worker API — called by the Node app on the same machine, never by a browser.

    POST /analyze   {"path": "/abs/song.mp3", "lyrics": "...", "separate": true, "force": false}
                    → {"job_id": "..."}
    GET  /jobs/{id} → status, stage, pct, log, result_dir
    GET  /health

Binds to 127.0.0.1 by default. Jobs run one at a time.
"""
import queue
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import config, pipeline

app = FastAPI(title="AutoSeq worker")
JOBS = {}
WORK = queue.Queue()


class AnalyzeReq(BaseModel):
    path: str
    lyrics: str | None = None
    separate: bool = True
    force: bool = False
    mode: str = "full"          # "full" | "lyrics" (redo only the lyrics on the saved vocal stem)
    title: str | None = None    # song title for the published-lyrics lookup


def _worker():
    while True:
        jid = WORK.get()
        j = JOBS[jid]
        j["status"] = "running"

        def log(msg, j=j):
            j["log"].append(f"{time.strftime('%H:%M:%S')}  {msg}")
            print(f"[{jid}] {msg}", flush=True)

        def progress(stage, pct, j=j):
            j["stage"], j["pct"] = stage, pct

        try:
            if j["mode"] == "lyrics":
                result, job_dir = pipeline.redo_lyrics(j["path"], lyrics_text=j["lyrics"], log=log, progress=progress,
                                                     title=j.get("title"))
            else:
                result, job_dir = pipeline.analyze(j["path"], lyrics_text=j["lyrics"], do_separate=j["separate"],
                                                   force=j["force"], log=log, progress=progress,
                                                   title=j.get("title"))
            j.update(status="done", stage="done", pct=100, songHash=result["songId"], resultDir=str(job_dir),
                     summary={"bpm": result["bpm"], "tempoBand": result["tempoBand"],
                              "duration": result["duration"], "key": result["key"]["name"],
                              "sections": [s["type"] for s in result["sections"]],
                              "words": len(result["words"])})
        except Exception as e:
            log(f"FAILED: {e.__class__.__name__}: {e}")
            j["status"] = "error"


threading.Thread(target=_worker, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True, "device": config.torch_device(), "queued": WORK.qsize(),
            "running": sum(1 for j in JOBS.values() if j["status"] == "running")}


@app.post("/analyze")
def analyze(req: AnalyzeReq):
    if not Path(req.path).is_file():
        raise HTTPException(400, f"file not found: {req.path}")
    jid = uuid.uuid4().hex[:10]
    JOBS[jid] = {"id": jid, "path": req.path, "lyrics": (req.lyrics or "").strip() or None,
                 "separate": req.separate, "force": req.force, "mode": req.mode, "title": req.title,
                 "status": "queued", "stage": "queued", "pct": 0, "log": []}
    WORK.put(jid)
    return {"job_id": jid}


@app.get("/jobs/{jid}")
def job(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "unknown job (worker restarted?)")
    return {k: v for k, v in j.items() if k not in ("lyrics",)}
