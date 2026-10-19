import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const PROJECTION_DOMAIN = 'session_projcache'
const PROJECTION_TABLE = 'sessions'
const DELETE_PASSES = 11
const DELETE_RETRY_MS = 200
const QUIESCE_TIMEOUT_MS = 15_000
const QUIESCE_POLL_MS = 50
// The only file the host parses when it lists a session. Renaming it away makes
// the session vanish from persistence listings without touching the directory
// name (the host rejects a log whose header id no longer matches its path).
const GENERATION_FILE = /^session\.v\d+\.jsonl(?:\.zstd)?$/
const STAGE_MARK = '.deleting-'
const STAGE_SWEEP_MIN_AGE_MS = 10 * 60 * 1000
// Host ids are `session-<uuid>` (or a bare uuid); third-party bridges invent their own
// prefixes (e.g. dsh-social-bridge-plugin uses `social-<hex32>`). Accept any single path
// segment made of safe characters instead of whitelisting host formats.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const messageOf = error => (error instanceof Error ? error.message : String(error))
const delay = ms => new Promise((resolve) => { setTimeout(resolve, ms) })
const fail = (status, code, message, extra) => ({ status, body: { ok: false, code, message, ...extra } })
const pass = body => ({ status: 200, body: { ok: true, ...body } })
const note = (warnings, label, error) => { warnings.push(`${label}: ${messageOf(error)}`) }
const isMissing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
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
export function sessionsRoot(ctx) {
  const persistence = ctx === undefined ? undefined : service(ctx, 'sessionPersistence')
  const configured = persistence === undefined ? undefined : persistence.root
  if (typeof configured === 'string' && configured.length > 0) return configured
  return path.join(dshHome(), 'sessions')
}
export function isValidSessionId(sessionId) {
  // Windows silently drops a trailing dot, so `foo.` and `foo` would hit the same directory.
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) && !sessionId.endsWith('.')
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
export function relativeDirs(dirs, root) {
  return dirs.map(dir => path.relative(root, dir) || path.basename(dir))
}
export function registryIds(registry, key, warnings) {
  if (registry === undefined) return undefined
  try {
    const value = registry[key]
    return Array.isArray(value) ? value : undefined
  } catch (error) {
    note(warnings, `workspace.${key}`, error)
    return undefined
  }
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
function nativeDelete(ctx) {
  const sessions = service(ctx, 'sessions')
  if (typeof sessions?.delete === 'function') return sessions.delete.bind(sessions)
  const persistence = service(ctx, 'sessionPersistence')
  if (typeof persistence?.delete === 'function') return persistence.delete.bind(persistence)
  return undefined
}
function realRootOf(root) {
  try {
    return fs.realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}
/**
 * Keep only directories that really live under the configured session root.
 * `realpath` resolves symlinks, so a link pointing outside the root is dropped
 * before any rename or rm can follow it.
 */
function containedDirs(dirs, root, warnings) {
  const realRoot = realRootOf(root)
  const kept = []
  for (const dir of dirs) {
    let real
    try {
      real = fs.realpathSync(dir)
    } catch (error) {
      note(warnings, `realpath("${dir}")`, error)
      continue
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) kept.push(dir)
    else warnings.push(`ignored session directory outside ${root}: "${dir}" -> "${real}"`)
  }
  return kept
}
/**
 * Describe which host contracts this build actually exposes. Deleting a cold
 * session needs only the filesystem; deleting a live one additionally needs the
 * session store's detach path; cascading and accounting are best-effort extras.
 * The plugin reports this through `GET <route>` so callers can degrade explicitly
 * instead of discovering missing internals halfway through a delete.
 */
export function hostCapabilities(ctx) {
  const sessions = service(ctx, 'sessions')
  const persistence = service(ctx, 'sessionPersistence')
  const agents = service(ctx, 'agents')
  const storageDomain = service(ctx, 'storageDomain')
  const registry = service(ctx, 'workspaceRegistry')
  const native = nativeDelete(ctx)
  const capabilities = {
    mode: native !== undefined ? 'native' : undefined,
    native: typeof sessions?.delete === 'function'
      ? 'sessions.delete'
      : typeof persistence?.delete === 'function' ? 'sessionPersistence.delete' : null,
    detachLive: typeof sessions?.detachEntered === 'function' && typeof sessions?.store?.get === 'function',
    flush: typeof sessions?.flush === 'function',
    persistenceRoot: typeof persistence?.root === 'string',
    persistenceStat: typeof persistence?.stat === 'function',
    persistenceList: typeof persistence?.list === 'function',
    agentsDetach: typeof agents?.detachEntered === 'function' && typeof agents?.store?.get === 'function',
    projectionCache: typeof storageDomain?.get === 'function',
    workspaceRegistry: typeof registry?.list === 'function',
  }
  if (capabilities.mode === undefined) capabilities.mode = capabilities.detachLive ? 'detach' : 'filesystem-only'
  return capabilities
}
function ambiguousNames(dirs) {
  return [...new Set(dirs.map(dir => path.basename(dir)))]
}
async function locate(ctx, variants, root, warnings) {
  const live = variants
    .map(variant => ({ variant, session: ctx.sessions.get(variant) }))
    .filter(entry => entry.session !== undefined)
  const persistence = service(ctx, 'sessionPersistence')
  let persisted = false
  let persistedVariant
  if (persistence !== undefined && typeof persistence.stat === 'function') {
    for (const variant of variants) {
      try {
        if ((await persistence.stat(variant)) !== undefined) {
          persisted = true
          persistedVariant = variant
          break
        }
      } catch (error) {
        note(warnings, `stat("${variant}")`, error)
      }
    }
  }
  const cache = cacheTable(ctx)
  const cached = variants.filter(variant => cacheRowExists(cache, variant))
  const dirs = []
  for (const variant of new Set(variants)) dirs.push(...findSessionDirs(variant, root))
  const uniqueDirs = containedDirs([...new Set(dirs)], root, warnings)
  // Report the id the host/UI actually uses, not just the spelling the caller typed
  // (the API accepts both `session-<uuid>` and the bare uuid).
  let canonical = variants[0]
  if (live.length > 0) canonical = live[0].variant
  else if (uniqueDirs.length > 0) canonical = path.basename(uniqueDirs[0])
  else if (persistedVariant !== undefined) canonical = persistedVariant
  else if (cached.length > 0) canonical = cached[0]
  const names = ambiguousNames(uniqueDirs)
  return { live, persisted, cachedRows: cached.length, cache, dirs: uniqueDirs, canonical, names }
}
function agentPhase(agent) {
  const kind = agent?.phase?.kind
  if (typeof kind === 'string') return kind
  return agent?.status === 'running' ? 'running' : 'idle'
}
export async function waitForAgentIdle(agent, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : QUIESCE_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : QUIESCE_POLL_MS
  const deadline = Date.now() + timeoutMs
  while (agentPhase(agent) !== 'idle') {
    if (Date.now() >= deadline) return false
    await delay(pollMs)
  }
  return true
}
function runningRefusal(ctx, described) {
  for (const entry of described) {
    for (const variant of entry.variants) {
      const agent = ctx.agents.get(variant)
      if (agent !== undefined && agent.status === 'running') {
        return fail(409, 'running', `session "${variant}" is running; stop it before deleting`, { sessionId: entry.sessionId })
      }
    }
  }
  return undefined
}
async function quiesce(ctx, described, warnings, options = {}) {
  for (const entry of described) {
    for (const { variant, session } of entry.live) {
      const agent = ctx.agents.get(variant)
      if (agent !== undefined && agentPhase(agent) !== 'idle') {
        try {
          if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
        } catch (error) {
          note(warnings, `cancel("${variant}")`, error)
        }
        const stopped = await waitForAgentIdle(agent, {
          timeoutMs: options.quiesceTimeoutMs,
          pollMs: options.quiescePollMs,
        })
        if (!stopped) {
          return {
            refusal: fail(
              409,
              'still-running',
              `session "${variant}" is still stopping; wait for the turn to finish and retry`,
              { sessionId: entry.sessionId },
            ),
          }
        }
      }
      try {
        await ctx.sessions.flush(session)
      } catch (error) {
        note(warnings, `flush("${variant}")`, error)
      }
    }
  }
  return {}
}
function detachEntries(ctx, variants, warnings) {
  const store = ctx.sessions.store
  const canDetach = typeof ctx.sessions.detachEntered === 'function'
    && store !== undefined && typeof store.get === 'function'
  if (!canDetach) return { canDetach, detached: new Set(), failed: [] }
  const detached = new Set()
  const failed = []
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
      detached.add(variant)
    } catch (error) {
      failed.push({ variant, reason: messageOf(error) })
      note(warnings, `detach("${variant}")`, error)
    }
  }
  return { canDetach, detached, failed }
}
/**
 * Drop the agent registry entries of the sessions being deleted. The host disposes
 * sessions but never agents on `session/disposed`, so without this step every
 * deleted live session leaves an agent behind in `ctx.agents` (memory plus a
 * stale `agent/status` source). `detachEntered` is idempotent: a later loop
 * teardown sees the entry gone and does nothing.
 */
