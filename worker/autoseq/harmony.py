"""Key and chords from the harmonic stem mix (drums out, vocals down).

Chords are beat-synchronous: one chroma vector per beat, matched against 24
major/minor templates, smoothed with a Viterbi pass so a chord only changes
when the evidence for the new one holds up.
"""
import numpy as np
import librosa

NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MAJ_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
SR = 22050
HOP = 2048


def harmonic_mix(stems, load):
    """Sum of the pitched stems with the vocal pulled down (vocals smear chroma)."""
    weights = {"bass": 1.0, "guitar": 1.0, "piano": 1.0, "other": 1.0, "vocals": 0.3}
    mix = None
    for name, w in weights.items():
        if name in stems:
            y = load(stems[name], SR) * w
            mix = y if mix is None else mix[:len(y)] + y[:len(mix)]
    return mix


def analyze(y_harm, beats, duration, log=print):
    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=SR, hop_length=HOP)
    profile = chroma.sum(axis=1)

    if len(beats) < 4:
        log("chords: too few beats to place chords")
        return _key(profile, []), []
    bounds = np.concatenate([[0.0], beats, [duration]])
    frames = librosa.time_to_frames(bounds, sr=SR, hop_length=HOP)
    frames = np.clip(frames, 0, chroma.shape[1] - 1)
    sync = librosa.util.sync(chroma, frames, aggregate=np.median)       # one column per beat-span
    labels = _viterbi(sync)

    chords, start_i = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[start_i]:
            lab = labels[start_i]
            if lab is not None:
                root, q = lab
                if _power(sync[:, start_i:i].mean(axis=1), root):
                    q = "5"
                chords.append({
                    "start": round(float(bounds[start_i]), 4),
                    "end": round(float(bounds[min(i, len(bounds) - 1)]), 4),
                    "name": NAMES[root] + {"maj": "", "min": "m", "5": "5"}[q],
                    "root": root, "quality": q,
                })
            start_i = i
    key = _key(profile, chords)
    for c in chords:
        c["degree"] = _degree(c["root"], c["quality"], key)
    log(f"chords: key {key['name']} · {len(chords)} chord changes · "
        f"{len({c['name'] for c in chords})} distinct")
    return key, chords


def _key(profile, chords):
    """Key = the scale the chords actually live in, with the chroma profile as a tie-breaker.

    Chroma alone (Krumhansl) is easily pulled to the relative/dominant key by a
    loud guitar; chord roots + qualities are much harder to fool.
    """
    fits = {"maj": {0: "maj", 2: "min", 4: "min", 5: "maj", 7: "maj", 9: "min"},
            "min": {0: "min", 3: "maj", 5: "min", 7: "any", 8: "maj", 10: "maj"}}
    total = sum(c["end"] - c["start"] for c in chords) or 1
    best, best_score = None, -1e9
    for r in range(12):
        for mode, prof in (("maj", MAJ_PROFILE), ("min", MIN_PROFILE)):
            ks = np.corrcoef(np.roll(prof, r), profile)[0, 1]
            sc = 0.0
            for c in chords:
                d = (c["end"] - c["start"]) / total
                iv = (c["root"] - r) % 12
                want = fits[mode].get(iv)
                if want is None:
                    sc -= 0.5 * d
                elif c["quality"] == "5" or want == "any" or want == c["quality"]:
                    sc += d * (1.5 if iv == 0 else 1.0)       # tonic chords count extra
                else:
                    sc += 0.3 * d
            # songs usually start or end on home: small nudge for relative-key ties
            ends = [chords[0], chords[-1]] if chords else []
            sc += sum(0.15 for c in ends if c["root"] == r)
            score = sc + 0.5 * ks
            if score > best_score:
                best, best_score = (r, mode), score
    r, mode = best
    return {"root": r, "mode": mode, "name": NAMES[r] + (" minor" if mode == "min" else " major")}


def _templates():
    """24 major/minor triad templates (power chords are decided afterwards, see _power)."""
    T, labs = [], []
    for r in range(12):
        for q, iv in (("maj", (0, 4, 7)), ("min", (0, 3, 7))):
            v = np.zeros(12)
            v[[(r + i) % 12 for i in iv]] = 1
            v[r] += 0.5                       # root a bit heavier
            T.append(v / np.linalg.norm(v))
            labs.append((r, q))
    return np.array(T), labs


def _power(seg_chroma, root, third_ratio=0.4):
    """Distorted guitars mostly play power chords (root + fifth, no third).

    A triad template still finds the right ROOT on those, but has to guess
    major vs minor. If neither third is anywhere near as strong as the fifth,
    call it a power chord instead of inventing a quality.
    """
    c = seg_chroma / (seg_chroma.max() or 1)
    fifth = c[(root + 7) % 12]
    third = max(c[(root + 3) % 12], c[(root + 4) % 12])
    return fifth > 0.3 and third < third_ratio * fifth


def _viterbi(sync, p_stay=0.9, beta=12.0, no_chord_energy=0.02):
    T, labs = _templates()
    energy = sync.sum(axis=0)
    norm = sync / (np.linalg.norm(sync, axis=0, keepdims=True) + 1e-9)
    sim = T @ norm                                     # (24, n_beats)
    logp = beta * sim
    logp -= np.logaddexp.reduce(logp, axis=0, keepdims=True)
    n = len(labs)
    trans = np.full((n, n), np.log((1 - p_stay) / (n - 1)))
    np.fill_diagonal(trans, np.log(p_stay))
    score = logp[:, 0].copy()
    back = np.zeros((n, sync.shape[1]), dtype=int)
    for t in range(1, sync.shape[1]):
        cand = score[:, None] + trans
        back[:, t] = np.argmax(cand, axis=0)
        score = cand[back[:, t], np.arange(n)] + logp[:, t]
    path = [int(np.argmax(score))]
    for t in range(sync.shape[1] - 1, 0, -1):
        path.append(back[path[-1], t])
    path.reverse()
    quiet = energy < no_chord_energy * (np.percentile(energy, 90) or 1)
    return [None if quiet[i] else labs[p] for i, p in enumerate(path)]


def _degree(root, q, key):  # noqa: ARG001
    """1-7 scale degree of the chord root relative to the key (0 = outside the scale)."""
    scale = [0, 2, 4, 5, 7, 9, 11] if key["mode"] == "maj" else [0, 2, 3, 5, 7, 8, 10]
    iv = (root - key["root"]) % 12
    return scale.index(iv) + 1 if iv in scale else 0
