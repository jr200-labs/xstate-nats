import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'
import { parseNatsResult, connectToNats, disconnectNats } from './connection'

vi.mock('@nats-io/nats-core', async () => {
  const actual = await vi.importActual('@nats-io/nats-core')
  return {
    ...actual,
    wsconnect: vi.fn(),
    credsAuthenticator: vi.fn((_creds: Uint8Array) => 'mock-authenticator'),
  }
})

describe('parseNatsResult', () => {
  it('should return null for null input', () => {
    expect(parseNatsResult(null)).toBeNull()
  })

  it('should return the Error for Error input', () => {
    const error = new Error('test error')
    expect(parseNatsResult(error)).toBe(error)
  })

  it('should parse JSON message', () => {
    const data = { foo: 'bar', num: 42 }
    const msg = {
      json: () => data,
      string: () => JSON.stringify(data),
    } as any
    expect(parseNatsResult(msg)).toEqual(data)
  })

  it('should fall back to string when JSON parsing fails', () => {
    const msg = {
      json: () => {
        throw new Error('not json')
      },
      string: () => 'plain text',
    } as any
    expect(parseNatsResult(msg)).toBe('plain text')
  })
})

describe('connectToNats', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should call wsconnect with opts and no auth', async () => {
    const { wsconnect } = await import('@nats-io/nats-core')
    const mockConnection = {
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      }),
    }
    vi.mocked(wsconnect).mockResolvedValue(mockConnection as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const actor = createActor(connectToNats, {
      input: { opts: { servers: ['ws://localhost:4222'] } },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output !== undefined) resolve(snap.output)
      })
    })
    actor.start()

    const result = await outputPromise
    expect(wsconnect).toHaveBeenCalledWith({ servers: ['ws://localhost:4222'] })
    expect(result).toBe(mockConnection)
  })

  it('should merge userpass auth config', async () => {
    const { wsconnect } = await import('@nats-io/nats-core')
    const mockConnection = {
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      }),
    }
    vi.mocked(wsconnect).mockResolvedValue(mockConnection as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const actor = createActor(connectToNats, {
      input: {
        opts: { servers: ['ws://localhost:4222'] },
        auth: { type: 'userpass' as const, user: 'admin', pass: 'secret' },
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output !== undefined) resolve(snap.output)
      })
    })
    actor.start()
    await outputPromise

    expect(wsconnect).toHaveBeenCalledWith({
      servers: ['ws://localhost:4222'],
      user: 'admin',
      pass: 'secret',
    })
  })

  it('should merge token auth config', async () => {
    const { wsconnect } = await import('@nats-io/nats-core')
    const mockConnection = {
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      }),
    }
    vi.mocked(wsconnect).mockResolvedValue(mockConnection as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const actor = createActor(connectToNats, {
      input: {
        opts: { servers: ['ws://localhost:4222'] },
        auth: { type: 'token' as const, token: 'my-token' },
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output !== undefined) resolve(snap.output)
      })
    })
    actor.start()
    await outputPromise

    expect(wsconnect).toHaveBeenCalledWith({
      servers: ['ws://localhost:4222'],
      token: 'my-token',
    })
  })

  it('should merge decentralised auth config', async () => {
    const { wsconnect, credsAuthenticator } = await import('@nats-io/nats-core')
    const mockConnection = {
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      }),
    }
    vi.mocked(wsconnect).mockResolvedValue(mockConnection as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const actor = createActor(connectToNats, {
      input: {
        opts: { servers: ['ws://localhost:4222'] },
        auth: {
          type: 'decentralised' as const,
          sentinelB64: btoa('test-creds'),
          user: 'nkey-user',
          pass: 'nkey-pass',
        },
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output !== undefined) resolve(snap.output)
      })
    })
    actor.start()
    await outputPromise

    expect(credsAuthenticator).toHaveBeenCalled()
    expect(wsconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: ['ws://localhost:4222'],
        authenticator: 'mock-authenticator',
        user: 'nkey-user',
        pass: 'nkey-pass',
      })
    )
  })

  it('should process status events from the connection', async () => {
    const { wsconnect } = await import('@nats-io/nats-core')
    let statusIndex = 0
    const statuses = [
      { type: 'disconnect', data: {} },
      { type: 'reconnect', data: {} },
      { type: 'error', data: {} },
      { type: 'close', data: {} },
      { type: 'ldm', data: {} },
      { type: 'ping', data: {} },
      { type: 'forceReconnect', data: {} },
      { type: 'reconnecting', data: {} },
      { type: 'slowConsumer', data: {} },
      { type: 'staleConnection', data: {} },
      { type: 'update', data: {} },
    ]
    let resolveStatusDone: () => void
    const statusDone = new Promise<void>(r => (resolveStatusDone = r))

    const mockConnection = {
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (statusIndex < statuses.length) {
              return Promise.resolve({ value: statuses[statusIndex++], done: false })
            }
            // Signal done, then return done: true to exit the loop
            resolveStatusDone!()
            return Promise.resolve({ value: undefined, done: true })
          },
        }),
      }),
    }
    vi.mocked(wsconnect).mockResolvedValue(mockConnection as any)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const actor = createActor(connectToNats, {
      input: { opts: { servers: ['ws://localhost:4222'] } },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output !== undefined) resolve(snap.output)
      })
    })
    actor.start()
    await outputPromise
    await statusDone
    // Wait for the status loop to finish processing
    await new Promise(r => setTimeout(r, 50))

    // Verify the status loop processed all events
    expect(consoleSpy).toHaveBeenCalledWith('Status loop received status', expect.objectContaining({ type: 'disconnect' }))
    expect(consoleSpy).toHaveBeenCalledWith('Status loop received status', expect.objectContaining({ type: 'reconnect' }))
    expect(consoleSpy).toHaveBeenCalledWith('Exiting nats status loop')
    consoleSpy.mockRestore()
    debugSpy.mockRestore()
  })

  it('should throw for unsupported auth type', async () => {
    const { wsconnect } = await import('@nats-io/nats-core')
    vi.mocked(wsconnect).mockResolvedValue({} as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    // The error is thrown synchronously inside the fromPromise creator,
    // so it becomes an unhandled exception. We test via the actor error status.
    const actor = createActor(connectToNats, {
      input: {
        opts: { servers: ['ws://localhost:4222'] },
        auth: { type: 'unknown' as any },
      },
    })

    // Catch the unhandled error from the actor
    let caughtError: Error | undefined
    const origListeners = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.once('uncaughtException', (err: Error) => {
      caughtError = err
    })

    actor.start()

    await vi.waitFor(() => {
      expect(caughtError).toBeDefined()
    })
    expect(caughtError!.message).toContain('Unsupported auth config type')

    // Restore listeners
    origListeners.forEach(l => process.on('uncaughtException', l))
  })
})

describe('disconnectNats', () => {
  it('should drain and close connection', async () => {
    const mockConnection = {
      drain: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }

    const actor = createActor(disconnectNats, {
      input: { connection: mockConnection as any },
    })

    const donePromise = new Promise<void>(resolve => {
      actor.subscribe(snap => {
        if (snap.status === 'done') resolve()
      })
    })
    actor.start()
    await donePromise

    expect(mockConnection.drain).toHaveBeenCalled()
    expect(mockConnection.close).toHaveBeenCalled()
  })

  it('should handle null connection gracefully', async () => {
    const actor = createActor(disconnectNats, {
      input: { connection: null as any },
    })

    const donePromise = new Promise<void>(resolve => {
      actor.subscribe(snap => {
        if (snap.status === 'done') resolve()
      })
    })
    actor.start()

    await expect(donePromise).resolves.not.toThrow()
  })
})
