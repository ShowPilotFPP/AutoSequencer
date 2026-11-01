"""CLI.

    python -m autoseq song.mp3 [--lyrics lyrics.txt] [--no-separate] [--split] [--force]
    python -m autoseq serve [--port 5050]
"""
import argparse
import sys
from pathlib import Path

from . import config


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "serve":
        p = argparse.ArgumentParser(prog="autoseq serve")
        p.add_argument("--port", type=int, default=config.PORT)
        p.add_argument("--host", default=config.HOST)
        a = p.parse_args(argv[1:])
        import uvicorn
        uvicorn.run("autoseq.server:app", host=a.host, port=a.port)
        return

    p = argparse.ArgumentParser(prog="autoseq", description="Analyze a song into xLights timing tracks")
    p.add_argument("audio")
    p.add_argument("--lyrics", help="text file with the real lyrics (improves words + lip sync)")
    p.add_argument("--no-separate", action="store_true", help="skip Demucs (fast, lower quality)")
    p.add_argument("--split", action="store_true", help="also write one .xtiming per track")
    p.add_argument("--force", action="store_true", help="ignore the cached analysis")
    a = p.parse_args(argv)
    from . import pipeline
    lyr = Path(a.lyrics).read_text() if a.lyrics else None
    result, job = pipeline.analyze(a.audio, lyrics_text=lyr, do_separate=not a.no_separate,
                                   split_xtiming=a.split, force=a.force)
    print(f"\n→ {job / (Path(a.audio).stem + '.xtiming')}\n→ {job / 'analysis.json'}")


if __name__ == "__main__":
    main()
