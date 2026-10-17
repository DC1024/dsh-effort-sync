/** Capture a Node-style response into { status, headers, text, json }. */
function makeRes() {
  const out = {
    status: 0,
    headers: undefined,
    chunks: [],
    get text() { return out.chunks.join('') },
    get json() { try { return JSON.parse(out.text) } catch { return undefined } },
    writeHead: (code, headers) => { out.status = code; out.headers = headers },
    setHeader: () => {},
    end: (body) => { if (body) out.chunks.push(String(body)) },
  }
  return out
}

/**
 * Drive handleSyncRequest with a captured response.
 * @returns the captured response.
 */
export async function drive(handler, ctx, req) {
  const res = makeRes()
  await handler(ctx, req, res)
  return res
}

export { makeRes }
