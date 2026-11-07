// One scene per script section, in order. Each scene gets the Playwright page; helpers come in as `h`.
// h.at('word') waits for that word in the generated voice (no-op with your own recording),
// h.hold(s) is a pause that stretches to your pace. See README "Scene helpers" for the rest.

// Where each part starts (default: appUrl).
export const open = {
  part2: async (page, h) => {
    await page.goto(h.appUrl, { waitUntil: 'domcontentloaded' })
    await h.sleep(1.5)
    await h.scrollToText(page, 'Two ways to voice it', 110)
  },
}

export default (h) => ({
  part1: [
    // [The repo page]
    async (page) => {
      await h.moveTo(page, 420, 230, 40)
      await h.at('voice'); await h.hoverText(page, 'voice-first-demo', false)
      await h.at('screen'); await h.moveTo(page, h.W * 0.45, 520, 40)
      await h.hold(2)
    },
    // [How it works]
    async (page) => {
      await h.at('flips', 0.8); await h.scrollToText(page, 'How it works', 110)
      await h.at('teleprompter'); await h.hoverText(page, 'Voice studio', false)
      await h.at('recorder'); await h.hoverText(page, 'Recorder', false)
      await h.hold(2)
    },
  ],
  part2: [
    // [Two ways to voice it]
    async (page) => {
      await h.at('clone'); await h.hoverText(page, 'cloned voice', false)
      await h.hold(3)
    },
    // [Making it yours]
    async (page) => {
      await h.at('scenes', 0.8); await h.scrollToText(page, 'Making it yours', 110)
      await h.at('word'); await h.hoverText(page, "at('word')", false)
      await h.hold(2)
    },
  ],
})
