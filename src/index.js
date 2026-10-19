import { deleteSessionCore } from './core.js'
export const name = 'dsh-session-delete'
export const inject = ['sessions', 'agents', 'connection']
export const DELETE_ROUTE = '/api/dsh-session-delete'
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
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
      if (result.status === 200 && result.body?.dryRun !== true && result.body?.detached !== true) {
        // A detached Session already announced itself through `session/disposed`; a
        // session that was cold (only on disk) has no such event, so the sidebar row
        // would survive until a page reload without this broadcast.
        try {
          ctx.emit('api-session/removed', result.body.sessionId)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-session-delete: removal broadcast failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return json(result.status, result.body)
    },
  })
  ctx.effect(() => dispose, 'dsh-session-delete: http route')
}
