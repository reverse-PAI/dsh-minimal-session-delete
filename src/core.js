import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const PROJECTION_DOMAIN = 'session_projcache'
const PROJECTION_TABLE = 'sessions'
const DELETE_PASSES = 11
const DELETE_RETRY_MS = 200
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_ID_RE = new RegExp(`^(?:session-(?:${UUID}|\\d{1,9})|${UUID})$`, 'i')
const messageOf = error => (error instanceof Error ? error.message : String(error))
const delay = ms => new Promise((resolve) => { setTimeout(resolve, ms) })
const fail = (status, code, message, extra) => ({ status, body: { ok: false, code, message, ...extra } })
const pass = body => ({ status: 200, body: { ok: true, ...body } })
const note = (warnings, label, error) => { warnings.push(`${label}: ${messageOf(error)}`) }
function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}
function dshHome() {
  const home = process.env['DSH_HOME']
  return home !== undefined && home.length > 0 ? home : path.join(os.homedir(), '.dsh')
}
export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}
export function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else variants.add(`session-${sessionId}`)
  return [...variants]
}
export function findSessionDirs(sessionId, root = sessionsRoot()) {
  let slugs
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const variants = sessionIdVariants(sessionId)
  const found = []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, slug.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory()) found.push(candidate)
      } catch {
      }
    }
  }
  return found
}
export function removeSessionDirs(targets) {
  const removed = []
  const failed = []
  for (const dir of targets) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      failed.push({ dir, reason: messageOf(error) })
    }
  }
  return { removed, failed }
}
function relativeDirs(dirs, root) {
  return dirs.map(dir => path.relative(root, dir) || path.basename(dir))
}
function cacheTable(ctx) {
  const storageDomain = service(ctx, 'storageDomain')
  if (storageDomain === undefined || typeof storageDomain.get !== 'function') return undefined
  const domain = storageDomain.get(PROJECTION_DOMAIN)
  if (domain === undefined || typeof domain.table !== 'function') return undefined
  try {
    return domain.table(PROJECTION_TABLE)
  } catch {
    return undefined
  }
}
function cacheRecordPath(variant) {
  return path.join(dshHome(), 'storages', PROJECTION_DOMAIN, PROJECTION_TABLE, `${variant}.json`)
}
function cacheRowExists(cache, variant) {
  if (cache !== undefined) {
    try {
      return cache.get(variant) !== undefined
    } catch {
    }
  }
  return fs.existsSync(cacheRecordPath(variant))
}
async function locate(ctx, sessionId, variants, warnings) {
  const live = variants
    .map(variant => ({ variant, session: ctx.sessions.get(variant) }))
    .filter(entry => entry.session !== undefined)
  const persistence = service(ctx, 'sessionPersistence')
  let persisted = false
  if (persistence !== undefined && typeof persistence.stat === 'function') {
    for (const variant of variants) {
      try {
        if ((await persistence.stat(variant)) !== undefined) {
          persisted = true
          break
        }
      } catch (error) {
        note(warnings, `stat("${variant}")`, error)
      }
    }
  }
  const cache = cacheTable(ctx)
  const cachedRows = variants.filter(variant => cacheRowExists(cache, variant)).length
  return { live, persisted, cachedRows, cache, dirs: findSessionDirs(sessionId) }
}
function runningRefusal(ctx, variants, sessionId) {
  for (const variant of variants) {
    const agent = ctx.agents.get(variant)
    if (agent !== undefined && agent.status === 'running') {
      return fail(409, 'running', `session "${variant}" is running; stop it before deleting`, { sessionId })
    }
  }
  return undefined
}
async function quiesce(ctx, live, warnings) {
  for (const { variant, session } of live) {
    const agent = ctx.agents.get(variant)
    if (agent !== undefined && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'user' })
      } catch (error) {
        note(warnings, `cancel("${variant}")`, error)
      }
    }
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      note(warnings, `flush("${variant}")`, error)
    }
  }
}
function detachLive(ctx, variants, live, sessionId, warnings) {
  const store = ctx.sessions.store
  const canDetach = typeof ctx.sessions.detachEntered === 'function'
    && store !== undefined && typeof store.get === 'function'
  if (live.length > 0 && !canDetach) {
    return {
      refusal: fail(
        409,
        'cannot-detach',
        'this Harness build does not expose the session-store detach path needed to delete an attached session',
        { sessionId },
      ),
    }
  }
  if (!canDetach) return { detached: false }
  let detached = false
  for (const variant of variants) {
    let entry
    try {
      entry = store.get(variant)
    } catch {
      entry = undefined
    }
    if (entry === undefined) continue
    try {
      ctx.sessions.detachEntered(entry)
      detached = true
    } catch (error) {
      note(warnings, `detach("${variant}")`, error)
    }
  }
  return { detached }
}
async function removeAll(sessionId, warnings, targets) {
  const removed = []
  const failed = new Map()
  let remaining = targets
  for (let passIndex = 0; ; passIndex += 1) {
    const outcome = removeSessionDirs(remaining)
    removed.push(...outcome.removed)
    for (const entry of outcome.failed) failed.set(entry.dir, entry.reason)
    remaining = findSessionDirs(sessionId)
    if (remaining.length === 0 || passIndex >= DELETE_PASSES - 1) break
    await delay(DELETE_RETRY_MS)
  }
  for (const [dir, reason] of failed) note(warnings, `rm("${dir}") failed`, new Error(reason))
  return { removed, remaining }
}
async function dropCacheRow(cache, variant, warnings) {
  if (cache !== undefined) {
    try {
      return await cache.delete(variant)
    } catch (error) {
      note(warnings, `projection cache delete("${variant}")`, error)
    }
  }
  const file = cacheRecordPath(variant)
  try {
    if (!fs.existsSync(file)) return false
    fs.rmSync(file, { force: true })
    return true
  } catch (error) {
    note(warnings, `projection cache file("${variant}")`, error)
    return false
  }
}
async function clearAccounting(registry, variants, cache, warnings) {
  let cacheRowsCleared = 0
  for (const variant of variants) {
    if (await dropCacheRow(cache, variant, warnings)) cacheRowsCleared += 1
  }
  let archiveCleared = false
  if (registry !== undefined && Array.isArray(registry.archivedSessionIds)) {
    for (const variant of variants) {
      if (!registry.archivedSessionIds.includes(variant)) continue
      try {
        await registry.unarchiveSession(variant)
        archiveCleared = true
      } catch (error) {
        note(warnings, `unarchive("${variant}")`, error)
      }
    }
  }
  let pinCleared = false
  if (registry !== undefined && Array.isArray(registry.pinnedSessionIds)) {
    for (const variant of variants) {
      if (!registry.pinnedSessionIds.includes(variant)) continue
      try {
        await registry.unpinSession(variant)
        pinCleared = true
      } catch (error) {
        note(warnings, `unpin("${variant}")`, error)
      }
    }
  }
  return { cacheRowsCleared, archiveCleared, pinCleared }
}
async function detachWorkspaceSlots(registry, variants, warnings) {
  if (registry === undefined || typeof registry.list !== 'function') return
  for (const workspace of registry.list()) {
    if (workspace === null || workspace === undefined) continue
    if (typeof workspace.detachSession !== 'function') continue
    for (const variant of variants) {
      try {
        await workspace.detachSession(variant)
      } catch (error) {
        note(warnings, `workspace slot detach("${variant}")`, error)
      }
    }
  }
}
export async function deleteSessionCore(ctx, rawSessionId, options = {}) {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    return fail(400, 'invalid-id', `invalid session id: ${JSON.stringify(rawSessionId)}`)
  }
  const warnings = []
  const variants = sessionIdVariants(sessionId)
  const root = sessionsRoot()
  const { live, persisted, cachedRows, cache, dirs } = await locate(ctx, sessionId, variants, warnings)
  if (dirs.length === 0 && live.length === 0 && !persisted && cachedRows === 0) {
    return fail(404, 'not-found', `no session found for "${sessionId}"`)
  }
  const refusal = runningRefusal(ctx, variants, sessionId)
  if (refusal !== undefined) return refusal
  if (options.dryRun === true) {
    return pass({
      dryRun: true,
      sessionId,
      dirs: relativeDirs(dirs, root),
      attached: live.length > 0,
      persisted,
      cachedRows,
    })
  }
  await quiesce(ctx, live, warnings)
  const detach = detachLive(ctx, variants, live, sessionId, warnings)
  if (detach.refusal !== undefined) return detach.refusal
  const { removed, remaining } = await removeAll(sessionId, warnings, dirs)
  const registry = service(ctx, 'workspaceRegistry')
  const { cacheRowsCleared, archiveCleared, pinCleared } = await clearAccounting(registry, variants, cache, warnings)
  if (remaining.length > 0) {
    const remainingRel = relativeDirs(remaining, root)
    for (const dir of remaining) ctx.logger?.warn?.(`dsh-session-delete: could not remove ${dir}`)
    return fail(500, 'delete-failed', `session files could not be fully removed: ${remainingRel.join(', ')}`, {
      sessionId,
      remainingDirs: remainingRel,
      warnings,
    })
  }
  await detachWorkspaceSlots(registry, variants, warnings)
  return pass({
    sessionId,
    removedDirs: relativeDirs(removed, root),
    remainingDirs: [],
    detached: detach.detached,
    cacheRowsCleared,
    archiveCleared,
    pinCleared,
    warnings,
  })
}
