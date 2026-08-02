/**
 * The Gemini speech catalogue: which models can talk, which voices they have,
 * and which ones Forge picks when nobody has said.
 *
 * It lives in `shared/` because both ends need the same list and neither may
 * import the other: the main process calls the API with these names
 * (electron/gemini-tts.ts) and the Settings page has to offer every one of them
 * with a sample button (src/components/settings/VoiceSection.tsx). One list, so
 * a voice cannot exist in the picker and not in the request.
 *
 * Free of any import on purpose — `shared/` is loaded by the renderer, by the
 * main process and by voice:check under bare Node.
 */

/** Newest and fastest of the three, and the default. */
export const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview'

/**
 * Tried automatically when the default is out of quota or unavailable to the
 * key. Its rate limit is a separate bucket, which is the entire point: on a
 * free AI Studio key the 3.1 preview 429s after roughly six sentences a minute.
 */
export const FALLBACK_TTS_MODEL = 'gemini-2.5-flash-preview-tts'

export interface TtsModelSpec {
  id: string
  label: string
  /** One line for the Settings row. Latencies are measured, not quoted. */
  hint: string
}

/**
 * Every TTS model Steve's key can reach, newest first. All three were verified
 * live on 2026-07-30; the timings are for a one-sentence reply.
 */
export const TTS_MODELS: readonly TtsModelSpec[] = [
  { id: DEFAULT_TTS_MODEL, label: 'Flash 3.1', hint: 'Newest and quickest — about two seconds' },
  { id: FALLBACK_TTS_MODEL, label: 'Flash 2.5', hint: 'The fallback. About three seconds' },
  { id: 'gemini-2.5-pro-preview-tts', label: 'Pro 2.5', hint: 'Slowest at about five seconds' }
]

/**
 * The default voice.
 *
 * Picked on Google's own one-word descriptions rather than a hunch: of the
 * thirty prebuilt voices exactly one is documented as **Warm**, and warm is the
 * precise opposite of the complaint that started this. Everything else is one
 * click away in Settings › Voice, with a sample button, because it is his ear.
 */
export const DEFAULT_TTS_VOICE = 'Sulafat'

export interface TtsVoice {
  name: string
  /** Google's own one-word description. Shown verbatim in Settings. */
  character: string
}

/**
 * The thirty prebuilt voices, with Google's published descriptions.
 *
 * Zephyr, Puck, Charon, Kore, Fenrir and Leda were confirmed live against
 * `gemini-3.1-flash-tts-preview` on 2026-07-30 before the key hit its
 * per-minute quota; the rest are Google's published list. Nothing is invented —
 * a name the API does not know comes back as a 404 and the engine chain falls
 * to the local voice, so a name that ever disappears costs a sentence rather
 * than silence.
 */
export const TTS_VOICES: readonly TtsVoice[] = [
  { name: 'Zephyr', character: 'Bright' },
  { name: 'Puck', character: 'Upbeat' },
  { name: 'Charon', character: 'Informative' },
  { name: 'Kore', character: 'Firm' },
  { name: 'Fenrir', character: 'Excitable' },
  { name: 'Leda', character: 'Youthful' },
  { name: 'Orus', character: 'Firm' },
  { name: 'Aoede', character: 'Breezy' },
  { name: 'Callirrhoe', character: 'Easy-going' },
  { name: 'Autonoe', character: 'Bright' },
  { name: 'Enceladus', character: 'Breathy' },
  { name: 'Iapetus', character: 'Clear' },
  { name: 'Umbriel', character: 'Easy-going' },
  { name: 'Algieba', character: 'Smooth' },
  { name: 'Despina', character: 'Smooth' },
  { name: 'Erinome', character: 'Clear' },
  { name: 'Algenib', character: 'Gravelly' },
  { name: 'Rasalgethi', character: 'Informative' },
  { name: 'Laomedeia', character: 'Upbeat' },
  { name: 'Achernar', character: 'Soft' },
  { name: 'Alnilam', character: 'Firm' },
  { name: 'Schedar', character: 'Even' },
  { name: 'Gacrux', character: 'Mature' },
  { name: 'Pulcherrima', character: 'Forward' },
  { name: 'Achird', character: 'Friendly' },
  { name: 'Zubenelgenubi', character: 'Casual' },
  { name: 'Vindemiatrix', character: 'Gentle' },
  { name: 'Sadachbia', character: 'Lively' },
  { name: 'Sadaltager', character: 'Knowledgeable' },
  { name: 'Sulafat', character: 'Warm' }
]

