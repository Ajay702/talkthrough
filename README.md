# voice-first-demo

Make a narrated product demo video by recording your **voice first** and letting the
**screen recording build itself around your timing**.

Usually you record the screen, then struggle to talk over it at the right moments. This
flips it. You read a script at your own pace, the tool notes when you move to each
section, and a headless browser then performs each scene to fit what you said.
Optionally, your voice is cloned so every on-screen action lands **exactly on the word** that mentions it.

## How it works

```
script.md ──► Voice studio (teleprompter) ──► voice/<part>.webm + marks.json
                                                     │
              ┌──────────────────────────────────────┴───────────────────────────┐
              ▼  your own recording                                               ▼  cloned / AI voice
   record.mjs: one scene per section,                  tts-remap.mjs: speak each line (ElevenLabs clone
   paced to your timing                                of your takes, or an OpenAI voice)
              │                                        build-voice.mjs: voice track + time of every word
              ▼                                        record.mjs: actions wait for their words (at('word'))
   merge.sh ──► final/demo.mp4                         warp.mjs: re-time the video piece by piece so each
                                                       action starts on its word ──► final/part*-synced.mp4
```

- **Voice studio** (`voiceover_server.py` + `voiceover.html`): a local teleprompter. It shows
  one section of `script.md` at a time, what will be on screen, and a suggested duration.
  Press <kbd>Space</kbd> to move to the next section.
- **Recorder** (`record.mjs`): drives a headless browser and captures it at a steady 25 fps
  (Chrome DevTools screencast, cropped to 1920×1080). The cursor moves like a hand: eased, on a
  slight curve. Scrolls glide, typing has human gaps, and a red dot shows the pointer.
- **Merge** (`merge.sh`): normalises loudness, puts the voice on each part and joins the parts.

## Two ways to voice it

**1. Your own recording.** Fast, and it's really you. Scenes stretch or squeeze their pauses
(0.4× to 2.5×) to fit how long you spoke, so scene changes land within a second or two.

**2. A cloned voice (or an AI voice), synced to the word.** Your studio takes are uploaded once to
ElevenLabs as an instant clone of your voice. The clone then reads each line, from
`spoken-lines.json` if you want natural "um"s and `[pause]` tags (ElevenLabs v3), or from `script.md`.
`build-voice.mjs` transcribes the result (OpenAI Whisper) to get the time of every word. In your scenes,
`await at('Generate')` waits for that word, and `warp.mjs` speeds up slow stretches such as page loads
and typing, or holds a frame, so each logged action starts exactly on its word. No OpenAI or ElevenLabs
account? Use way 1.

## Requirements

macOS or Linux with Node 18+, Python 3.10+ and ffmpeg. It uses Brave if installed,
otherwise Playwright's Chromium (or set `BROWSER_PATH`). For way 2: an ElevenLabs plan that
includes instant voice cloning, and an OpenAI API key for the word timings.

```bash
npm install
npx playwright install chromium   # only if you don't have Brave
```

## Usage

1. **Write the script.** `script.md` has `## Part 1` / `## Part 2` headings. Each section starts with a
   bold on-screen cue like `**[Main chart: hover over a point]**`, followed by the lines to say.
2. **Record your voice.** `npm run studio`, open http://localhost:8766, pick a part, press Start and read.
3. **Way 1, your recording:** `npm run record`, then `npm run merge` → `final/demo.mp4`.
4. **Way 2, cloned voice, synced to the word** (keys in your environment, never in the repo):
   ```bash
   npm run record                # once, so each scene's clip exists for the quick preview
   npm run voice:clone           # clone + speak every line   → final/demo-myvoice.mp4 (section-level sync)
   npm run voice:words           # voice track + word times   → voice-el/
   npm run record:synced         # actions wait for their words, timestamps logged
   npm run warp                  # → final/part1-synced.mp4, final/part2-synced.mp4
   ```
   `npm run voice:openai` does the same with an OpenAI stock voice; set `TTS_STYLE` to describe how it should sound.

Your recordings, voices, sessions and videos (`voice/`, `voice-el/`, `tts/`, `out/`, `final/`, `state/`)
are git-ignored and stay on your machine, apart from the API calls you choose to make in way 2.

## Making it yours

Each scene in `record.mjs` is `[name, wordCount, async (page) => { ... }]` and matches one script section.
Set `APP_URL`, then write the scenes with ordinary Playwright calls and the helpers:

- `await at('word')` waits until that word is spoken (way 2), so the click lands as you say it.
- `hold(seconds)` is a pause that stretches to fit your timing (way 1).
- `moveTo`, `moveToEl`, `scrollToText`, `typeHuman`, `clickEl`, `hoverText`, `caption` give human-looking motion.

The included example has the tool demo its own GitHub page, so it runs with no login.

**Logged-in apps:** start your browser with `--remote-debugging-port=9333`, log in (and stay logged in:
logging out ends the session), then `SESSION_DOMAINS="yourapp.com" node save-session.mjs part1`. The recorder
loads `state/<part>.json` automatically. Delete those files when you're done.

A few details that took some finding:
- Brave's headless screencast leaves out the bottom 81 px of the viewport, so the viewport is
  made taller and the frame is cropped back to 1920×1080.
- GitHub pages never go fully network-idle, so page loads wait for content, not for the network.
- Speech is faster than a UI: typing a name and loading a page take longer than saying "I'll open it".
  Start slow actions early in the section, and let `warp.mjs` absorb the rest (it caps speed-ups at 3×).
- Write tricky names phonetically in `spoken-lines.json` (for example "N-eight-N"), and check the transcript.

## AI note

Built with help from Claude Code (Anthropic).
