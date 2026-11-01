"""Runs the full analysis for one song and caches everything by file hash.

    SEPARATE  → Demucs stems, then DrumSep kick/snare/cymbals/toms
    TRANSCRIBE→ drums, basic-pitch notes, beats, chords, sections
    LYRICS    → words, phrases, mouth shapes
    EXPORT    → analysis.json + autoseq.xtiming
"""
import json
import shutil
import time
from pathlib import Path

from . import align, audio, beats, config, drums, harmony, kit, lyrics, notes, separate, structure, xtiming


def analyze(src_path, lyrics_text=None, do_separate=True, split_xtiming=False,
            log=print, progress=lambda stage, pct: None, force=False, title=None):
    src_path = Path(src_path)
    song_id = audio.file_hash(src_path)
    job = config.JOBS_DIR / song_id
    job.mkdir(parents=True, exist_ok=True)
    cached = job / "analysis.json"
    if cached.exists() and not force and not lyrics_text:
        log("analysis: cached result")
        progress("done", 100)
        return json.loads(cached.read_text()), job

    t0 = time.time()
    wav = job / "mix.wav"
    if not wav.exists():
        audio.to_wav(src_path, wav)
    y_mix = audio.load_mono(wav, structure.SR)
    duration = len(y_mix) / structure.SR
    log(f"audio: {src_path.name} · {duration:.1f}s · id {song_id}")

    # ---------------- SEPARATE
    progress("separate", 5)
    if do_separate:
        stems = separate.separate(wav, job, log=log)
    else:
        log("stems: separation OFF — every stage runs on the full mix (lower quality)")
        stems = {n: wav for n in ("drums", "vocals")}
    stems_mono = {n: audio.load_mono(p, structure.SR) for n, p in stems.items()}
    kit_paths = kit.separate_kit(stems["drums"], job, log=log) if do_separate else None
    progress("transcribe", 35)

    # ---------------- TRANSCRIBE
    bt = beats.track(wav, y_mix, structure.SR, log=log)
    if kit_paths:
        kit_y = {k: audio.load_mono(p, config.SAMPLE_RATE) for k, p in kit_paths.items()}
        drum_hits = drums.detect_kit(kit_y, config.SAMPLE_RATE, log=log,
                                     beats=bt["beats"], downbeats=bt["downbeats"])
    else:
        drum_y = audio.load_mono(stems["drums"], config.SAMPLE_RATE)
        drum_hits = drums.detect(drum_y, config.SAMPLE_RATE, log=log)
    progress("transcribe", 50)

    note_tracks, shares = ({}, {})
    if do_separate:
        note_tracks, shares = notes.transcribe(stems, audio.rms(y_mix), log=log, enabled=config.NOTES)
    progress("transcribe", 65)

    y_harm = harmony.harmonic_mix(stems, audio.load_mono) if do_separate else audio.load_mono(wav, harmony.SR)
    key, chords = harmony.analyze(y_harm, bt["beats"], duration, log=log)
    st = structure.analyze(y_mix, stems_mono, bt["downbeats"], bt["beats"], drum_hits,
                           bt["bpm"], duration, log=log)
    progress("lyrics", 75)

    # ---------------- LYRICS
    vocal_share = shares.get("vocals", 1.0)
    if stems.get("vocals") and vocal_share >= config.STEM_MIN_SHARE:
        words, phrases, phonemes = _lyrics(stems["vocals"], lyrics_text, log, title)
    else:
        log("lyrics: no vocals in this song")
        words, phrases, phonemes = [], [], []
    progress("export", 95)

    result = {
        "version": 2, "songId": song_id, "file": src_path.name, "duration": round(duration, 3),
        "bpm": bt["bpm"], "beatSource": bt["beatSource"], "beats": bt["beats"], "downbeats": bt["downbeats"],
        "key": key, "chords": chords, **st,
        "drums": drum_hits, "drumSource": "drumsep" if kit_paths else "drum-stem",
        "notes": note_tracks,
        "noteHits": {k: notes.onsets_from_notes(v) for k, v in note_tracks.items() if k != "vocals"},
        "stemShare": shares, "stems": sorted(stems) if do_separate else [],
        "words": words, "phrases": phrases, "phonemes": phonemes,
        "elapsed": round(time.time() - t0, 1),
    }
    _export(result, job, src_path, split_xtiming, log)
    if do_separate:
        _cleanup(job, log)
    log(f"done in {result['elapsed']}s")
    progress("done", 100)
    return result, job


