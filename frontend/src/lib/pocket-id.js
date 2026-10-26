// Sign in with Pocket ID (api/server.js, OpenID Connect). The server sends the browser back to the
// app with `?pocket_id=<result>` after every callback. HashRouter never sees that query, so it is
// read off window.location.search at boot and dropped from the address bar at once, like a
// device-link code (lib/device-link.js).

const RESULTS = new Set(['signed-in', 'linked', 'unbound', 'disabled', 'denied', 'session', 'already-linked', 'taken', 'failed', 'unavailable'])

export function pocketIdResultFromSearch(search) {
  const v = new URLSearchParams(String(search || '').replace(/^\?/, '')).get('pocket_id') || ''
  return RESULTS.has(v) ? v : (v ? 'failed' : '')
}

export function stripPocketIdFromUrl() {
  if (typeof window === 'undefined') return
  const u = new URL(window.location.href)
  if (!u.searchParams.has('pocket_id')) return
  u.searchParams.delete('pocket_id')
  const q = u.searchParams.toString()
  history.replaceState({}, '', u.pathname + (q ? '?' + q : '') + u.hash)
}

// Offered only where the server says it is configured, and never in the mobile app: the flow is a
// browser redirect back to this origin, which the app's WebView is not.
export const pocketIdOn = (config, mobile = false) => !mobile && !!(config && config.pocket_id === true)
