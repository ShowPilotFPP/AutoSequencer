"""Settings, overridable with AUTOSEQ_* environment variables."""
import os
from pathlib import Path


def _env(name, default, cast=str):
    v = os.environ.get(f"AUTOSEQ_{name}")
    return cast(v) if v not in (None, "") else default


DATA_DIR = Path(_env("DATA_DIR", str(Path(__file__).resolve().parents[2] / "data" / "analysis"))).expanduser().resolve()
JOBS_DIR = DATA_DIR / "jobs"            # one folder per song hash: stems, analysis.json, .xtiming
MODELS_DIR = Path(_env("MODELS_DIR", str(Path(__file__).resolve().parents[1] / "models"))).expanduser().resolve()

# DrumSep (inagoy/drumsep): a Demucs model that splits a drum stem into kick /
# snare / cymbals / toms. Downloaded once from Google Drive by setup or on first use.
DRUMSEP_GDRIVE_ID = _env("DRUMSEP_GDRIVE_ID", "1-Dm666ScPkg8Gt2-lK3Ua0xOudWHZBGC")
DRUMSEP = _env("DRUMSEP", 1, int)        # 0 = skip the kit split, detect from the drum stem alone

# Stems kept after a song is analyzed. Each stem is ~35 MB per 3-minute song.
# "vocals" keeps what lyric re-runs need; "all" keeps everything (a full re-run
# then skips Demucs); "none" keeps nothing.
KEEP_STEMS = _env("KEEP_STEMS", "vocals")

SAMPLE_RATE = 44100                      # working rate for everything
DEMUCS_MODEL = _env("DEMUCS_MODEL", "htdemucs_6s")   # drums bass guitar piano vocals other
DEVICE = _env("DEVICE", "auto")          # auto | mps | cuda | cpu
FRAME_MS = _env("FRAME_MS", 25, int)     # xLights frame size marks are snapped to (25 = 40fps, 50 = 20fps)

WHISPER_MODEL = _env("WHISPER_MODEL", "large-v3-turbo")
WHISPER_THREADS = _env("WHISPER_THREADS", 0, int)     # 0 = all cores
RHUBARB_BIN = _env("RHUBARB_BIN", "rhubarb")         # path to Rhubarb Lip Sync binary (optional)

# A stem must carry at least this share of the mix's energy before we
# transcribe it. Demucs always returns all six stems; an "empty" piano stem is
# just separation noise and turns into thousands of phantom notes.
STEM_MIN_SHARE = _env("STEM_MIN_SHARE", 0.02, float)

# Note transcription per instrument (basic-pitch). Off by default: the sequencer
# doesn't use note tracks yet, and it costs about a minute per song.
NOTES = _env("NOTES", 0, int)
# Demucs segment overlap. 0.25 is Demucs' default; 0.1 is ~15% faster with
# barely audible difference in the stems.
DEMUCS_OVERLAP = _env("DEMUCS_OVERLAP", 0.1, float)

# Forced alignment (torchaudio MMS_FA) re-times every lyric word against the vocal
# stem. A line keeps its earlier timing when the aligner's average letter
# confidence is below ALIGN_MIN_SCORE.
FORCED_ALIGN = _env("FORCED_ALIGN", 1, int)
ALIGN_MIN_SCORE = _env("ALIGN_MIN_SCORE", 0.1, float)

PORT = _env("PORT", 5051, int)
HOST = _env("HOST", "127.0.0.1")       # only the Node app talks to the worker

JOBS_DIR.mkdir(parents=True, exist_ok=True)


def torch_device():
    if DEVICE != "auto":
        return DEVICE
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"
