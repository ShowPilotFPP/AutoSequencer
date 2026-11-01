# AutoSeq

A personal auto-sequencer for xLights. A Node/Express app (library, uploads, downloads) drives a Python analysis worker. The worker separates the song into stems and finds beats, bars, drum hits, chords, sections, lyrics, and mouth shapes, then writes them all as xLights timing tracks.

```
browser ──► app/ (Node 22 + Express + SQLite, port 3075) ──► worker/ (Python, 127.0.0.1:5051)
                         data/uploads, data/autoseq.db          data/analysis/jobs/<song hash>/
```

## Install (Ubuntu 22.04/24.04 LXC or VM)

```bash
git clone git@github.com:ShowPilotFPP/AutoSequencer.git /opt/autoseq   # private: needs the deploy key, see below
cd /opt/autoseq
bash setup_ubuntu.sh
```

The script installs ffmpeg, Node 22 and PM2 (if they're missing), and a Python 3.11 virtualenv for the worker via `uv`, so the system Python is untouched. It also installs CPU-only PyTorch, Demucs, the DrumSep drum-split model, beat_this, faster-whisper, basic-pitch, and Rhubarb Lip Sync, then starts both processes under PM2 and runs `pm2 save`.

**Updating:** the version chip in AutoSeq's header turns into an **Update available** button when `main` on GitHub has something new (hover it to see what changed). Click it and AutoSeq installs the update and restarts itself in a few seconds. From a shell it's `/opt/autoseq/scripts/update.sh`, or `scripts/update.sh <tag or commit>` to go back to an older version. Only what changed gets rebuilt: Node packages, Python packages, or the worker. `data/`, `bin/` and `worker/.venv/` are never touched. The log is in `data/update.log`.

**Linking an existing install to GitHub (once):** the repo is private, so the server reaches it with a read-only deploy key. On the server, as root:

```bash
# copy scripts/setup-github.sh into /opt/autoseq once (it's one small file), then:
sudo bash /opt/autoseq/setup-github.sh
```

It makes the key, prints it with the link to GitHub's *Settings > Deploy keys* page, waits while you add it, then turns `/opt/autoseq` into a checkout of `main` and restarts. Your songs and settings stay where they are.

**Shipping a change:** changes arrive as pull requests; merging one into `main` is what makes it show up as an update. Tag a commit (`v1.1.0`) whenever you want a named version to roll back to.

Then open `http://<container-ip>:3075`. To expose it like your other apps, point a Cloudflare Tunnel at `localhost:3075`. The worker only listens on 127.0.0.1.

**Container sizing:** 4+ cores, 8 GB RAM minimum (Demucs alone needs 4–6 GB on a 3-minute song, and running out kills it silently), and 30–40 GB of disk. Models and the venv take about 8 GB. Each song needs about 250 MB while it's being analyzed, then about 40 MB once its stems are cleaned up (see `KEEP_STEMS`). The first song downloads roughly 2 GB of models. After that, expect about 6–9 minutes per song on CPU, mostly Demucs, DrumSep and Whisper. Re-opening the same song is instant, because results are cached by audio hash.

## Day to day

```bash
pm2 status
pm2 logs autoseq-worker     # analysis progress and errors
pm2 restart autoseq autoseq-worker
```

In xLights, open the song's sequence, right-click the timing area, choose **Import Timing Track**, select the downloaded `.xtiming`, and tick the tracks you want.

## Tracks you get

These are Beats (numbered 1–4), Downbeats, Sections, Chords (power chords show as C5, G5, and so on), Kick, Snare, Toms, Hihat, Crash, a notes track per instrument that's actually playing, and Lyrics. Lyrics has three layers (phrases, words, mouth shapes) in xLights' own lyric format, so Singing Face effects use it directly.

## Settings

Worker settings are environment variables in `ecosystem.config.js`, prefixed `AUTOSEQ_`:

| Variable | Default | |
|---|---|---|
| `FRAME_MS` | 25 | Snap marks to your sequence timing (50 for 20 fps) |
| `WHISPER_MODEL` | large-v3-turbo | `medium.en` is faster on weak CPUs |
| `DEVICE` | auto | Uses CUDA automatically if the box has an NVIDIA GPU |
| `STEM_MIN_SHARE` | 0.02 | How much of the mix a stem needs before its notes are transcribed |
| `KEEP_STEMS` | vocals | What to keep after analysis: `vocals` (enough for "Redo lyrics only"), `all` (a full re-run skips Demucs, but costs ~250 MB per song), or `none` |
| `NOTES` | 0 | `1` turns on note tracks per instrument (basic-pitch). Off by default: the sequencer doesn't use them yet, and they cost about a minute per song |
| `DEMUCS_OVERLAP` | 0.1 | Demucs segment overlap; its default 0.25 is about 15% slower |
| `FORCED_ALIGN` | 1 | Re-time every lyric word against the vocal with torchaudio's MMS forced aligner (downloads about 1.2 GB once) |
| `ALIGN_MIN_SCORE` | 0.1 | How sure the aligner must be before a line takes its timing; less sure lines keep the earlier estimate |
| `DRUMSEP` | 1 | `0` skips the kick/snare/cymbal/tom split and detects drums from the drum stem alone |

**Re-running a song:** "Redo lyrics only" re-transcribes the saved vocal stem, optionally using lyrics you paste in, and takes a minute or two. "Re-run everything" redoes the whole analysis, including Demucs if its stems were cleaned up.

After changing one, run `pm2 restart autoseq-worker --update-env`.

## Without the web app

```bash
cd worker && .venv/bin/python -m autoseq /path/song.mp3 --split
```

`--split` also writes one `.xtiming` file per track, for older xLights builds. `--no-separate` is a fast, lower-quality test mode. `--force` ignores the cache.

## Sequences (phase 2)

On the **Layout** tab, upload `xlights_rgbeffects.xml` from your show folder. AutoSeq lists your props and groups and suggests a role for each: background, bar sweeps, kick, snare, toms, crash, singing face, and matrix visuals. Tick whatever you want instead, pick the default singing face, and enter the folder your songs live in on the xLights machine, so the sequence finds its audio. Then **Save**.

Each analyzed song then gets a **Download sequence (.xsq)** button. Save the file in your show folder and open it in xLights. Every role sits on its own layer per prop, so anything you don't like can be deleted or edited by hand.

How the effects are chosen:
- **Sections** set the look: palette, effect type, and brightness. Brightness is stretched to the song's own quiet-to-loud range.
- **Drum hits** become decaying flashes, coloured by the chord underneath them. Kicks round-robin across props in big sections.
- **Toms** step across props left to right during fills.
- **The singing face** follows the lyric track, while the matrix background dims under it.

The rules live in `app/sequencer/recipes.js`.

## Preview on your house

**Preview on my house** on a song plays the planned show on your layout, in the browser, with the song. The wheel moves around, Ctrl + wheel (or a trackpad pinch) zooms at the cursor, and you can drag to pan. *Fit* resets the view, the pixel-size slider makes small props easier to see, and space plays or pauses. The effects are drawn in simplified form from the same plan the .xsq is written from, so it's a guide; xLights' render is the final word.

## Choosing your show folder

On the Show layout page, **Choose show folder** and pick your xLights show folder (the one with `xlights_rgbeffects.xml` in it). In Chrome or Edge the folder is read right in the browser: the layout is sent to AutoSeq and re-sent whenever you save it in xLights, singing-face pictures are found by file name inside the folder, and **Save sequence to show folder** writes the .xsq straight into it. Chrome remembers the folder; it may ask once per visit, or choose "Allow on every visit".

The browser only offers this on a secure page: https, or localhost. Over plain `http://192.168.x.x:3075` Chrome hides it, and the button falls back to reading the folder once per visit, with no remembering and no saving. Either serve AutoSeq over https (for example through Nginx Proxy Manager with a Let's Encrypt certificate, `autoseq.yourdomain`), or in Chrome open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.1.143:3075`, and relaunch.

## Alternative: mounting the show folder on the server

With the show folder mounted, AutoSeq reads `xlights_rgbeffects.xml` straight from it, re-reads it whenever you save in xLights, and finds your singing-face pictures there. The pictures are matched by file name in the show folder and the folder above it, so Faces folders shared between shows work too.

**On the Mac** (System Settings > General > Sharing > File Sharing): turn it on, add `Documents/Light Shows` as a shared folder, and under Options tick "Share files and folders using SMB" plus your user.

**On the Proxmox host** (an unprivileged LXC can't mount SMB itself, so the host mounts it and passes it through):

```bash
apt install cifs-utils
mkdir -p /mnt/lightshows
printf 'username=will\npassword=YOUR_MAC_PASSWORD\n' > /root/.mac-cred && chmod 600 /root/.mac-cred
echo '//MAC-IP/Light Shows /mnt/lightshows cifs credentials=/root/.mac-cred,ro,uid=100000,gid=100000,iocharset=utf8,vers=3.0,_netdev,nofail 0 0' >> /etc/fstab
mount /mnt/lightshows
pct set <CTID> -mp0 /mnt/lightshows,mp=/mnt/lightshows,ro=1
pct reboot <CTID>
```

Then on the Show layout page enter `/mnt/lightshows/Halloween Light Show`.

## Colours from the album cover

The default *Look* is **From the album cover**: the song is looked up on the iTunes Search API, and the cover's strongest colours (boosted to full brightness) become the show's palette, with each kind of section leading with a different pair. If no cover is found, or it's nearly one colour, it falls back to *Auto*.

## Credits

The effect presets, themes and effect parameter catalog in `app/sequencer/library/` come from
[x-onset / xlights-autosequencer](https://github.com/derwin12/xlights-autosequencer) by derwin12,
MIT licensed (see `app/sequencer/library/LICENSE-xonset`). The published-lyrics lookup uses
`syncedlyrics`, an idea taken from the same project. So are several sequencing rules: matching
props (all the trees, all the stars) moving together on every beat in the big parts, washes fading
in and out by length, long effects flipping direction every 4 bars, shader speeds by intensity, and
guard rails for Pinwheel, Spirals, Wave and Color Wash.
