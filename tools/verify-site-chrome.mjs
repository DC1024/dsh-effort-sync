/**
 * Render the promo page without a browser automation library.
 *
 * The machine has Playwright's downloaded Chromium but no `playwright` package
 * to drive it (and no network to fetch one), so this talks to the browser over
 * the DevTools protocol directly: launch headless with remote debugging, find
 * the page target on 127.0.0.1, evaluate a measurement script, and ask for a
 * full-page screenshot.
 *
 * Usage: node tools/verify-site-chrome.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pageUrl = pathToFileURL(path.join(root, 'docs', 'index.html')).href
const outDir = path.join(root, '.verify')
fs.mkdirSync(outDir, { recursive: true })

const CHROME = process.env.CHROME_BIN
  ?? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')
if (!fs.existsSync(CHROME)) {
  console.error('chromium not found at', CHROME, '— set CHROME_BIN')
  process.exit(2)
}

const PORT = 9333
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-site-check-'))

const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
  })
}

async function waitForDevTools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${PORT}/json/version`)
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('DevTools endpoint never came up')
}

/** Minimal CDP client: text frames only, one command at a time. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const events = []
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: done, reject: fail } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) fail(new Error(JSON.stringify(msg.error)))
        else done(msg.result)
        return
      }
      events.push(msg)
    })
    socket.addEventListener('error', (error) => reject(error))
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const messageId = ++id
        return new Promise((done, fail) => {
          pending.set(messageId, { resolve: done, reject: fail })
          socket.send(JSON.stringify({ id: messageId, method, params }))
        })
      },
      events,
      close: () => socket.close(),
    }))
  })
}

const MEASURE = `(() => {
  const doc = document.documentElement;
  const inner = window.innerWidth;
  const hidden = [];
  for (const el of document.querySelectorAll('[data-reveal]')) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const inViewport = rect.top < window.innerHeight && rect.bottom > 0;
    if (Number(style.opacity) < 0.9 && inViewport) {
      hidden.push({ tag: el.tagName.toLowerCase(), cls: String(el.className), opacity: style.opacity });
    }
  }
  const wide = [];
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('pre, table, .cmd, code, svg')) {
    const rect = el.getBoundingClientRect();
    if ((rect.right > inner + 1 || rect.left < -1) && !inScroller(el)) {
      wide.push({ tag: el.tagName.toLowerCase(), cls: String(el.className), left: Math.round(rect.left), right: Math.round(rect.right) });
    }
  }
  const canvas = document.getElementById('mesh');
  return JSON.stringify({
    innerWidth: inner,
    scrollWidth: doc.scrollWidth,
    horizontalOverflow: doc.scrollWidth - inner,
    bodyHeight: document.body.scrollHeight,
    hiddenReveals: hidden,
    overflowing: wide.slice(0, 12),
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    title: document.title,
    h1: document.querySelector('h1') ? document.querySelector('h1').innerText.replace(/\\n+/g, ' / ') : null,
    sections: [...document.querySelectorAll('section[id]')].map(s => s.id),
    copyButtons: document.querySelectorAll('.copy').length,
    reveals: document.querySelectorAll('[data-reveal]').length,
    consoleErrors: window.__errors || []
  });
})()`

let version
try {
  version = await waitForDevTools()
} catch (error) {
  child.kill()
  console.error('could not start chromium:', error.message)
  process.exit(1)
}
console.log('browser:', version.Browser)

const results = {}
let failures = 0

async function shoot(name, width, height) {
  const target = await getJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`).catch(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    return list.find((t) => t.type === 'page')
  })
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'mobile' })
  await client.send('Page.navigate', { url: pageUrl })
  await new Promise((r) => setTimeout(r, 1600))
  // walk the page so the reveal observers fire everywhere
  await client.send('Runtime.evaluate', {
    expression: `(async () => { const h = document.body.scrollHeight; for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 300)); })()`,
    awaitPromise: true,
  })
  const measured = await client.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  const metrics = JSON.parse(measured.result.value)
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = path.join(outDir, `site-${name}.png`)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))

  const problems = []
  if (metrics.horizontalOverflow > 0) problems.push(`page is ${metrics.horizontalOverflow}px wider than the viewport`)
  if (metrics.hiddenReveals.length) problems.push(`${metrics.hiddenReveals.length} reveal(s) invisible in viewport: ${JSON.stringify(metrics.hiddenReveals.slice(0, 3))}`)
  if (metrics.overflowing.length) problems.push(`${metrics.overflowing.length} element(s) overflow: ${JSON.stringify(metrics.overflowing.slice(0, 3))}`)
  if (!metrics.h1) problems.push('no h1 text')
  if (!metrics.canvas || metrics.canvas.w < 100) problems.push('canvas has no backing store')
  if (problems.length) failures++

  results[name] = { metrics, problems, screenshot: file }
  console.log(`\n[${name} ${width}x${height}] ${problems.length ? 'PROBLEMS' : 'clean'}`)
  console.log('  scrollWidth/innerWidth:', metrics.scrollWidth, '/', metrics.innerWidth, '| overflow:', metrics.horizontalOverflow)
  console.log('  body height:', metrics.bodyHeight, '| reveals:', metrics.reveals, '| copy buttons:', metrics.copyButtons)
  console.log('  title:', metrics.title)
  console.log('  h1:', metrics.h1)
  console.log('  sections:', metrics.sections.join(', '))
  console.log('  canvas px:', JSON.stringify(metrics.canvas))
  for (const p of problems) console.log('  ! ' + p)
  console.log('  shot:', file)
  client.close()
}

await shoot('desktop', 1440, 900)
await shoot('mobile', 414, 820)

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2))
child.kill()
console.log(`\n${failures === 0 ? 'site verification: clean' : `site verification: ${failures} viewport(s) with problems`}`)
process.exit(failures === 0 ? 0 : 1)
