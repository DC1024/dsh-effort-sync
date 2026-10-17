/**
 * Offline rehearsal: drive the real plugin entry (host half) against a fake
 * context and a stub provider, over real HTTP, and assert the diff it computes
 * and writes. No live config or credential is touched.
 *
 * Run:  node rehearsal.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply, handleSyncRequest } from './lib/index.js'
import { drive, makeRes } from './test-res.mjs'

const UPSTREAM = [
  { id: 'group/smart-split', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  {
    id: 'cc/gpt-6-luna',
    supported_reasoning_levels: [
      { effort: 'none' }, { effort: 'low' }, { effort: 'medium' },
      { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' },
    ],
  },
  { id: 'glm-5.3-flash', reasoning: false, supported_reasoning_levels: [{ effort: 'high' }] },
  { id: 'unlisted-model', supported_reasoning_levels: [{ effort: 'high' }] },
]

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: UPSTREAM }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`

/**
 * Stub the provider side. A real loopback fetch is not reliable inside the
 * agent's sandbox, and the point here is the sync logic, not Node's HTTP stack
 * (step 6 exercises real HTTP on the plugin's own route).
 */
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('/models')) {
    if (href.startsWith('file:')) throw new TypeError('fetch failed') // unreachable provider
    if (href.includes('/unauthorized/')) return new Response('nope', { status: 401 })
    return new Response(JSON.stringify({ data: UPSTREAM }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(url, init)
}

// ---- fake configuration ---------------------------------------------------
const entry = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }
const inherited = {
  providers: {
    magpie: {
      apiKeyEnv: 'MAGPIE_API_KEY',
      baseURL,
      models: [
        { id: 'group/smart-split', name: 'Auto' },
        { id: 'cc/gpt-6-luna', name: 'GPT-6 Luna', reasoningEfforts: { max: 'ultra' } },
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoningEfforts: { high: 'high' } },
        { id: 'never-advertised', name: 'Gone' },
      ],
    },
    empty: { apiKeyEnv: 'MAGPIE_API_KEY', baseURL, models: [] },
    broken: { apiKeyEnv: 'MAGPIE_API_KEY', baseURL: 'file:///no-such-dir/v1', models: [{ id: 'x' }] },
    unkeyed: { baseURL, models: [{ id: 'x' }] },
  },
}
let rows = [{ entry, inherited, override: {} }]

let edits = 0
let lastEdited = null
const fakeCtx = {
  configEditor: {
    configuration: () => rows,
    edit: async (row, change) => {
      edits += 1
      const next = await change(row.override ?? {}, row.inherited ?? {})
      lastEdited = next
      rows = [{ entry: row.entry, inherited: row.inherited, override: next }]
    },
  },
  credentials: { resolve: async (ref) => (ref === 'MAGPIE_API_KEY' ? { value: 'sk-test' } : undefined) },
}

const changesOf = (body, model) => (body.changes ?? []).find((c) => c.model === model)
const post = (body) => drive(handleSyncRequest, fakeCtx, {
  method: 'POST',
  json: async () => {
    if (body instanceof Error) throw body
    return body
  },
})

// ---- 1. dry run computes the diff and writes nothing ----------------------
const dry = await post({ dryRun: true })
assert.equal(dry.status, 200)
const dryBody = dry.json
assert.equal(dryBody.ok, true, 'dry run reports ok')
assert.equal(dryBody.dryRun, true)
assert.equal(edits, 0, 'dry run must not write')
assert.ok(dryBody.upstreamModels >= 4, 'counts the models the readable providers advertise')
assert.equal(dryBody.providers.find((p) => p.provider === 'magpie').upstream, 4, 'magpie advertises four models')
assert.equal(changesOf(dryBody, 'group/smart-split').to.join(','), 'low,high', 'smart-split gains low+high')
assert.deepEqual(changesOf(dryBody, 'cc/gpt-6-luna').to, ['low', 'medium', 'high', 'xhigh', 'max'])
assert.ok(changesOf(dryBody, 'cc/gpt-6-luna').skipped.includes('none'), 'none is reported, not guessed')
assert.equal(changesOf(dryBody, 'glm-5.3-flash'), undefined, 'already-synced model is not re-listed')
assert.ok(!dryBody.changes.some((c) => c.model === 'never-advertised'), 'unadvertised model untouched')
assert.ok(dryBody.providers.some((p) => p.provider === 'empty' && p.models === 0), 'empty provider is reported')
assert.ok(dryBody.providers.some((p) => p.provider === 'broken' && /could not read|fetch failed/.test(p.error ?? '')), 'unreadable provider is reported, not fatal')
assert.ok(dryBody.providers.some((p) => p.provider === 'unkeyed' && /apiKeyEnv/.test(p.error ?? '')), 'provider without a key ref is reported')

