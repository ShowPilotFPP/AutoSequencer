"""Word timing by forced alignment: the right words, pinned to the actual singing.

Everything before this step gets each LINE to the right place (published line
times, rests in the vocal, Whisper's words). Inside a line, though, words were
spread by syllable count — a guess, and singers stretch and squeeze words
constantly. That's why words drifted off the singing within lines.

Forced alignment fixes that properly. We already know the exact words, so instead
of asking a speech model "what was sung?", we ask "WHEN was each of these letters
sung?". torchaudio's MMS_FA aligner (Meta's multilingual forced-alignment model,
trained on 1,100+ languages, robust to singing on a separated vocal) scores every
letter against every 20 ms of the vocal stem and finds the best path through
them. Each line is aligned inside a window around where it already sits, so a
wrong guess elsewhere in the song can't pull it away.

Per line, the result is only kept if the aligner is confident and the words stay
sensible; otherwise that line keeps its previous timing. Held notes are kept:
a word runs until the next word starts unless there's a real rest between them.
"""
import re

import numpy as np

from . import config

_model = None


def _load(log):
    global _model
    if _model is None:
        import torch
        import torchaudio
        bundle = torchaudio.pipelines.MMS_FA
        log("lyrics: loading the forced-alignment model (about 1.2 GB, downloaded once)")
        # with_star: the model gets an extra "anything else" token, used between lines and
        # for bleeped words so ad-libs, music and muted spots don't have to match letters
        model = bundle.get_model(with_star=True)
        model.eval()
        torch.set_num_threads(max(1, torch.get_num_threads()))
        _model = (torch, bundle, model, bundle.get_tokenizer(), bundle.get_aligner(), set(bundle.get_dict()) - {'*'})
    return _model


def _norm(word, alphabet):
    w = word.lower().replace("’", "'")
    w = "".join(ch for ch in w if ch in alphabet and ch not in "-*")
    return w


def _syl(word):
    return max(1, len(re.findall(r"[aeiouy]+", word.lower())))


def _line_ok(times, toks):
    """A line placement is believable: no word over 4 s, and no faster than ~14 syllables
    a second (faster than the fastest rap verses)."""
    if not times:
        return False
    a, b = times[0][0], times[-1][1]
    syl = sum(_syl(t) for t in toks)
    return max(e - s for s, e in times) < 4.0 and syl / max(0.05, b - a) <= 14


def _global(words, groups, wave, sr, T, torch, model, tokenizer, aligner, alphabet, log):
    """Align ALL the lyrics against the WHOLE vocal in one pass.

    The vocal is turned into letter probabilities 15 seconds at a time, joined into one
    long track, and every word of the lyrics is placed along it in order. Nothing
    depends on where lines were guessed to be, so a bad guess can't push words into
    the wrong spot. A "*" between lines lets ad-libs, instrumental breaks and anything
    the lyrics don't mention pass by without having to match letters; bleeped words are
    "*" too. Returns {word index: (start, end)} and which lines came out believable.
    """
    chunk = 15 * sr
    ems = []
    with torch.inference_mode():
        for i in range(0, wave.numel(), chunk):
            seg = wave[i:i + chunk]
            if seg.numel() < 800:
                seg = torch.nn.functional.pad(seg, (0, 800 - seg.numel()))
            em, _ = model(seg.unsqueeze(0))
            ems.append(em[0])
    emission = torch.cat(ems)
    fps = emission.size(0) / T
    transcript, owner = ['*'], [None]
    for li, idx in enumerate(groups):
        for k in idx:
            raw = words[k]["text"]
            t = '*' if raw == '*' else _norm(raw, alphabet)
            if t:                                  # a bleeped word is a "*" that still belongs to its word
                transcript.append(t); owner.append(k)
        transcript.append('*'); owner.append(None)
    spans = aligner(emission, tokenizer(transcript))
    times = {}
    for sp, k in zip(spans, owner):
        if k is not None:
            times[k] = (sp[0].start / fps, sp[-1].end / fps)
    ok = []
    for idx in groups:
        real = [k for k in idx if k in times and words[k]["text"] != '*']
        ok.append(bool(real) and _line_ok([times[k] for k in real], [words[k]["text"] for k in real]))
    return times, ok


