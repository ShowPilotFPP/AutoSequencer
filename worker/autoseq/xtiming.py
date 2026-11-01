"""Write analysis results as xLights timing tracks (.xtiming).

One file holds every track (<timings> root); xLights' "Import Timing Track"
offers each one by name. `split=True` also writes one file per track for older
xLights builds that only accept a single <timing> root.

xLights wants integer milliseconds, snapped to the sequence frame, with no
overlap inside a layer and start < end — every mark is cleaned to that here.
"""
from pathlib import Path
from xml.sax.saxutils import quoteattr

from . import config


def build_tracks(a):
    """Map an analysis dict to {track name: [layers]} where a layer is [(start, end, label)]."""
    dur = a["duration"]
    T = {}
    T["AutoSeq Beats"] = [_points([b for b in a["beats"]], dur, labels=_beat_numbers(a))]
    T["AutoSeq Downbeats"] = [_points(a["downbeats"], dur)]
    T["AutoSeq Sections"] = [[(s["start"], s["end"], s["type"].upper()) for s in a["sections"]]]
    if a.get("chords"):
        T["AutoSeq Chords"] = [[(c["start"], c["end"], c["name"]) for c in a["chords"]]]
    for name in ("kick", "snare", "toms", "hihat", "crash"):
        hits = a.get("drums", {}).get(name)
        if hits:
            T[f"AutoSeq {name.capitalize()}"] = [_points([h["time"] for h in hits], dur, hold=0.25)]
    for name, hits in a.get("noteHits", {}).items():
        if hits:
            T[f"AutoSeq {name.capitalize()} Notes"] = [_points([h["time"] for h in hits], dur, hold=0.4)]
    if a.get("words"):
        T["AutoSeq Lyrics"] = [
            [(p["start"], p["end"], p["text"]) for p in a.get("phrases", [])],
            [(w["start"], w["end"], w["text"]) for w in a["words"]],
            [(p["start"], p["end"], p["text"]) for p in a.get("phonemes", [])],
        ]
    return T


def write(analysis, path, split=False):
    tracks = build_tracks(analysis)
    path = Path(path)
    parts = ['<?xml version="1.0" encoding="UTF-8"?>', "<timings>"]
    for name, layers in tracks.items():
        parts.append(_timing_xml(name, layers, indent="    "))
    parts.append("</timings>")
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")
    written = [path]
    if split:
        d = path.with_suffix("")
        d.mkdir(exist_ok=True)
        for name, layers in tracks.items():
            f = d / (name.replace(" ", "_") + ".xtiming")
            f.write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + _timing_xml(name, layers) + "\n",
                         encoding="utf-8")
            written.append(f)
    return written, list(tracks)


# ---------------------------------------------------------------- helpers

def _beat_numbers(a):
    """Label each beat 1-4 counted from the nearest preceding downbeat."""
    db = sorted(a["downbeats"])
    labels, j, count = [], -1, 0
    for b in a["beats"]:
        while j + 1 < len(db) and db[j + 1] <= b + 0.03:
            j, count = j + 1, 0
        count += 1
        labels.append(str(count))
    return labels


def _points(times, dur, hold=None, labels=None):
    """Point events → marks that run to the next event (capped at `hold` seconds)."""
    times = sorted(times)
    out = []
    for i, t in enumerate(times):
        nxt = times[i + 1] if i + 1 < len(times) else dur
        end = min(nxt, t + hold) if hold else nxt
        out.append((t, end, labels[i] if labels else ""))
    return out


def _clean(layer):
    f = config.FRAME_MS
    out, last_end = [], 0
    for s, e, lab in sorted(layer, key=lambda x: x[0]):
        s = max(int(round(s * 1000 / f)) * f, last_end)
        e = int(round(e * 1000 / f)) * f
        if e <= s:
            e = s + f
        out.append((s, e, lab))
        last_end = e
    return out


def _timing_xml(name, layers, indent=""):
    i1, i2, i3 = indent + "    ", indent + "        ", indent + "            "
    rows = [f'{indent}<timing name={quoteattr(name)} SourceVersion="2024.01">']
    for layer in layers:
        rows.append(f"{i1}<EffectLayer>")
        rows += [f'{i2}<Effect label={quoteattr(str(lab))} starttime="{s}" endtime="{e}" />'
                 for s, e, lab in _clean(layer)]
        rows.append(f"{i1}</EffectLayer>")
    rows.append(f"{indent}</timing>")
    return "\n".join(rows).replace(i3, i2)
