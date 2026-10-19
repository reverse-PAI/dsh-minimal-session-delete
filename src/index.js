import { deleteSessionCore, hostCapabilities } from './core.js'
export const name = 'dsh-session-delete'
export const inject = ['sessions', 'agents', 'connection']
export const DELETE_ROUTE = '/api/dsh-session-delete'
const messageOf = error => (error instanceof Error ? error.message : String(error))
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
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        // Machine-readable host-contract probe. The client and any external
        // caller can decide whether live deletion and cascade are available
        // instead of discovering a missing internal halfway through a delete.
        let capabilities
        try {
          capabilities = hostCapabilities(ctx)
        } catch (error) {
          capabilities = { mode: 'unknown', error: messageOf(error) }
        }
        return json(200, { ok: true, capabilities })
      }
      if (request.method !== 'POST') {
        return json(405, { ok: false, code: 'method-not-allowed', message: 'use GET or POST' })
      }
      const { payload, refusal } = await readPayload(request)
      if (refusal !== undefined) return refusal
      let result
      try {
        result = await deleteSessionCore(ctx, payload['sessionId'], { dryRun: payload['dryRun'] === true })
      } catch (error) {
        ctx.logger?.error?.(`dsh-session-delete: delete failed: ${messageOf(error)}`)
        result = {
          status: 500,
          body: { ok: false, code: 'internal', message: 'internal error while deleting the session' },
        }
      }
      if (result.status === 200 && result.body?.dryRun !== true) {
        // A detached Session already announced itself through `session/disposed`; a
        // session that was cold (only on disk) has no such event, so the sidebar row
        // would survive until a page reload without this broadcast.
        const broadcast = Array.isArray(result.body?.broadcast) ? result.body.broadcast : []
        for (const sessionId of broadcast) {
          try {
            ctx.emit('api-session/removed', sessionId)
          } catch (error) {
            ctx.logger?.warn?.(`dsh-session-delete: removal broadcast failed: ${messageOf(error)}`)
          }
        }
      }
      return json(result.status, result.body)
    },
  })
  ctx.effect(() => dispose, 'dsh-session-delete: http route')
}
