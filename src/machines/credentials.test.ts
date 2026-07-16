import { TimeoutError } from '@nats-io/nats-core'
import { createActor, waitFor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialMachine, getCredentials } from './credentials'

describe('credentialMachine', () => {
  afterEach(() => vi.useRealTimers())

  it('loads once and shares the ready credentials', async () => {
    const credentials = { auth: { type: 'token' as const, token: 'one' } }
    const load = vi.fn(async () => credentials)
    const actor = createActor(credentialMachine, { input: { adapter: { load } } }).start()

    await expect(Promise.all([getCredentials(actor), getCredentials(actor)])).resolves.toEqual([
      credentials,
      credentials,
    ])
    expect(load).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().value).toBe('ready')
    actor.stop()
  })

  it('deduplicates requests while refreshing near expiry', async () => {
    let finishRefresh!: (value: { auth: { type: 'token'; token: string } }) => void
    const refreshed = { auth: { type: 'token' as const, token: 'two' } }
    const refresh = vi.fn(
      () =>
        new Promise<{ auth: { type: 'token'; token: string } }>((resolve) => {
          finishRefresh = resolve
        }),
    )
    const actor = createActor(credentialMachine, {
      input: {
        adapter: {
          load: async () => ({
            auth: { type: 'token' as const, token: 'one' },
            expiresAt: Date.now() + 30_000,
          }),
          refresh,
        },
      },
    }).start()

    await waitFor(actor, (snapshot) => snapshot.matches('refreshing'))
    const first = getCredentials(actor)
    const second = getCredentials(actor)
    finishRefresh(refreshed)

    await expect(Promise.all([first, second])).resolves.toEqual([refreshed, refreshed])
    expect(refresh).toHaveBeenCalledOnce()
    actor.stop()
  })

  it('proactively refreshes before credentials expire', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(now)
    const refresh = vi.fn(async () => ({
      auth: { type: 'token' as const, token: 'two' },
      expiresAt: now.getTime() + 600_000,
    }))
    const actor = createActor(credentialMachine, {
      input: {
        refreshBeforeExpiryMs: 1_000,
        adapter: {
          load: async () => ({
            auth: { type: 'token' as const, token: 'one' },
            expiresAt: now.getTime() + 5_000,
          }),
          refresh,
        },
      },
    }).start()

    await vi.advanceTimersByTimeAsync(4_000)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await expect(getCredentials(actor)).resolves.toMatchObject({
      auth: { token: 'two' },
    })
    actor.stop()
  })

  it('rejects expired credentials when no refresh adapter exists', async () => {
    vi.useFakeTimers()
    const actor = createActor(credentialMachine, {
      input: {
        adapter: {
          load: async () => ({
            auth: { type: 'token' as const, token: 'one' },
            expiresAt: Date.now() + 10,
          }),
        },
      },
    }).start()

    await vi.advanceTimersByTimeAsync(10)
    await expect(getCredentials(actor)).rejects.toThrow('expired')
    expect(actor.getSnapshot().value).toBe('expired')
    actor.stop()
  })

  it('does not release an expired value returned by the initial load', async () => {
    const actor = createActor(credentialMachine, {
      input: {
        adapter: {
          load: async () => ({
            auth: { type: 'token' as const, token: 'stale' },
            expiresAt: Date.now() - 1,
          }),
        },
      },
    }).start()

    await expect(getCredentials(actor)).rejects.toThrow('expired')
    expect(actor.getSnapshot().value).toBe('expired')
    actor.stop()
  })

  it('fails closed when refresh returns another stale value', async () => {
    const actor = createActor(credentialMachine, {
      input: {
        adapter: {
          load: async () => ({ expiresAt: Date.now() + 1_000 }),
          refresh: async () => ({ expiresAt: Date.now() + 1_000 }),
        },
      },
    }).start()

    await expect(getCredentials(actor)).rejects.toThrow('too close to expiry')
    expect(actor.getSnapshot().value).toBe('failed')
    actor.stop()
  })

  it('bounds a hung adapter operation and fails all waiters', async () => {
    const actor = createActor(credentialMachine, {
      input: {
        operationTimeoutMs: 5,
        adapter: { load: () => new Promise(() => {}) },
      },
    }).start()

    const first = getCredentials(actor)
    const second = getCredentials(actor)
    await expect(first).rejects.toBeInstanceOf(TimeoutError)
    await expect(second).rejects.toBeInstanceOf(TimeoutError)
    await waitFor(actor, (snapshot) => snapshot.matches('failed'))
    actor.stop()
  })

  it('can reload after a failure', async () => {
    const load = vi
      .fn<() => Promise<{ auth: { type: 'token'; token: string } }>>()
      .mockRejectedValueOnce(new Error('session unavailable'))
      .mockResolvedValueOnce({ auth: { type: 'token', token: 'recovered' } })
    const actor = createActor(credentialMachine, { input: { adapter: { load } } }).start()
    await waitFor(actor, (snapshot) => snapshot.matches('failed'))

    actor.send({ type: 'CREDENTIALS.RELOAD' })

    await expect(getCredentials(actor)).resolves.toMatchObject({
      auth: { token: 'recovered' },
    })
    expect(load).toHaveBeenCalledTimes(2)
    actor.stop()
  })

  it('rejects immediately after the actor is stopped', async () => {
    const actor = createActor(credentialMachine, {
      input: { adapter: { load: async () => ({}) } },
    }).start()
    actor.stop()

    await expect(getCredentials(actor)).rejects.toThrow('actor is stopped')
  })
})
