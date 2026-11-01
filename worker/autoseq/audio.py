"""Loading, hashing and small signal helpers shared by every stage."""
import hashlib
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from . import config


def file_hash(path, length=16):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:length]


def to_wav(src, dst):
    """Transcode anything ffmpeg can read (mp3/m4a/mp4/flac...) to 44.1k stereo WAV."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-ac", "2", "-ar", str(config.SAMPLE_RATE), str(dst)],
        check=True,
    )
    return Path(dst)


def load_mono(path, sr=config.SAMPLE_RATE):
    """Mono float32 at `sr`. Uses soundfile for WAV, ffmpeg for everything else."""
    path = Path(path)
    if path.suffix.lower() != ".wav":
        with tempfile.TemporaryDirectory() as td:
            return load_mono(to_wav(path, Path(td) / "a.wav"), sr)
    y, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if file_sr != sr:
        import librosa
        y = librosa.resample(y, orig_sr=file_sr, target_sr=sr)
    return y


def rms(y):
    return float(np.sqrt(np.mean(np.square(y)))) if len(y) else 0.0


def frame_rms(y, sr, hop_s=0.01, win_s=0.03):
    hop, win = int(sr * hop_s), int(sr * win_s)
    if len(y) < win:
        return np.zeros(1, dtype=np.float32)
    n = 1 + (len(y) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    return np.sqrt(np.mean(np.square(y[idx]), axis=1)).astype(np.float32)
