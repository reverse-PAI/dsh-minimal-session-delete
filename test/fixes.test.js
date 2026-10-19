import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deleteSessionCore,
  hostCapabilities,
  rollbackStagedDirs,
  stageSessionDirs,
  waitForAgentIdle,
} from '../src/core.js'

const UUID = '6f1c2f0e-3b7a-4a6e-9a1d-2c5b8f7d9e01'
const CHILD = 'social-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FORK = 'social-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-fix-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = root
  return {
    root,
    restore() {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function makeContext({ root, statIds = [], list = [], live = {}, agents = {}, storageDomain }) {
  const values = {
    sessionPersistence: {
      root,
      stat: async id => (statIds.includes(id) ? { id } : undefined),
      list: async () => list,
    },
  }
  if (storageDomain !== undefined) values.storageDomain = storageDomain
  const store = new Map()
  for (const id of Object.keys(live)) store.set(id, id)
  return {
    sessions: {
      get: id => live[id],
      list: () => Object.values(live),
      store,
      detachEntered: entry => { store.delete(entry) },
      flush: async () => {},
    },
    agents: { get: id => agents[id] },
    get: key => values[key],
  }
}

function seedDir(root, ...segments) {
  const dir = path.join(root, ...segments)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), '{}')
  return dir
}

test('waitForAgentIdle waits for phase.kind and gives up on a stuck agent', async () => {
  const agent = { phase: { kind: 'maintenance' }, status: 'idle' }
  setTimeout(() => { agent.phase = { kind: 'idle' } }, 25)
  assert.equal(await waitForAgentIdle(agent, { timeoutMs: 500, pollMs: 5 }), true)
  const stuck = { phase: { kind: 'running' }, status: 'running' }
  assert.equal(await waitForAgentIdle(stuck, { timeoutMs: 25, pollMs: 5 }), false)
})

test('deleting a parent cascades to subagent sessions but keeps user forks', async () => {
  const env = sandbox()
  try {
    const parentDir = seedDir(env.root, 'project-a', `session-${UUID}`)
    const childDir = seedDir(env.root, 'project-a', CHILD)
    const forkDir = seedDir(env.root, 'project-a', FORK)
    const ctx = makeContext({
      root: env.root,
      list: [
        { header: { id: `session-${UUID}`, origin: 'user' } },
        { header: { id: CHILD, parentSession: `session-${UUID}`, origin: 'subagent' } },
        { header: { id: FORK, parentSession: `session-${UUID}`, origin: 'fork' } },
      ],
    })
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual([...result.body.removedSessions].sort(), [CHILD, `session-${UUID}`].sort())
    assert.equal(fs.existsSync(parentDir), false)
    assert.equal(fs.existsSync(childDir), false)
    assert.equal(fs.existsSync(forkDir), true, 'a user fork is an independent session')
  } finally {
    env.restore()
  }
})

test('a running subagent refuses the whole cascade before touching any file', async () => {
  const env = sandbox()
  try {
    const parentDir = seedDir(env.root, 'project-a', `session-${UUID}`)
    const childDir = seedDir(env.root, 'project-a', CHILD)
    const ctx = makeContext({
      root: env.root,
      list: [
        { header: { id: CHILD, parentSession: `session-${UUID}`, origin: 'subagent' } },
      ],
      agents: { [CHILD]: { status: 'running', phase: { kind: 'running' } } },
    })
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'running')
    assert.equal(fs.existsSync(parentDir), true)
    assert.equal(fs.existsSync(childDir), true)
  } finally {
    env.restore()
  }
})

