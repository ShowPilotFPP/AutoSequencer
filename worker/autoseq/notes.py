"""Stage 2 — note transcription of the melodic stems with Spotify basic-pitch.

Only stems that actually carry part of the song are transcribed: Demucs always
returns every stem, and a near-silent one is separation noise that would
otherwise become thousands of phantom notes.
"""
import numpy as np

from . import audio, config

MELODIC = ["bass", "guitar", "piano", "other", "vocals"]
# sensible pitch windows per instrument, to throw away bleed from the others
RANGES = {"bass": (28, 67), "guitar": (40, 88), "piano": (21, 108), "other": (21, 108), "vocals": (40, 84)}


def transcribe(stems, mix_rms, log=print, enabled=True):
    if not enabled:
        # still measure how much each stem plays (the lyrics stage uses the vocal share)
        shares = {n: round(audio.rms(audio.load_mono(stems[n], 22050)) / (mix_rms or 1), 4) for n in MELODIC if n in stems}
        log("notes: skipped (AUTOSEQ_NOTES=0) — saves about a minute; the sequencer doesn't use note tracks yet")
        return {}, shares
    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except Exception as e:
        log(f"notes: basic-pitch unavailable ({e}); skipping note tracks")
        return {}, {}

    out, shares = {}, {}
    for name in MELODIC:
        path = stems.get(name)
        if not path:
            continue
        share = audio.rms(audio.load_mono(path, 22050)) / (mix_rms or 1)
        shares[name] = round(share, 4)
        if share < config.STEM_MIN_SHARE:
            log(f"notes: {name} skipped (only {share:.1%} of the mix)")
            continue
        _, _, events = predict(str(path), model_or_model_path=ICASSP_2022_MODEL_PATH,
                               onset_threshold=0.55, frame_threshold=0.3,
                               minimum_note_length=80)
        lo, hi = RANGES[name]
        notes = [
            {"time": round(float(s), 4), "end": round(float(e), 4),
             "pitch": int(p), "velocity": round(float(a), 3)}
            for s, e, p, a, *_ in events if lo <= p <= hi and a >= 0.15
        ]
        notes.sort(key=lambda n: n["time"])
        out[name] = notes
        log(f"notes: {name} {len(notes)} notes ({share:.1%} of mix)")
    return out, shares


def onsets_from_notes(notes, min_gap=0.08):
    """Collapse chords/simultaneous notes into single hit times (for timing tracks)."""
    hits = []
    for n in notes:
        if not hits or n["time"] - hits[-1]["time"] >= min_gap:
            hits.append({"time": n["time"], "velocity": n["velocity"]})
        else:
            hits[-1]["velocity"] = max(hits[-1]["velocity"], n["velocity"])
    return hits