def refine(words, phrases, vocal_path, log=print):
    """Re-time every word with forced alignment, line by line. Returns (words, phrases)."""
    if not config.FORCED_ALIGN or not words:
        return words, phrases
    try:
        torch, bundle, model, tokenizer, aligner, alphabet = _load(log)
    except Exception as e:                         # not installed / no download: keep what we have
        log(f"lyrics: forced alignment unavailable ({e.__class__.__name__}: {e}) — keeping the estimated word timing")
        return words, phrases
    from . import audio

    sr = bundle.sample_rate                       # 16 kHz
    y = audio.load_mono(vocal_path, sr)
    T = len(y) / sr
    wave = torch.from_numpy(y).float()

    # which words belong to which line (lines own their words, in order)
    groups, i = [], 0
    for p in phrases:
        n = len(p["text"].split())
        groups.append(list(range(i, min(i + n, len(words)))))
        i += n
    if i != len(words):                           # counts don't add up: group by time instead
        groups = [[k for k, w in enumerate(words) if p["start"] - 0.05 <= w["start"] < p["end"] + 0.05] for p in phrases]

    out = [dict(w) for w in words]
    kept, redone = 0, 0
    todo = set(range(len(groups)))
    try:
        gtimes, gok = _global(words, groups, wave, sr, T, torch, model, tokenizer, aligner, alphabet, log)
        for li, idx in enumerate(groups):
            if gok[li]:
                for k in idx:
                    if k in gtimes:
                        out[k]["start"], out[k]["end"] = round(gtimes[k][0], 3), round(gtimes[k][1], 3)
                todo.discard(li)
                redone += 1
        log(f"lyrics: whole-song alignment placed {redone} of {len(groups)} lines")
        # words the whole-song pass placed become the starting point for any line it missed
        words = [dict(w) for w in out]
    except Exception as e:
        log(f"lyrics: whole-song alignment failed ({e.__class__.__name__}: {e}) — aligning line by line")
    for li, idx in enumerate(groups):
        if not idx or li not in todo:
            continue
        toks = [_norm(words[k]["text"], alphabet) for k in idx]
        real = [j for j, t in enumerate(toks) if t]
        if not real:
            continue
        guess = bool(phrases[li].get("guess")) if li < len(phrases) else False
        first = words[idx[0]]["start"]
        nxt = words[groups[li + 1][0]]["start"] if li + 1 < len(groups) and groups[li + 1] else T
        need = sum(len(toks[j]) for j in real) * 0.06 + 0.4            # CTC needs ≥ 1 frame per letter
        # Candidate windows. The tight one (a second either side of where the line
        # already is, ending just before the next line) is right most of the time;
        # the wider ones catch a line whose published time is off. The aligner scores
        # every window, and a wider one only wins if it's clearly more confident.
        # (Windows are NOT clipped to where the previous line ended: one late held word
        # would then push every following line late too.)
        prev_first = words[groups[li - 1][0]]["start"] if li > 0 and groups[li - 1] else 0.0
        tight_end = max(words[idx[-1]]["end"] + 1.0, nxt - 0.05)
        cands = [(max(0.0, first - 1.0), tight_end, 0.0)]
        cands.append((max(0.0, prev_first + 0.5, first - 3.0), tight_end, 0.04))
        if guess:                                                       # a line only your lyrics have
            cands.append((max(0.0, prev_first + 0.5, first - 8.0), max(tight_end, nxt + 0.3), 0.0))
        best = None
        for start, end, handicap in cands:
            end = min(T, end, start + (20.0 if guess else 14.0))
            if end - start < need:
                end = min(T, start + need)
            seg = wave[int(start * sr):int(end * sr)]
            if seg.numel() < sr * 0.3:
                continue
            try:
                with torch.inference_mode():
                    emission, _ = model(seg.unsqueeze(0))
                    spans = aligner(emission[0], tokenizer([toks[j] for j in real]))
            except Exception:
                continue
            ratio = seg.numel() / emission.size(1) / sr                   # seconds per emission frame
            times = [(start + sp[0].start * ratio, start + sp[-1].end * ratio) for sp in spans]
            conf = float(np.mean([float(np.mean([t.score for t in sp])) for sp in spans]))
            if best is None or conf - handicap > best[0]:
                best = (conf - handicap, conf, times)
        if best is None:
            kept += 1
            continue
        _, conf, times = best
        durs = [b - a for a, b in times]
        # sanity: confident, no absurd word lengths, and the line didn't jump away
        sane = (conf >= config.ALIGN_MIN_SCORE and _line_ok(times, [toks[j] for j in real])
                and (guess or abs(times[0][0] - first) < 3.5))
        if not sane:
            kept += 1
            continue
        redone += 1
        for j, (a, b) in zip(real, times):
            out[idx[j]]["start"], out[idx[j]]["end"] = round(a, 3), round(b, 3)
        # words with no letters the aligner knows (numbers, symbols) sit between their neighbours
        for j, k in enumerate(idx):
            if j in real:
                continue
            prev = out[idx[j - 1]]["end"] if j > 0 else out[k]["start"]
            nxt_w = next((out[idx[r]]["start"] for r in range(j + 1, len(idx)) if r in real), prev + 0.3)
            out[k]["start"], out[k]["end"] = round(prev, 3), round(max(prev + 0.05, nxt_w), 3)

    # Last resort for a line neither pass could place believably (crammed into a sliver):
    # spread its words by syllable across the room between the lines around it, so it
    # at least plays in the right stretch at a singable speed.
    for li, idx in enumerate(groups):
        if not idx:
            continue
        times = [(out[k]["start"], out[k]["end"]) for k in idx]
        if _line_ok(times, [out[k]["text"] for k in idx if out[k]["text"] != '*']):
            continue
        lo = out[groups[li - 1][-1]]["end"] if li > 0 and groups[li - 1] else max(0.0, out[idx[0]]["start"] - 2)
        hi = out[groups[li + 1][0]]["start"] if li + 1 < len(groups) and groups[li + 1] else min(T, out[idx[-1]]["end"] + 2)
        syl = [_syl(out[k]["text"]) if out[k]["text"] != '*' else 1 for k in idx]
        need = sum(syl) / 6.0                                   # about 6 syllables a second
        span = min(max(hi - lo, 0.1), max(need, 0.4))
        a = max(lo, min(out[idx[0]]["start"], hi - span))
        t = a
        for k, sy in zip(idx, syl):
            d = span * sy / sum(syl)
            out[k]["start"], out[k]["end"] = round(t, 3), round(t + d, 3)
            t += d
        log(f"lyrics: line {li + 1} couldn't be pinned to the singing; spread across {a:.1f}–{a + span:.1f}s")

    # held notes: a word lasts until the next word unless there's a real rest (> 0.6 s)
    for a, b in zip(out, out[1:]):
        gap = b["start"] - a["end"]
        if 0 < gap <= 0.6:
            a["end"] = b["start"]
        if a["end"] > b["start"]:
            a["end"] = max(a["start"] + 0.04, b["start"])

    new_phrases = []
    for p, idx in zip(phrases, groups):
        if idx:
            new_phrases.append({"start": out[idx[0]]["start"], "end": out[idx[-1]]["end"], "text": p["text"]})
            # (the guess flag is only needed while aligning)
        else:
            new_phrases.append(dict(p))
    log(f"lyrics: forced alignment re-timed {redone} of {redone + kept} lines word by word"
        + (f" ({kept} kept their earlier timing: the aligner wasn't sure)" if kept else ""))
    return out, new_phrases
