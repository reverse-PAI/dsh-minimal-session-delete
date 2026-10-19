import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deleteSessionCore,
  isValidSessionId,
  registryIds,
  relativeDirs,
  sessionIdVariants,
} from '../src/core.js'

const UUID = '6f1c2f0e-3b7a-4a6e-9a1d-2c5b8f7d9e01'

test('isValidSessionId accepts host and third-party id shapes and rejects traversal', () => {
  for (const id of [
    `session-${UUID}`,
    UUID,
    'session-123',
    'social-5b510bc0035ecbde3964f3d0fe794b39',
    'sticker-abc_1.2',
  ]) {
    assert.equal(isValidSessionId(id), true, id)
  }
  for (const id of [
    '',
    '.hidden',
    '..',
    '../etc',
    'a/b',
    'a\\b',
    `session-${UUID}/../x`,
    `session-${UUID}.`,
    'x'.repeat(201),
  ]) {
    assert.equal(isValidSessionId(id), false, id)
  }
})

test('sessionIdVariants toggles the session- prefix without duplicates', () => {
  assert.deepEqual(sessionIdVariants(`session-${UUID}`).sort(), [`session-${UUID}`, UUID].sort())
  assert.deepEqual(sessionIdVariants(UUID).sort(), [`session-${UUID}`, UUID].sort())
})

test('relativeDirs reports project-relative paths', () => {
  const root = path.join(os.tmpdir(), 'dsh-msd-test-root')
  const dir = path.join(root, 'project-a', `session-${UUID}`)
  assert.deepEqual(relativeDirs([dir], root), [path.join('project-a', `session-${UUID}`)])
})

test('registryIds degrades an unstarted registry to a warning', () => {
  const warnings = []
  const unstarted = {
    get archivedSessionIds() {
      throw new Error('workspace registry is not started yet')
    },
  }
  assert.equal(registryIds(unstarted, 'archivedSessionIds', warnings), undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /workspace registry is not started yet/)

  assert.deepEqual(registryIds({ archivedSessionIds: ['a'] }, 'archivedSessionIds', warnings), ['a'])
  assert.equal(registryIds({ archivedSessionIds: 'nope' }, 'archivedSessionIds', warnings), undefined)
  assert.equal(registryIds(undefined, 'archivedSessionIds', warnings), undefined)
  assert.equal(warnings.length, 1)
})

test('deleteSessionCore refuses an invalid id before touching services', async () => {
  const result = await deleteSessionCore({}, `../${UUID}`)
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid-id')
})

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msd-root-'))
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

function fakeContext(root, persistedIds) {
  const values = {
    sessionPersistence: {
      root,
      stat: async id => (persistedIds.includes(id) ? {} : undefined),
    },
  }
  return {
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    get: key => values[key],
  }
}

test('deleteSessionCore removes the log directory and reports the root', async () => {
  const env = sandbox()
  try {
    const dir = path.join(env.root, 'project-a', `session-${UUID}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'log.jsonl'), '{}')
    const ctx = fakeContext(env.root, [])
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.root, env.root)
    assert.deepEqual(result.body.removedDirs, [path.join('project-a', `session-${UUID}`)])
    assert.equal(fs.existsSync(dir), false)
    const again = await deleteSessionCore(ctx, UUID)
    assert.equal(again.status, 404)
  } finally {
    env.restore()
  }
})

test('deleteSessionCore refuses to report success when the configured root has no log', async () => {
  const env = sandbox()
  try {
    const ctx = fakeContext(env.root, [`session-${UUID}`])
    const result = await deleteSessionCore(ctx, UUID)
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'logs-not-found')
    assert.equal(result.body.root, env.root)
  } finally {
    env.restore()
  }
})
