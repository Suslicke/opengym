// "Sign in with Pocket ID" and "Connect Pocket ID" (api/server.js, OpenID Connect). Both are
// browser redirects: the sign-in is a plain navigation to the API, the connect asks the API for
// the address first (a POST, so the origin check applies) and then goes there. The result comes
// back as `?pocket_id=<result>` and is read at boot (store/useStore.js, App.jsx).
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { api, appBase } from '../lib/api.js'
import { MOBILE } from '../lib/mobile.js'
import { pocketIdOn } from '../lib/pocket-id.js'
import { confirmSheet } from '../sheets.jsx'
import { Row } from './ui.jsx'

export const pocketIdOffered = config => pocketIdOn(config, MOBILE)

export function signInWithPocketId() {
  window.location.assign(appBase().replace(/\/$/, '') + '/api/auth/oidc/login')
}

// What the callback's result means to the person who just came back from Pocket ID.
export function pocketIdMessage(result) {
  switch (result) {
    case 'signed-in': return ''
    case 'linked': return t('Pocket ID is connected. You can sign in with it from now on.')
    case 'unbound': return t('This Pocket ID account is not connected to any profile here. Sign in with your passkey, then connect Pocket ID in Settings → Account.')
    case 'disabled': return t('This account has been disabled.')
    case 'denied': return t('Pocket ID sign-in was cancelled.')
    case 'session': return t('Your session changed while connecting Pocket ID. Sign in and try again.')
    case 'already-linked': return t('Pocket ID is already connected to this profile.')
    case 'taken': return t('That Pocket ID account is already connected to another profile.')
    case 'unavailable': return t('Pocket ID cannot be reached right now.')
    default: return t('Pocket ID sign-in failed. Try again.')
  }
}

export function PocketIdRow() {
  const config = useStore(s => s.config)
  const [st, setSt] = useState(null)
  const on = pocketIdOffered(config)
  const load = () => api('/api/auth/oidc/link').then(setSt).catch(() => setSt(null))
  useEffect(() => { if (on) load() }, [on])
  if (!on) return null
  const toast = m => useUI.getState().toast(m)
  const connect = async () => {
    try {
      const r = await api('/api/auth/oidc/link', { method: 'POST', body: '{}' })
      if (r?.url) window.location.assign(r.url)
    } catch (e) { toast(e.code === 'already-linked' ? pocketIdMessage('already-linked') : (e.message || pocketIdMessage('failed'))) }
  }
  const disconnect = () => confirmSheet({
    title: t('Disconnect Pocket ID?'),
    message: t('You will no longer be able to sign in to this profile with Pocket ID. Your passkeys keep working.'),
    confirmText: t('Disconnect'),
    danger: true,
    onConfirm: async () => {
      try { await api('/api/auth/oidc/link', { method: 'DELETE' }); toast(t('Pocket ID disconnected')) }
      catch (e) { toast(e.message || t('Could not disconnect Pocket ID')) }
      load()
    }
  })
  return st?.linked
    ? <Row icon="link" iconTint="var(--indigo)" title={t('Pocket ID')} value={t('Connected')} subtitle={t('Tap to disconnect it from this profile.')} accessory="chevron" onClick={disconnect} />
    : <Row icon="link" iconTint="var(--indigo)" title={t('Connect Pocket ID')} subtitle={t('Sign in to this profile with your Pocket ID account.')} accessory="chevron" onClick={connect} />
}
