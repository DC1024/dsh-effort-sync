/**
 * dsh-effort-sync — client half.
 *
 * Adds one button to Settings → Models: "同步推理等级". Adding a model in the GUI
 * leaves `reasoningEfforts` empty, so the model picker has no thinking levels to
 * offer; DSH cannot fill them in because its model-discovery contract carries no
 * reasoning field. This button asks the host half to read each provider's
 * `/v1/models` and write the levels it advertises.
 *
 * The seat is the documented additive extension point `settings.models.footer`
 * (declared by @deepseek-ai/dsh-client-ui-settings-models), so nothing shipped is
 * shadowed. The click is an explicit user action, so the host side applies the
 * diff instead of only reporting it — and the diff it wrote is shown right here.
 */

window.__ModuleLoader__.load({
  id: 'dsh-effort-sync',
  factory: (require) => {
    const React = require('react')
    const h = (type, props, ...kids) => React.createElement(type, props, ...kids)

    const CSS = `
.des-root{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding:12px 14px;border-radius:var(--dsw-radius-lg,10px);
  background:var(--dsw-alias-settings-card-fill,rgba(127,127,127,.06));border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(127,127,127,.22))}
.des-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.des-title{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}
.des-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);margin:0}
.des-button{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:0 0;color:var(--dsw-alias-label-primary,inherit);
  font:inherit;font-size:12px;line-height:18px;cursor:pointer;margin-left:auto}
.des-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.des-button:disabled{opacity:.45;cursor:default}
.des-result{margin:0;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-secondary,inherit)}
.des-result-error{color:var(--dsw-alias-state-error-primary,#e5534b)}
`

    /** POST one sync request to the host half. */
    const requestSync = async (body) => {
      const resp = await fetch('/dsh-effort-sync/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body ?? {}),
      })
      let data
      try {
        data = await resp.json()
      } catch {
        throw new Error(`HTTP ${resp.status}`)
      }
      if (data?.error) throw new Error(String(data.error))
      if (!resp.ok && data?.ok !== true) throw new Error(`HTTP ${resp.status}`)
      return data
    }

    /** One-line-per-change summary of what the button just wrote. */
    const summarize = (report) => {
      const changes = report?.changes ?? []
      if (!changes.length) {
        const per = (report?.providers ?? []).map((p) => `${p.provider}: ${p.error ?? `${p.models ?? 0} models, up to date`}`)
        return ['已是最新，无需改动。', ...per].join('\n')
      }
      const lines = [`已写入 ${changes.length} 个模型的推理等级：`]
      for (const c of changes) {
        lines.push(`  ${c.provider ? `${c.provider} / ` : ''}${c.model}: ${(c.from ?? []).join(',') || '(无)'} → ${(c.to ?? []).join(',')}`)
        if (c.skipped?.length) lines.push(`      跳过（DSH 不认识的等级）: ${c.skipped.join(', ')}`)
      }
      for (const n of report?.notes ?? []) lines.push(`  注: ${n}`)
      return lines.join('\n')
    }

    const TEXTS = {
      title: '推理等级',
      hint: '供应商在 /v1/models 里公布了 supported_reasoning_levels，但 DSH 的模型发现契约没有这个字段，所以新加的模型选不到思考强度。点一下即可按供应商公布的内容补齐。',
      idle: '同步推理等级',
      busy: '同步中…',
      done: '再同步一次',
    }

    /** The seat's body: one button plus the report of its last run. */
    function SyncRow() {
      const [status, setStatus] = React.useState('idle')
      const [result, setResult] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      const run = async () => {
        setStatus('busy')
        setFailed(false)
        try {
          const report = await requestSync({ dryRun: false })
          setResult(summarize(report))
          setStatus('done')
        } catch (error) {
          setResult(`同步失败：${String(error?.message ?? error)}`)
          setFailed(true)
          setStatus('idle')
        }
      }

      const label = status === 'busy' ? TEXTS.busy : status === 'done' ? TEXTS.done : TEXTS.idle
      return h('div', { className: 'des-root' },
        h('div', { className: 'des-head' },
          h('span', { className: 'des-title' }, TEXTS.title),
          h('button', {
            type: 'button',
            className: 'des-button',
            disabled: status === 'busy',
            title: TEXTS.hint,
            onClick: run,
          }, label)),
        h('p', { className: 'des-hint' }, TEXTS.hint),
        result ? h('pre', { className: failed ? 'des-result des-result-error' : 'des-result' }, result) : null)
    }

    function apply(ctx) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-effort-sync'
      tag.textContent = CSS
      document.head.appendChild(tag)

      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer',
        id: 'dsh-effort-sync',
        order: 50,
      }, SyncRow))

      console.log('[dsh-effort-sync] client half ready')
    }

    var module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
