/**
 * Create the GitHub repository for this plugin.
 *
 * Reads GITHUB_TOKEN from the environment (never the command line), reuses the
 * CONNECT-through-local-proxy transport from tools/gh-check.mjs, and treats
 * "already exists" (422) as success so the script stays idempotent.
 *
 * Usage: GITHUB_TOKEN=... node tools/gh-create-repo.mjs [name] [--private]
 */
import http from 'node:http'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 7897 }
const TARGET = { host: 'api.github.com', port: 443 }

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--')) ?? 'dsh-effort-sync'
const isPrivate = args.includes('--private')

function tunnel(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${TARGET.host}:${TARGET.port}`,
      timeout: timeoutMs,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT -> HTTP ${res.statusCode}`))
      resolve(socket)
    })
    req.on('timeout', () => reject(new Error('CONNECT timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function api(method, path, body, token) {
  const socket = tls.connect({ socket: await tunnel(), servername: TARGET.host })
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  socket.write([
    `${method} ${path} HTTP/1.1`,
    `Host: ${TARGET.host}`,
    'User-Agent: dsh-effort-sync-tooling',
    'Accept: application/vnd.github+json',
    'Connection: close',
    ...(payload ? ['Content-Type: application/json', `Content-Length: ${payload.length}`] : []),
    `Authorization: Bearer ${token}`,
    '', '',
  ].join('\r\n'))
  if (payload) socket.write(payload)
  const chunks = []
  for await (const chunk of socket) chunks.push(chunk)
  socket.end()
  const text = Buffer.concat(chunks).toString('utf8')
  const split = text.indexOf('\r\n\r\n')
  const status = Number(text.slice(0, split).split('\r\n')[0].split(' ')[1])
  return { status, body: text.slice(split + 4) }
}

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is required in the environment.')
  process.exit(2)
}

const created = await api('POST', '/user/repos', {
  name,
  description: 'DSH plugin: sync model-catalog reasoning levels (reasoningEfforts) from what the provider advertises on /v1/models — sync_reasoning_levels tool plus a one-click button in the Models settings page.',
  private: isPrivate,
  has_issues: true,
  has_wiki: false,
  auto_init: false,
}, token)

if (created.status === 201) {
  const repo = JSON.parse(created.body)
  console.log('created:', repo.full_name, '| private:', repo.private, '| default branch:', repo.default_branch)
} else if (created.status === 422) {
  console.log(`repo "${name}" already exists — nothing to do`)
} else {
  console.error('create failed:', created.status)
  console.error(created.body.slice(0, 400))
  process.exit(1)
}
