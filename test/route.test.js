import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, DELETE_ROUTE } from '../src/index.js'

function harness() {
  let route
  const emitted = []
  const ctx = {
    connection: { fetch: { register: (spec) => { route = spec; return () => {} } } },
    effect: () => {},
    logger: { warn() {}, error() {} },
    sessions: { get: () => undefined, flush: async () => {} },
    agents: { get: () => undefined },
    get: () => undefined,
    emit: (event, ...args) => { emitted.push([event, ...args]) },
  }
  apply(ctx)
  return { route, emitted }
}

test('registers the delete route as an authenticated buffered POST', () => {
  const { route } = harness()
  assert.equal(route.path, DELETE_ROUTE)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
})

test('the route rejects non-POST, non-object JSON and invalid ids', async () => {
  const { route } = harness()
  const get = await route.fetch(new Request(`http://x${DELETE_ROUTE}`, { method: 'GET' }))
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
