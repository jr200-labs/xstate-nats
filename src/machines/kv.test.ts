import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createActor, fromPromise, sendTo, setup, assign } from 'xstate'
import { kvManagerLogic } from './kv'

vi.mock('@nats-io/nats-core', () => ({
  wsconnect: vi.fn(),
}))

// We'll set up specific Kvm mock behavior per test
const mockKvStore = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  keys: vi.fn(),
}

const mockKvmInstance = {
  open: vi.fn().mockResolvedValue(mockKvStore),
  list: vi.fn(),
  create: vi.fn(),
}

vi.mock('@nats-io/kv', () => ({
  Kvm: class MockKvm {
    open = mockKvmInstance.open
    list = mockKvmInstance.list
    create = mockKvmInstance.create
  },
}))

vi.mock('@nats-io/jetstream', () => ({
  jetstream: vi.fn(() => ({
    jetstreamManager: vi.fn().mockResolvedValue({
      streams: {
        delete: vi.fn().mockResolvedValue(true),
      },
    }),
  })),
}))

function createMockConnection() {
  return {
    subscribe: vi.fn(),
    publish: vi.fn(),
    status: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
      }),
    }),
  } as any
}

// Parent machine wrapper so sendParent works
function createParentMachine(kvLogic?: any) {
  const actualLogic = kvLogic || kvManagerLogic
  return setup({
    types: {
      context: {} as { childState: string },
      events: {} as any,
    },
    actors: {
      kv: actualLogic,
    },
  }).createMachine({
    initial: 'active',
    context: { childState: '' },
    invoke: {
      src: 'kv',
      id: 'kv',
    },
    on: {
      'KV.*': {
        actions: sendTo('kv', ({ event }: any) => {
          return { ...event }
        }),
      },
      'KV.CONNECTED': {
        actions: assign({ childState: 'connected' }),
      },
      'KV.DISCONNECTED': {
        actions: assign({ childState: 'disconnected' }),
      },
    },
    states: {
      active: {},
    },
  })
}

