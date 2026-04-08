import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createActor, fromPromise, createMachine, sendParent } from 'xstate'
import { natsMachine } from './root'

vi.mock('@nats-io/nats-core', () => ({
  wsconnect: vi.fn(),
  credsAuthenticator: vi.fn(),
}))

vi.mock('@nats-io/kv', () => ({
  Kvm: vi.fn().mockImplementation(() => ({})),
}))

const mockSubjectMachine = createMachine({
  initial: 'idle',
  states: {
    idle: {
      on: {
        'SUBJECT.CONNECT': { target: 'connected' },
        'SUBJECT.DISCONNECTED': { target: 'idle' },
      },
    },
    connected: {
      entry: sendParent({ type: 'SUBJECT.CONNECTED' }),
      on: {
        'SUBJECT.*': {},
        'SUBJECT.DISCONNECTED': { target: 'idle' },
      },
    },
  },
})

const mockKvMachine = createMachine({
  initial: 'idle',
  states: {
    idle: {
      on: {
        'KV.CONNECT': { target: 'connected' },
        'KV.DISCONNECTED': { target: 'idle' },
      },
    },
    connected: {
      entry: sendParent({ type: 'KV.CONNECTED' }),
      on: {
        'KV.*': {},
        'KV.DISCONNECTED': { target: 'idle' },
      },
    },
  },
})

const mockConnection = {
  drain: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getServer: vi.fn().mockReturnValue('ws://localhost:4222'),
  status: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}),
    }),
  }),
} as any

function createTestMachine() {
  return natsMachine.provide({
    actors: {
      connectToNats: fromPromise(async () => mockConnection),
      disconnectNats: fromPromise(async () => {}),
      subject: mockSubjectMachine,
      kv: mockKvMachine,
    },
  })
}

function configureAndConnect(actor: any) {
  actor.send({
    type: 'CONFIGURE',
    config: { opts: { servers: ['ws://localhost:4222'] }, maxRetries: 3 },
  })
  actor.send({ type: 'CONNECT' })
}

describe('natsMachine', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('should start in not_configured state', () => {
    const actor = createActor(createTestMachine())
    actor.start()
    expect(actor.getSnapshot().value).toBe('not_configured')
    actor.stop()
  })

  it('should transition to configured on CONFIGURE', () => {
    const actor = createActor(createTestMachine())
    actor.start()

    actor.send({
      type: 'CONFIGURE',
      config: { opts: { servers: ['ws://localhost:4222'] }, maxRetries: 3 },
    })

    expect(actor.getSnapshot().value).toBe('configured')
    expect(actor.getSnapshot().context.natsConfig).toEqual({
      opts: { servers: ['ws://localhost:4222'] },
      maxRetries: 3,
    })
    actor.stop()
  })

  it('should reach connected state after CONNECT', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    expect(actor.getSnapshot().context.connection).toBe(mockConnection)
    expect(actor.getSnapshot().context.subjectManagerReady).toBe(true)
    expect(actor.getSnapshot().context.kvManagerReady).toBe(true)
    actor.stop()
  })

  it('should transition to closed on DISCONNECT from connected', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    actor.send({ type: 'DISCONNECT' })

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('closed')
    })
    actor.stop()
  })

  it('should transition to error when connection fails', async () => {
    const failError = new Error('connection failed')
    const failMachine = natsMachine.provide({
      actors: {
        connectToNats: fromPromise(async () => {
          throw failError
        }),
        disconnectNats: fromPromise(async () => {}),
        subject: mockSubjectMachine,
        kv: mockKvMachine,
      },
    })

    const actor = createActor(failMachine)
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('error')
    })
    expect(actor.getSnapshot().context.error).toBe(failError)
    expect(actor.getSnapshot().context.retries).toBe(1)
    actor.stop()
  })

  it('should reset from error state', async () => {
    const failMachine = natsMachine.provide({
      actors: {
        connectToNats: fromPromise(async () => {
          throw new Error('fail')
        }),
        disconnectNats: fromPromise(async () => {}),
        subject: mockSubjectMachine,
        kv: mockKvMachine,
      },
    })

    const actor = createActor(failMachine)
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('error')
    })

    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().value).toBe('not_configured')
    expect(actor.getSnapshot().context.natsConfig).toBeUndefined()
    expect(actor.getSnapshot().context.connection).toBeNull()
    expect(actor.getSnapshot().context.retries).toBe(0)
    actor.stop()
  })

  it('should reset from configured state', () => {
    const actor = createActor(createTestMachine())
    actor.start()

    actor.send({
      type: 'CONFIGURE',
      config: { opts: { servers: ['ws://localhost:4222'] }, maxRetries: 3 },
    })
    actor.send({ type: 'RESET' })

    expect(actor.getSnapshot().value).toBe('not_configured')
    actor.stop()
  })

  it('should reconnect from closed state', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    actor.send({ type: 'DISCONNECT' })
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('closed')
    })

    actor.send({ type: 'CONNECT' })
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    actor.stop()
  })

  it('should reset from closed state', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    actor.send({ type: 'DISCONNECT' })
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('closed')
    })
    actor.send({ type: 'RESET' })

    expect(actor.getSnapshot().value).toBe('not_configured')
    actor.stop()
  })

  it('should transition to closed on CLOSE event from connected', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    actor.send({ type: 'CLOSE' })

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('closed')
    })
    actor.stop()
  })

  it('should transition to error when disconnect fails', async () => {
    const disconnectError = new Error('disconnect failed')
    const failDisconnectMachine = natsMachine.provide({
      actors: {
        connectToNats: fromPromise(async () => mockConnection),
        disconnectNats: fromPromise(async () => {
          throw disconnectError
        }),
        subject: mockSubjectMachine,
        kv: mockKvMachine,
      },
    })

    const actor = createActor(failDisconnectMachine)
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })
    actor.send({ type: 'DISCONNECT' })

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('error')
    })
    expect(actor.getSnapshot().context.error).toBe(disconnectError)
    actor.stop()
  })

  it('should forward SUBJECT.* events when connected', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })

    expect(() => {
      actor.send({
        type: 'SUBJECT.SUBSCRIBE',
        config: { subject: 'test', callback: vi.fn() },
      } as any)
    }).not.toThrow()

    actor.stop()
  })

  it('should forward KV.* events when connected', async () => {
    const actor = createActor(createTestMachine())
    actor.start()
    configureAndConnect(actor)

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('connected')
    })

    expect(() => {
      actor.send({
        type: 'KV.SUBSCRIBE',
        config: { bucket: 'test', key: 'k', callback: vi.fn() },
      } as any)
    }).not.toThrow()

    actor.stop()
  })


})