def redo_lyrics(src_path, lyrics_text=None, log=print, progress=lambda stage, pct: None, title=None):
    """Re-run only the lyrics stage on the saved vocal stem — seconds-to-minutes, not a full analysis."""
    src_path = Path(src_path)
    job = config.JOBS_DIR / audio.file_hash(src_path)
    cached, vocals = job / "analysis.json", job / "stems" / "vocals.wav"
    if not cached.exists():
        raise RuntimeError("this song hasn't been analyzed yet — run a full analysis first")
    if not vocals.exists():
        raise RuntimeError("the vocal stem was cleaned up — run a full re-run instead")
    t0 = time.time()
    progress("lyrics", 75)
    result = json.loads(cached.read_text())
    result["words"], result["phrases"], result["phonemes"] = _lyrics(vocals, lyrics_text, log, title)
    progress("export", 95)
    _export(result, job, src_path, False, log)
    log(f"lyrics redone in {time.time() - t0:.1f}s")
    progress("done", 100)
    return result, job


# ---------------------------------------------------------------- helpers

def _lyrics(vocal_path, lyrics_text, log, title=None):
    """Lyrics never take the rest of the analysis down with them."""
    try:
        return _lyrics_inner(vocal_path, lyrics_text, log, title)
    except Exception as e:
        log(f"lyrics: stage failed ({e.__class__.__name__}: {e}) — saving the analysis without lyrics")
        return [], [], []


def _lyrics_inner(vocal_path, lyrics_text, log, title=None):
    heard, phrases = lyrics.transcribe(vocal_path, log=log)
    words = heard
    if lyrics_text:
        lyrics_text = lyrics.clean_pasted(lyrics_text)
    if lyrics_text:                                  # lyrics you pasted win (for the words)
        timed = lyrics.merge_with_published(lyrics_text, lyrics.lookup(title, log)) if title else None
        if timed:
            words, phrases = lyrics.align_synced(timed, heard, vocal_path, log)
            log(f"lyrics: {len(words)} words of your lyrics placed using the published line timing")
        else:
            words, phrases = lyrics.align_plain(lyrics_text, heard, vocal_path, log)
            log(f"lyrics: {len(words)} words of your lyrics placed ({len(heard)} heard by Whisper used as pins)")
    elif title:
        lines = lyrics.lookup(title, log)
        timed = [l for l in (lines or []) if l[0] is not None]
        if lines and len(timed) >= 0.8 * len(lines):
            words, phrases = lyrics.align_synced(lines, heard, vocal_path, log)
            log(f"lyrics: {len(words)} words placed from the published line timing "
                f"({len(heard)} heard by Whisper used as pins)")
        elif lines:
            words, phrases = lyrics.align_plain("\n".join(t for _, t in lines), heard, vocal_path, log)
            log(f"lyrics: {len(words)} published words placed ({len(heard)} heard by Whisper used as pins)")
    if words:                                        # pin every word to the actual singing
        words, phrases = align.refine(words, phrases, vocal_path, log)
    phonemes = []
    if words:
        cues = lyrics.rhubarb_cues(vocal_path, words, log=log)
        phonemes = lyrics.build_phonemes(words, cues)
        log(f"lyrics: {len(phonemes)} mouth shapes")
    return words, phrases, phonemes


def _export(result, job, src_path, split, log):
    (job / "analysis.json").write_text(json.dumps(result, indent=1))
    xt = job / "autoseq.xtiming"
    _, names = xtiming.write(result, xt, split=split)
    log(f"export: {len(names)} timing tracks")


def _cleanup(job, log):
    """Drop stems we don't need to keep (each is ~35 MB for a 3-minute song)."""
    keep = config.KEEP_STEMS.lower()
    if keep == "all":
        return
    freed = 0
    for f in list((job / "stems").glob("*.wav")) + [job / "mix.wav"]:
        if keep == "vocals" and f.name == "vocals.wav":
            continue
        if f.exists():
            freed += f.stat().st_size
            f.unlink()
    if freed:
        log(f"cleanup: removed {freed / 1e6:.0f} MB of stems (AUTOSEQ_KEEP_STEMS={keep})")
