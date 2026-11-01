"""Kick / snare / hi-hat / crash hits from the separated drum stem.

Lessons taken straight from autosequencer's changelog:
  * Detect on the DRUM STEM, never the full mix (bass & vocals fake kicks/snares).
  * Don't judge a snare by what else is playing — a backbeat over a kick is the
    most ordinary pattern there is. Judge it by whether it sounds like THIS
    song's snare: learn a spectral profile from the snare hits that occur on
    their own, then keep the candidates that match its shape (not loudness).
  * Crashes: compare the second AFTER a hit with the second BEFORE it, so busy
    hi-hat songs still find them.
"""
import numpy as np
import librosa

HOP = 256
N_FFT = 2048
MIN_GAP = 0.06          # seconds between two hits of the same drum


def detect(drum_y, sr, log=print):
    S = np.abs(librosa.stft(drum_y, n_fft=N_FFT, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    t = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=HOP)
    fps = sr / HOP

    def band(lo, hi):
        # mean, not sum: bands have very different bin counts, and the snare
        # check compares mid against high directly
        return S[(freqs >= lo) & (freqs < hi)].mean(axis=0)

    low, mid, high = band(30, 130), band(180, 4000), band(6000, 16000)

    # a rise in the band is not enough — the band must also be LOUD for that drum,
    # otherwise the broadband snare crack shows up as a quiet "kick"
    kick_idx = _loud(_peaks(_flux(low), fps, rel=0.30), low, fps, rel=0.35)
    hat_idx = _loud(_peaks(_flux(high), fps, rel=0.25), high, fps, rel=0.15)
    broad_idx = _peaks(_flux(S[freqs >= 150].sum(axis=0)), fps, rel=0.15)

    snare_idx = _snares(S, freqs, broad_idx, kick_idx, low, mid, high, fps, log)
    crash_idx = _crashes(high, hat_idx, fps)
    crash_set = set(crash_idx.tolist())
    hat_idx = np.array([i for i in hat_idx if i not in crash_set], dtype=int)

    out = {
        "kick": _hits(kick_idx, low, t),
        "snare": _hits(snare_idx, mid, t),
        "hihat": _hits(hat_idx, high, t),
        "crash": _hits(crash_idx, high, t),
    }
    on_kick = sum(1 for s in snare_idx if np.min(np.abs(kick_idx - s), initial=1e9) < 0.03 * fps)
    log(f"drums: kick {len(out['kick'])} · snare {len(out['snare'])} ({on_kick} on a kick) · "
        f"hihat {len(out['hihat'])} · crash {len(out['crash'])}")
    return out


# ---------------------------------------------------------------- helpers

def _flux(x):
    """Half-wave-rectified log-energy rise — a cheap, sharp onset function."""
    # reference level floored at 1% of the loud end: on a separated stem that is
    # silent most of the time the median is ~0, and the first hit after silence
    # would dwarf every hit that follows it
    ref = max(np.median(x), 0.01 * np.percentile(x, 99.5)) + 1e-9
    lx = np.log1p(x / ref)
    d = np.diff(lx, prepend=lx[0])
    return np.maximum(d, 0)


def _peaks(env, fps, rel):
    """Peaks above `rel` × the local (4 s) maximum and above the global noise floor.

    The local maximum keeps quiet verses from losing every hit to a loud chorus.
    """
    if env.max() <= 0:
        return np.array([], dtype=int)
    from scipy.ndimage import maximum_filter1d
    from scipy.signal import find_peaks
    local_max = maximum_filter1d(env, size=int(4 * fps))
    floor = np.median(env) + 3 * np.median(np.abs(env - np.median(env)))
    idx, _ = find_peaks(env, distance=max(1, int(MIN_GAP * fps)))
    keep = (env[idx] >= rel * local_max[idx]) & (env[idx] > floor)
    return idx[keep]


def _loud(idx, energy, fps, rel):
    """Keep onsets whose band energy (peak of the next 30 ms) reaches `rel` × the local 4 s max."""
    if len(idx) == 0:
        return idx
    from scipy.ndimage import maximum_filter1d
    w = max(1, int(0.03 * fps))
    peak = np.array([energy[i:i + w].max() for i in idx])
    local = maximum_filter1d(energy, size=int(4 * fps))[idx]
    return idx[peak >= rel * local]


def _shape(S, freqs, i, fps):
    """Normalised log spectrum (150 Hz–12 kHz, 32 bands) of the 60 ms after a hit.

    Starting at 150 Hz keeps kick leakage out of the comparison; normalising
    removes loudness so only the timbre is compared.
    """
    seg = S[:, i:i + max(1, int(0.06 * fps))].mean(axis=1)
    edges = np.geomspace(150, 12000, 33)
    v = np.array([seg[(freqs >= a) & (freqs < b)].mean() for a, b in zip(edges[:-1], edges[1:])])
    v = np.log1p(v)
    v -= v.mean()
    n = np.linalg.norm(v)
    return v / n if n else v


def _snares(S, freqs, cand, kick_idx, low, mid, high, fps, log):
    if len(cand) == 0:
        return np.array([], dtype=int)
    near = int(0.03 * fps)
    kick_near = np.array([np.min(np.abs(kick_idx - c), initial=10 ** 9) <= near for c in cand])
    mid_dominant = mid[cand] > 0.6 * high[cand]
    lowish = low[cand] < np.percentile(low[kick_idx], 40) if len(kick_idx) else np.ones(len(cand), bool)

    # unmistakable snares: mid-band hits with no kick and no cymbal on top of them
    clean = cand[(~kick_near) & mid_dominant & lowish]
    if len(clean) < 6:
        log(f"drums: only {len(clean)} isolated snare hits — not enough to learn this song's snare, leaving Snare empty")
        return np.array([], dtype=int)

    shapes = np.array([_shape(S, freqs, i, fps) for i in clean])
    profile = np.median(shapes, axis=0)
    profile /= np.linalg.norm(profile) or 1
    clean_sim = shapes @ profile
    thr = max(0.55, float(np.percentile(clean_sim, 15)) - 0.05)

    cand_sim = np.array([_shape(S, freqs, i, fps) @ profile for i in cand])
    loud_enough = mid[cand] > 0.15 * np.percentile(mid[clean], 75)
    keep = cand[(cand_sim >= thr) & loud_enough]
    log(f"drums: learned snare from {len(clean)} isolated hits (match ≥ {thr:.2f})")
    return keep


def _crashes(high, hat_idx, fps):
    w = int(1.0 * fps)
    out = []
    for i in hat_idx:
        before = high[max(0, i - w):i].mean() if i > 0 else 0
        after = high[i + int(0.05 * fps):i + w].mean() if i + w < len(high) else 0
        if before > 0 and after > 2.2 * before and high[i] > np.percentile(high[hat_idx], 80):
            out.append(i)
    # a crash rings — collapse anything within 1 s into the first one
    merged = []
    for i in out:
        if not merged or i - merged[-1] > w:
            merged.append(i)
    return np.array(merged, dtype=int)


def _hits(idx, energy, t):
    if len(idx) == 0:
        return []
    e = energy[idx]
    v = e / (np.percentile(e, 95) or 1)
    return [{"time": round(float(t[i]), 4), "velocity": round(float(min(1.0, x)), 3)} for i, x in zip(idx, v)]


# ---------------------------------------------------------------- separated kit (DrumSep)

def detect_kit(kit, sr, log=print, beats=None, downbeats=None):
    """Hits from DrumSep's separated kick / snare / cymbals / toms signals.

    Each signal is already one drum, so detection is an onset per stem — plus a
    "does this drum actually own the moment?" check against the others, because
    separation still leaks (the kick thumps faintly in the snare signal, etc.).
    """
    env, flux = {}, {}
    n = None
    for name, y in kit.items():
        # time-domain RMS, not mean spectral magnitude: a kick packs its energy into a
        # few low bins, so a faint broadband snare leak would otherwise look as big as it
        e = librosa.feature.rms(y=y, frame_length=1024, hop_length=HOP)[0]
        n = len(e) if n is None else min(n, len(e))
        env[name], flux[name] = e, _flux(e)
    for k in env:
        env[k], flux[k] = env[k][:n], flux[k][:n]
    fps = sr / HOP
    t = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=HOP)
    w = max(1, int(0.03 * fps))
    # normalise each signal by its TYPICAL hit (90th percentile of onset peaks), not
    # its loudest moment — a handful of huge hits (a crash bleeding in, a big fill)
    # would otherwise push every ordinary hit under the threshold
    norm = {}
    for k in env:
        cand = _peaks(flux[k], fps, rel=0.1)
        vals = np.array([env[k][i:i + w].max() for i in cand]) if len(cand) else env[k]
        norm[k] = env[k] / (np.percentile(vals, 90) or 1)

    def peak(k, i):
        return norm[k][i:i + w].max()

    def owns(k, i, others, ratio):
        mine = peak(k, i)
        return all(mine >= ratio * peak(o, i) for o in others if o in norm)

    out = {}
    if "kick" in env:
        idx = _loud(_peaks(flux["kick"], fps, rel=0.25), env["kick"], fps, rel=0.3)
        out["kick"] = [i for i in idx if peak("kick", i) >= 0.25 and owns("kick", i, ["snare"], 0.35)]
    if "snare" in env:
        idx = _loud(_peaks(flux["snare"], fps, rel=0.25), env["snare"], fps, rel=0.3)
        out["snare"] = [i for i in idx if peak("snare", i) >= 0.4 and owns("snare", i, ["kick"], 0.5)]
    if "cymbals" in env:
        cym = _loud(_peaks(flux["cymbals"], fps, rel=0.2), env["cymbals"], fps, rel=0.15)
        crash = _crashes(env["cymbals"], cym, fps)
        cs = set(crash.tolist())
        out["hihat"] = [i for i in cym if i not in cs]
        out["crash"] = list(crash)
    if "toms" in env:
        # DrumSep routes anything PITCHED that leaked into the drum stem — palm-muted
        # guitar chugs, bass — into its toms output, so on heavy songs that signal
        # hums along all the time. Real tom hits are fills: they jump well above the
        # signal's own running level. Require 4x the 3-second median.
        from scipy.ndimage import median_filter
        floor = median_filter(env["toms"], size=int(3 * fps))
        idx = _loud(_peaks(flux["toms"], fps, rel=0.35), env["toms"], fps, rel=0.35)
        out["toms"] = [i for i in idx
                       if env["toms"][i:i + w].max() >= 4 * max(floor[i], 1e-6)
                       and owns("toms", i, ["snare", "kick"], 0.6)]

    if "snare" in env and beats is not None and downbeats is not None and len(out.get("snare", [])) >= 8:
        out["snare"] = _rescue_snares(out["snare"], env, norm, fps, beats, downbeats, w, log)

    hits = {k: _hits(np.array(v, dtype=int), env["kick" if k == "kick" else "snare" if k == "snare"
                     else "toms" if k == "toms" else "cymbals"], t) for k, v in out.items()}
    log("drums (kit): " + " · ".join(f"{k} {len(v)}" for k, v in hits.items()))
    return hits


