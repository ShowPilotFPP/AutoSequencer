"""Stage 1 — stem separation with Demucs (htdemucs_6s by default).

Runs Demucs as a subprocess so a crash or OOM inside torch can't take the
service down with it, and falls back to CPU if MPS/CUDA fails (some Demucs
ops are still flaky on MPS).
"""
import shutil
import subprocess
import sys
from pathlib import Path

from . import config

STEMS_6 = ["drums", "bass", "guitar", "piano", "vocals", "other"]


def separate(wav_path, job_dir, log=print):
    out_dir = Path(job_dir) / "stems"
    if out_dir.exists() and all((out_dir / f"{s}.wav").exists() for s in _expected()):
        log("stems: cached")
        return {s: out_dir / f"{s}.wav" for s in _expected()}

    tmp = Path(job_dir) / "_demucs"
    device = config.torch_device()
    for dev in dict.fromkeys([device, "cpu"]):          # try preferred device, then CPU
        log(f"stems: running Demucs {config.DEMUCS_MODEL} on {dev}")
        cmd = [sys.executable, "-m", "demucs", "-n", config.DEMUCS_MODEL,
               "-d", dev, "--overlap", str(config.DEMUCS_OVERLAP), "-o", str(tmp), str(wav_path)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            break
        # keep the whole output; the UI only gets the line that actually explains it
        logfile = Path(job_dir) / f"demucs-{dev}.log"
        logfile.write_text(f"$ {' '.join(cmd)}\n\n--- stdout\n{r.stdout}\n--- stderr\n{r.stderr}")
        log(f"stems: Demucs failed on {dev}: {_real_error(r.stderr)}  (full output: {logfile})")
    else:
        raise RuntimeError("Demucs failed on every device")

    produced = next((tmp / config.DEMUCS_MODEL).iterdir())  # <model>/<track name>/
    out_dir.mkdir(parents=True, exist_ok=True)
    stems = {}
    for f in produced.glob("*.wav"):
        dest = out_dir / f.name
        shutil.move(str(f), dest)
        stems[f.stem] = dest
    shutil.rmtree(tmp, ignore_errors=True)
    log(f"stems: {', '.join(sorted(stems))}")
    return stems


def _real_error(stderr):
    """Last meaningful line: skip progress bars and library warnings (e.g. the HF Hub notice)."""
    lines = [l.strip() for l in stderr.splitlines() if l.strip()]
    noise = ("warning", "warn(", "it/s", "s/it", "%|", "seconds/s", "hf_token", "hf hub")
    useful = [l for l in lines if not any(n in l.lower() for n in noise)]
    return (useful or lines or ["no error output"])[-1][:300]


def _expected():
    return STEMS_6 if config.DEMUCS_MODEL.endswith("6s") else ["drums", "bass", "vocals", "other"]
