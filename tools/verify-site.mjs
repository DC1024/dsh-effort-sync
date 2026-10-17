/**
 * Render the promo page in a real browser and fail loudly on the traps this
 * project already hit once (dsh-real-model): a hero that stays invisible, and
 * code blocks widening the page.
 *
 * Playwright comes from the DSH desktop app's own module store — no install.
 *
 * Usage: node tools/verify-site.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const page_url = pathToFileURL(path.join(root, 'docs', 'index.html')).href
const outDir = path.join(root, '.verify')
fs.mkdirSync(outDir, { recursive: true })

let chromium
const candidates = [
  process.env.PLAYWRIGHT_MODULE,
  'C:/Users/15657.DC-PC/AppData/Roaming/dsh-desktop/harness/profiles/.generations/live/dsh-ops+0.3.0+185ddf88697e/node_modules/playwright',
  'playwright',
].filter(Boolean)
for (const candidate of candidates) {
  try {
    chromium = require(candidate).chromium
    console.log('playwright from:', candidate)
    break
  } catch (error) {
    if (candidate === candidates.at(-1)) {
      console.error('playwright not found; set PLAYWRIGHT_MODULE to its index.js')
      console.error(String(error?.message ?? error))
      process.exit(2)
    }
  }
}

const browser = await chromium.launch()
const results = {}

async function shoot(name, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const problems = []
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message))

  await page.goto(page_url, { waitUntil: 'load' })
  // Let the reveal observers fire for everything above the fold, then walk the page.
  await page.waitForTimeout(700)
  const height_ = await page.evaluate(() => document.body.scrollHeight)
  for (let y = 0; y < height_; y += Math.round(height_ / 8) + 1) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.waitForTimeout(90)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    const inner = window.innerWidth
    const horizontal = doc.scrollWidth - inner
    const hidden = []
    for (const el of document.querySelectorAll('[data-reveal]')) {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const inViewport = rect.top < window.innerHeight && rect.bottom > 0
      if (Number(style.opacity) < 0.9 && inViewport) {
        hidden.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className,
          opacity: style.opacity,
          top: Math.round(rect.top),
        })
      }
    }
    const wide = []
    for (const el of document.querySelectorAll('pre, table, .cmd, code')) {
      const rect = el.getBoundingClientRect()
      if (rect.right > inner + 1 || rect.left < -1) {
        wide.push({ tag: el.tagName.toLowerCase(), cls: el.className, right: Math.round(rect.right), left: Math.round(rect.left) })
      }
    }
    return {
      innerWidth: inner,
      scrollWidth: doc.scrollWidth,
      horizontalOverflow: horizontal,
      bodyScrollHeight: document.body.scrollHeight,
      hiddenReveals: hidden,
      overflowing: wide.slice(0, 12),
      canvas: (() => {
        const c = document.getElementById('mesh')
        return c ? { w: c.width, h: c.height } : null
      })(),
      title: document.title,
      h1: document.querySelector('h1')?.innerText.replace(/\n+/g, ' / '),
      sections: [...document.querySelectorAll('section[id]')].map((s) => s.id),
      copies: document.querySelectorAll('.copy').length,
    }
  })

  if (metrics.horizontalOverflow > 0) problems.push(`page is ${metrics.horizontalOverflow}px wider than the viewport`)
  if (metrics.hiddenReveals.length) problems.push(`${metrics.hiddenReveals.length} reveal(s) still invisible in the first viewport`)
  if (metrics.overflowing.length) problems.push(`${metrics.overflowing.length} element(s) stick out horizontally`)
  if (consoleErrors.length) problems.push('console errors: ' + consoleErrors.join(' | '))
  if (!metrics.h1) problems.push('no h1 text')

  const file = path.join(outDir, `site-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  await page.close()

  results[name] = { metrics, problems, consoleErrors, screenshot: file }
  return problems.length === 0
}

const okDesktop = await shoot('desktop', 1440, 900)
const okMobile = await shoot('mobile', 414, 820)
await browser.close()

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2))
for (const [name, r] of Object.entries(results)) {
  console.log(`\n[${name}] ${r.problems.length ? 'PROBLEMS' : 'clean'}`)
  console.log('  viewport/scroll:', r.metrics.innerWidth, '/', r.metrics.scrollWidth, '| overflow:', r.metrics.horizontalOverflow)
  console.log('  title:', r.metrics.title)
  console.log('  h1:', r.metrics.h1)
  console.log('  sections:', r.metrics.sections.join(', '))
  console.log('  canvas px:', JSON.stringify(r.metrics.canvas), '| copy buttons:', r.metrics.copies)
  for (const p of r.problems) console.log('  ! ' + p)
  console.log('  shot:', r.screenshot)
}
process.exit(okDesktop && okMobile ? 0 : 1)