const VOICE_NAMES = new Set(TTS_VOICES.map((v) => v.name))

export function isTtsVoice(name: string): boolean {
  return VOICE_NAMES.has((name ?? '').trim())
}

export function isTtsModel(id: string): boolean {
  return TTS_MODELS.some((m) => m.id === (id ?? '').trim())
}

/**
 * The line the sample button says.
 *
 * A real reply rather than "the quick brown fox": what he is choosing between
 * is how the agent will sound saying the thing it says most.
 */
export const TTS_SAMPLE_LINE = 'Right — three Claude Code terminals, up and running.'

/* ------------------------------------------------------------- edge voices */

/**
 * The default Edge neural voice: warm, female, British — the character Steve
 * described wanting back when the agent "went back to a robot voice". Sonia is
 * the voice Edge's own Read Aloud defaults to for en-GB, which is as
 * road-tested as a free voice gets.
 */
export const DEFAULT_EDGE_VOICE = 'en-GB-SoniaNeural'

export interface EdgeVoice {
  /** The short name the endpoint wants, e.g. `en-GB-SoniaNeural`. */
  name: string
  /** What the picker shows. */
  label: string
  /** One-line character note, same shape as the Gemini list. */
  character: string
}

/**
 * A curated dozen rather than the full ~500 the endpoint serves: a picker of
 * five hundred names nobody can audition is worse than one of twelve you can.
 * All are multilingual-capable neural voices that exist on the readaloud
 * endpoint today; an unknown name fails the request cleanly and the chain
 * falls to the next engine, so a voice Microsoft retires costs a sentence,
 * not silence.
 */
export const EDGE_VOICES: readonly EdgeVoice[] = [
  { name: 'en-GB-SoniaNeural', label: 'Sonia — British', character: 'Warm. The default' },
  { name: 'en-GB-LibbyNeural', label: 'Libby — British', character: 'Bright' },
  { name: 'en-GB-MaisieNeural', label: 'Maisie — British', character: 'Youthful' },
  { name: 'en-GB-RyanNeural', label: 'Ryan — British', character: 'Calm, male' },
  { name: 'en-GB-ThomasNeural', label: 'Thomas — British', character: 'Even, male' },
  { name: 'en-IE-EmilyNeural', label: 'Emily — Irish', character: 'Gentle' },
  { name: 'en-AU-NatashaNeural', label: 'Natasha — Australian', character: 'Easy-going' },
  { name: 'en-US-AriaNeural', label: 'Aria — American', character: 'Expressive' },
  { name: 'en-US-JennyNeural', label: 'Jenny — American', character: 'Friendly' },
  { name: 'en-US-MichelleNeural', label: 'Michelle — American', character: 'Clear' },
  { name: 'en-US-GuyNeural', label: 'Guy — American', character: 'Newsreader, male' },
  { name: 'en-US-ChristopherNeural', label: 'Christopher — American', character: 'Deep, male' }
]

const EDGE_VOICE_NAMES = new Set(EDGE_VOICES.map((v) => v.name))

/**
 * A name we are willing to send. Looser than the Gemini check on purpose: the
 * endpoint knows hundreds of voices this list does not, and someone who types
 * `de-DE-KatjaNeural` into settings.json should get Katja, not Sonia. The
 * shape check is what keeps arbitrary strings out of the SSML.
 */
export function isEdgeVoice(name: string): boolean {
  const v = (name ?? '').trim()
  return EDGE_VOICE_NAMES.has(v) || /^[a-z]{2,3}-[A-Za-z]{2,10}-[A-Za-z0-9]{2,40}Neural$/.test(v)
}
