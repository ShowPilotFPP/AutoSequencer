"""Stage 3 — lyrics, words and mouth shapes from the isolated vocal stem.

Transcription:  faster-whisper (CPU/CUDA, the Ubuntu default) → mlx-whisper → whisperx → openai-whisper.
Mouth shapes:   CMU dictionary breaks each WORD into phonemes ("words win"),
                Rhubarb Lip Sync (optional) refines where inside the word each
                shape starts, and fills the gaps between words (held vowels,
                oohs, ad-libs the transcriber missed).
Output uses xLights' Preston-Blair set: AI E etc FV L MBP O U WQ rest.
"""
import difflib
import json
import re
import subprocess
import time
from pathlib import Path

from . import config

ARPA = {
    "AA": "AI", "AE": "AI", "AH": "AI", "AO": "O", "AW": "O", "AY": "AI", "B": "MBP", "CH": "etc",
    "D": "etc", "DH": "etc", "EH": "E", "ER": "E", "EY": "E", "F": "FV", "G": "etc", "HH": "etc",
    "IH": "AI", "IY": "E", "JH": "etc", "K": "etc", "L": "L", "M": "MBP", "N": "etc", "NG": "etc",
    "OW": "O", "OY": "O", "P": "MBP", "R": "etc", "S": "etc", "SH": "etc", "T": "etc", "TH": "etc",
    "UH": "U", "UW": "U", "V": "FV", "W": "WQ", "Y": "etc", "Z": "etc", "ZH": "etc",
}
VOWELS = {"AI", "E", "O", "U"}
RHUBARB = {"A": "MBP", "B": "etc", "C": "E", "D": "AI", "E": "O", "F": "U", "G": "FV", "H": "L", "X": "rest"}
_cmu = None


# ---------------------------------------------------------------- transcription

def transcribe(vocal_path, log=print):
    failed = False
    for fn in (_faster, _mlx, _whisperx, _openai):
        try:
            words, phrases = fn(str(vocal_path))
            words, phrases = _drop_stuck_repeats(words, phrases, log)
            log(f"lyrics: {len(words)} words via {fn.__name__[1:]}")
            return words, phrases
        except ImportError:
            continue
        except Exception as e:
            failed = True
            log(f"lyrics: {fn.__name__[1:]} failed: {e.__class__.__name__}: {e}")
    log("lyrics: transcription failed (error above) — skipping lyrics" if failed
        else "lyrics: no Whisper backend installed — skipping lyrics")
    return [], []


def _faster(path):
    from faster_whisper import WhisperModel
    dev = "cuda" if config.torch_device() == "cuda" else "cpu"
    model = WhisperModel(config.WHISPER_MODEL, device=dev,
                         compute_type="float16" if dev == "cuda" else "int8",
                         cpu_threads=config.WHISPER_THREADS)
    segs, _ = model.transcribe(path, language="en", word_timestamps=True,
                               condition_on_previous_text=False, vad_filter=True)
    out = []
    for s in segs:
        out.append({"words": [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])]})
    return _from_segments(out)


def _mlx(path):
    import mlx_whisper
    r = mlx_whisper.transcribe(path, path_or_hf_repo=f"mlx-community/whisper-{config.WHISPER_MODEL}",
                               word_timestamps=True, language="en", condition_on_previous_text=False)
    return _from_segments(r["segments"])


def _whisperx(path):
    import whisperx
    dev = "cuda" if config.torch_device() == "cuda" else "cpu"
    model = whisperx.load_model(config.WHISPER_MODEL, dev, compute_type="float16" if dev == "cuda" else "int8")
    audio = whisperx.load_audio(path)
    r = model.transcribe(audio, language="en")
    align, meta = whisperx.load_align_model(language_code="en", device=dev)
    r = whisperx.align(r["segments"], align, meta, audio, dev)
    return _from_segments(r["segments"])


def _openai(path):
    import whisper
    m = whisper.load_model("medium.en")
    r = m.transcribe(path, word_timestamps=True, condition_on_previous_text=False)
    return _from_segments(r["segments"])


