"""Second separation pass: split the drum stem into kick / snare / cymbals / toms.

Uses DrumSep (github.com/inagoy/drumsep), a Demucs-format model, so it runs
through the Demucs that's already installed. With a clean kick and a clean
snare signal, detection stops confusing guitar bleed and fills for drums —
which is exactly what wrecked the snare track on dense, distorted mixes.

If the model isn't available the pipeline falls back to the band-energy
detector on the plain drum stem.
"""
import shutil
import subprocess
import sys
from pathlib import Path

from . import config

NAMES = {"bombo": "kick", "kick": "kick", "redoblante": "snare", "snare": "snare",
         "platillos": "cymbals", "cymbals": "cymbals", "hihat": "cymbals", "toms": "toms", "tom": "toms"}
KIT = ["kick", "snare", "cymbals", "toms"]


def model_dir():
    return config.MODELS_DIR / "drumsep"


def ensure_model(log=print):
    """Return the model signature (file stem of the .th), downloading it if needed."""
    d = model_dir()
    found = sorted(d.glob("*.th")) if d.exists() else []
    if found:
        return found[0].stem
    d.mkdir(parents=True, exist_ok=True)
    log("kit: downloading DrumSep model (~170 MB, once)")
    try:
        import gdown
        out = d / "drumsep.download"
        gdown.download(id=config.DRUMSEP_GDRIVE_ID, output=str(out), quiet=True)
        # Demucs loads a local model by signature = file name; DrumSep ships as 49469ca8.th
        out.rename(d / "49469ca8.th")
        return "49469ca8"
    except Exception as e:
        log(f"kit: couldn't download DrumSep ({e.__class__.__name__}: {e}) — "
            f"put the .th file in {d} by hand, or set AUTOSEQ_DRUMSEP=0")
        for f in d.glob("*.download"):
            f.unlink(missing_ok=True)
        return None


def separate_kit(drum_wav, job_dir, log=print):
    """Return {"kick": Path, "snare": Path, "cymbals": Path, "toms": Path} or None."""
    if not config.DRUMSEP:
        return None
    out_dir = Path(job_dir) / "stems"
    cached = {k: out_dir / f"kit_{k}.wav" for k in KIT}
    if all(p.exists() for p in cached.values()):
        log("kit: cached")
        return cached
    sig = ensure_model(log)
    if not sig:
        return None

    tmp = Path(job_dir) / "_drumsep"
    for dev in dict.fromkeys([config.torch_device(), "cpu"]):
        log(f"kit: splitting the drums with DrumSep on {dev}")
        cmd = [sys.executable, "-m", "demucs", "--repo", str(model_dir()), "-n", sig,
               "-d", dev, "--overlap", str(config.DEMUCS_OVERLAP), "-o", str(tmp), str(drum_wav)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            break
        (Path(job_dir) / f"drumsep-{dev}.log").write_text(r.stdout + "\n" + r.stderr)
        log(f"kit: DrumSep failed on {dev} (exit {r.returncode}) — see drumsep-{dev}.log")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
        return None

    produced = next((tmp / sig).iterdir())
    got = {}
    for f in produced.glob("*.wav"):
        name = NAMES.get(f.stem.lower())
        if name:
            dest = out_dir / f"kit_{name}.wav"
            shutil.move(str(f), dest)
            got[name] = dest
    shutil.rmtree(tmp, ignore_errors=True)
    if not {"kick", "snare"} <= set(got):
        log(f"kit: DrumSep produced {sorted(got)} — expected kick and snare; falling back")
        return None
    log(f"kit: {', '.join(sorted(got))}")
    return got
