import type { AgentProfile } from './types'
import { commandExe, isShellProfile } from './agents'

/**
 * The maker's mark for each agent Forge knows, drawn in the top-left corner of
 * every terminal (desktop and Forge Web both render `src/components/AgentBadge`,
 * which reads this file). One source, so the two faces can never disagree about
 * what Claude looks like.
 *
 * Every mark is a real brand mark, inlined as path data so there is no runtime
 * dependency. Sources, per entry:
 *   - Simple Icons 16.32.0 (CC0), `icons/<slug>.svg`
 *   - LobeHub icons-static-svg 1.95.1 (MIT), `icons/<name>.svg` — used only
 *     where Simple Icons has no mark (OpenAI, xAI's Grok, Z.ai, Antigravity)
 * The shell glyph is Forge's own drawing, not anybody's brand.
 *
 * The shape is the identifier; colour is only a second cue (Steve is red-green
 * colourblind). All viewBoxes are 24×24, so the badge can size them as squares.
 */

export type AgentLogoKey =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'antigravity'
  | 'grok'
  | 'kimi'
  | 'qwen'
  | 'deepseek'
  | 'zai'
  | 'opencode'
  | 'shell'

export interface AgentLogoPath {
  d: string
  /**
   * Paint this path in the theme's ink rather than the brand colour — for a
   * two-tone mark (Kimi's K is ink, its dot is the brand blue).
   */
  ink?: boolean
}

export interface AgentLogo {
  key: AgentLogoKey
  /** Whose mark this is, e.g. "Anthropic Claude". */
  label: string
  viewBox: string
  paths: AgentLogoPath[]
  evenOdd?: boolean
  /**
   * The brand colour, tuned per surface so it clears 3:1 on both the dark
   * themes' headers and Paper's. Absent = a monochrome brand (OpenAI, Grok,
   * Z.ai, OpenCode), drawn in the theme's own ink so it never vanishes.
   */
  color?: { dark: string; light: string }
}

export const AGENT_LOGOS: Record<AgentLogoKey, AgentLogo> = {
  // Simple Icons `claude` — the Claude spark, Anthropic's product mark.
  claude: {
    key: 'claude',
    label: 'Anthropic Claude',
    viewBox: '0 0 24 24',
    color: { dark: '#D97757', light: '#C15F3C' },
    paths: [
      {
        d: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
      }
    ]
  },
  // LobeHub `openai` — the OpenAI blossom. Simple Icons withdrew OpenAI's mark.
  openai: {
    key: 'openai',
    label: 'OpenAI',
    viewBox: '0 0 24 24',
    evenOdd: true,
    paths: [
      {
        d: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z'
      }
    ]
  },
  // Simple Icons `googlegemini` — the Gemini sparkle, in its brand violet.
  gemini: {
    key: 'gemini',
    label: 'Google Gemini',
    viewBox: '0 0 24 24',
    color: { dark: '#8E75B2', light: '#7B5EA7' },
    paths: [
      {
        d: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81'
      }
    ]
  },
  // LobeHub `antigravity` — Google Antigravity's arch, in Google's own blues.
  antigravity: {
    key: 'antigravity',
    label: 'Google Antigravity',
    viewBox: '0 0 24 24',
    evenOdd: true,
    color: { dark: '#8AB4F8', light: '#1A73E8' },
    paths: [
      {
        d: 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z'
      }
    ]
  },
  // LobeHub `grok` — xAI's Grok mark. Monochrome brand.
  grok: {
    key: 'grok',
    label: 'xAI Grok',
    viewBox: '0 0 24 24',
    evenOdd: true,
    paths: [
      {
        d: 'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815'
      }
    ]
  },
  // Simple Icons `kimi` — Moonshot's K in ink, its dot in Kimi blue (the blue
  // from LobeHub `kimi-color`).
  kimi: {
    key: 'kimi',
    label: 'Moonshot Kimi',
    viewBox: '0 0 24 24',
    color: { dark: '#1783FF', light: '#1783FF' },
    paths: [
      {
        d: 'M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35'
      },
      {
        ink: true,
        d: 'M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441'
      }
    ]
  },
  // Simple Icons `qwen` — Alibaba's Qwen hexagram, in its brand violet.
  qwen: {
    key: 'qwen',
    label: 'Alibaba Qwen',
    viewBox: '0 0 24 24',
    color: { dark: '#8F7DFF', light: '#6950EF' },
    paths: [
      {
        d: 'M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z'
      }
    ]
  },
  // Simple Icons `deepseek` — the DeepSeek whale, in its brand blue.
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    viewBox: '0 0 24 24',
    color: { dark: '#6F88FF', light: '#4D6BFE' },
    paths: [
      {
        d: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45'
      }
    ]
  },
  // LobeHub `zai` — Z.ai (formerly Zhipu), maker of GLM. Monochrome brand.
  zai: {
    key: 'zai',
    label: 'Z.ai GLM',
    viewBox: '0 0 24 24',
    evenOdd: true,
    paths: [
      {
        d: 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z'
      }
    ]
  },
  // Simple Icons `opencode` — OpenCode's framed square. Monochrome brand.
  opencode: {
    key: 'opencode',
    label: 'OpenCode',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' }]
  },
  // Forge's own: a prompt chevron and cursor. Deliberately nobody's brand.
  shell: {
    key: 'shell',
    label: 'Shell',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M2.6 5.4 4.4 3.6 12.8 12l-8.4 8.4-1.8-1.8L9.2 12zM13 18h9v2.6h-9z' }]
  }
}