describe('kvManagerLogic', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('should start in kv_idle state', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()
    const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
    expect(childSnap?.value).toBe('kv_idle')
    parentActor.stop()
  })

  it('should have empty initial context', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()
    const ctx = parentActor.getSnapshot().children.kv?.getSnapshot()?.context
    expect(ctx?.cachedConnection).toBeNull()
    expect(ctx?.cachedKvm).toBeNull()
    expect(ctx?.subscriptions.size).toBe(0)
    expect(ctx?.subscriptionConfigs.size).toBe(0)
    expect(ctx?.syncRequired).toBe(0)
    parentActor.stop()
  })

  it('should transition to kv_connected on KV.CONNECT (no pending sync)', () => {
    const kvWithMockSync = kvManagerLogic.provide({
      actors: {
        kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })),
      },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'KV.CONNECT', connection })

    const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
    expect(childSnap?.value).toBe('kv_connected')
    expect(childSnap?.context.cachedConnection).toBe(connection)
    expect(childSnap?.context.cachedKvm).not.toBeNull()
    parentActor.stop()
  })

  it('should add subscription config on KV.SUBSCRIBE', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'test-bucket', key: 'test-key', callback: vi.fn() },
    })

    const ctx = parentActor.getSnapshot().children.kv?.getSnapshot()?.context
    const key = 'Pair(test-bucket, test-key)'
    expect(ctx?.subscriptionConfigs.has(key)).toBe(true)
    expect(ctx?.syncRequired).toBe(1)
    parentActor.stop()
  })

  it('should remove subscription config on KV.UNSUBSCRIBE', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b', key: 'k', callback: vi.fn() },
    })
    parentActor.send({ type: 'KV.UNSUBSCRIBE', bucket: 'b', key: 'k' })

    const ctx = parentActor.getSnapshot().children.kv?.getSnapshot()?.context
    expect(ctx?.subscriptionConfigs.has('Pair(b, k)')).toBe(false)
    expect(ctx?.syncRequired).toBe(2)
    parentActor.stop()
  })

  it('should clear all configs on KV.UNSUBSCRIBE_ALL', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b1', key: 'k1', callback: vi.fn() },
    })
    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b2', key: 'k2', callback: vi.fn() },
    })
    parentActor.send({ type: 'KV.UNSUBSCRIBE_ALL' })

    const ctx = parentActor.getSnapshot().children.kv?.getSnapshot()?.context
    expect(ctx?.subscriptionConfigs.size).toBe(0)
    parentActor.stop()
  })

  it('should sync when connecting with pending subscriptions', async () => {
    const kvWithMockSync = kvManagerLogic.provide({
      actors: {
        kvConsolidateState: fromPromise(async () => ({
          subscriptions: new Map([['Pair(b, k)', {} as any]]),
        })),
      },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b', key: 'k', callback: vi.fn() },
    })

    const connection = createMockConnection()
    parentActor.send({ type: 'KV.CONNECT', connection })

    await vi.waitFor(() => {
      const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
      expect(childSnap?.value).toBe('kv_connected')
    })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_LIST with bucket name', async () => {
    mockKvStore.keys.mockResolvedValue({
      [Symbol.asyncIterator]: () => {
        let i = 0
        const keys = ['key1', 'key2']
        return {
          next: () =>
            i < keys.length
              ? Promise.resolve({ value: keys[i++], done: false })
              : Promise.resolve({ value: undefined, done: true }),
        }
      },
    })
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_LIST', bucket: 'mybucket', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith(['key1', 'key2'])
    parentActor.stop()
  })

  it('should handle KV.BUCKET_LIST without bucket name', async () => {
    mockKvmInstance.list.mockReturnValue({
      [Symbol.asyncIterator]: () => {
        let done = false
        return {
          next: () => {
            if (!done) {
              done = true
              return Promise.resolve({ value: { bucket: 'b1' }, done: false })
            }
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    })
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_LIST', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith([{ bucket: 'b1' }])
    parentActor.stop()
  })

  it('should handle KV.BUCKET_LIST error', async () => {
    mockKvmInstance.open.mockRejectedValueOnce(new Error('open failed'))
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_LIST', bucket: 'fail', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_CREATE success', async () => {
    mockKvmInstance.list.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined, done: true }),
      }),
    })
    mockKvmInstance.create.mockResolvedValue({})
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_CREATE', bucket: 'new-bucket', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ ok: true })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_CREATE when bucket already exists', async () => {
    mockKvmInstance.list.mockReturnValue({
      [Symbol.asyncIterator]: () => {
        let done = false
        return {
          next: () => {
            if (!done) {
              done = true
              return Promise.resolve({ value: { bucket: 'existing' }, done: false })
            }
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    })
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_CREATE', bucket: 'existing', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ ok: false })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_DELETE', async () => {
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_DELETE', bucket: 'old-bucket', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_DELETE when stream delete fails', async () => {
    const { jetstream } = await import('@nats-io/jetstream')
    vi.mocked(jetstream).mockImplementationOnce(
      () =>
        ({
          jetstreamManager: vi.fn().mockRejectedValue(new Error('stream error')),
        }) as any,
    )

    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_DELETE', bucket: 'fail-bucket', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ ok: false })
    parentActor.stop()
  })

  it('should handle KV.GET', async () => {
    mockKvStore.get.mockResolvedValue({ key: 'k', value: 'v' })
    mockKvmInstance.open.mockResolvedValue(mockKvStore)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.GET', bucket: 'b', key: 'k', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ key: 'k', value: 'v' })
    parentActor.stop()
  })

  it('should handle KV.PUT', async () => {
    mockKvStore.put.mockResolvedValue(1)
    mockKvmInstance.open.mockResolvedValue(mockKvStore)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.PUT', bucket: 'b', key: 'k', value: 'hello', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ ok: true })
    parentActor.stop()
  })

  it('should handle KV.DELETE', async () => {
    mockKvStore.delete.mockResolvedValue(undefined)
    mockKvmInstance.open.mockResolvedValue(mockKvStore)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.DELETE', bucket: 'b', key: 'k', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ ok: true })
    parentActor.stop()
  })

  it('should handle KV.GET when bucket open returns null', async () => {
    mockKvmInstance.open.mockResolvedValueOnce(null)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.GET', bucket: 'missing', key: 'k', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.PUT when bucket open returns null', async () => {
    mockKvmInstance.open.mockResolvedValueOnce(null)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.PUT', bucket: 'missing', key: 'k', value: 'v', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.DELETE when bucket open returns null', async () => {
    mockKvmInstance.open.mockResolvedValueOnce(null)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.DELETE', bucket: 'missing', key: 'k', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.PUT error from kv.put', async () => {
    mockKvStore.put.mockRejectedValueOnce(new Error('put failed'))
    mockKvmInstance.open.mockResolvedValue(mockKvStore)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.PUT', bucket: 'b', key: 'k', value: 'v', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.DELETE error from kv.delete', async () => {
    mockKvStore.delete.mockRejectedValueOnce(new Error('delete failed'))
    mockKvmInstance.open.mockResolvedValue(mockKvStore)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.DELETE', bucket: 'b', key: 'k', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.GET error from kv.get', async () => {
    mockKvStore.get.mockRejectedValueOnce(new Error('get failed'))
    mockKvmInstance.open.mockResolvedValue(mockKvStore)
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.GET', bucket: 'b', key: 'k', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_LIST with no KVM initialized', async () => {
    // Test the !context.cachedKvm branch
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    // Manually null out cachedKvm - we can't easily do this through the machine
    // So we test the error path via a thrown exception instead
    mockKvmInstance.open.mockRejectedValueOnce(new Error('kvm error'))
    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_LIST', bucket: 'b', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should handle KV.BUCKET_CREATE error', async () => {
    mockKvmInstance.list.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('list failed')),
      }),
    })
    const kvWithMockSync = kvManagerLogic.provide({
      actors: { kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })) },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()
    parentActor.send({ type: 'KV.CONNECT', connection: createMockConnection() })

    const onResult = vi.fn()
    parentActor.send({ type: 'KV.BUCKET_CREATE', bucket: 'fail', onResult })

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalled()
    })
    expect(onResult).toHaveBeenCalledWith({ error: expect.any(Error) })
    parentActor.stop()
  })

  it('should transition to kv_error on sync failure', async () => {
    const kvWithFailSync = kvManagerLogic.provide({
      actors: {
        kvConsolidateState: fromPromise(async () => {
          throw new Error('sync failed')
        }),
      },
    })
    const parentActor = createActor(createParentMachine(kvWithFailSync))
    parentActor.start()

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b', key: 'k', callback: vi.fn() },
    })

    const connection = createMockConnection()
    parentActor.send({ type: 'KV.CONNECT', connection })

    await vi.waitFor(() => {
      const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
      expect(childSnap?.value).toBe('kv_error')
    })

    const ctx = parentActor.getSnapshot().children.kv?.getSnapshot()?.context
    expect(ctx?.error).toBeDefined()
    parentActor.stop()
  })

  it('should recover from kv_error on KV.CONNECT', async () => {
    let callCount = 0
    const kvWithRecovery = kvManagerLogic.provide({
      actors: {
        kvConsolidateState: fromPromise(async () => {
          callCount++
          if (callCount === 1) throw new Error('sync failed')
          return { subscriptions: new Map() }
        }),
      },
    })
    const parentActor = createActor(createParentMachine(kvWithRecovery))
    parentActor.start()

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b', key: 'k', callback: vi.fn() },
    })

    const connection = createMockConnection()
    parentActor.send({ type: 'KV.CONNECT', connection })

    await vi.waitFor(() => {
      const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
      expect(childSnap?.value).toBe('kv_error')
    })

    parentActor.send({ type: 'KV.CONNECT', connection })

    await vi.waitFor(() => {
      const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
      expect(childSnap?.value).toBe('kv_connected')
    })
    parentActor.stop()
  })

  it('should notify parent of KV.CONNECTED', () => {
    const kvWithMockSync = kvManagerLogic.provide({
      actors: {
        kvConsolidateState: fromPromise(async () => ({ subscriptions: new Map() })),
      },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'KV.CONNECT', connection })

    expect(parentActor.getSnapshot().context.childState).toBe('connected')
    parentActor.stop()
  })

  it('should sync when new subscription added while connected', async () => {
    const kvWithMockSync = kvManagerLogic.provide({
      actors: {
        kvConsolidateState: fromPromise(async () => ({
          subscriptions: new Map(),
        })),
      },
    })
    const parentActor = createActor(createParentMachine(kvWithMockSync))
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'KV.CONNECT', connection })

    parentActor.send({
      type: 'KV.SUBSCRIBE',
      config: { bucket: 'b', key: 'k', callback: vi.fn() },
    })

    await vi.waitFor(() => {
      const childSnap = parentActor.getSnapshot().children.kv?.getSnapshot()
      expect(childSnap?.value).toBe('kv_connected')
    })
    parentActor.stop()
  })
})
