/**
 * dsh-effort-sync — keep DSH's per-model reasoning levels in sync with what the
 * provider actually advertises.
 *
 * Two surfaces share one routine (./sync.js):
 *   - the `sync_reasoning_levels` tool for the agent (dry-run first);
 *   - `POST /dsh-effort-sync/sync` for the one-click button this plugin adds to
 *     the Models settings page (an explicit user click, so it applies).
 *
 * Safety posture:
 *   - the tool defaults to `dryRun: true`; the button applies, but reports the
 *     diff it wrote so the user can see exactly what changed;
 *   - only levels DSH actually knows are written; everything else is reported;
 *   - existing wire spellings are preserved (same rule as the Settings UI);
 *   - the sync is ADDITIVE by default: a gateway's advertised list can be a
 *     conservative subset of what the upstream accepts, so `replace` is opt-in;
 *   - providers the sync cannot read are left untouched and reported.
 */

import { runSync } from './sync.js'

const PARAMETERS = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      description: 'Provider key inside the adapter config to sync (defaults to every declared provider, e.g. "magpie").',
    },
    dryRun: {
      type: 'boolean',
      description: 'Report the diff without writing anything. Defaults to true.',
    },
    noneMapsToOff: {
      type: 'boolean',
      description:
        'Some providers advertise a "none" level meaning "no reasoning". Mapping it to DSH\'s "off" is '
        + 'provider-specific, so it is off by default; unknown levels are reported instead of guessed.',
    },
    only: {
      type: 'array',
      items: { type: 'string' },
      description: 'Limit the sync to these exact model ids.',
    },
    replace: {
      type: 'boolean',
      description:
        'Replace the declared levels with exactly what the provider advertises. Off by default, because the '
        + 'sync is ADDITIVE: a gateway\'s advertised list can be a conservative subset of what the upstream '
        + 'actually accepts (measured: magpie advertises low/high/max for a model whose upstream accepts all '
        + 'six, so replacing would silently drop working levels like off/medium/xhigh).',
    },
  },
  additionalProperties: false,
}

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    from: { type: 'array', items: { type: 'string' } },
    to: { type: 'array', items: { type: 'string' } },
    advertised: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
  required: ['model'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    provider: { type: 'string' },
    dryRun: { type: 'boolean' },
    upstreamModels: { type: 'number' },
    catalogModels: { type: 'number' },
    changes: { type: 'array', items: CHANGE_SCHEMA },
    notes: { type: 'array', items: { type: 'string' } },
    diagnostics: { type: 'array', items: { type: 'string' } },
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          ok: { type: 'boolean' },
          models: { type: 'number' },
          changed: { type: 'number' },
          upstream: { type: 'number' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    applied: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: false,
}

/** Human-readable diff, shared by the tool renderer and the button's result. */
function renderReport(value) {
  const lines = []
  if (value?.error) lines.push(`error: ${value.error}`)
  lines.push(
    `provider=${value?.provider ?? '?'} dryRun=${String(value?.dryRun)} `
    + `upstream=${value?.upstreamModels ?? 0} catalog=${value?.catalogModels ?? 0}`,
  )
  for (const c of value?.changes ?? []) {
    const from = (c.from ?? []).join(',') || '(none)'
    const to = (c.to ?? []).join(',') || '(none)'
    lines.push(`  ${c.provider ? `${c.provider} / ` : ''}${c.model}: ${from} -> ${to}`)
    if (c.skipped?.length) lines.push(`      skipped: ${c.skipped.join(', ')}`)
  }
  if (!(value?.changes ?? []).length) lines.push('  (no changes)')
  for (const n of value?.notes ?? []) lines.push(`  note: ${n}`)
  for (const d of value?.diagnostics ?? []) lines.push(`  entry: ${d}`)
  if (value?.applied) lines.push('applied: catalog updated')
  else if (value?.ok && value?.dryRun) lines.push('dry-run only — re-run with dryRun=false to apply')
  return lines
}

export const name = 'dsh-effort-sync'

/** Write one JSON response, tolerating either a Node or a web-style response. */
function json(res, code, value) {
  const body = JSON.stringify(value)
  if (typeof res?.writeHead === 'function') {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  res.statusCode = code
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.setHeader?.('cache-control', 'no-store')
  res.end(body)
}

/** Read the request's JSON body from either a web Request or a Node stream. */
async function readJson(req) {
  if (req?.json !== undefined) {
    try { return (await req.json()) ?? {} } catch { return {} }
  }
  const chunks = []
  for await (const chunk of req ?? []) chunks.push(chunk)
  const text = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { return {} }
}

/**
 * The settings-page button's endpoint: `POST /dsh-effort-sync/sync`.
 * A click is an explicit user action, so the write is applied — and the report
 * carries the diff that was written, which the client renders.
 * Exported so the offline rehearsal can drive it directly.
 */
export async function handleSyncRequest(ctx, req, res) {
  if (req?.method && String(req.method).toUpperCase() !== 'POST') {
    return json(res, 405, { ok: false, error: 'POST only' })
  }
  try {
    const body = await readJson(req)
    const report = await runSync(ctx, {
      provider: typeof body.provider === 'string' && body.provider ? body.provider : undefined,
      dryRun: body.dryRun === true,
      noneMapsToOff: body.noneMapsToOff === true,
      only: Array.isArray(body.only) ? body.only : undefined,
      replace: body.replace === true,
    })
    return json(res, report.ok ? 200 : 400, report)
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

export function apply(root) {
  // ---- the agent-facing tool -------------------------------------------
  root.inject(['tools', 'configEditor', 'credentials'], (ctx) => {
    ctx.tools.register({
      name: 'sync_reasoning_levels',
      description:
        'Sync DSH model catalog reasoning levels (reasoningEfforts) from what the configured providers '
        + 'advertise on their /v1/models endpoint. DSH cannot do this itself: its discovery contract has no '
        + 'reasoning field, so these levels must be declared in the catalog. Reports a diff by default '
        + '(dryRun=true); pass dryRun=false to persist through configEditor. Only levels DSH knows are '
        + 'written, existing wire spellings are preserved, and unknown levels are reported rather than guessed.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderReport(value).join('\n') }],
      },
      execute(args) {
        return runSync(ctx, args ?? {})
      },
    })
  }, 'dsh-effort-sync: tool')

  // ---- the settings-page button's endpoint ------------------------------
  // Same shape as dsh-real-model's route: the browser posts JSON, the host
  // answers JSON. One click means apply, so dryRun defaults to false here.
  root.inject(['webServer', 'configEditor', 'credentials'], (ctx) => {
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-effort-sync/sync',
        handler: (req, res) => handleSyncRequest(ctx, req, res),
      }))
      ctx.logger?.info?.('dsh-effort-sync: /dsh-effort-sync/sync registered')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-effort-sync: web route failed: ${e?.message ?? e}`)
    }
  }, 'dsh-effort-sync: route')
}
