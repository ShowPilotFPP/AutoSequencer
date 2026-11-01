"""Beats and downbeats.

Prefers beat_this (CPJKU, 2024) which tracks beats AND bar starts directly and
installs cleanly on current Python/NumPy. Falls back to librosa's beat tracker
plus a "which of the four phases lands on the most low-end hits" downbeat
guess, which is decent but wrong on songs with pickups.
"""
import numpy as np

from . import config

_model = None


def track(wav_path, y_mono, sr, log=print):
    try:
        beats, downbeats = _beat_this(wav_path)
        source = "beat_this"
    except Exception as e:  # not installed or failed
        log(f"beats: beat_this unavailable ({e.__class__.__name__}: {e}); using librosa")
        beats, downbeats = _librosa(y_mono, sr)
        source = "librosa"

    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    beats, n_fixed = _fix_tempo(beats)
    downbeats = _vote_downbeats(beats, downbeats) if n_fixed else _regular_downbeats(beats, downbeats)
    if n_fixed:
        log(f"beats: repaired {n_fixed} beats where the tracker switched to half/double time")
    beats, downbeats = _extend_grid(beats, downbeats, len(y_mono) / sr)
    ibi = np.diff(beats)
    bpm = float(60.0 / np.median(ibi)) if len(ibi) else 0.0
    log(f"beats: {len(beats)} beats, {len(downbeats)} bars, {bpm:.1f} BPM ({source})")
    return {"beats": beats.round(4).tolist(), "downbeats": downbeats.round(4).tolist(),
            "bpm": round(bpm, 1), "beatSource": source}


def _fix_tempo(beats):
    """Put stretches tracked at double or half speed back on the song's main beat."""
    if len(beats) < 16:
        return beats, 0
    P = float(np.median(np.diff(beats)))
    out, changed = [float(beats[0])], 0
    for t in beats[1:]:
        gap = t - out[-1]
        if gap < 0.7 * P:                       # an extra beat inside a beat
            changed += 1
            continue
        n = int(round(gap / P))
        if n >= 2 and abs(gap / n - P) < 0.18 * P:   # missing beat(s)
            out += [out[-1] + gap * k / n for k in range(1, n)]
            changed += n - 1
        out.append(float(t))
    return np.array(out), changed


def _vote_downbeats(beats, downbeats, per_bar=4):
    """Bar lines every 4 beats, in the phase the tracker's own downbeats agree on nearby."""
    if len(beats) < 16 or not len(downbeats):
        return downbeats
    votes = [(int(np.argmin(np.abs(beats - d))),) for d in downbeats]
    votes = [(i, i % per_bar) for (i,) in votes]
    out, last = [], -per_bar
    for i in range(len(beats)):
        count = [0] * per_bar
        for vi, ph in votes:
            if abs(vi - i) <= 16:
                count[ph] += 1
        phase = int(np.argmax(count))
        if i % per_bar == phase and i - last >= 2:
            out.append(beats[i])
            last = i
    return np.array(out)


def _regular_downbeats(beats, downbeats):
    """Patch stretches where the downbeat tracker lost the bar.

    Real songs do have the odd 2- or 3-beat bar at the end of a phrase, so those
    are kept. What gets fixed: runs of 1-beat "bars" (the tracker flailing in a
    breakdown) and long gaps with no bar line at all. Both are re-counted at the
    song's usual bar length from the last good downbeat.
    """
    if len(downbeats) < 6 or len(beats) < 16:
        return downbeats
    bidx = sorted({int(np.argmin(np.abs(beats - d))) for d in downbeats})
    per = int(np.median(np.diff(bidx)))
    if per < 2:
        return downbeats
    out = [bidx[0]]
    for b in bidx[1:]:
        if b - out[-1] < max(2, per // 2):          # a 1-beat bar: spurious
            continue
        while b - out[-1] > per + per // 2:         # missing bar lines: count them in
            out.append(out[-1] + per)
        out.append(b)
    # one odd bar is music; several odd bars in a row is the tracker lost — re-count that stretch
    fixed, i = [out[0]], 1
    while i < len(out):
        if out[i] - fixed[-1] != per and i + 1 < len(out) and out[i + 1] - out[i] != per:
            j = i
            while j < len(out) and out[j] - out[j - 1] != per:
                j += 1
            end = out[j - 1] if j == len(out) else out[j]
            while end - fixed[-1] >= per + 2:       # keep a short last bar only if it's 2+ beats
                fixed.append(fixed[-1] + per)
            i = j
            continue
        fixed.append(out[i])
        i += 1
    if fixed[-1] != out[-1] and out[-1] - fixed[-1] >= 2:
        fixed.append(out[-1])
    return beats[np.array(sorted({x for x in fixed if x < len(beats)}))]


def _extend_grid(beats, downbeats, duration):
    """Trackers often stay silent through a drumless intro or ringing ending.
    Extend the grid at the song's own tempo so those bars still get beats."""
    if len(beats) < 8:
        return beats, downbeats
    ibi = float(np.median(np.diff(beats)))
    head = np.arange(beats[0] - ibi, 0.05, -ibi)[::-1]
    tail = np.arange(beats[-1] + ibi, duration - 0.05, ibi)
    if len(downbeats):
        per_bar = max(1, int(round(np.median(np.diff(downbeats)) / ibi))) if len(downbeats) > 1 else 4
        first = int(np.argmin(np.abs(beats - downbeats[0])))
        db_head = head[::-1][per_bar - 1 - (first % per_bar)::per_bar][::-1] if len(head) else head
        last = int(np.argmin(np.abs(beats - downbeats[-1])))
        db_tail = tail[per_bar - 1 - ((len(beats) - 1 - last) % per_bar)::per_bar] if len(tail) else tail
        downbeats = np.concatenate([db_head, downbeats, db_tail])
    return np.concatenate([head, beats, tail]), downbeats


def _beat_this(wav_path):
    global _model
    from beat_this.inference import File2Beats
    if _model is None:
        dev = config.torch_device()
        # beat_this works on cuda/cpu; MPS support is patchy, CPU is fast enough (~10 s/song)
        _model = File2Beats(checkpoint_path="final0", device="cuda" if dev == "cuda" else "cpu", dbn=False)
    beats, downbeats = _model(str(wav_path))
    return beats, downbeats


def _librosa(y, sr):
    import librosa
    # hop 256 matters: at 512 the tempo grid is coarse enough to be ~2% off,
    # which drifts a full beat out of phase over a minute
    hop = 256
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    _, frames = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop, units="frames")
    beats = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    if len(beats) < 8:
        return beats, beats[::4]
    # low-band onset strength sampled at each beat → pick the phase with the most weight
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
    low = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S[freqs < 150]), sr=sr)
    fr = np.clip(frames, 0, len(low) - 1)
    strength = low[fr] / (low[fr].mean() or 1)
    # chords tend to change on bar one; kick-on-1-and-3 alone can't tell 1 from 3
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr, n_fft=4096)
    cs = librosa.util.sync(chroma, np.concatenate([[0], frames]), aggregate=np.median)[:, 1:]
    change = np.r_[0, np.linalg.norm(np.diff(cs / (cs.sum(axis=0) + 1e-9), axis=1), axis=0)]
    change = change / (change.mean() or 1)
    score = strength + 1.5 * change[:len(strength)]
    phase = int(np.argmax([score[p::4].mean() for p in range(4)]))
    return beats, beats[phase::4]
