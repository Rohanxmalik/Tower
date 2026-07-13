# The 20-second demo GIF — production script

One GIF, two placements: the **README hero** (first thing a visitor sees) and the
**Show HN** post. It has to prove the whole claim in one breath: *type a task on your
phone, a machine somewhere does the work, you get a PR link.*

Target: **≤ 25 seconds, 800 px wide, ≤ 10 MB** (GitHub renders README images up to
10 MB — over that, the hero is a broken link).

## The shot

One continuous frame, split-screen:

- **Left:** the board (`/board`) on a phone — real phone via scrcpy, or browser
  device mode.
- **Right:** the worker's terminal (`tower work --auto`), visible the whole time.

The viewer must see both sides *simultaneously* — the phone commanding, the terminal
obeying. That juxtaposition is the product.

## Shot list

| Time    | On screen                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0–3s    | Board open on the phone, worker terminal idle alongside (`tower work` banner + polling). One beat of stillness — let it register.  |
| 3–8s    | Type into the send box: **"Add a /ping route to server.js"**. Pick the live worker in the recipient dropdown. Tap **Delegate**.    |
| 8–15s   | The worker terminal wakes: task accepted, branch created, headless `claude` runs. Board chip flips OPEN → ACCEPTED.                 |
| 15–20s  | Terminal prints `✅ task … done — branch tower/task-… · <PR link>`. Board chip flips to **DONE** with the PR link. Tap the link.    |

End on the PR page (or the DONE chip if the PR page is too busy) — hold 1 second, cut.

## Reality check: the run takes minutes, not seconds

A real headless run is 1–3 minutes. Don't fake it — **time-compress it**. Record the
whole thing, keep 0–8s real-time, then speed-ramp the middle (6–8×) until the `✅`
appears, and return to real-time for the finish. A visible speed-up reads as "the
machine is working", which is honest and looks good. Every editor (even Clipchamp,
preinstalled on Windows 11) can do a speed ramp.

Pick a task that genuinely finishes fast: "Add a /ping route to server.js" against a
small Express demo repo is ideal — one file, one obvious diff, real PR.

## Prep checklist (before recording)

- A **demo repo** (small Express app with `server.js`), pushed to GitHub, `gh` authed
  on the worker machine so the PR actually opens.
- Team Tower running (Render or local `--http`), board open and authed
  (`/board#token=<your-token>` once, then it's saved).
- Worker running in the demo repo with `--auto` (no approval pause in this cut):
  `npx -y tower-mcp work --auto` — confirm the board shows it **online** in the
  recipient dropdown before you roll.
- Clean working tree on the worker clone (the preflight refuses a dirty tree).
- Terminal: readable font (16 pt+ at 800 px final width), dark theme, window sized so
  the interesting lines aren't buried.
- Do one full dry run. The second take is always the keeper.

## Capture setup (Windows)

**Phone side, pick one:**

- **scrcpy** (real phone, USB): `scrcpy --max-size 1080 --window-title Board` — mirror
  the phone with the board open. Most convincing option; you see a thumb tap Delegate.
- **Browser device mode**: F12 → device toolbar → iPhone-ish preset on
  `https://tower-xxxx.onrender.com/board`. Faster to set up, still reads as "phone".

**Layout:** phone mirror left, Windows Terminal right, snapped side-by-side
(Win+Left / Win+Right). Hide everything else — taskbar auto-hide, no notifications
(Focus Assist on).

**Record, pick one:**

- **OBS Studio** — best control: a Display Capture scene cropped to the two windows,
  1600×900 canvas, 30 fps, record to MP4.
- **Xbox Game Bar** (built in) — Win+Alt+R records the focused window; simpler but
  captures one window, so prefer OBS for the split-screen.

## Convert to GIF

**ffmpeg** (two-pass palette — the difference between a crisp GIF and a muddy one):

```bash
# Pass 1: build the palette
ffmpeg -i demo.mp4 -vf "fps=12,scale=800:-1:flags=lanczos,palettegen" palette.png
# Pass 2: render with it
ffmpeg -i demo.mp4 -i palette.png -filter_complex "fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" demo.gif
```

**gifski** (often smaller/prettier, `cargo install gifski` or the release binary):

```bash
gifski --fps 12 --width 800 --quality 80 -o demo.gif demo.mp4
```

Over 10 MB? In order of least pain: drop `--quality` / raise `bayer_scale`, cut the
hold frames tighter, drop fps to 10, narrow to 720 px. Terminal + board content
survives all four.

## Embed

README, directly under the tagline (the maintainer pastes this — this file doesn't
touch the README):

```markdown
![Delegate a task from your phone; a worker machine ships the PR](docs/demo.gif)
```

Commit the GIF as `docs/demo.gif`. Site placement: same asset as the hero on the
landing page, above the fold, `<img>` not autoplay video — GIFs need no play button
and no codec debates. Keep `docs/demo.svg` (the existing terminal demo) further down;
the GIF is the opener, the SVG is the detail.