def _from_segments(segments):
    words, phrases = [], []
    for s in segments:
        ws = [w for w in s.get("words", []) if "start" in w and "end" in w]
        clean = [(w["start"], w["end"], _clean(w["word"])) for w in ws]
        clean = [c for c in clean if c[2]]
        if not clean:
            continue
        for a, b, t in clean:
            words.append({"start": round(a, 3), "end": round(max(b, a + 0.05), 3), "text": t})
        phrases.append({"start": round(clean[0][0], 3), "end": round(clean[-1][1], 3),
                        "text": " ".join(c[2] for c in clean)})
    return words, phrases


BLEEP = "*"     # a censored word: it takes up its time in the song, but the mouth stays shut


def _clean(w):
    # "***", "f***", "b*tch", "...", "…" stand for a word that was bleeped or muted
    if "*" in w or re.fullmatch(r"\W*(\.\.\.|…)\W*", w):
        return BLEEP
    return re.sub(r"[^A-Za-z']", "", w).lower()


def clean_pasted(text):
    """Lyrics pasted straight from a lyrics site, tidied up.

    Drops [Verse 1: …] / [Chorus] headers, the "You might also like" block lyric sites
    insert (and the song titles listed after it, up to the next header), and the
    trailing "123Embed". Bleeped words ("***", "f***", "...") are kept: they hold their
    time in the song with the mouth closed.
    """
    out, skipping = [], False
    for raw in (text or "").splitlines():
        line = raw.strip()
        if re.match(r"^\[.*\]$", line):                    # section header
            skipping = False
            continue
        if re.match(r"^you might also like", line, re.I):
            skipping = True
            continue
        if skipping:
            continue
        line = re.sub(r"\d*\s*Embed$", "", line).strip()
        line = re.sub(r"\s*\.\.\.\s*", " ... ", line)          # "like..." → "like ..." so it counts as a word
        if line:
            out.append(line)
    return "\n".join(out)


def _drop_stuck_repeats(words, phrases, log):
    """Whisper sometimes locks onto one word and repeats it for a whole verse."""
    keep_p, dropped = [], 0
    for p in phrases:
        toks = p["text"].split()
        if len(toks) >= 8 and len(set(toks)) / len(toks) < 0.25:
            dropped += 1
            continue
        keep_p.append(p)
    if dropped:
        log(f"lyrics: dropped {dropped} stuck/repeating line(s)")
        spans = [(p["start"], p["end"]) for p in keep_p]
        words = [w for w in words if any(a - 0.01 <= w["start"] <= b + 0.01 for a, b in spans)]
    return words, keep_p


