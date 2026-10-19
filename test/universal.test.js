import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deleteSessionCore, hostCapabilities } from '../src/core.js'

const UUID = '9a2e4c7b-1f3d-4b5a-8c6d-0e1f2a3b4c5d'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-universal-'))
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

function makeContext({ root, live = {} }) {
  const values = {
    sessionPersistence: {
      root,
      stat: async () => undefined,
      list: async () => [],
    },
  }
  const store = new Map()
  for (const id of Object.keys(live)) store.set(id, id)
  const ctx = {
    sessions: {
      get: id => live[id],
      list: () => Object.values(live),
      store,
      detachEntered: entry => { store.delete(entry) },
      flush: async () => {},
    },
    agents: { get: () => undefined },
    get: key => values[key],
  }
  values.sessions = ctx.sessions
  values.agents = ctx.agents
  return ctx
}

function seedDir(root, ...segments) {
  const dir = path.join(root, ...segments)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), '{}')
  return dir
}

test('hostCapabilities reports native / detach / filesystem-only modes', () => {
  const env = sandbox()
  try {
    assert.equal(hostCapabilities(makeContext({ root: env.root })).mode, 'detach')
    const native = makeContext({ root: env.root })
    native.sessions.delete = async () => true
    assert.equal(hostCapabilities(native).mode, 'native')
    assert.equal(hostCapabilities(native).native, 'sessions.delete')
    assert.equal(hostCapabilities({ get: () => undefined }).mode, 'filesystem-only')
  } finally {
    env.restore()
  }
})

test('a native host delete API is used instead of the filesystem path', async () => {
  const env = sandbox()
  try {
    const calls = []
    const ctx = makeContext({ root: env.root })
    ctx.sessions.delete = async id => { calls.push(id); return { deleted: true } }
    const dry = await deleteSessionCore(ctx, UUID, { dryRun: true })
    assert.equal(dry.status, 200)
    assert.equal(dry.body.mode, 'native')
    assert.deepEqual(calls, [])
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 200)
    assert.equal(result.body.mode, 'native')
    assert.deepEqual(calls, [UUID])
  } finally {
    env.restore()
  }
})

test('a host without a detach API still deletes a cold session', async () => {
  const env = sandbox()
  try {
    const dir = seedDir(env.root, 'project-a', UUID)
    const ctx = makeContext({ root: env.root })
    delete ctx.sessions.detachEntered
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.mode, 'filesystem-only')
    assert.equal(fs.existsSync(dir), false)
  } finally {
    env.restore()
  }
})

test('refuses to delete two different spellings as one session', async () => {
  const env = sandbox()
  try {
    seedDir(env.root, 'project-a', 'abc')
    seedDir(env.root, 'project-a', 'session-abc')
    const result = await deleteSessionCore(makeContext({ root: env.root }), 'abc')
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'ambiguous-id')
    assert.deepEqual([...result.body.candidates].sort(), ['abc', 'session-abc'])
    assert.equal(fs.existsSync(path.join(env.root, 'project-a', 'abc')), true)
    assert.equal(fs.existsSync(path.join(env.root, 'project-a', 'session-abc')), true)
  } finally {
    env.restore()
  }
})

test('a session directory symlinked outside the root is never deleted', async () => {
  const env = sandbox()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-outside-'))
  try {
    seedDir(outside, 'keep-me')
    fs.mkdirSync(path.join(env.root, 'project-a'), { recursive: true })
    try {
      fs.symlinkSync(path.join(outside, 'keep-me'), path.join(env.root, 'project-a', 'linked'), 'dir')
    } catch {
      return // Windows without developer mode cannot create symlinks; skip.
    }
    const result = await deleteSessionCore(makeContext({ root: env.root }), 'linked')
    assert.notEqual(result.status, 200)
    assert.equal(fs.existsSync(path.join(outside, 'keep-me')), true)
  } finally {
    env.restore()
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
