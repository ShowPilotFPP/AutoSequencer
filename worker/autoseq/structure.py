"""Song structure: sections, energy curve, tempo band, silent tail.

Sections are found per BAR (downbeat to downbeat) from three kinds of feature:
harmony (chroma), timbre (MFCC) and which instruments are playing (stem RMS).
A checkerboard novelty curve over the bar self-similarity matrix gives the
boundaries; repeated segments are clustered and then named by simple rules
(loudest repeated group = chorus, vocal repeated group = verse, ...).
"""
import numpy as np
import librosa

from . import audio

SR = 22050
STEM_ORDER = ["drums", "bass", "guitar", "piano", "vocals", "other"]


def analyze(y_mix, stems_mono, downbeats, beats, drum_hits, bpm, duration, log=print):
    off_start = _silent_tail(y_mix, SR, duration)
    bars = _bars(downbeats, beats, min(duration, off_start or duration))
    if len(bars) < 6:
        sections = [{"start": 0.0, "end": round(duration, 3), "type": "verse", "group": "A", "energy": 0.5}]
    else:
        feats, bar_energy, vocal_on = _bar_features(y_mix, stems_mono, bars)
        cuts = _boundaries(feats, vocal_on)
        sections = _label(bars, cuts, feats, bar_energy, vocal_on)
    if off_start and off_start < duration - 1.0:
        sections[-1]["end"] = round(off_start, 3)
        sections.append({"start": round(off_start, 3), "end": round(duration, 3),
                         "type": "off", "group": "-", "energy": 0.0})

    energy = _energy_curve(y_mix, beats, duration)
    band, why = _tempo_band(bpm, drum_hits, beats)
    log("sections: " + " ".join(f"{s['type']}({s['group']})" for s in sections))
    log(f"tempo band: {band} — {why}")
    return {"sections": sections, "energy": energy, "tempoBand": band, "tempoBandWhy": why,
            "offStart": round(off_start, 3) if off_start else None}


# ---------------------------------------------------------------- bars & features

def _bars(downbeats, beats, end):
    db = [d for d in downbeats if d < end - 0.5]
    if len(db) < 2 and len(beats) >= 8:
        db = list(beats[::4])
    if not db:
        return []
    starts = ([0.0] if db[0] > 0.5 else []) + list(db)
    if len(db) > 2 and db[0] > 0.5:          # don't let a pickup become one giant first "bar"
        bar = float(np.median(np.diff(db)))
        pre = list(np.arange(db[0] - bar, 0.2, -bar)[::-1])
        starts = ([0.0] if not pre or pre[0] > 0.2 else []) + pre + list(db)
    return [(s, e) for s, e in zip(starts, starts[1:] + [end]) if e - s > 0.2]


def _bar_features(y, stems_mono, bars):
    hop = 512
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=y, sr=SR, n_mfcc=13, hop_length=hop)
    feats, energy, vocal = [], [], []
    vocal_y = stems_mono.get("vocals")
    vocal_ref = np.percentile(audio.frame_rms(vocal_y, SR), 90) if vocal_y is not None else 0
    for s, e in bars:
        a, b = librosa.time_to_frames([s, e], sr=SR, hop_length=hop)
        b = max(b, a + 1)
        c = chroma[:, a:b].mean(axis=1)
        m = mfcc[1:, a:b].mean(axis=1)
        i0, i1 = int(s * SR), int(e * SR)
        st = np.array([audio.rms(stems_mono[n][i0:i1]) if n in stems_mono else 0.0 for n in STEM_ORDER])
        feats.append(np.concatenate([c / (c.sum() or 1), m, st]))
        energy.append(audio.rms(y[i0:i1]))
        v = audio.rms(stems_mono["vocals"][i0:i1]) if vocal_y is not None else 0.0
        # relative to its own peak AND to the mix, so a silent stem's noise never counts as singing
        vocal.append(v > 0.25 * vocal_ref and v > 0.08 * energy[-1])
    F = np.array(feats)
    H = F[:, :24]
    # standardise harmony/timbre, but floor the spread: a dimension that barely
    # moves would otherwise turn noise into "difference"
    sd = H.std(axis=0)
    H = (H - H.mean(axis=0)) / np.maximum(sd, 0.1 * np.median(sd) + 1e-9)
    # stems as each instrument's share of its loudest bar — silent stems stay ~0
    St = F[:, 24:] / (F[:, 24:].max() or 1)
    # weights: harmony, timbre, instrumentation — instrumentation matters most for lights
    F = np.hstack([H[:, :12] * 0.6, H[:, 12:] * 0.8, St * 6.0])
    E = np.array(energy)
    return F, E / (E.max() or 1), np.array(vocal)


