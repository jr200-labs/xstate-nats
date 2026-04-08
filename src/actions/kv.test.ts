import { describe, it, expect, vi } from 'vitest'
import { createActor } from 'xstate'
import { KvSubscriptionKey, kvConsolidateState } from './kv'

describe('KvSubscriptionKey', () => {
  it('should create a key from bucket and key', () => {
    const result = KvSubscriptionKey.key('my-bucket', 'my-key')
    expect(result).toBe('Pair(my-bucket, my-key)')
  })

  it('should parse a key back', () => {
    const pair = KvSubscriptionKey.fromKey('Pair(bucket1, key1)')
    expect(pair.x).toBe('bucket1')
    expect(pair.y).toBe('key1')
  })

  it('should support equality check', () => {
    const a = new KvSubscriptionKey('b', 'k')
    const b = new KvSubscriptionKey('b', 'k')
    const c = new KvSubscriptionKey('b', 'other')
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(false)
  })

  it('should convert to key string', () => {
    const pair = new KvSubscriptionKey('bucket', 'key')
    expect(pair.toKey()).toBe('Pair(bucket, key)')
  })
})

describe('kvConsolidateState', () => {
  it('should throw when connection and kvm are null', async () => {
    let caughtError: Error | undefined
    const origListeners = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.once('uncaughtException', (err: Error) => {
      caughtError = err
    })

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: null,
        connection: null,
        currentState: new Map(),
        targetState: new Map(),
      },
    })
    actor.start()

    await vi.waitFor(() => {
      expect(caughtError).toBeDefined()
    })
    expect(caughtError!.message).toContain('NATS connection or KVM is not available')
    origListeners.forEach(l => process.on('uncaughtException', l))
  })

  it('should throw when kvm is null', async () => {
    let caughtError: Error | undefined
    const origListeners = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.once('uncaughtException', (err: Error) => {
      caughtError = err
    })

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: null,
        connection: {} as any,
        currentState: new Map(),
        targetState: new Map(),
      },
    })
    actor.start()

    await vi.waitFor(() => {
      expect(caughtError).toBeDefined()
    })
    expect(caughtError!.message).toContain('NATS connection or KVM is not available')
    origListeners.forEach(l => process.on('uncaughtException', l))
  })

  it('should unsubscribe from items not in target state', async () => {
    const mockWatcher = { stop: vi.fn() }
    const currentState = new Map([['Pair(bucket, key1)', mockWatcher as any]])

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: { open: vi.fn() } as any,
        connection: {} as any,
        currentState,
        targetState: new Map(),
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output) resolve(snap.output)
      })
    })
    actor.start()

    const result = await outputPromise
    expect(mockWatcher.stop).toHaveBeenCalled()
    expect(result.subscriptions.has('Pair(bucket, key1)')).toBe(false)
  })

  it('should handle unsubscribe errors gracefully', async () => {
    const mockWatcher = {
      stop: vi.fn(() => {
        throw new Error('stop failed')
      }),
    }
    const currentState = new Map([['Pair(bucket, key1)', mockWatcher as any]])

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: { open: vi.fn() } as any,
        connection: {} as any,
        currentState,
        targetState: new Map(),
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output) resolve(snap.output)
      })
    })
    actor.start()
    await outputPromise
    consoleSpy.mockRestore()

    expect(mockWatcher.stop).toHaveBeenCalled()
  })

  it('should subscribe to new items in target state', async () => {
    const mockWatcher = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
      }),
    }
    const mockKv = {
      watch: vi.fn().mockResolvedValue(mockWatcher),
    }
    const mockKvm = {
      open: vi.fn().mockResolvedValue(mockKv),
    }

    const callback = vi.fn()
    const targetState = new Map([
      [
        'Pair(bucket, key1)',
        {
          bucket: 'bucket',
          key: 'key1',
          callback,
        },
      ],
    ])

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState: new Map(),
        targetState: targetState as any,
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output) resolve(snap.output)
      })
    })
    actor.start()

    const result = await outputPromise
    expect(mockKvm.open).toHaveBeenCalledWith('bucket')
    expect(mockKv.watch).toHaveBeenCalled()
    expect(result.subscriptions.has('Pair(bucket, key1)')).toBe(true)
  })

  it('should keep existing subscriptions that are still in target', async () => {
    const existingWatcher = { stop: vi.fn() } as any
    const currentState = new Map([['Pair(bucket, key1)', existingWatcher]])

    const callback = vi.fn()
    const targetState = new Map([
      [
        'Pair(bucket, key1)',
        {
          bucket: 'bucket',
          key: 'key1',
          callback,
        },
      ],
    ])

    const mockKvm = { open: vi.fn() }
    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState,
        targetState: targetState as any,
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output) resolve(snap.output)
      })
    })
    actor.start()

    const result = await outputPromise
    expect(existingWatcher.stop).not.toHaveBeenCalled()
    expect(mockKvm.open).not.toHaveBeenCalled()
    expect(result.subscriptions.get('Pair(bucket, key1)')).toBe(existingWatcher)
  })

  it('should invoke callback for watcher entries with JSON values', async () => {
    let entryIndex = 0
    let resolveDelivered: () => void
    const deliveredPromise = new Promise<void>(r => (resolveDelivered = r))
    const entries = [
      { operation: 'PUT', string: () => '{"val":1}' },
      { operation: 'PUT', string: () => '{"val":2}' },
    ]
    const mockWatcher = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (entryIndex < entries.length) {
            return Promise.resolve({ value: entries[entryIndex++], done: false })
          }
          resolveDelivered!()
          return new Promise(() => {})
        },
      }),
    }
    const mockKv = { watch: vi.fn().mockResolvedValue(mockWatcher) }
    const mockKvm = { open: vi.fn().mockResolvedValue(mockKv) }

    const callback = vi.fn()
    const targetState = new Map([
      ['Pair(b, k)', { bucket: 'b', key: 'k', callback }],
    ])

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState: new Map(),
        targetState: targetState as any,
      },
    })
    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => { if (snap.output) resolve(snap.output) })
    })
    actor.start()
    await outputPromise
    await deliveredPromise
    await new Promise(r => setTimeout(r, 10))

    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenCalledWith({ bucket: 'b', key: 'k', value: { val: 1 } })
    expect(callback).toHaveBeenCalledWith({ bucket: 'b', key: 'k', value: { val: 2 } })
  })

  it('should fall back to string when JSON parsing fails in watcher', async () => {
    let delivered = false
    let resolveDelivered: () => void
    const deliveredPromise = new Promise<void>(r => (resolveDelivered = r))
    const mockWatcher = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (!delivered) {
            delivered = true
            return Promise.resolve({
              value: { operation: 'PUT', string: () => 'not-json' },
              done: false,
            })
          }
          resolveDelivered!()
          return new Promise(() => {})
        },
      }),
    }
    const mockKv = { watch: vi.fn().mockResolvedValue(mockWatcher) }
    const mockKvm = { open: vi.fn().mockResolvedValue(mockKv) }

    const callback = vi.fn()
    const targetState = new Map([
      ['Pair(b, k)', { bucket: 'b', key: 'k', callback }],
    ])

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState: new Map(),
        targetState: targetState as any,
      },
    })
    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => { if (snap.output) resolve(snap.output) })
    })
    actor.start()
    await outputPromise
    await deliveredPromise
    await new Promise(r => setTimeout(r, 10))

    expect(callback).toHaveBeenCalledWith({ bucket: 'b', key: 'k', value: 'not-json' })
  })

  it('should skip DEL operations in watcher', async () => {
    let delivered = false
    let resolveDelivered: () => void
    const deliveredPromise = new Promise<void>(r => (resolveDelivered = r))
    const mockWatcher = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (!delivered) {
            delivered = true
            return Promise.resolve({
              value: { operation: 'DEL', string: () => '{}' },
              done: false,
            })
          }
          resolveDelivered!()
          return new Promise(() => {})
        },
      }),
    }
    const mockKv = { watch: vi.fn().mockResolvedValue(mockWatcher) }
    const mockKvm = { open: vi.fn().mockResolvedValue(mockKv) }

    const callback = vi.fn()
    const targetState = new Map([
      ['Pair(b, k)', { bucket: 'b', key: 'k', callback }],
    ])

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState: new Map(),
        targetState: targetState as any,
      },
    })
    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => { if (snap.output) resolve(snap.output) })
    })
    actor.start()
    await outputPromise
    await deliveredPromise
    await new Promise(r => setTimeout(r, 10))

    expect(callback).not.toHaveBeenCalled()
  })

  it('should handle watcher loop errors', async () => {
    const mockWatcher = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('watcher broke')),
      }),
    }
    const mockKv = { watch: vi.fn().mockResolvedValue(mockWatcher) }
    const mockKvm = { open: vi.fn().mockResolvedValue(mockKv) }

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const callback = vi.fn()
    const targetState = new Map([
      ['Pair(b, k)', { bucket: 'b', key: 'k', callback }],
    ])

    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState: new Map(),
        targetState: targetState as any,
      },
    })
    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => { if (snap.output) resolve(snap.output) })
    })
    actor.start()
    await outputPromise

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Watcher loop error'),
        expect.any(Error)
      )
    })
    consoleSpy.mockRestore()
  })

  it('should handle subscribe errors gracefully', async () => {
    const mockKvm = {
      open: vi.fn().mockRejectedValue(new Error('open failed')),
    }

    const callback = vi.fn()
    const targetState = new Map([
      [
        'Pair(bucket, key1)',
        {
          bucket: 'bucket',
          key: 'key1',
          callback,
        },
      ],
    ])

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const actor = createActor(kvConsolidateState, {
      input: {
        kvm: mockKvm as any,
        connection: {} as any,
        currentState: new Map(),
        targetState: targetState as any,
      },
    })

    const outputPromise = new Promise<any>(resolve => {
      actor.subscribe(snap => {
        if (snap.output) resolve(snap.output)
      })
    })
    actor.start()

    const result = await outputPromise
    consoleSpy.mockRestore()
    expect(result.subscriptions.has('Pair(bucket, key1)')).toBe(false)
  })
})
