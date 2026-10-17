/**
 * Verify a push landed: the remote branch tip, the tree it points at, and the
 * workflow file GitHub sees. Read-only, through the same proxy tunnel.
 *
 * Usage: GITHUB_TOKEN=... node tools/gh-verify.mjs [owner/name] [branch]
 */
import http from 'node:http'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 7897 }
const TARGET = { host: 'api.github.com', port: 443 }
const repo = process.argv[2] ?? 'DC1024/dsh-effort-sync'
const branch = process.argv[3] ?? 'main'

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

async function api(path) {
  const socket = tls.connect({ socket: await tunnel(), servername: TARGET.host })
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: ${TARGET.host}`,
    `Authorization: Bearer ${process.env.GITHUB_TOKEN}`,
    'User-Agent: dsh-effort-sync-tooling',
    'Accept: application/vnd.github+json',
    'Connection: close',
    '', '',
  ].join('\r\n'))
  const chunks = []
  for await (const chunk of socket) chunks.push(chunk)
  socket.end()
  const raw = Buffer.concat(chunks).toString('utf8')
  const split = raw.indexOf('\r\n\r\n')
  const status = Number(raw.slice(0, split).split('\r\n')[0].split(' ')[1])
  let body
  try { body = JSON.parse(raw.slice(split + 4)) } catch { body = undefined }
  return { status, body }
}

if (!process.env.GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN is required in the environment.')
  process.exit(2)
}

const ref = await api(`/repos/${repo}/git/ref/heads/${branch}`)
console.log(`ref heads/${branch} ->`, ref.status, ref.body?.object?.sha ?? ref.body?.message)

const commit = await api(`/repos/${repo}/commits/${branch}`)
if (commit.status === 200) {
  console.log('commit:', commit.body.sha.slice(0, 7), '|', commit.body.commit.message.split('\n')[0])
  console.log('author:', commit.body.commit.author.name, '<' + commit.body.commit.author.email + '>')
  console.log('files in tree:')
  for (const entry of commit.body.files ?? []) {
    console.log(`  ${entry.status.padEnd(9)} ${entry.filename}`)
  }
  console.log(`total ${commit.body.files?.length ?? 0} files (GitHub caps this list at 300)`)
}

const workflow = await api(`/repos/${repo}/contents/.github/workflows/ci.yml?ref=${branch}`)
console.log('workflow present:', workflow.status === 200 ? 'yes' : `no (${workflow.status})`)

const meta = await api(`/repos/${repo}`)
if (meta.status === 200) {
  console.log('repo:', meta.body.full_name, '| private:', meta.body.private,
    '| default branch:', meta.body.default_branch, '| pushed:', meta.body.pushed_at)
}
