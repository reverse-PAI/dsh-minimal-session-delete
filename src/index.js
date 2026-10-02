/**
 * Host half of `@local/dsh-session-delete`: wires the deletion core
 * (`./core.js`, where the algorithm and its ordering are documented) to one
 * authenticated exact Fetch route.
 *
 * `ctx.connection.fetch.register` is the carrier the shipped session-log export
 * uses: the shared `/api` channel enforces Host/Origin trust and the browser
 * session cookie before any handler runs, which is why the browser addresses it
 * with a document-relative path.
 *
 * @module @local/dsh-session-delete
 */

import { deleteSessionCore } from './core.js'

export const name = 'dsh-session-delete'

/** `connection` carries the route; `sessions`/`agents` are what the core reads. */
export const inject = ['sessions', 'agents', 'connection']

/** Absolute registration path of the delete route. */
export const DELETE_ROUTE = '/api/dsh-session-delete'

/** One JSON response for the route. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Parse a JSON-object request body, or answer the refusal. */
async function readPayload(request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    payload = undefined
  }
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? { payload }
    : { refusal: json(400, { ok: false, code: 'bad-json', message: 'request body must be a JSON object' }) }
}

/**
 * Register the authenticated delete route.
 * @param ctx - Host context; `connection` is a declared dependency.
 */
export function apply(ctx) {
  const dispose = ctx.connection.fetch.register({
    path: DELETE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return json(405, { ok: false, code: 'method-not-allowed', message: 'use POST' })
      }
      const { payload, refusal } = await readPayload(request)
      if (refusal !== undefined) return refusal
      let result
      try {
        result = await deleteSessionCore(ctx, payload['sessionId'], { dryRun: payload['dryRun'] === true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.error?.(`dsh-session-delete: delete failed: ${message}`)
        result = { status: 500, body: { ok: false, code: 'internal', message } }
      }
      return json(result.status, result.body)
    },
  })
  ctx.effect(() => dispose, 'dsh-session-delete: http route')
}
