/**
 * Poll the Pages workflow until it settles, then fetch the deployed page.
 *
 * Usage: GITHUB_TOKEN=... node tools/gh-check-pages.mjs [owner/name]
 */
import http from 'node:http'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 7897 }
const repo = process.argv[2] ?? 'DC1024/dsh-effort-sync'
const SITE = 'dc1024.github.io'
const PAGE = '/dsh-effort-sync/'

function tunnel(host, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${host}:443`,
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

async function get(host, path, token) {
  const socket = tls.connect({ socket: await tunnel(host), servername: host })
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'User-Agent: dsh-effort-sync-tooling',
    'Accept: application/vnd.github+json, text/html',
    'Connection: close',
    ...(token ? [`Authorization: Bearer ${token}`] : []),
    '', '',
  ].join('\r\n'))
  const chunks = []
  for await (const chunk of socket) chunks.push(chunk)
  socket.end()
  const raw = Buffer.concat(chunks).toString('utf8')
  const split = raw.indexOf('\r\n\r\n')
  const head = raw.slice(0, split).split('\r\n')
  const status = Number(head[0].split(' ')[1])
  let parsed
  try { parsed = JSON.parse(raw.slice(split + 4)) } catch { parsed = undefined }
  return { status, headers: head, body: raw.slice(split + 4), json: parsed }
}

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is required in the environment.')
  process.exit(2)
}

let run
const deadline = Date.now() + 240000
while (Date.now() < deadline) {
  const runs = await get('api.github.com', `/repos/${repo}/actions/runs?per_page=5`, token)
  const pages = (runs.json?.workflow_runs ?? []).filter((r) => r.name === 'GitHub Pages')
  if (pages.length) {
    run = pages[0]
    console.log(`run #${run.run_number} ${run.status}/${run.conclusion ?? '-'} ${run.head_sha.slice(0, 7)} ${run.html_url}`)
    if (run.status === 'completed') break
  } else {
    console.log('no Pages run yet…')
  }
  await new Promise((r) => setTimeout(r, 15000))
}

if (!run) {
  console.error('Pages workflow never appeared')
  process.exit(1)
}
if (run.conclusion !== 'success') {
  console.error(`Pages deployment concluded "${run.conclusion ?? 'unknown'}" — stopping before touching the live URL`)
  process.exit(1)
}

for (let attempt = 1; attempt <= 6; attempt++) {
  const page = await get(SITE, PAGE)
  const hasTitle = page.body.includes('dsh-effort-sync')
  const hasHero = page.body.includes('网关报了六档强度')
  const hasCss = page.body.includes('./style.css')
  console.log(`live check #${attempt}: HTTP ${page.status} | title-text: ${hasTitle} | hero: ${hasHero} | links css: ${hasCss} | bytes: ${page.body.length}`)
  if (page.status === 200 && hasHero) {
    console.log('live site OK -> https://dc1024.github.io/dsh-effort-sync/')
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 15000))
}
console.error('live page did not serve the expected markup')
process.exit(1)
