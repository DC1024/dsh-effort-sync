/**
 * dsh-effort-sync — the sync routine itself.
 *
 * Kept separate from the plugin entry so both surfaces can share one
 * implementation: the `sync_reasoning_levels` tool (agent-driven) and the
 * `POST /dsh-effort-sync/sync` route (one-click button in the Models settings
 * page). They differ only in defaults: the tool is dryRun-first, the button is
 * an explicit user click and applies.
 *
 * Why this exists: DSH's model-discovery contract (`LlmDiscoveredModel`) has no
 * slot for reasoning capability, so a provider that publishes
 * `supported_reasoning_levels` on `/v1/models` (magpie does) still leaves the
 * model picker empty. DSH does have the capability concept
 * (`LlmResolvedModelInfo.reasoning`), but its only input is the catalog
 * declaration `reasoningEfforts` — which is what this writes, through the same
 * `configEditor` path the Settings UI uses.
 */

/** DSH's canonical thinking-level vocabulary, in display order. */
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Provider plugins this sync understands: name -> how to read its catalog. */
export const ADAPTERS = [
  { packageName: '@deepseek-ai/dsh-llm-pi-ai', entryIds: ['llm-pi-ai'] },
]

/** Merge an entry's inherited layer with its explicit override (override wins). */
export function mergeLayers(current, inherited) {
  const out = { ...(inherited ?? {}) }
  for (const [k, v] of Object.entries(current ?? {})) out[k] = v
  return out
}

/** One line per loader entry, for when matching fails and we must see reality. */
export function describeEntries(rows) {
  return rows.slice(0, 60).map((row) => {
    const entry = row?.entry ?? {}
    const effective = mergeLayers(row?.override, row?.inherited)
    const providers = effective?.providers
    const keys = providers && typeof providers === 'object' ? Object.keys(providers).join('/') : ''
    return `id=${String(entry.id ?? '')} name=${String(entry.name ?? '')} providers=[${keys}]`
  })
}

/**
 * Locate the adapter entry this may edit. Matching is scored rather than exact
 * because a loader entry's `name` is whatever the profile wrote (a package
 * name, a bundle alias, or a path), and the decisive signal is really "does
 * this entry carry a providers block with models".
 */
export function findEntry(rows) {
  let best
  for (const row of rows) {
    const entry = row?.entry ?? {}
    const id = String(entry.id ?? '')
    const name = String(entry.name ?? '')
    const effective = mergeLayers(row?.override, row?.inherited)
    const hasProviders = Boolean(effective?.providers && typeof effective.providers === 'object')
    const hasModels = Boolean(
      hasProviders
      && Object.values(effective.providers).some((p) => Array.isArray(p?.models) && p.models.length),
    )

    let score = 0
    if (ADAPTERS.some((a) => a.packageName === name || a.entryIds.includes(id))) score += 100
    else if (ADAPTERS.some((a) => name.includes(a.packageName) || id.includes(a.entryIds[0]))) score += 80
    if (hasProviders) score += 30
    if (hasModels) score += 40

    if (score > 0 && (!best || score > best.score)) best = { row, score }
  }
  return best?.row
}

/** Read the levels a provider advertises for one model row. */
export function upstreamLevels(row) {
  const raw = row?.supported_reasoning_levels
  if (!Array.isArray(raw)) return undefined
  return raw
    .map((x) => (typeof x === 'string' ? x : x?.effort))
    .filter((v) => typeof v === 'string' && v.length > 0)
}

/** Keep only what DSH knows, in canonical order; report the rest. */
export function toDesiredLevels(levels, noneMapsToOff) {
  const desired = []
  const skipped = []
  for (const level of levels) {
    if (LEVELS.includes(level)) {
      if (!desired.includes(level)) desired.push(level)
    } else if (level === 'none' && noneMapsToOff) {
      if (!desired.includes('off')) desired.push('off')
    } else {
      skipped.push(level)
    }
  }
  desired.sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b))
  return { desired, skipped }
}

/** Build the next reasoningEfforts map, preserving existing wire spellings. */
export function nextEfforts(existing, desired) {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  const next = {}
  for (const level of desired) {
    next[level] = Object.prototype.hasOwnProperty.call(current, level) ? current[level] : level
  }
  return next
}

/** Current level ids of a catalog row, whatever shape it is in. */
export function currentLevels(model) {
  const declared = model?.reasoningEfforts
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return []
  return Object.keys(declared)
}

/** Keep every level either side knows, in canonical order (additive merge). */
export function unionLevels(existing, advertised) {
  return LEVELS.filter((level) => existing.includes(level) || advertised.includes(level))
}

function sameLevels(a, b) {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

export async function fetchUpstreamModels(baseURL, apiKey, signal) {
  const url = String(baseURL).replace(/\/+$/, '') + '/models'
  const resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal,
  })
  if (!resp.ok) throw new Error(`GET ${url} -> HTTP ${resp.status}`)
  const data = await resp.json()
  return Array.isArray(data?.data) ? data.data : []
}

