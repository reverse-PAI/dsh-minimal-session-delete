/**
 * Deletion core of `@local/dsh-session-delete` — no Cordis coupling beyond the
 * Host services read through `ctx`, so it is directly testable.
 *
 * The Harness ships no deletion API ("the seam has no deletion API" —
 * `dsh-session-persistence-jsonl`), so the whole operation is owned here, in the
 * order the live machinery requires:
 *
 *   1. validate the id (`session-<uuid>` and bare `<uuid>` both occur on disk);
 *   2. refuse while the Session's Agent is running — the caller stops it first;
 *   3. for an idle attached Session: clear its inbox, then `sessions.flush`;
 *   4. `sessions.detachEntered(entry)` — the step that makes deletion safe. It
 *      emits `session/disposed`, which stops further appends and flushes (a live
 *      writer would otherwise keep writing into the removed log) and makes the
 *      Session Controller emit `api-session/removed`, which the browser applies
 *      as an in-place row removal — no page reload. It also closes the JSONL
 *      write handle, which keeps the release clean but is NOT what unblocks the
 *      unlink: libuv opens with FILE_SHARE_DELETE, so a Node-held file is
 *      deletable;
 *   5. delete `<DSH_HOME>/sessions/<slug>/<id>/` for every id spelling, retrying
 *      against transient EXTERNAL locks (an AV scan, another process);
 *   6. drop the `session_projcache` row, the registry-global archive mark, and
 *      the workspace `sessionIds` slot (the registry keeps such a slot forever
 *      otherwise — see {@link detachWorkspaceSlots}).
 *
 * @module @local/dsh-session-delete/core
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECTION_DOMAIN = 'session_projcache'
const PROJECTION_TABLE = 'sessions'
/** Re-delete passes (and the delay between them) while a writer releases the file. */
const DELETE_PASSES = 11
const DELETE_RETRY_MS = 200
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/**
 * Every id shape that reaches disk: `session-<uuid>` and the bare `<uuid>` the
 * older stores carry, plus the `session-<n>` the store mints when `create` is
 * called without an id. Deliberately closed: no `.`, no separator, nothing that
 * could turn a path segment into a traversal.
 */
const SESSION_ID_RE = new RegExp(`^(?:session-(?:${UUID}|\\d{1,9})|${UUID})$`, 'i')

const messageOf = error => (error instanceof Error ? error.message : String(error))
const delay = ms => new Promise((resolve) => { setTimeout(resolve, ms) })
const fail = (status, code, message, extra) => ({ status, body: { ok: false, code, message, ...extra } })
const pass = body => ({ status: 200, body: { ok: true, ...body } })
/** Record one contained failure without letting it abort the deletion. */
const note = (warnings, label, error) => { warnings.push(`${label}: ${messageOf(error)}`) }

/** Read an optional Host service; a throwing context lookup reads as absent. */
function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/** `$DSH_HOME`, the directory the session root hangs off. Internal: only `sessionsRoot` reads it. */
function dshHome() {
  const home = process.env['DSH_HOME']
  return home !== undefined && home.length > 0 ? home : path.join(os.homedir(), '.dsh')
}

/** The JSONL session root the profile configures as `dshHomePath('sessions')`. */
export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** Every spelling of one id: the id itself and its prefixed/bare twin. */
export function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else variants.add(`session-${sessionId}`)
  return [...variants]
}

/**
 * Every on-disk Session directory for one id, found by scanning the project
 * directories so a workspace-path slug is never re-derived here.
 */
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
        // Missing or unreadable entry: keep scanning.
      }
    }
  }
  return found
}

/** One removal pass: the directories removed, and the failures with their reasons. */
export function removeSessionDirs(sessionId, root = sessionsRoot()) {
  const removed = []
  const failed = []
  for (const dir of findSessionDirs(sessionId, root)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      failed.push({ dir, reason: messageOf(error) })
    }
  }
  return { removed, failed }
}

/** Session directories relative to the root: absolute paths never reach the browser. */
function relativeDirs(dirs, root) {
  return dirs.map(dir => path.relative(root, dir) || path.basename(dir))
}

/** The projection-cache table handle, or `undefined` when the composition omits it. */
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

/**
 * The projection-cache record file the `storage-json` backend keeps for one id.
 * A fallback only: `storageDomain.get` is documented as a diagnostic lookup that
 * returns an OPEN domain alone, and the cache opens lazily — with it closed the
 * table path silently does nothing while this file is still on the medium.
 */
