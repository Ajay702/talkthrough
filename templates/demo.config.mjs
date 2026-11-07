// voice-first-demo settings for this project. Keys go in demo/.env (git-ignored), never here.
export default {
  // Where the recorder starts. Scenes can navigate anywhere from here.
  appUrl: 'https://github.com/Ajay702/voice-first-demo',

  // Logged-in pages: run `vfd session admin` once, then map parts to sessions.
  sessions: {
    // part1: 'admin',
  },

  voice: {
    // 'eleven' = clone YOUR voice from your studio takes (ElevenLabs), lines land on the exact word
    // 'openai' = an OpenAI stock voice, styled by `style`
    // 'own'    = use your studio recording as it is (no AI voice, no API key)
    provider: 'own',
    // elevenModel: 'eleven_v3',
    // openaiVoice: 'ash',
    // style: 'Warm, relaxed developer showing a project to a colleague. Light Indian English accent.',
  },

  // Who writes the first draft in `vfd draft`: 'auto' uses Claude if ANTHROPIC_API_KEY is set, else OpenAI.
  llm: { provider: 'auto' /*, anthropicModel: 'claude-opus-5-5', openaiModel: 'gpt-4.1' */ },
}
