/** Probe: what the route reports for each kind of broken provider. */
import { handleSyncRequest } from '../lib/index.js'
import { drive } from '../test-res.mjs'

const UPSTREAM = [{ id: 'a', supported_reasoning_levels: [{ effort: 'high' }] }]
globalThis.fetch = async () => new Response(JSON.stringify({ data: UPSTREAM }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const entry = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }
const inherited = {
  providers: {
    magpie: { apiKeyEnv: 'K', baseURL: 'http://x/v1', models: [{ id: 'a' }] },
    empty: { apiKeyEnv: 'K', baseURL: 'http://x/v1', models: [] },
    broken: { apiKeyEnv: 'K', baseURL: 'file:///no-such-dir/v1', models: [{ id: 'x' }] },
    unkeyed: { baseURL: 'http://x/v1', models: [{ id: 'x' }] },
  },
}
const ctx = {
  configEditor: { configuration: () => [{ entry, inherited, override: {} }], edit: async () => {} },
  credentials: { resolve: async () => ({ value: 'x' }) },
}

const res = await drive(handleSyncRequest, ctx, { method: 'POST', json: async () => ({ dryRun: true }) })
console.log('status', res.status)
console.log('providers', JSON.stringify(res.json.providers, null, 1))
console.log('notes', JSON.stringify(res.json.notes, null, 1))
