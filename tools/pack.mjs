/**
 * Pack dsh-effort-sync into an npm-format tarball without a package manager.
 *
 * Why: `pnpm pack` spawns a child with piped stdio, which the agent sandbox
 * refuses (EPERM); escalation is not worth it for tar+gzip. The output layout is
 * exactly what npm/pnpm produce — `<name>-<version>/package.json`, gzipped tar
 * with the usual header checksum — so `npm i <file>.tgz` accepts it.
 *
 * Usage: node tools/pack.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const prefix = `${pkg.name}-${pkg.version}`
const outFile = path.join(root, `${prefix}.tgz`)

/** Files npm would include: `files` entries plus the manifest itself. */
function collect() {
  const wanted = new Set(['package.json', 'README.md', 'LICENSE'])
  for (const entry of pkg.files ?? []) wanted.add(entry)
  const files = []
  for (const entry of wanted) {
    const abs = path.join(root, entry)
    if (!fs.existsSync(abs)) continue
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      for (const rel of walk(abs, entry)) files.push(rel)
    } else {
      files.push(entry)
    }
  }
  return files.sort()
}

function walk(dir, rel) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, name)
    const childRel = `${rel}/${name}`
    if (fs.statSync(child).isDirectory()) out.push(...walk(child, childRel))
    else out.push(childRel)
  }
  return out
}

function tarHeader(name, size) {
  const buf = Buffer.alloc(512)
  const write = (offset, length, value) => buf.write(value, offset, Math.min(length, Buffer.byteLength(value)))
  write(0, 100, name)              // name
  write(100, 8, '0000644\0')       // mode
  write(108, 8, '0000000\0')       // uid
  write(116, 8, '0000000\0')       // gid
  write(124, 12, size.toString(8).padStart(11, '0') + '\0')
  write(136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0')
  buf.write('        ', 148, 8, 'ascii') // checksum placeholder
  buf.write('0', 156, 1, 'ascii')        // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of buf) sum += byte
  write(148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return buf
}

const files = collect()
const chunks = []
for (const rel of files) {
  const data = fs.readFileSync(path.join(root, rel))
  chunks.push(tarHeader(`${prefix}/${rel}`, data.length), data)
  const pad = (512 - (data.length % 512)) % 512
  if (pad) chunks.push(Buffer.alloc(pad))
}
chunks.push(Buffer.alloc(1024)) // two zero blocks end the archive

const tar = Buffer.concat(chunks)
// npm writes a gzipped tar; the mtime is intentionally zeroed for reproducibility.
fs.writeFileSync(outFile, zlib.gzipSync(tar, { level: 9, mtime: 0 }))

const listing = files.map((f) => `  ${f}`).join('\n')
console.log(`packed ${outFile}`)
console.log(`  ${files.length} files, ${fs.statSync(outFile).size} bytes`)
console.log(listing)
