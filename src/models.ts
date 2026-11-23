import { Model, Provider } from "@opencode/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}
const positive = (...values: unknown[]) => {
  const value = values.find((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
  return typeof value === "number" ? Math.floor(value) : undefined
}
const title = (text: string) => text.split(" ").map((word) => word.slice(0, 1).replace(/[a-z]/, (c) => c.toUpperCase()) + word.slice(1)).join(" ")
function name(id: string) {
  if (id.startsWith("gpt-")) return `GPT-${title(id.slice(4).replaceAll("-", " "))}`
  const versionFirst = /^claude-(\d+)-(\d+)-([a-z]+)(?:-(\d{8}))?$/.exec(id)
  const datedFamily = /^claude-([a-z]+)-(\d+)-(\d{8})$/.exec(id)
  const familyFirst = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/.exec(id)
  if (versionFirst) return `Claude ${versionFirst[1]}.${versionFirst[2]} ${title(versionFirst[3])}${date(versionFirst[4])}`
  if (datedFamily) return `Claude ${title(datedFamily[1])} ${datedFamily[2]}${date(datedFamily[3])}`
  if (familyFirst) return `Claude ${title(familyFirst[1])} ${familyFirst[2]}${familyFirst[3] ? `.${familyFirst[3]}` : ""}${date(familyFirst[4])}`
  return id
}
function date(value: string | undefined) {
  return value ? ` (${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)})` : ""
}

export function applyCatalog(editor: ProviderEditor, input: { id: string; name: string; baseURL: string; apiKey: string; gateway: unknown; official: unknown; defaultModel?: string }) {
  const providerID = Provider.ID.make(input.id)
  const existing = editor.get(input.id)
  const officialProviders = object(object(input.official).providers)
  const limits = new Map<string, RecordValue>()
  for (const provider of ["anthropic", "openai"]) {
    for (const [id, model] of Object.entries(object(object(officialProviders[provider]).models))) limits.set(id, object(object(model).limit))
  }
  const gateway = object(input.gateway)
  const entries = gateway.data ?? gateway.models
  if (!Array.isArray(entries)) throw new Error("Invalid gateway catalog")
  const seen = new Set<string>()
  const models = entries.flatMap((entry) => {
    const item = object(entry)
    if (typeof item.id !== "string" || !item.id || /^(gpt-image|codex-auto-review)/.test(item.id) || seen.has(item.id)) return []
    seen.add(item.id)
    const id = Model.ID.make(item.id)
    const base = existing?.models.get(id) ?? Model.Info.default(providerID, id)
    const fallback = limits.get(id) ?? {}
    const context = positive(item.context_length, item.context_window, item.max_context_length, item.context, fallback.context)
    const inputLimit = positive(
      item.input_length, item.max_input_length, item.max_prompt_tokens,
      item.input_token_limit, item.input, fallback.input,
    )
    const output = positive(item.max_output_length, item.max_tokens, item.output_token_limit, item.output, fallback.output)
    const timestamp = typeof item.created === "number" ? item.created * 1000 : NaN
    const released = Number.isFinite(new Date(timestamp).getTime()) ? Math.floor(timestamp / 86400000) * 86400000 : undefined
    return [{
      ...base,
      name: name(item.id),
      time: released === undefined ? base.time : { ...base.time, released },
      limit: {
        ...base.limit,
        ...(context === undefined ? {} : { context }),
        ...(inputLimit === undefined ? {} : { input: inputLimit }),
        ...(output === undefined ? {} : { output }),
      },
    }]
  })
  if (!models.length) throw new Error("No chat models in gateway catalog")
  if (input.defaultModel && !seen.has(input.defaultModel)) {
    const id = Model.ID.make(input.defaultModel)
    models.push(existing?.models.get(id) ?? { ...Model.Info.default(providerID, id), name: input.defaultModel })
  }
  if (!existing) {
    editor.add({ info: { ...Provider.Info.empty(providerID), name: input.name, activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: input.baseURL, apiKey: input.apiKey } }, models })
    return
  }
  editor.update(input.id, (provider) => {
    provider.name = input.name
    provider.package = "@opencode/ai/providers/openai-compatible"
    provider.settings = { ...provider.settings, baseURL: input.baseURL, apiKey: input.apiKey }
  })
  editor.models.set(input.id, models)
}
