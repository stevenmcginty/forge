import type { RealtimeToolSpec } from '@shared/realtime'

/**
 * A tool list in each vendor's shape. Pure, and apart from ./tools.ts on
 * purpose: ./gemini.ts and ./openai.ts need only this, and Forge Web
 * (web/src/deck) runs the same sessions in a browser, where ./tools.ts and the
 * renderer-only tool implementations behind it cannot be bundled.
 */

/** OpenAI's function tool shape (the session config in main adds `type`). */
export function openAIToolSpecs(tools: RealtimeToolSpec[]): RealtimeToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

/**
 * Gemini's Schema is OpenAPI-flavoured: upper-case type names and no
 * `additionalProperties`. Converted rather than written twice.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue
    if (key === 'type' && typeof value === 'string') out.type = value.toUpperCase()
    else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)])
      )
    } else out[key] = toGeminiSchema(value)
  }
  return out
}

export function geminiToolDeclarations(tools: RealtimeToolSpec[]): Array<Record<string, unknown>> {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const hasParams = Object.keys((t.parameters.properties as Record<string, unknown>) ?? {}).length > 0
        return hasParams
          ? { name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }
          : { name: t.name, description: t.description }
      })
    }
  ]
}
