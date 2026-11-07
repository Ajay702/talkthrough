# voice-first-demo

**Narrated product demo videos for your app, without the editing.** Hiring assignments, launches,
client handoffs and PR reviews all ask for "a short video walking through it". This makes one from your
running app: you talk (or your cloned voice does), and the screen recording builds itself around your words.

```bash
npx voice-first-demo init          # adds a demo/ folder to your project
npx vfd draft --about "invoicing app for freelancers: create and send an invoice"
npx vfd studio                      # read the script aloud once
npx vfd make                        # → demo/final/demo.mp4
```

- **Voice first.** Record narration at your own pace in a little teleprompter. No more re-recording the screen because you stumbled.
- **Your own voice, cloned (optional).** ElevenLabs clones your voice from that one take, then reads every line, with each click landing on the exact word that mentions it.
- **Looks like a person did it.** The cursor glides on a curve, scrolls ease in and out, and typing has human gaps. Real 1080p at 25 fps.
- **AI writes the first draft.** Claude (or OpenAI) looks at your app's pages and writes the script plus the Playwright scenes. You edit, not author.
- **Local first.** Recordings, logins and videos stay in `demo/` (git-ignored). Only the AI calls you turn on leave your machine.

## How it works

```
your app ──► vfd draft (Claude/OpenAI) ──► script.md + scenes.mjs + spoken-lines.json
                                                   │
                vfd studio (Voice studio: teleprompter) ──► your voice, section by section
                                                   │
            ┌──────────────────────────────────────┴───────────────────────────┐
            ▼ voice.provider: 'own'                                             ▼ 'eleven' (your cloned voice) / 'openai'
   vfd record: scenes paced to your recording              vfd voice: speaks each line + time of every word
   vfd render: your voice over the video                   vfd record: actions wait for their words, at('word')
                                                           vfd render: re-times the video so each action lands on its word
            └──────────────────────────────────────┬───────────────────────────┘
                                                   ▼
                                      demo/final/demo.mp4
```

- **Voice studio** (`vfd studio`): a local teleprompter at http://localhost:8766. It shows one section at a
  time and what will be on screen. Press <kbd>Space</kbd> to move on, and listen back or redo any part.
- **Recorder** (`vfd record`): drives a headless browser (Brave if installed, else Chromium) and captures it
  at a steady frame rate. Each scene stretches or squeezes its pauses to fit your timing.
- **Render** (`vfd render`): adds the narration, re-times scenes to the words when using a generated voice,
  and joins the parts into `demo/final/demo.mp4`.

## Two ways to voice it

| | Your own recording (`provider: 'own'`) | Your cloned voice (`provider: 'eleven'`) |
|---|---|---|
| Keys | none | `ELEVENLABS_API_KEY` (plan with instant voice cloning) |
| Sync | scene-level, within a second or two | word-exact: `h.at('Send')` clicks on "Send" |
| Retakes | re-read the part | edit `spoken-lines.json`, run `vfd make` again |

**Whose voice?** Always yours: the clone is made from what *you* record in `vfd studio`, in *your* ElevenLabs
account, with *your* key. Only clone your own voice, or one you have explicit permission to use (ElevenLabs' terms
require this). Delete the clone from your ElevenLabs Voices page whenever you like.

The **cloned voice** reads `spoken-lines.json`: same meaning as the script, but written the way people talk.
That means a light "um", `[pause]` tags (ElevenLabs v3), and names spelled as pronounced ("N-eight-N"). Word
timings come straight from ElevenLabs. `provider: 'openai'` uses an OpenAI stock voice instead, styled by
`voice.style`, with word timings from Whisper.

## Install

Node 18+ and ffmpeg (`brew install ffmpeg` or `apt install ffmpeg`), on macOS or Linux (Windows untested so far). Without Brave, run `npx playwright install chromium` once.

```bash
npm install -D voice-first-demo      # or use npx every time
npx vfd init
npx vfd doctor                        # checks ffmpeg, browser, keys, script ↔ scenes
```