// ---- 2. apply writes exactly the diff, preserving existing spellings ------
const applied = await post({})
assert.equal(applied.status, 200)
assert.equal(applied.json.applied, true, 'a click applies')
assert.equal(edits, 1, 'one write for one click')
const magpie = lastEdited.providers.magpie
const written = magpie.models.find((m) => m.id === 'cc/gpt-6-luna')
assert.equal(written.reasoningEfforts.max, 'ultra', 'existing wire spelling preserved')
assert.equal(written.reasoningEfforts.low, 'low', 'new levels use identity spelling')
assert.equal(magpie.models.find((m) => m.id === 'never-advertised').reasoningEfforts, undefined, 'unadvertised model still undeclared')
assert.deepEqual(Object.keys(lastEdited.providers), ['magpie'], 'only the provider with changes is stored')
assert.equal(magpie.apiKeyEnv, undefined, 'the stored override stays minimal (no inherited fields copied)')

// ---- 3. idempotence: a second click is a no-op ----------------------------
const again = await post({})
assert.equal(again.json.changes.length, 0, 'second click finds nothing to change')
assert.equal(edits, 1, 'no redundant write')

// ---- 4. provider filter + error paths ------------------------------------
const scoped = await post({ provider: 'magpie', dryRun: true })
assert.equal(scoped.json.ok, true)
assert.equal(scoped.json.provider, 'magpie')

const unknown = await post({ provider: 'nope' })
assert.equal(unknown.status, 400, 'unknown provider is a 400')
assert.match(unknown.json.error, /not declared/)

const wrongMethod = await drive(handleSyncRequest, fakeCtx, { method: 'GET' })
assert.equal(wrongMethod.status, 405)

const badJson = await post(new Error('boom'))
assert.equal(badJson.status, 200, 'unparsable body degrades to "sync everything"')
assert.equal(badJson.json.changes.length, 0, 'still nothing left to write')

// ---- 5. the plugin entry registers both surfaces --------------------------
const labels = []
const registrations = { tools: [], routes: [] }
const root = {
  inject: (deps, fn, label) => {
    labels.push(label)
    if (deps.includes('tools')) {
      fn({
        tools: { register: (def) => registrations.tools.push(def) },
        configEditor: fakeCtx.configEditor,
        credentials: fakeCtx.credentials,
      })
    }
    if (deps.includes('webServer')) {
      fn({
        webServer: { register: (route) => { registrations.routes.push(route); return () => {} } },
        configEditor: fakeCtx.configEditor,
        credentials: fakeCtx.credentials,
        effect: (fn2) => { fn2(); return () => {} },
        logger: { info: () => {}, warn: () => {} },
      })
    }
  },
}
apply(root)
assert.deepEqual(labels, ['dsh-effort-sync: tool', 'dsh-effort-sync: route'])
assert.equal(registrations.tools[0].name, 'sync_reasoning_levels')
assert.equal(registrations.tools[0].output.schema.required[0], 'ok')
assert.equal(registrations.routes[0].path, '/dsh-effort-sync/sync')
assert.equal(registrations.routes[0].kind, 'exact')

const freshRows = [{ entry, inherited, override: {} }]
rows = freshRows
const rendered = registrations.tools[0].output.render({}, (await post({ dryRun: true })).json)
  .map((b) => b.text).join('\n')
assert.match(rendered, /group\/smart-split: \(none\) -> low,high/)
assert.match(rendered, /cc\/gpt-6-luna: max -> low,medium,high,xhigh,max/)
assert.match(rendered, /skipped: none/)

// ---- 6. the registered route answers a real HTTP POST ---------------------
const route = registrations.routes[0]
const server = http.createServer((req, res) => { route.handler(req, res) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const live = await fetch(`http://127.0.0.1:${port}/dsh-effort-sync/sync`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dryRun: true }),
})
const liveBody = await live.json()
assert.equal(live.status, 200)
assert.equal(liveBody.ok, true)
assert.equal(liveBody.dryRun, true)

// A GET on the same route is refused.
const refused = await fetch(`http://127.0.0.1:${port}/dsh-effort-sync/sync`, { method: 'GET' })
assert.equal(refused.status, 405)
server.close()
upstream.close()

console.log('rehearsal: all assertions passed\n')
console.log('tool render output for the current catalog:')
for (const line of rendered.split('\n')) console.log('  |', line)
