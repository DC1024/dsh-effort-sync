/** Probe: trace the trickle-down helpers the write path uses. */
import { mergeLayers, declaredProviderKeys } from '../lib/sync.js'

const inherited = {
  providers: {
    magpie: {
      apiKeyEnv: 'K',
      baseURL: 'http://x/v1',
      models: [{ id: 'a' }, { id: 'b', reasoningEfforts: { max: 'ultra' } }],
    },
  },
}
const current = {}

console.log('declaredProviderKeys ->', JSON.stringify(declaredProviderKeys(current, inherited)))
console.log('mergeLayers ->', JSON.stringify(mergeLayers(current, inherited)))
console.log('inherited.providers.magpie.models ->', JSON.stringify(inherited?.providers?.['magpie']?.models))