/**
 * One declared provider key, with the fields DSH would resolve for it.
 *
 * Field-level trickle-down: a layer that names `providers.<key>` at all replaces
 * the whole provider OBJECT (that is how the Loader merges configs), so a layer
 * that owns only `models` would otherwise look like it has no `baseURL`. Reading
 * each field from override-then-inherited reproduces what a request would use.
 */
function readProvider(current, inherited, key) {
  const over = current?.providers?.[key]
  const under = inherited?.providers?.[key]
  const pick = (field) => (over?.[field] !== undefined ? over[field] : under?.[field])
  return {
    key,
    apiKeyEnv: pick('apiKeyEnv'),
    baseURL: pick('baseURL'),
    models: Array.isArray(pick('models')) ? pick('models') : [],
  }
}

/**
 * Model lists are trickled down by id, because a model entry is written whole
 * (a layer cannot own just one field of it) and the sync only ever needs to add
 * one field to an entry the lower layer already describes.
 */
function mergeModels(over, under) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(over) ? over : []) {
    if (typeof m?.id === 'string') seen.add(m.id)
    out.push(m)
  }
  for (const m of Array.isArray(under) ? under : []) {
    if (typeof m?.id !== 'string' || seen.has(m.id)) continue
    out.push(m)
  }
  return out
}