def realign_to_lyrics(words, lyrics_text):
    """Pin the user's correct lyrics onto the timing the transcriber found.

    A substitution, not a re-guess: matched/replaced words take the old word's
    slot; extra lyric words share a slot with their neighbour; no audio needed.
    """
    given = [g for g in (_clean(t) for t in lyrics_text.split()) if g]
    heard = [w["text"] for w in words]
    out, pending = [], []           # pending = lyric words waiting for a slot (insert at the very start)

    def spread(a, b, texts):
        step = (b - a) / len(texts)
        return [{"start": round(a + k * step, 3), "end": round(a + (k + 1) * step, 3), "text": t}
                for k, t in enumerate(texts)]

    sm = difflib.SequenceMatcher(a=heard, b=given, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        new = given[j1:j2]
        if not new:                                   # transcriber heard a word that isn't in the lyrics
            continue
        if i2 == i1:                                  # lyric words the transcriber missed
            if out:
                prev = out.pop()
                out += spread(prev["start"], prev["end"], [prev["text"]] + new)
            else:
                pending += new
            continue
        src = words[i1:i2]
        if pending:                                   # give the first slot to the waiting words too
            first = src[0]
            out += spread(first["start"], first["end"], pending + [new[0]])
            pending, src, new = [], src[1:], new[1:]
            if not new:
                continue
            if not src:
                prev = out.pop()
                out += spread(prev["start"], prev["end"], [prev["text"]] + new)
                continue
        if len(new) == len(src):
            out += [{"start": w["start"], "end": w["end"], "text": t} for w, t in zip(src, new)]
        else:
            out += spread(src[0]["start"], src[-1]["end"], new)
    if pending and out:
        last = out.pop()
        out += spread(last["start"], last["end"], [last["text"]] + pending)
    return out


def search_title(title):
    """A file name made searchable: "Eminem & Juice WRLD - Godzilla (Clean) (Lyrics) - Audio at
    192khz" → "Eminem Juice WRLD Godzilla". Drops (…)/[…] tags, "lyrics", "official video",
    "audio at 192khz", "HQ", "clean"/"explicit" and the like."""
    q = re.sub(r"[_]+", " ", title or "")
    q = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", q)                                   # (Clean) [Official Video]
    q = re.sub(r"\b(official\s+(music\s+)?(video|audio|lyric video)|lyrics?|lyric video|audio(\s+at\s+\d+\s*k?hz)?"
               r"|\d+\s*k?hz|hq|hd|4k|clean|explicit|visuali[sz]er|remaster(ed)?(\s+\d{4})?|full song)\b", " ", q, flags=re.I)
    q = re.sub(r"\s*[-–—|]\s*$", "", re.sub(r"\s+[-–—|]\s+[-–—|\s]*", " - ", q))
    q = re.sub(r"[&,]", " ", q)
    return re.sub(r"\s+", " ", q).strip(" -")


def lookup(title, log=print, timeout=20):
    """Published lyrics for a song title, via syncedlyrics (idea from x-onset).

    Free, no API key: it searches public lyric databases such as LRCLIB. Returns
    a list of (seconds or None, line text). Synced lyrics (LRC) carry a start
    time per line, which `align_synced` uses as the backbone of the word timing.
    """
    if not title:
        return None
    try:
        import syncedlyrics
    except ImportError:
        return None
    import concurrent.futures
    query = search_title(title)
    try:
        with concurrent.futures.ThreadPoolExecutor(1) as ex:
            lrc = ex.submit(syncedlyrics.search, query).result(timeout=timeout)
    except Exception as e:
        log(f"lyrics: lookup failed ({e.__class__.__name__})")
        return None
    if not lrc:
        log(f"lyrics: no published lyrics found for \"{query}\"")
        return None
    lines = []
    for line in lrc.splitlines():
        if re.match(r"^\s*\[[a-z]+:", line):            # [ar:...] [ti:...] metadata
            continue
        m = re.match(r"^\s*\[(\d+):(\d+(?:\.\d+)?)\]", line)
        t = int(m.group(1)) * 60 + float(m.group(2)) if m else None
        text = re.sub(r"\[[0-9:.]+\]|<[0-9:.]+>", "", line).strip()
        if text:
            lines.append((t, text))
    if len(lines) < 4:
        return None
    timed = sum(1 for t, _ in lines if t is not None)
    log(f"lyrics: found published lyrics for \"{query}\" ({len(lines)} lines"
        f"{', with line timing' if timed >= len(lines) * 0.8 else ''})")
    return lines


def syllables(word):
    """Vowel sounds in a word (at least 1) — how long it takes to sing, roughly."""
    global _cmu
    if _cmu is None:
        import cmudict
        _cmu = cmudict.dict()
    prons = _cmu.get(word.lower().strip("'"))
    if prons:
        return max(1, sum(1 for p in prons[0] if p[-1].isdigit()))
    return max(1, len(re.findall(r"[aeiouy]+", word.lower())))


def align_synced(lines, heard, vocal_path, log=print, search=6.0):
    """Word timing from synced (LRC) lyrics + the separated vocal + Whisper's words.

      1. Shift the whole LRC so its line starts land on vocal onsets (published
         timings are often a second or two off for a different release/edit).
      2. Inside each line, spread the words over the stretches where the voice is
         actually sounding, in proportion to their syllables — so no word starts
         in silence and nothing stays lit across a rest.
      3. Where Whisper heard the same word, pin it to Whisper's start and bend
         the words between pins to fit.
    """
    import numpy as np
    from . import audio
    y = audio.load_mono(vocal_path, 22050)
    hop = 0.02
    env = audio.frame_rms(y, 22050, hop_s=hop, win_s=0.04)
    if not len(env) or env.max() <= 0:
        return [], []
    thr = max(0.08 * float(np.percentile(env, 95)), 1e-4)
    active = env > thr
    onset = np.maximum(0, np.diff(env, prepend=env[0]))
    onset = np.convolve(onset, np.ones(5) / 5, mode="same")
    T = len(env) * hop
    fr = lambda t: int(np.clip(round(t / hop), 0, len(env) - 1))

    timed = [(l[0], l[1], (l[2] if len(l) > 2 else False)) for l in lines if l[0] is not None]

    # 1. global offset: a sung line starts right after a rest, so the right shift
    # puts each line start where the voice comes in after quiet
    act = active.astype(float)
    csum = np.concatenate([[0], np.cumsum(act)])
    span = lambda a, b: (csum[max(0, min(len(act), b))] - csum[max(0, min(len(act), a))]) / max(1, b - a)
    pre, post = int(0.5 / hop), int(0.3 / hop)

    def score(off):
        sc = 0.0
        for t, _, _ in timed:
            c = fr(t + off)
            sc += span(c, c + post) - span(c - pre, c)
        return sc
    offs = np.arange(-search, search + 0.001, 0.04) if search else np.array([0.0])
    scores = [score(o) for o in offs]
    off = float(offs[int(np.argmax(scores))])
    if search:
        log(f"lyrics: published line timing shifted by {off:+.2f}s to match the singing")

    words, phrases = [], []
    for i, (t, txt, guess) in enumerate(timed):
        toks = [w for w in (_clean(x) for x in txt.split()) if w]
        if not toks:
            continue
        s0 = max(0.0, t + off)
        nxt = timed[i + 1][0] + off if i + 1 < len(timed) else T
        # a line can't take longer than its syllables plus a held note: when the next
        # line is far away (a guitar solo after "ooh yeah baby"), instrument bleed in
        # the vocal stem would otherwise stretch the words across the whole solo
        n_syl = sum(syllables(w) for w in toks)
        s1 = max(s0 + 0.2, min(nxt, T, s0 + 2.0 + 0.6 * n_syl))
        # 2. sung stretches inside the line window (gaps < 0.15 s merged)
        a, b = fr(s0), fr(s1)
        segs, run = [], None
        for k in range(a, b):
            if active[k]:
                if run is None:
                    run = [k, k + 1]
                elif k - run[1] <= int(0.15 / hop):
                    run[1] = k + 1
                else:
                    segs.append(run); run = [k, k + 1]
        if run:
            segs.append(run)
        if not segs:
            segs = [[a, min(b, a + max(1, int(len(toks) * 0.35 / hop)))]]
        total = sum(e - s for s, e in segs)
        syl = np.array([syllables(w) for w in toks], dtype=float)
        cum = np.concatenate([[0], np.cumsum(syl)]) / syl.sum()

        def at(f):                                   # fraction of sung time → seconds
            x = f * total
            for s, e in segs:
                if x <= e - s:
                    return (s + x) * hop
                x -= e - s
            return segs[-1][1] * hop
        starts = np.array([at(f) for f in cum[:-1]])
        ends = np.array([at(f) for f in cum[1:]])

        # 3. pin to Whisper's words heard inside this window
        cand = [w for w in heard if s0 - 0.3 <= w["start"] < s1]
        if cand:
            sm = difflib.SequenceMatcher(a=toks, b=[w["text"] for w in cand], autojunk=False)
            pins = [(blk.a + k, cand[blk.b + k]["start"]) for blk in sm.get_matching_blocks() for k in range(blk.size)]
            if pins:
                idx = np.array([p[0] for p in pins]); dv = np.array([p[1] for p in pins]) - starts[idx]
                shift = np.interp(np.arange(len(toks)), idx, dv)
                starts = starts + shift
                ends = ends + shift
        for k, w in enumerate(toks):
            st = float(max(starts[k], words[-1]["end"] if words else 0))
            en = float(max(st + 0.06, min(ends[k], s1 + 0.5, st + 3.5)))   # longest held word: 3.5 s
            words.append({"start": round(st, 3), "end": round(en, 3), "text": w})
        line_words = words[-len(toks):]
        phrases.append({"start": line_words[0]["start"], "end": line_words[-1]["end"], "text": " ".join(toks), "guess": guess})
    return words, phrases


def merge_with_published(text, published):
    """Your pasted lyrics (the words to use) + published synced lyrics (when each line starts).

    Lines are paired up in order by how similar they are (so "Hey, yeah. Bark at the
    moon" pairs with "hey yeah bark at the moon", and an extra "Ha, ha, ha" just sits
    between its neighbours). Returns [(seconds, line)] or None if they don't match up.
    """
    mine = [l.strip() for l in text.splitlines() if l.strip()]
    pub = [(t, l) for t, l in (published or []) if t is not None]
    if not mine or len(pub) < 4:
        return None
    norm = lambda l: " ".join(w for w in (_clean(x) for x in l.split()) if w)
    A, B = [norm(l) for l in mine], [norm(l) for _, l in pub]
    sim = lambda i, j: difflib.SequenceMatcher(a=A[i], b=B[j]).ratio()
    n, m = len(A), len(B)
    # in-order pairing that maximises total similarity (skips allowed on both sides)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            r = sim(i, j)
            score[i][j] = max(score[i + 1][j], score[i][j + 1], (r + score[i + 1][j + 1]) if r >= 0.6 else -1)
    pairs, i, j = {}, 0, 0
    while i < n and j < m:
        r = sim(i, j)
        if r >= 0.6 and score[i][j] == r + score[i + 1][j + 1]:
            pairs[i] = pub[j][0]; i += 1; j += 1
        elif score[i][j] == score[i + 1][j]:
            i += 1
        else:
            j += 1
    if len(pairs) < max(3, 0.5 * n):
        return None
    # lines without a partner go between their neighbours
    known = sorted(pairs)
    out = []
    for k, line in enumerate(mine):
        if k in pairs:
            out.append((pairs[k], line, False)); continue
        before = max([x for x in known if x < k], default=None)
        after = min([x for x in known if x > k], default=None)
        if before is not None and after is not None:
            t = pairs[before] + (pairs[after] - pairs[before]) * (k - before) / (after - before)
        elif before is not None:
            t = pairs[before] + 3.0 * (k - before)
        else:
            t = max(0.0, pairs[after] - 3.0 * (after - k))
        if before is not None:                      # an extra line usually follows straight on from the one before
            prev_line = mine[before]
            est = pairs[before] + 0.6 + 0.35 * sum(syllables(w) for w in (_clean(x) for x in prev_line.split()) if w)
            t = min(t, est) if after is None or est < pairs[after] else t
        out.append((t, line, True))                # a guess: the aligner may move it further
    return out


def align_plain(text, heard, vocal_path, log=print):
    """Lyrics without line timing (pasted, or a plain published copy).

    Estimate where each line starts by laying all the lines over the stretches
    where the voice is actually sounding, in proportion to their syllables; then
    Whisper's heard words pin them in place where it recognised any (each line
    is allowed to slide up to 2 s to its pins). Much better than spreading words
    evenly over whatever Whisper happened to hear.
    """
    import numpy as np
    from . import audio
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines:
        return [], []
    y = audio.load_mono(vocal_path, 22050)
    hop = 0.02
    env = audio.frame_rms(y, 22050, hop_s=hop, win_s=0.04)
    if not len(env) or env.max() <= 0:
        return [], []
    active = env > max(0.08 * float(np.percentile(env, 95)), 1e-4)
    idx = np.flatnonzero(active)
    syl = [sum(syllables(w) for w in (_clean(x) for x in l.split()) if w) or 1 for l in lines]
    cum = np.concatenate([[0], np.cumsum(syl)]) / sum(syl)
    starts = [float(idx[min(len(idx) - 1, int(f * len(idx)))] * hop) for f in cum[:-1]]
    # slide each line toward the heard words that match it
    timed = []
    for st, line in zip(starts, lines):
        toks = [w for w in (_clean(x) for x in line.split()) if w]
        near = [w for w in heard if abs(w["start"] - st) < 8]
        if toks and near:
            sm = difflib.SequenceMatcher(a=toks, b=[w["text"] for w in near], autojunk=False)
            m = [(blk.a, near[blk.b]["start"]) for blk in sm.get_matching_blocks() if blk.size]
            if m:
                k, t = m[0]
                guess = t - (k * 0.3)                  # roughly where the line's first word would be
                if abs(guess - st) < 6:
                    st = guess
        timed.append((st, line))
    # lines never change order: a slide can't put a line before the one above it
    for k in range(1, len(timed)):
        if timed[k][0] < timed[k - 1][0] + 0.5:
            timed[k] = (timed[k - 1][0] + 0.5, timed[k][1])
    log(f"lyrics: laid {len(lines)} lines over the sung parts of the song (no published line timing)")
    return align_synced(timed, heard, vocal_path, log, search=0)


# ---------------------------------------------------------------- mouth shapes

def word_phonemes(word):
    global _cmu
    if _cmu is None:
        import cmudict
        _cmu = cmudict.dict()
    prons = _cmu.get(word.lower().strip("'"))
    if prons:
        seq = [ARPA.get(re.sub(r"\d", "", p), "etc") for p in prons[0]]
    else:                                             # unknown word: letter heuristics
        m = {"a": "AI", "e": "E", "i": "AI", "o": "O", "u": "U", "b": "MBP", "m": "MBP", "p": "MBP",
             "f": "FV", "v": "FV", "l": "L", "w": "WQ"}
        seq = [m.get(c, "etc") for c in word.lower() if c.isalpha()]
    merged = []
    for p in seq:                                     # collapse repeats like "etc etc"
        if not merged or merged[-1] != p:
            merged.append(p)
    return merged or ["etc"]


def rhubarb_cues(vocal_path, words, log=print):
    """Mouth-shape timing from the vocal audio.

    Uses Rhubarb's PHONETIC recognizer: we already have the words from Whisper,
    so all we want from Rhubarb is where the mouth moves — and the default
    PocketSphinx recognizer can take 15+ minutes on a full song on CPU. Any
    failure (missing binary, timeout, crash) falls back to dictionary timing
    instead of failing the analysis.
    """
    try:
        import soundfile as sf
        duration = sf.info(str(vocal_path)).duration
    except Exception:
        duration = 300
    timeout = max(120, int(duration * 1.5))
    cmd = [config.RHUBARB_BIN, "-f", "json", "--extendedShapes", "GHX", "-q",
           "--recognizer", "phonetic", str(vocal_path)]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        log("lyrics: Rhubarb not installed — mouth-shape timing from the dictionary only")
        return []
    except subprocess.TimeoutExpired:
        log(f"lyrics: Rhubarb took over {timeout}s — using dictionary timing for mouth shapes")
        return []
    if r.returncode != 0:
        log(f"lyrics: Rhubarb failed ({r.stderr.strip()[-200:]}) — using dictionary timing")
        return []
    try:
        cues = json.loads(r.stdout)["mouthCues"]
    except Exception:
        log("lyrics: Rhubarb returned unreadable output — using dictionary timing")
        return []
    log(f"lyrics: Rhubarb measured {len(cues)} mouth cues in {time.time() - t0:.0f}s")
    return [{"start": c["start"], "end": c["end"], "shape": RHUBARB.get(c["value"], "etc")} for c in cues]


def build_phonemes(words, cues, snap=0.06):
    out = []
    bounds = sorted({round(c["start"], 3) for c in cues})
    for w in words:
        if w["text"] == BLEEP:                               # bleeped word: mouth stays closed
            continue
        ph = word_phonemes(w["text"])
        a, b = w["start"], w["end"]
        weights = [2.0 if p in VOWELS else 1.0 for p in ph]
        total = sum(weights)
        edges, acc = [a], a
        for wt in weights[:-1]:
            acc += (b - a) * wt / total
            near = [x for x in bounds if a < x < b and abs(x - acc) <= snap]
            edges.append(min(near, key=lambda x: abs(x - acc)) if near else acc)
        edges.append(b)
        edges = [max(edges[i], edges[i - 1]) if i else edges[0] for i in range(len(edges))]
        for p, s, e in zip(ph, edges, edges[1:]):
            if e - s >= 0.02:
                out.append({"start": round(s, 3), "end": round(e, 3), "text": p})

    # gaps: audio-measured shapes stand, unless they touch a word
    spans = [(w["start"], w["end"]) for w in words]
    for c in cues:
        if c["shape"] == "rest":
            continue
        if any(c["start"] < b and c["end"] > a for a, b in spans):
            continue
        out.append({"start": round(c["start"], 3), "end": round(c["end"], 3), "text": c["shape"]})
    out.sort(key=lambda x: x["start"])
    return out
