// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* "Sign in with Pocket ID" on the sign-in screen: only where /api/config says `pocket_id`, below
   the passkey, and it is a plain navigation to the API's login route. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [] }
  state.snapshot = () => ({
    config: state.config, S: {},
    setUser: vi.fn(), adoptProfile: vi.fn(), setGuest: vi.fn(), loadConfig: vi.fn(async () => state.config),
    pushState: vi.fn(), pullState: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'your fingerprint', bio: () => 'your fingerprint',
  appBase: () => '/', api: vi.fn(), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
}))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false }))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const buttons = host => [...host.querySelectorAll('button')].map(b => b.textContent)
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0 })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login with Pocket ID', () => {
  it('is not there unless the server says so', () => {
    mocks.config = { allow_guest: true }
    expect(buttons(mount(<Login />))).not.toContain('Sign in with Pocket ID')
  })

  it('sits after the passkey and goes to the API login route', () => {
    mocks.config = { pocket_id: true, allow_guest: true }
    const page = mount(<Login />)
    expect(buttons(page).slice(0, 2)).toEqual(['Sign in with passkey', 'Sign in with Pocket ID'])
    const assign = vi.fn()
    const orig = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, assign } })
    try { act(() => button(page, 'Sign in with Pocket ID').click()) }
    finally { Object.defineProperty(window, 'location', { configurable: true, value: orig }) }
    expect(assign).toHaveBeenCalledWith('/api/auth/oidc/login')
  })
})