/** Plain shells a custom profile might name as its command. */
const SHELL_EXES = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'nu', 'wsl'])

/** Which CLI is which maker, by its executable. */
const EXE_LOGOS: Record<string, AgentLogoKey> = {
  claude: 'claude',
  codex: 'openai',
  gemini: 'gemini',
  agy: 'antigravity',
  antigravity: 'antigravity',
  grok: 'grok',
  kimi: 'kimi',
  qwen: 'qwen',
  opencode: 'opencode'
}

/**
 * A model named in the arguments beats the executable: `opencode -m …deepseek…`
 * is DeepSeek wearing OpenCode, and `claude --model 'glm-5.3[1m]'` is GLM on
 * Claude Code's harness. The logo says whose brain is answering.
 */
const MODEL_HINTS: [RegExp, AgentLogoKey][] = [
  [/(^|[^a-z])(glm|zai|zhipu)/, 'zai'],
  [/deepseek/, 'deepseek'],
  [/qwen/, 'qwen'],
  [/kimi|moonshot/, 'kimi'],
  [/grok/, 'grok'],
  [/gemini/, 'gemini'],
  [/claude|anthropic/, 'claude'],
  [/(^|[^a-z])gpt-|openai/, 'openai']
]

/** Built-in profile ids, for a profile whose command says nothing useful. */
const ID_LOGOS: Record<string, AgentLogoKey> = {
  claude: 'claude',
  codex: 'openai',
  gemini: 'gemini',
  antigravity: 'antigravity',
  grok: 'grok',
  kimi: 'kimi',
  qwen: 'qwen',
  deepseek: 'deepseek',
  glm: 'zai',
  opencode: 'opencode'
}

/**
 * The mark a profile wears, or null for an agent Forge does not recognise —
 * which keeps its two-letter text badge.
 */
export function agentLogoFor(profile: Pick<AgentProfile, 'id' | 'command' | 'kind'>): AgentLogo | null {
  if (isShellProfile(profile)) return AGENT_LOGOS.shell
  const command = profile.command.trim()
  const exe = commandExe(command)
  const args = command.slice(command.indexOf(' ') + 1 || command.length).toLowerCase()
  for (const [pattern, key] of MODEL_HINTS) if (pattern.test(args)) return AGENT_LOGOS[key]
  const byExe = EXE_LOGOS[exe]
  if (byExe) return AGENT_LOGOS[byExe]
  if (SHELL_EXES.has(exe)) return AGENT_LOGOS.shell
  const byId = ID_LOGOS[profile.id]
  return byId ? AGENT_LOGOS[byId] : null
}