def _boundaries(F, vocal_on, kernel=4, min_len=4):
    n = len(F)
    norm = F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-9)
    ssm = norm @ norm.T
    k = kernel
    sign = np.block([[np.ones((k, k)), -np.ones((k, k))], [-np.ones((k, k)), np.ones((k, k))]])
    nov = np.zeros(n)
    for i in range(k, n - k):
        nov[i] = (ssm[i - k:i + k, i - k:i + k] * sign).sum()
    # vocals coming in or dropping out is almost always a section edge
    for i in range(1, n):
        if vocal_on[i] != vocal_on[i - 1]:
            nov[i] += 0.5 * (nov.max() or 1)
    cuts, order = [0], np.argsort(-nov)
    thr = np.percentile(nov[nov > 0], 60) if (nov > 0).any() else 0
    for i in order:
        if nov[i] <= thr:
            break
        if all(abs(i - c) >= min_len for c in cuts) and n - i >= min_len // 2:
            cuts.append(int(i))
    return sorted(cuts)


def _label(bars, cuts, F, bar_energy, vocal_on):
    from scipy.cluster.hierarchy import fcluster, linkage
    segs = [(a, b) for a, b in zip(cuts, cuts[1:] + [len(bars)])]
    seg_f = np.array([F[a:b].mean(axis=0) for a, b in segs])
    seg_e = np.array([bar_energy[a:b].mean() for a, b in segs])
    seg_v = np.array([vocal_on[a:b].mean() for a, b in segs])

    if len(segs) > 1:
        from scipy.spatial.distance import pdist
        d = pdist(seg_f, "euclidean")
        Z = linkage(d, "average")
        groups = fcluster(Z, t=0.6 * np.median(d), criterion="distance")
    else:
        groups = np.array([1])
    letters = {}
    names = [letters.setdefault(g, chr(65 + len(letters))) for g in groups]

    count = {g: list(groups).count(g) for g in set(groups)}
    gen = {g: seg_e[groups == g].mean() for g in set(groups)}
    gvoc = {g: seg_v[groups == g].mean() for g in set(groups)}
    repeated = [g for g in count if count[g] >= 2]
    chorus = max(repeated, key=lambda g: gen[g]) if repeated else None
    sung = vocal_on.mean() > 0.15                    # instrumentals can't use vocals to find verses
    verse_c = [g for g in repeated if g != chorus and (gvoc[g] > 0.4 or not sung)]
    verse = max(verse_c, key=lambda g: count[g]) if verse_c else None

    types = []
    last = len(groups) - 1
    for i, g in enumerate(groups):
        a, b = segs[i]
        if g == chorus:
            t = "chorus"
        elif i == 0 and last > 0 and (count[g] == 1 or seg_e[i] < 0.6 * seg_e.max() or (sung and seg_v[i] < 0.4)):
            t = "intro"
        elif i == last and last > 1 and (count[g] == 1 or b - a <= 6):
            t = "outro"
        elif g == verse:
            t = "verse"
        elif sung and seg_v[i] < 0.3:
            t = "break"
        elif count[g] == 1 and i > len(groups) / 2:
            t = "bridge"
        else:
            t = "verse"
        types.append(t)
    # a short non-chorus section sitting right before a chorus is a pre-chorus
    for i in range(len(types) - 1):
        a, b = segs[i]
        if types[i + 1] == "chorus" and types[i] in ("verse", "bridge") and b - a <= 4 and groups[i] != verse:
            types[i] = "prechorus"

    return [{"start": round(bars[a][0], 3), "end": round(bars[b - 1][1], 3), "type": t,
             "group": names[i], "energy": round(float(seg_e[i]), 3)}
            for i, ((a, b), t) in enumerate(zip(segs, types))]


# ---------------------------------------------------------------- misc

def _silent_tail(y, sr, duration):
    env = audio.frame_rms(y, sr, hop_s=0.1, win_s=0.2)
    if not len(env):
        return None
    loud = np.where(env > 0.02 * env.max())[0]
    if not len(loud):
        return None
    t = (loud[-1] + 1) * 0.1
    return t if duration - t > 1.5 else None


def _energy_curve(y, beats, duration):
    """0-1 loudness per beat, lightly smoothed — drives brightness/intensity."""
    if len(beats) < 2:
        return []
    edges = list(beats) + [duration]
    vals = np.array([audio.rms(y[int(a * SR):int(b * SR)]) for a, b in zip(edges, edges[1:])])
    vals = np.convolve(vals, np.ones(3) / 3, mode="same")
    vals = vals / (np.percentile(vals, 98) or 1)
    return [{"time": round(float(b), 3), "value": round(float(min(1, v)), 3)} for b, v in zip(beats, vals)]


def _tempo_band(bpm, drum_hits, beats):
    n_beats = max(1, len(beats))
    hits = sum(len(drum_hits.get(k, [])) for k in ("kick", "snare", "hihat", "toms"))
    density = hits / n_beats
    band = "slow" if bpm < 90 else "upbeat" if bpm >= 125 else "medium"
    why = f"{bpm:.0f} BPM, {density:.1f} drum hits per beat"
    if band == "slow" and density > 2.5:
        band, why = "medium", why + " (busy drums lift a slow tempo)"
    elif band == "upbeat" and density < 0.8:
        band, why = "medium", why + " (sparse drums calm a fast tempo)"
    return band, why