function detachAgents(ctx, variants, warnings) {
  const agents = ctx.agents
  if (agents === undefined || typeof agents.detachEntered !== 'function') return 0
  const store = agents.store
  if (store === undefined || typeof store.get !== 'function') return 0
  let detached = 0
  for (const variant of variants) {
    let entry
    try {
      entry = store.get(variant)
    } catch {
      entry = undefined
    }
    if (entry === undefined) continue
    try {
      agents.detachEntered(entry)
      detached += 1
    } catch (error) {
      note(warnings, `agent detach("${variant}")`, error)
    }
  }
  return detached
}
export function stageSessionDirs(dirs) {
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
  const staged = []
  const failed = []
  for (const dir of dirs) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) continue
      failed.push({ dir, reason: messageOf(error) })
      continue
    }
    // Hide the generation log instead of renaming the directory: the host lists
    // every directory under a project and rejects a log whose header does not
    // match its path, so a renamed directory would break persistence listing.
    // A directory without a parseable generation log is simply skipped.
    const moves = []
    let failure
    for (const entry of entries) {
      if (!entry.isFile() || !GENERATION_FILE.test(entry.name)) continue
      const from = path.join(dir, entry.name)
      const to = path.join(dir, `${STAGE_MARK}${stamp}--${entry.name}`)
      try {
        fs.renameSync(from, to)
        moves.push({ from, to })
      } catch (error) {
        failure = error
        break
      }
    }
    if (failure !== undefined) {
      for (const move of [...moves].reverse()) {
        try {
          fs.renameSync(move.to, move.from)
        } catch {
          // reported by the caller through `failed`
        }
      }
      failed.push({ dir, reason: messageOf(failure) })
      continue
    }
    staged.push({ dir, moves })
  }
  return { staged, failed }
}
export function rollbackStagedDirs(staged, warnings) {
  const failed = []
  for (const { dir, moves } of [...staged].reverse()) {
    for (const { from, to } of [...moves].reverse()) {
      try {
        fs.renameSync(to, from)
      } catch (error) {
        failed.push({ from, to, reason: messageOf(error) })
        note(warnings, `rollback("${to}" -> "${from}")`, error)
      }
    }
  }
  return failed
}
async function removeStaged(staged, warnings) {
  const targets = staged.map(entry => entry.dir)
  const noted = new Set()
  for (let pass = 0; pass < DELETE_PASSES; pass += 1) {
    if (pass > 0) await delay(DELETE_RETRY_MS)
    const outcome = removeSessionDirs(targets.filter(dir => fs.existsSync(dir)))
    for (const { dir, reason } of outcome.failed) {
      if (noted.has(dir)) continue
      noted.add(dir)
      note(warnings, `rm("${dir}") failed`, new Error(reason))
    }
    if (targets.every(dir => !fs.existsSync(dir))) break
  }
  return targets.filter(dir => fs.existsSync(dir))
}
function sweepStaleStaged(root, warnings) {
  let slugs
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - STAGE_SWEEP_MIN_AGE_MS
  const stagedName = new RegExp(`^${STAGE_MARK.replaceAll('.', '\\.')}(\\d+)-(\\d+)-[0-9a-f]+--`)
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugPath = path.join(root, slug.name)
    let dirs
    try {
      dirs = fs.readdirSync(slugPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const full = path.join(slugPath, dir.name)
      let files
      try {
        files = fs.readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      let stale = false
      let live = false
      for (const file of files) {
        if (!file.isFile()) continue
        if (GENERATION_FILE.test(file.name)) {
          live = true
          break
        }
        const match = stagedName.exec(file.name)
        if (match !== null && Number(match[1]) <= cutoff) stale = true
      }
      if (live || !stale) continue
      try {
        fs.rmSync(full, { recursive: true, force: true })
        warnings.push(`swept stale staged session "${full}"`)
      } catch (error) {
        note(warnings, `sweep("${full}")`, error)
      }
    }
  }
}
/**
 * Collect subagent-origin descendants of `sessionId` from both the live session
 * store and the persistence listing (so cold subagent logs are covered too).
 * Fork lineage shares `header.parentSession` but not `origin === 'subagent'`;
 * forks are independent user sessions and are intentionally left alone.
 */
export async function discoverSubagentDescendants(ctx, sessionId, warnings) {
  const parentOf = new Map()
  const subagentOf = new Set()
  const add = header => {
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') return
    if (typeof header.parentSession === 'string' && header.parentSession.length > 0) parentOf.set(header.id, header.parentSession)
    if (header.origin === 'subagent') subagentOf.add(header.id)
  }
  try {
    const live = typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
    for (const session of live) add(session?.header)
  } catch (error) {
    note(warnings, 'live session list', error)
  }
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      for (const snapshot of await persistence.list()) add(snapshot?.header)
    } catch (error) {
      note(warnings, 'stored session list', error)
    }
  }
  const children = new Map()
  for (const [id, parent] of parentOf) {
    if (id === parent || !subagentOf.has(id)) continue
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [id])
    else siblings.push(id)
  }
  const found = []
  const emitted = new Set()
  const seeds = sessionIdVariants(sessionId)
  const seen = new Set(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of children.get(parent) ?? []) {
      if (!emitted.has(child)) {
        emitted.add(child)
        found.push(child)
      }
      for (const variant of sessionIdVariants(child)) {
        if (seen.has(variant)) continue
        seen.add(variant)
        queue.push(variant)
      }
    }
  }
  return found
}
async function dropCacheRow(cache, variant, warnings) {
  if (cache !== undefined) {
    try {
      return await cache.delete(variant)
    } catch (error) {
      // The domain row is still in memory. Deleting the on-disk copy here would
      // let the in-memory snapshot resurrect the row on the next write/close, so
      // leave the storage alone and surface the failure instead.
      note(warnings, `projection cache delete("${variant}")`, error)
      return false
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
  const archived = registryIds(registry, 'archivedSessionIds', warnings)
  if (archived !== undefined) {
    for (const variant of variants) {
      if (!archived.includes(variant)) continue
      try {
        await registry.unarchiveSession(variant)
        archiveCleared = true
      } catch (error) {
        note(warnings, `unarchive("${variant}")`, error)
      }
    }
  }
  let pinCleared = false
  const pinned = registryIds(registry, 'pinnedSessionIds', warnings)
  if (pinned !== undefined) {
    for (const variant of variants) {
      if (!pinned.includes(variant)) continue
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
  let workspaces
  try {
    workspaces = registry.list()
  } catch (error) {
    note(warnings, 'workspace list', error)
    return
  }
  for (const workspace of workspaces) {
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
  if (!isValidSessionId(sessionId)) {
    return fail(400, 'invalid-id', `invalid session id: ${JSON.stringify(rawSessionId)}`)
  }
  const warnings = []
  const capabilities = hostCapabilities(ctx)
  // A host that grows a first-class delete API owns the whole lifecycle
  // (detach, accounting, removal event). Delegate and never touch the files
  // ourselves, so the plugin cannot drift from the host's semantics.
  const nativeApi = nativeDelete(ctx)
  if (nativeApi !== undefined && options.dryRun === true) {
    // The native API has no inspect-only mode; do not fall through to the
    // filesystem locate, which may not know where this host keeps its sessions.
    return pass({
      dryRun: true,
      mode: 'native',
      native: capabilities.native,
      sessionId,
      note: 'native host delete API; dryRun does not call it',
    })
  }
  const native = options.dryRun === true ? undefined : nativeApi
  if (native !== undefined) {
    try {
      const variants = sessionIdVariants(sessionId)
      let result = false
      for (const variant of variants) {
        result = await native(variant)
        if (result !== false) break
      }
      if (result === false) return fail(404, 'not-found', `no session found for "${sessionId}"`)
      return pass({
        native: capabilities.native,
        mode: 'native',
        sessionId,
        removedSessions: variants,
        broadcast: [],
        warnings,
        result: result ?? null,
      })
    } catch (error) {
      return fail(500, 'delete-failed', `the host delete API failed: ${messageOf(error)}`, { sessionId })
    }
  }
  const root = sessionsRoot(ctx)
  const primaryVariants = sessionIdVariants(sessionId)
  const primary = await locate(ctx, primaryVariants, root, warnings)
  if (primary.dirs.length === 0 && primary.live.length === 0 && !primary.persisted && primary.cachedRows === 0) {
    return fail(404, 'not-found', `no session found for "${sessionId}"`)
  }
  if (primary.names.length > 1) {
    // `abc` and `session-abc` are two different real directories: deleting both
    // would destroy a session the caller never named. Refuse and let the caller
    // retry with the exact id.
    return fail(409, 'ambiguous-id', `both "${primary.names.join('" and "')}" exist; delete one exact id at a time`, {
      sessionId,
      candidates: primary.names,
    })
  }
  const descendants = await discoverSubagentDescendants(ctx, sessionId, warnings)
  const described = [{ sessionId, variants: primaryVariants, ...primary }]
  for (const childId of descendants) {
    const variants = sessionIdVariants(childId)
    const located = await locate(ctx, variants, root, warnings)
    if (located.dirs.length === 0 && located.live.length === 0 && !located.persisted && located.cachedRows === 0) continue
    if (located.names.length > 1) {
      return fail(409, 'ambiguous-id', `subagent session id is ambiguous: "${located.names.join('" and "')}"`, {
        sessionId: childId,
        candidates: located.names,
      })
    }
    described.push({ sessionId: childId, variants, ...located })
  }
  if (options.dryRun === true) {
    return pass({
      dryRun: true,
      mode: capabilities.mode,
      sessionId,
      root,
      dirs: relativeDirs(primary.dirs, root),
      attached: primary.live.length > 0,
      persisted: primary.persisted,
      cachedRows: primary.cachedRows,
      sessions: described.map(entry => ({
        sessionId: entry.sessionId,
        dirs: relativeDirs(entry.dirs, root),
        attached: entry.live.length > 0,
        persisted: entry.persisted,
        cachedRows: entry.cachedRows,
      })),
    })
  }
  if (primary.persisted && primary.dirs.length === 0) {
    return fail(
      409,
      'logs-not-found',
      `persistence reports "${sessionId}" but no log directory exists under ${root}; check the configured session root`,
      { sessionId, root },
    )
  }
  const viable = [described[0]]
  for (const entry of described.slice(1)) {
    if (entry.persisted && entry.dirs.length === 0) {
      warnings.push(`skipped subagent session "${entry.sessionId}": persistence reports it but no log directory exists`)
      continue
    }
    viable.push(entry)
  }
  const refusal = runningRefusal(ctx, viable)
  if (refusal !== undefined) return refusal
  const quiet = await quiesce(ctx, viable, warnings, options)
  if (quiet.refusal !== undefined) return quiet.refusal
  const allVariants = viable.flatMap(entry => entry.variants)
  const hasLive = viable.some(entry => entry.live.length > 0)
  const probe = detachEntries(ctx, [], warnings)
  if (hasLive && !probe.canDetach) {
    return fail(
      409,
      'cannot-detach',
      'this Harness build does not expose the session-store detach path needed to delete an attached session',
      { sessionId, root },
    )
  }
  sweepStaleStaged(root, warnings)
  // Rename first: the visible session path disappears before any live session is
  // detached, and a failed rename leaves the app and the files fully intact.
  const allDirs = [...new Set(viable.flatMap(entry => entry.dirs))]
  const { staged, failed } = stageSessionDirs(allDirs)
  if (failed.length > 0) {
    rollbackStagedDirs(staged, warnings)
    return fail(
      500,
      'delete-failed',
      `session files could not be staged for removal: ${failed.map(entry => entry.reason).join('; ')}`,
      { sessionId, root, warnings },
    )
  }
  const detach = detachEntries(ctx, allVariants, warnings)
  if (detach.failed.length > 0) {
    rollbackStagedDirs(staged, warnings)
    return fail(
      500,
      'detach-failed',
      `session "${detach.failed[0].variant}" could not be detached; the files were restored${detach.detached.size > 0 ? ' (a partially detached session may need a reload)' : ''}`,
      {
        sessionId,
        root,
        detached: [...detach.detached],
        warnings,
      },
    )
  }
  const removedDirs = staged.map(entry => entry.dir)
  const agentsDetached = detachAgents(ctx, allVariants, warnings)
  const remaining = await removeStaged(staged, warnings)
  const registry = service(ctx, 'workspaceRegistry')
  const { cacheRowsCleared, archiveCleared, pinCleared } = await clearAccounting(registry, allVariants, primary.cache, warnings)
  await detachWorkspaceSlots(registry, allVariants, warnings)
  const detachedIds = [...detach.detached]
  const removedSessions = viable.map(entry => entry.canonical ?? entry.sessionId)
  const broadcast = removedSessions.filter(id => !sessionIdVariants(id).some(variant => detach.detached.has(variant)))
  return pass({
    mode: capabilities.mode,
    sessionId,
    root,
    removedDirs: relativeDirs(removedDirs, root),
    remainingDirs: relativeDirs(remaining, root),
    removedSessions,
    broadcast,
    detached: detach.detached.size > 0,
    detachedSessions: detachedIds,
    agentsDetached,
    cacheRowsCleared,
    archiveCleared,
    pinCleared,
    warnings,
  })
}
