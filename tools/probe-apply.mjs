/** Probe: what the apply path actually writes. */
import { runSync } from '../lib/sync.js'

const UPSTREAM = [
  { id: 'group/smart-split', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  { id: 'cc/gpt-6-luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
]
globalThis.fetch = async () => new Response(JSON.stringify({ data: UPSTREAM }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const entry = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }
const inherited = {
  providers: {
    magpie: {
      apiKeyEnv: 'K',
      baseURL: 'http://x/v1',
      models: [
        { id: 'group/smart-split', name: 'Auto' },
        { id: 'cc/gpt-6-luna', name: 'GPT-6 Luna', reasoningEfforts: { max: 'ultra' } },
      ],
    },
  },
}
// The entry starts with NO override at all: the provider lives in a lower layer,
// exactly like a hand-written profile patch. The write must not lose the models.
const row = { entry, inherited, override: {} }
const rows = [row]
const ctx = {
  configEditor: {
    configuration: () => rows,
    edit: async (target, change) => {
      const next = await change(target.override ?? {}, target.inherited ?? {})
      console.log('EDIT next:', JSON.stringify(next, null, 1))
      target.override = next
    },
  },
  credentials: { resolve: async () => ({ value: 'x' }) },
}

const report = await runSync(ctx, { dryRun: false })
console.log('applied:', report.applied, 'changes:', report.changes.length)
console.log('stored override:', JSON.stringify(row.override, null, 1))