test('a turn that does not stop in time returns still-running without staging or detaching', async () => {
  const env = sandbox()
  try {
    const dir = seedDir(env.root, 'project-a', `session-${UUID}`)
    const liveId = `session-${UUID}`
    const stuck = { status: 'idle', phase: { kind: 'maintenance' }, cancel: () => {} }
    const ctx = makeContext({
      root: env.root,
      live: { [liveId]: { header: { id: liveId } } },
      agents: { [liveId]: stuck },
    })
    const result = await deleteSessionCore(ctx, UUID, { quiesceTimeoutMs: 25, quiescePollMs: 5 })
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'still-running')
    assert.equal(fs.existsSync(dir), true)
    assert.equal(ctx.sessions.store.size, 1, 'nothing was detached')
  } finally {
    env.restore()
  }
})

test('a failing projection-cache delete keeps the on-disk row instead of resurrecting it', async () => {
  const env = sandbox()
  try {
    const dir = seedDir(env.root, 'project-a', `session-${UUID}`)
    const cacheFile = path.join(env.root, 'storages', 'session_projcache', 'sessions', `${UUID}.json`)
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, '{"rows":[]}')
    const storageDomain = {
      get: () => ({
        table: () => ({
          get: () => undefined,
          delete: async () => { throw new Error('domain write chain failed') },
        }),
      }),
    }
    const ctx = makeContext({ root: env.root, storageDomain })
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(fs.existsSync(dir), false)
    assert.equal(fs.existsSync(cacheFile), true)
    assert.ok(result.body.warnings.some(warning => warning.includes('domain write chain failed')))
  } finally {
    env.restore()
  }
})

test('dryRun reports a logs-not-found session instead of failing the probe', async () => {
  const env = sandbox()
  try {
    const ctx = makeContext({ root: env.root, statIds: [`session-${UUID}`] })
    const probe = await deleteSessionCore(ctx, UUID, { dryRun: true })
    assert.equal(probe.status, 200)
    assert.equal(probe.body.dryRun, true)
    assert.equal(probe.body.persisted, true)
    const real = await deleteSessionCore(ctx, UUID)
    assert.equal(real.status, 409)
    assert.equal(real.body.code, 'logs-not-found')
  } finally {
    env.restore()
  }
})

test('detaches the agent registry entry of the deleted live session', async () => {
  const env = sandbox()
  try {
    const dir = seedDir(env.root, 'project-a', `session-${UUID}`)
    const liveId = `session-${UUID}`
    const detached = []
    const agentsStore = new Map([[liveId, 'entry-1']])
    const ctx = makeContext({ root: env.root, live: { [liveId]: { header: { id: liveId } } } })
    ctx.agents = {
      store: agentsStore,
      detachEntered: entry => {
        agentsStore.delete(liveId)
        detached.push(entry)
      },
      get: () => ({ status: 'idle', phase: { kind: 'idle' } }),
    }
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual(detached, ['entry-1'])
    assert.equal(agentsStore.size, 0)
    assert.equal(result.body.agentsDetached, 1)
    assert.equal(fs.existsSync(dir), false)
  } finally {
    env.restore()
  }
})

test('stageSessionDirs keeps a failed rename reversible', () => {
  const env = sandbox()
  try {
    const first = seedDir(env.root, 'project-a', `session-${UUID}`)
    const second = seedDir(env.root, 'project-b', CHILD)
    const original = fs.renameSync
    fs.renameSync = (from, to) => {
      if (from.startsWith(second)) {
        const error = new Error('EPERM: operation not permitted')
        error.code = 'EPERM'
        throw error
      }
      return original(from, to)
    }
    try {
      const { staged, failed } = stageSessionDirs([first, second])
      assert.equal(staged.length, 1)
      assert.equal(failed.length, 1)
      assert.equal(fs.existsSync(first), true)
      assert.equal(fs.existsSync(path.join(first, 'session.v4.jsonl.zstd')), false)
      assert.equal(fs.existsSync(second), true)
      assert.equal(fs.existsSync(path.join(second, 'session.v4.jsonl.zstd')), true)
      rollbackStagedDirs(staged, [])
      assert.equal(fs.existsSync(path.join(first, 'session.v4.jsonl.zstd')), true)
    } finally {
      fs.renameSync = original
    }
  } finally {
    env.restore()
  }
})