function cacheRecordPath(variant) {
  return path.join(dshHome(), 'storages', PROJECTION_DOMAIN, PROJECTION_TABLE, `${variant}.json`)
}

/** Whether one cache row exists, through the open domain's table or on the medium. */
function cacheRowExists(cache, variant) {
  if (cache !== undefined) {
    try {
      return cache.get(variant) !== undefined
    } catch {
      // Handle closed mid-call: fall through to the file.
    }
  }
  return fs.existsSync(cacheRecordPath(variant))
}

/** Attached Sessions plus the on-disk, persistence and cache evidence for one id. */
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

/** The running-Session refusal: a caller stops the Session first, as archiving does. */
function runningRefusal(ctx, variants, sessionId) {
  for (const variant of variants) {
    const agent = ctx.agents.get(variant)
    if (agent !== undefined && agent.status === 'running') {
      return fail(409, 'running', `session "${variant}" is running; stop it before deleting`, { sessionId })
    }
  }
  return undefined
}

/** Clear a latched inbox wake, then make the log durable before anything disappears. */
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

/** Detach every live spelling, or refuse; see step 4 in the module doc. */
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

/**
 * Re-delete passes, against a transient external lock rather than our own writer.
 * One scan per pass, reused for the return value; every directory that ever
 * failed is reported once.
 */
async function removeAll(sessionId, warnings) {
  const removed = []
  const failed = new Map()
  let remaining = []
  for (let passIndex = 0; ; passIndex += 1) {
    const outcome = removeSessionDirs(sessionId)
    removed.push(...outcome.removed)
    for (const entry of outcome.failed) failed.set(entry.dir, entry.reason)
    remaining = findSessionDirs(sessionId)
    if (remaining.length === 0 || passIndex >= DELETE_PASSES - 1) break
    await delay(DELETE_RETRY_MS)
  }
  for (const [dir, reason] of failed) note(warnings, `rm("${dir}") failed`, new Error(reason))
  return { removed, remaining }
}

/**
 * Drop one projection-cache row: through the open domain's table when there is
 * one, else straight off the medium (a closed domain holds nothing in memory, so
 * the record file is the only copy left).
 * @returns whether a row was actually removed.
 */
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

/**
 * Drop the projection-cache rows and the archive marks. The workspace
 * `sessionIds` slot is handled separately, and only once the session is really
 * gone — see {@link detachWorkspaceSlots}.
 */
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

  // A pin outlives archive (archiving drops it, deleting would not), so a
  // pinned-then-deleted session would otherwise keep its id in the registry's
  // durable `pinnedSessionIds` forever.
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

/**
 * Drop the deleted session's slot from every workspace record.
 *
 * The registry keeps a slot forever otherwise: its activation reconcile rebuilds
 * `sessionIds` as "header-backed ids first, then every id already in the record"
 * — it preserves ids that no longer have a header, by design ("an archived
 * session keeps its `sessionIds` slot so unarchiving restores its position"), and
 * it has no notion of a deleted session.
 *
 * `detachSession` is public API on the `Workspace` interface and runs through the
 * entity's own `table.update`, so this joins the domain write chain instead of
 * racing it. It is a no-op for an id the record does not account.
 */
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

/**
 * Delete one Session end to end.
 * @param ctx - Host context carrying sessions, agents, and the optional stores.
 * @param rawSessionId - the requested Session id, in either spelling.
 * @param options - `dryRun` reports what would happen without touching anything.
 * @returns the HTTP status and the JSON body to answer with.
 */
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

  const { removed, remaining } = await removeAll(sessionId, warnings)
  const registry = service(ctx, 'workspaceRegistry')
  const { cacheRowsCleared, archiveCleared, pinCleared } = await clearAccounting(registry, variants, cache, warnings)

  if (remaining.length > 0) {
    const remainingRel = relativeDirs(remaining, root)
    // Absolute paths stay in the Host log; the browser only sees slug/id pairs.
    for (const dir of remaining) ctx.logger?.warn?.(`dsh-session-delete: could not remove ${dir}`)
    return fail(500, 'delete-failed', `session files could not be fully removed: ${remainingRel.join(', ')}`, {
      sessionId,
      remainingDirs: remainingRel,
      warnings,
    })
  }

  // The session is gone, so its workspace slot goes too. Deliberately after the
  // failure guard: a partial delete leaves the session listed and accounted.
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
