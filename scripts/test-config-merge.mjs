import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeConfigChanges } from '../src/lib/config-merge.ts'

test('stale editor keeps remote avatar while saving a new name', () => {
  const baseline = { user: { avatar: '/profile.png', name: 'Old' }, music: { playlists: [1] } }
  const edited = { user: { avatar: '/profile.png', name: 'New' }, music: { playlists: [1] } }
  const latest = { user: { avatar: '/profile-123.jpg', name: 'Old' }, music: { playlists: [1, 2] } }
  assert.deepEqual(mergeConfigChanges(baseline, edited, latest), {
    user: { avatar: '/profile-123.jpg', name: 'New' }, music: { playlists: [1, 2] },
  })
  assert.equal(edited.user.avatar, '/profile.png')
})

test('a newly selected local avatar wins over the old remote image', () => {
  const baseline = { user: { avatar: '/profile.png' } }
  const edited = { user: { avatar: 'blob:preview' } }
  const latest = { user: { avatar: '/profile-old.jpg' } }
  assert.equal(mergeConfigChanges(baseline, edited, latest).user.avatar, 'blob:preview')
})

test('local deletions do not resurrect remote values', () => {
  const baseline = { user: { avatar: '/profile.png', description: 'old' } }
  const edited = { user: { avatar: '/profile.png' } }
  const latest = { user: { avatar: '/profile-new.jpg', description: 'changed elsewhere' } }
  assert.deepEqual(mergeConfigChanges(baseline, edited, latest), { user: { avatar: '/profile-new.jpg' } })
})
