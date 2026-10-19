import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, DELETE_ROUTE } from '../src/index.js'

const UUID = '6f1c2f0e-3b7a-4a6e-9a1d-2c5b8f7d9e01'
const CHILD = 'social-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function harness(overrides = {}) {
  let route
  const emitted = []
  const ctx = {
    connection: { fetch: { register: (spec) => { route = spec; return () => {} } } },
    effect: () => {},
    logger: { warn() {}, error() {} },
    sessions: { get: () => undefined, flush: async () => {} },
    agents: { get: () => undefined },
    get(key) {
      return key === 'sessions' ? this.sessions : key === 'agents' ? this.agents : undefined
    },
    emit: (event, ...args) => { emitted.push([event, ...args]) },
    ...overrides,
  }
  apply(ctx)
  return { route, emitted }
}

test('registers the delete route as an authenticated buffered GET/POST', () => {
  const { route } = harness()
  assert.equal(route.path, DELETE_ROUTE)
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
})

test('GET reports the host capabilities instead of attempting a delete', async () => {
  const { route, emitted } = harness()
  const response = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.capabilities.mode, 'filesystem-only')
  assert.equal(body.capabilities.detachLive, false)
  assert.deepEqual(emitted, [])
})

test('a host delete API is delegated to and never touches the filesystem', async () => {
  const calls = []
  const { route, emitted } = harness({
    sessions: {
      get: () => undefined,
      flush: async () => {},
      delete: async (id) => { calls.push(id); return { deleted: true } },
    },
  })
  const response = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'social-0123456789abcdef0123456789abcdef' }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.mode, 'native')
  assert.deepEqual(calls, ['social-0123456789abcdef0123456789abcdef'])
  // The host owns its own removal event; the plugin must not double-broadcast.
  assert.deepEqual(emitted, [])
})

test('the route rejects non-POST, non-object JSON and invalid ids', async () => {
  const { route } = harness()
  const get = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, { method: 'PUT' }))
  assert.equal(get.status, 405)
  assert.equal((await get.json()).code, 'method-not-allowed')

  const array = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, { method: 'POST', body: '[1]' }))
  assert.equal(array.status, 400)
  assert.equal((await array.json()).code, 'bad-json')

  const invalid = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: '../etc' }),
  }))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid-id')
})

test('a cold delete broadcasts api-session/removed so the sidebar row can drop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-route-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = root
  try {
    const { route, emitted } = harness()
    const dir = path.join(root, 'sessions', 'project-a', 'social-5b510bc0035ecbde3964f3d0fe794b39')
    fs.mkdirSync(dir, { recursive: true })

    const dry = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'social-5b510bc0035ecbde3964f3d0fe794b39', dryRun: true }),
    }))
    assert.equal(dry.status, 200)
    assert.deepEqual(emitted, [])

    const ok = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'social-5b510bc0035ecbde3964f3d0fe794b39' }),
    }))
    assert.equal(ok.status, 200)
    assert.deepEqual(emitted, [['api-session/removed', 'social-5b510bc0035ecbde3964f3d0fe794b39']])
    assert.equal(fs.existsSync(dir), false)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a cold parent delete cascades to subagent sessions and broadcasts each removal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-route-cascade-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = root
  try {
    const parentDir = path.join(root, 'sessions', 'project-a', `session-${UUID}`)
    const childDir = path.join(root, 'sessions', 'project-a', CHILD)
    fs.mkdirSync(parentDir, { recursive: true })
    fs.mkdirSync(childDir, { recursive: true })
    const persistence = {
      stat: async () => ({}),
      list: async () => [
        { header: { id: `session-${UUID}`, origin: 'user' } },
        { header: { id: CHILD, parentSession: `session-${UUID}`, origin: 'subagent' } },
      ],
    }
    const { route, emitted } = harness({
      get: key => (key === 'sessionPersistence' ? persistence : undefined),
    })

    const response = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: `session-${UUID}` }),
    }))
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const body = await response.json()
    assert.deepEqual([...body.removedSessions].sort(), [CHILD, `session-${UUID}`].sort())
    assert.equal(fs.existsSync(parentDir), false)
    assert.equal(fs.existsSync(childDir), false)
    assert.deepEqual(
      [...emitted].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [['api-session/removed', CHILD], ['api-session/removed', `session-${UUID}`]]
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    )
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a staging failure returns 500, keeps the files and never broadcasts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-route-fail-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = root
  const original = fs.renameSync
  try {
    const dir = path.join(root, 'sessions', 'project-a', `session-${UUID}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), '{}')
    const { route, emitted } = harness()
    fs.renameSync = () => {
      const error = new Error('EPERM: operation not permitted')
      error.code = 'EPERM'
      throw error
    }
    const response = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: UUID }),
    }))
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.code, 'delete-failed')
    assert.deepEqual(emitted, [])
    assert.equal(fs.existsSync(dir), true)
    assert.ok(Array.isArray(body.warnings))
  } finally {
    fs.renameSync = original
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
