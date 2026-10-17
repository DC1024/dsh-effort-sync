/**
 * Reach the GitHub API through the user's local HTTP proxy.
 *
 * fetch() has no proxy support for the environment's HTTPS_PROXY, and this
 * machine needs the proxy to reach GitHub. Node's http module can issue a
 * CONNECT tunnel itself, but TLS over an already-established socket needs a raw
 * craft, so this mirrors the pattern already proven on this host: hand-built
 * CONNECT + tls.connect.
 *
 * Usage: node tools/gh-check.mjs
 */
import http from 'node:http'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 7897 }
const TARGET = { host: 'api.github.com', port: 443 }

/** Open a CONNECT tunnel and hand back a TLS socket over it. */
function tunnel({ proxy = PROXY, target = TARGET, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      timeout: timeoutMs,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`CONNECT ${target.host} -> HTTP ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.on('timeout', () => reject(new Error('CONNECT timed out')))
    req.on('error', reject)
    req.end()
  })
}

/** One HTTPS request over a fresh tunnel. */
async function request({ method = 'GET', path, body, headers = {} } = {}) {
  const raw = await tunnel()
  const socket = tls.connect({ socket: raw, servername: TARGET.host })
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const head = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${TARGET.host}`,
    'User-Agent: dsh-effort-sync-tooling',
    'Accept: application/vnd.github+json',
    'Connection: close',
    ...(payload ? ['Content-Type: application/json', `Content-Length: ${payload.length}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '', '',
  ].join('\r\n')
  socket.write(head)
  if (payload) socket.write(payload)
  const chunks = []
  for await (const chunk of socket) chunks.push(chunk)
  socket.end()
  const text = Buffer.concat(chunks).toString('utf8')
  const split = text.indexOf('\r\n\r\n')
  const rawHead = text.slice(0, split)
  const status = Number(rawHead.split('\r\n')[0].split(' ')[1])
  return { status, head: rawHead, body: text.slice(split + 4) }
}

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is not set; pass it via the environment, never the command line.')
  process.exit(2)
}

const who = await request({ path: '/user', headers: { Authorization: `Bearer ${token}` } })
console.log('GET /user ->', who.status)
if (who.status === 200) {
  const me = JSON.parse(who.body)
  console.log('login:', me.login, '| name:', me.name ?? '(none)')
} else {
  console.log(who.body.slice(0, 300))
}

const repos = await request({
  path: '/user/repos?per_page=100&sort=updated',
  headers: { Authorization: `Bearer ${token}` },
})
console.log('GET /user/repos ->', repos.status)
if (repos.status === 200) {
  const names = JSON.parse(repos.body).map((r) => `${r.full_name}${r.private ? ' (private)' : ''}`)
  console.log('repos:', names.join(', ') || '(none)')
}
