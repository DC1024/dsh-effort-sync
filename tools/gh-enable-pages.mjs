/**
 * Enable GitHub Pages for this repository with the Actions build type.
 *
 * Pages is off on a fresh repository, and without this the Pages workflow's
 * deploy job fails at `configure-pages`. Idempotent: an existing Pages site is
 * reported and left alone.
 *
 * Usage: GITHUB_TOKEN=... node tools/gh-enable-pages.mjs [owner/name]
 */
import http from 'node:http'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 7897 }
const TARGET = { host: 'api.github.com', port: 443 }
const repo = process.argv[2] ?? 'DC1024/dsh-effort-sync'

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

async function api(method, path, body) {
  const socket = tls.connect({ socket: await tunnel(), servername: TARGET.host })
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  socket.write([
    `${method} ${path} HTTP/1.1`,
    `Host: ${TARGET.host}`,
    `Authorization: Bearer ${process.env.GITHUB_TOKEN}`,
    'User-Agent: dsh-effort-sync-tooling',
    'Accept: application/vnd.github+json',
    'Connection: close',
    ...(payload ? ['Content-Type: application/json', `Content-Length: ${payload.length}`] : []),
    '', '',
  ].join('\r\n'))
  if (payload) socket.write(payload)
  const chunks = []
  for await (const chunk of socket) chunks.push(chunk)
  socket.end()
  const raw = Buffer.concat(chunks).toString('utf8')
  const split = raw.indexOf('\r\n\r\n')
  const status = Number(raw.slice(0, split).split('\r\n')[0].split(' ')[1])
  let parsed
  try { parsed = JSON.parse(raw.slice(split + 4)) } catch { parsed = undefined }
  return { status, body: parsed }
}

if (!process.env.GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN is required in the environment.')
  process.exit(2)
}

const before = await api('GET', `/repos/${repo}/pages`)
if (before.status === 200) {
  console.log('pages already enabled:', before.body.html_url, '| build_type:', before.body.build_type)
} else {
  const created = await api('POST', `/repos/${repo}/pages`, { build_type: 'workflow' })
  if (created.status === 201) {
    console.log('pages enabled:', created.body.html_url, '| build_type:', created.body.build_type)
  } else {
    console.error('enable failed:', created.status)
    console.error(JSON.stringify(created.body).slice(0, 400))
    process.exit(1)
  }
}

const after = await api('GET', `/repos/${repo}/pages`)
console.log('pages state:', after.status, after.body?.html_url ?? '', after.body?.build_type ?? '')