def _rescue_snares(confirmed, env, norm, fps, beats, downbeats, w, log):
    """Fill in snares the strict pass missed, using THIS song's own snare pattern.

    The strict pass (snare must stand up to the kick at that instant) is right
    almost every time it fires, but under a busy double kick it misses most
    backbeats. Its hits still show where this song puts its snare in the bar —
    usually beats 2 and 4. In those slots only, accept a weaker hit: the snare
    signal just has to jump clearly above its own running level.
    """
    from scipy.ndimage import median_filter
    beats, db = np.asarray(beats), np.asarray(downbeats)
    if len(beats) < 8 or len(db) < 4:
        return confirmed
    sixteenth = float(np.median(np.diff(beats))) / 4

    def slot(i):
        t = i / fps
        j = np.searchsorted(db, t) - 1
        if j < 0 or j >= len(db) - 1:
            return None
        return int(round((t - db[j]) / sixteenth)) % 16

    counts = np.bincount([x for x in (slot(i) for i in confirmed) if x is not None], minlength=16)
    if counts.sum() < 8:
        return confirmed
    slots = [k for k in range(16) if counts[k] >= 0.15 * counts.sum()]
    if counts[slots].sum() < 0.5 * counts.sum():          # no clear pattern — don't guess
        log("drums: snare has no steady pattern, skipping the backbeat fill-in")
        return confirmed

    # Judge each slot against the REST OF ITS OWN BAR, not a running average: in a
    # dense section guitar/kick bleed keeps the snare signal busy everywhere, so a
    # real backbeat only shows up as being louder than the off-slots around it.
    e = env["snare"]
    floor = median_filter(e, size=int(2 * fps))
    have = set(confirmed)
    half = max(1, int(0.03 * fps))

    def level(t):
        c = int(round(t * fps))
        lo, hi = max(0, c - half), min(len(e) - 1, c + half)
        if hi <= lo:
            return 0.0, c
        i = lo + int(np.argmax(e[lo:hi]))
        return float(e[i]), i

    added = []
    others = [k for k in range(16) if k not in slots]
    for j in range(len(db) - 1):
        bar_len = db[j + 1] - db[j]
        if not (0.75 < bar_len / (16 * sixteenth) < 1.25):      # skip bars the beat tracker mangled
            continue
        base = np.median([level(db[j] + k * sixteenth)[0] for k in others]) or 1e-6
        for k in slots:
            v, i = level(db[j] + k * sixteenth)
            if any(abs(i - h) <= 2 * half for h in have):
                continue
            strong_vs_bar = v >= 1.6 * base
            strong_vs_floor = v >= 2.5 * max(floor[i], 1e-6)
            if (strong_vs_bar or strong_vs_floor) and norm["snare"][i:i + w].max() >= 0.12:
                added.append(i)
    log(f"drums: snare slots {', '.join(str(k // 4 + 1) + ('' if k % 4 == 0 else '.' + str(k % 4)) for k in slots)}"
        f" in the bar — filled in {len(added)} snares the strict pass missed")
    return sorted(set(confirmed) | set(added))
