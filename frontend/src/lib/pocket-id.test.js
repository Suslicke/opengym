import { describe, it, expect } from 'vitest'
import { pocketIdResultFromSearch, pocketIdOn } from './pocket-id.js'

describe('pocketIdResultFromSearch', () => {
  it('reads a known result', () => {
    expect(pocketIdResultFromSearch('?pocket_id=signed-in')).toBe('signed-in')
    expect(pocketIdResultFromSearch('a=1&pocket_id=unbound')).toBe('unbound')
  })
  it('is empty without one', () => {
    expect(pocketIdResultFromSearch('')).toBe('')
    expect(pocketIdResultFromSearch('?link=ABC')).toBe('')
  })
  it('turns anything unknown into a plain failure', () => {
    expect(pocketIdResultFromSearch('?pocket_id=<script>')).toBe('failed')
  })
})

describe('pocketIdOn', () => {
  it('needs the server to say so', () => {
    expect(pocketIdOn({ pocket_id: true })).toBe(true)
    expect(pocketIdOn({})).toBe(false)
    expect(pocketIdOn(null)).toBe(false)
    expect(pocketIdOn({ pocket_id: 'true' })).toBe(false)
  })
  it('is never offered in the mobile app', () => {
    expect(pocketIdOn({ pocket_id: true }, true)).toBe(false)
  })
})