/** The provider keys either layer names, in override-then-inherited order. */
export function declaredProviderKeys(current, inherited) {
  const keys = []
  for (const layer of [current?.providers, inherited?.providers]) {
    if (!layer || typeof layer !== 'object') continue
    for (const key of Object.keys(layer)) if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * Next `providers` block for the stored override: copy the effective catalog,
 * apply the synced levels, and keep only the keys this edit owns. The stored
 * entry needs the whole model list because the Loader swaps an array instead of
 * merging it — but a model keeps its inherited fields via the trickle-down.
 */
function withSyncedLevels(current, inherited, changes, replace) {
  const providers = { ...(current?.providers ?? {}) }
  for (const key of new Set(changes.map((c) => c.provider))) {
    const targets = new Map(
      changes
        .filter((c) => c.provider === key)
        .map((c) => [c.model, (replace ? c.advertised : c.to) ?? c.to]),
    )
    if (!targets.size) continue
    const stored = current?.providers?.[key] ?? {}
    const source = mergeModels(current?.providers?.[key]?.models, inherited?.providers?.[key]?.models)
    const priorById = new Map(
      (Array.isArray(stored.models) ? stored.models : [])
        .filter((m) => typeof m?.id === 'string')
        .map((m) => [m.id, m]),
    )
    const models = source.map((m) => {
      const wanted = targets.get(m?.id)
      const prior = priorById.get(m?.id)
      if (wanted === undefined) return prior ?? m
      return { ...(prior ?? m), reasoningEfforts: nextEfforts(m.reasoningEfforts, wanted) }
    })
    providers[key] = { ...stored, models }
  }
  return providers
}

/**
 * Sync every declared provider (or one chosen provider) from what its
 * `/v1/models` advertises. Read-only unless `dryRun` is false.
 *
 * @param ctx - plugin context providing configEditor + credentials.
 * @param args - provider | dryRun | noneMapsToOff | only | replace.
 * @returns a plain report object (also a valid `sync_reasoning_levels` output).
 */
export async function runSync(ctx, args = {}) {
  const {
    provider: wantProvider,
    dryRun = true,
    noneMapsToOff = false,
    only,
    replace = false,
  } = args ?? {}

  const notes = []
  try {
    // ---- read the catalog ------------------------------------------------
    const rows = ctx.configEditor.configuration()
    const row = findEntry(rows)
    if (!row) {
      return {
        ok: false,
        error: 'no supported model-provider entry found in this profile',
        diagnostics: describeEntries(rows),
        notes,
      }
    }
    const allKeys = declaredProviderKeys(row.override, row.inherited)
    if (!allKeys.length) {
      return {
        ok: false,
        error: `entry "${String(row.entry?.id ?? '')}" has no providers block`,
        diagnostics: describeEntries(rows),
        notes,
      }
    }
    const keys = wantProvider
      ? (allKeys.includes(wantProvider) ? [wantProvider] : [])
      : allKeys
    if (!keys.length) {
      return {
        ok: false,
        error: `provider "${wantProvider}" is not declared in entry "${String(row.entry?.id ?? '')}"`,
        notes,
        diagnostics: describeEntries(rows),
      }
    }

    const changes = []
    const results = []
    let upstreamModels = 0
    let catalogModels = 0

    for (const key of keys) {
      const per = await planProvider({
        ctx,
        provider: readProvider(row.override, row.inherited, key),
        only,
        replace,
        noneMapsToOff,
        notes,
      })
      upstreamModels += per.upstreamModels
      catalogModels += per.catalogModels
      results.push(per.summary)
      changes.push(...per.changes)
    }

    const skippedAny = changes.flatMap((c) => c.skipped ?? [])
    if (skippedAny.length && !noneMapsToOff) {
      notes.push(
        `levels reported but not written: ${[...new Set(skippedAny)].join(', ')} `
        + '(pass noneMapsToOff=true to map "none" to "off")',
      )
    }

    const report = {
      ok: true,
      provider: keys.join(','),
      dryRun,
      upstreamModels,
      catalogModels,
      changes,
      notes,
      applied: false,
      providers: results,
    }

    // ---- write -----------------------------------------------------------
    if (dryRun || !changes.length) return report

    // The inherited layer comes from `configuration()`, never from the edit
    // callback: `edit` only promises the entry and a change function, and
    // measured against the live harness its second argument arrives empty.
    // Re-reading here also picks up anything written between the diff and now.
    const fresh = ctx.configEditor.configuration().find((r) => r?.entry?.id === row.entry?.id
      || r?.entry === row.entry) ?? row
    const current = fresh.override ?? row.override ?? {}
    const inherited = fresh.inherited ?? row.inherited ?? {}

    await ctx.configEditor.edit(row.entry, (editCurrent, editInherited) => {
      const usable = editCurrent && typeof editCurrent === 'object' && Object.keys(editCurrent).length > 0
      const base = usable ? editCurrent : current
      const lower = editInherited && typeof editInherited === 'object' && Object.keys(editInherited).length > 0
        ? editInherited
        : inherited
      return { ...base, providers: withSyncedLevels(base, lower, changes, replace) }
    })
    report.applied = true
    return report
  } catch (error) {
    return {
      ok: false,
      provider: wantProvider,
      dryRun,
      changes: [],
      notes,
      diagnostics: [],
      error: String(error?.message ?? error) + (error?.stack ? `\n${String(error.stack).split('\n')[1] ?? ''}` : ''),
    }
  }
}

/** Diff one provider's declared catalog against what it advertises. */
async function planProvider({ ctx, provider, only, replace, noneMapsToOff, notes }) {
  const { key, apiKeyEnv, baseURL, models } = provider
  const summary = { provider: key, ok: true, models: models.length, changed: 0, upstream: 0, error: undefined }
  const empty = { changes: [], upstreamModels: 0, catalogModels: models.length, summary }

  if (!models.length) {
    summary.error = 'declares no models'
    notes.push(`${key}: declares no models (left untouched)`)
    return empty
  }
  if (!apiKeyEnv) {
    summary.error = 'declares no apiKeyEnv'
    notes.push(`${key}: declares no apiKeyEnv (left untouched)`)
    return empty
  }
  if (!baseURL) {
    summary.error = 'declares no baseURL'
    notes.push(`${key}: declares no baseURL (left untouched)`)
    return empty
  }

  // A provider that cannot be read must never stop the others: report and move on.
  let upstream
  try {
    const cred = await ctx.credentials.resolve(apiKeyEnv)
    if (!cred?.value) {
      summary.error = `credential "${apiKeyEnv}" is not configured`
      notes.push(`${key}: credential "${apiKeyEnv}" is not configured (left untouched)`)
      return empty
    }
    const signal = AbortSignal.timeout(20000)
    upstream = await fetchUpstreamModels(baseURL, cred.value, signal)
  } catch (error) {
    summary.error = String(error?.message ?? error)
    summary.ok = false
    notes.push(`${key}: could not read ${baseURL}/models — ${summary.error} (left untouched)`)
    return empty
  }

  const byId = new Map(upstream.map((m) => [m?.id, m]))
  summary.upstream = upstream.length

  const changes = []
  const wanted = new Set(
    models.map((m) => m?.id).filter((id) => typeof id === 'string' && (!only?.length || only.includes(id))),
  )
  let nonReasoning = 0

  for (const model of models) {
    const id = model?.id
    if (typeof id !== 'string' || !wanted.has(id)) continue
    const up = byId.get(id)
    if (!up) {
      notes.push(`${key} / ${id}: not advertised by the provider (left untouched)`)
      continue
    }
    const levels = upstreamLevels(up)
    if (!levels) {
      notes.push(`${key} / ${id}: provider advertises no supported_reasoning_levels (left untouched)`)
      continue
    }
    if (up.reasoning === false) nonReasoning += 1
    const { desired, skipped } = toDesiredLevels(levels, noneMapsToOff)
    if (!desired.length) {
      notes.push(`${key} / ${id}: provider advertises no level DSH knows (${skipped.join(', ') || 'none'})`)
      continue
    }
    const have = currentLevels(model)
    const target = replace ? desired : unionLevels(have, desired)
    if (sameLevels(have, target)) continue
    changes.push({ provider: key, model: id, from: have, to: target, advertised: desired, skipped })
  }

  if (nonReasoning) {
    notes.push(
      `${key}: ${nonReasoning} model(s) the provider marks reasoning=false were still given levels from its `
      + 'own level list; declare reasoningEfforts=false by hand if you want the picker hidden.',
    )
  }

  summary.changed = changes.length
  return { changes, upstreamModels: upstream.length, catalogModels: models.length, summary }
}
