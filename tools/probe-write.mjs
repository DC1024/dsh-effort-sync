/** Probe: reproduce the write transform in isolation. */
const models = [{ id: 'a', name: 'Auto' }, { id: 'b', name: 'Bea', reasoningEfforts: { max: 'ultra' } }]
const inherited = { providers: { magpie: { apiKeyEnv: 'K', baseURL: 'http://x/v1', models } } }
const current = {}
const changes = [
  { provider: 'magpie', model: 'a', from: [], to: ['low', 'high'] },
  { provider: 'magpie', model: 'b', from: ['max'], to: ['low', 'max'] },
]
const replace = false
const key = 'magpie'

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

const targets = new Map(
  changes.filter((c) => c.provider === key).map((c) => [c.model, (replace ? c.advertised : c.to) ?? c.to]),
)
console.log('targets', JSON.stringify([...targets]))
const source = mergeModels(current?.providers?.[key]?.models, inherited?.providers?.[key]?.models)
console.log('source', JSON.stringify(source))
const priorById = new Map([])
const next = source.map((m) => {
  const wanted = targets.get(m?.id)
  if (wanted === undefined) return m
  return { ...m, reasoningEfforts: Object.fromEntries(wanted.map((l) => [l, l])) }
})
console.log('next', JSON.stringify(next))