Keys go in `demo/.env` (git-ignored); `npx vfd key ELEVENLABS_API_KEY` asks for one with hidden input and saves it there. You only need the ones for features you use:

| Key | Used for |
|---|---|
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | `vfd draft` writes your script and scenes |
| `ELEVENLABS_API_KEY` | cloning your voice (key permissions: Text to Speech, Voices write) |
| `OPENAI_API_KEY` | `provider: 'openai'` voice, and word timings if ElevenLabs can't give them |

## Usage

1. **`vfd init`** adds `demo/` with `demo.config.mjs`, `script.md`, `scenes.mjs`, `.env.example` and `.gitignore`.
   The starter demos this repo's GitHub page, so `vfd make` works right away.
2. **Point it at your app:** set `appUrl` in `demo.config.mjs`. For pages behind a login, run `vfd session admin`,
   log in in the window that opens, press Enter, and map parts to sessions: `sessions: { part1: 'admin' }`.
3. **`vfd draft --about "..." [--pages /dashboard,/account@customer] [--minutes 3] [--session admin]`** writes the script
   (`@customer` looks at that page as the saved `customer` session),
   the spoken lines and the scenes, plus `DRAFT-NOTES.md` listing what to double-check.
4. **`vfd studio`** to record your voice. Even with a cloned voice you record once: that's what gets cloned.
5. **`vfd make`** → `demo/final/demo.mp4`. Or step by step: `vfd voice`, `vfd record`, `vfd render`.

## Making it yours

`script.md` has `## Part` headings. Each section starts with a bold on-screen cue, followed by what you say:

```md
## Part 1: Sending an invoice
**[Invoice list, click New invoice]**
Let me create one. I'll pick a client, add two lines, and hit Send.
```

`scenes.mjs` has one scene per section, written with ordinary Playwright calls plus helpers (`h`):

```js
export default (h) => ({
  part1: [
    async (page) => {
      await h.clickEl(page, page.getByRole('button', { name: 'New invoice' }))   // slow actions first
      await h.at('client'); await h.hoverText(page, 'Acme Ltd')                    // on the word "client"
      await h.at('Send');   await h.clickEl(page, page.getByRole('button', { name: 'Send' }))
    },
  ],
})
```

### Scene helpers

| Helper | What it does |
|---|---|
| `at('word')` | wait until that word is spoken in this section (generated voice; no-op for your own recording) |
| `hold(s)` | a pause that stretches to your pace |
| `moveTo(page, x, y)`, `moveToEl(page, loc)` | glide the cursor like a hand |
| `clickEl(page, loc)`, `typeHuman(page, loc, text)` | move, then click; type with human gaps |
| `scrollSmooth(page, y)`, `scrollToText(page, text)` | eased scrolling |
| `hoverText(page, text)`, `hoverBadge(page, label)` | point at text; `hoverBadge` picks the right-most match (status badges) |
| `waitText(page, /re/, s)`, `caption(page, text)` | wait for something to appear; show a caption at the top |

Optional `export const open = { part2: async (page, h) => ... }` sets where a part starts (default: `appUrl`).

## Tips that took some finding

- Speech is faster than a UI. Typing a name or loading a page takes longer than saying "I'll open it", so start slow
  actions at the top of a scene. Render speeds stretches up (max 3×) or holds a frame so actions still land on their words.
- Logging out of the app ends a saved session. Record before logging out, or run `vfd session` again.
- For a closer accent match, record a minute of natural talk (not reading) in the studio before cloning. Delete
  `demo/tts/eleven_voice_id.txt` to re-clone.
- Check product names in the transcript (`demo/tts/<part>.words.json`) and spell them phonetically in `spoken-lines.json`.
- If your demo sends emails or changes data, point it at a test account. Every `vfd make` runs the scenes for real.
- Reset state between scenes by reloading the page. Many apps' "Clear filters" buttons leave the inputs filled.

## Contributing

Issues and PRs are welcome: new helpers, more voice providers, Windows support, better drafts. Run
`node bin/vfd.mjs doctor` in a test project before opening a PR.

## License

MIT. Built with help from Claude Code (Anthropic).
