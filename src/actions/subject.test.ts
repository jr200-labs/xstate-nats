import { describe, it, expect, vi, beforeEach } from 'vitest'
import { subjectConsolidateState, subjectRequest, subjectPublish } from './subject'
import type { SubjectSubscriptionConfig } from './subject'

// Mock the connection module
vi.mock('./connection', () => ({
  parseNatsResult: vi.fn((msg: any) => {
    if (!msg) return null
    if (msg instanceof Error) return msg
    try {
      return msg.json()
    } catch {
      return msg.string()
    }
  }),
}))

function createMockConnection() {
  return {
    subscribe: vi.fn(),
    request: vi.fn(),
    publish: vi.fn(),
  } as any
}

function createMockSubscription(subject: string) {
  return {
    unsubscribe: vi.fn(),
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}), // never resolves
    }),
  } as any
}

describe('subjectConsolidateState', () => {
  it('should throw when connection is null', () => {
    expect(() =>
      subjectConsolidateState({
        input: {
          connection: null,
          currentSubscriptions: new Map(),
          targetSubscriptions: new Map(),
        },
      })
    ).toThrow('NATS connection is not available')
  })

  it('should subscribe to new subjects in target', () => {
    const connection = createMockConnection()
    const mockSub = createMockSubscription('test.subject')
    connection.subscribe.mockReturnValue(mockSub)

    const callback = vi.fn()
    const targetSubscriptions = new Map<string, SubjectSubscriptionConfig>([
      ['test.subject', { subject: 'test.subject', callback }],
    ])

    const result = subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions: new Map(),
        targetSubscriptions,
      },
    })

    expect(connection.subscribe).toHaveBeenCalledWith('test.subject', undefined)
    expect(result.subscriptions.has('test.subject')).toBe(true)
  })

  it('should unsubscribe from subjects not in target', () => {
    const connection = createMockConnection()
    const mockSub = createMockSubscription('old.subject')
    const currentSubscriptions = new Map([['old.subject', mockSub]])

    const result = subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions,
        targetSubscriptions: new Map(),
      },
    })

    expect(mockSub.unsubscribe).toHaveBeenCalled()
    expect(result.subscriptions.has('old.subject')).toBe(false)
  })

  it('should keep existing subscriptions that are still in target', () => {
    const connection = createMockConnection()
    const existingSub = createMockSubscription('keep.subject')
    const callback = vi.fn()

    const currentSubscriptions = new Map([['keep.subject', existingSub]])
    const targetSubscriptions = new Map<string, SubjectSubscriptionConfig>([
      ['keep.subject', { subject: 'keep.subject', callback }],
    ])

    const result = subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions,
        targetSubscriptions,
      },
    })

    expect(connection.subscribe).not.toHaveBeenCalled()
    expect(existingSub.unsubscribe).not.toHaveBeenCalled()
    expect(result.subscriptions.get('keep.subject')).toBe(existingSub)
  })

  it('should handle subscribe errors gracefully', () => {
    const connection = createMockConnection()
    connection.subscribe.mockImplementation(() => {
      throw new Error('subscribe failed')
    })

    const callback = vi.fn()
    const targetSubscriptions = new Map<string, SubjectSubscriptionConfig>([
      ['fail.subject', { subject: 'fail.subject', callback }],
    ])

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions: new Map(),
        targetSubscriptions,
      },
    })
    consoleSpy.mockRestore()

    expect(result.subscriptions.has('fail.subject')).toBe(false)
  })

  it('should handle unsubscribe errors gracefully', () => {
    const connection = createMockConnection()
    const mockSub = {
      unsubscribe: vi.fn(() => {
        throw new Error('unsub failed')
      }),
    } as any

    const currentSubscriptions = new Map([['bad.subject', mockSub]])

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions,
        targetSubscriptions: new Map(),
      },
    })
    consoleSpy.mockRestore()

    expect(mockSub.unsubscribe).toHaveBeenCalled()
  })

  it('should invoke callback for each message in the async loop', async () => {
    const connection = createMockConnection()
    const messages = [
      { json: () => ({ id: 1 }), string: () => '{"id":1}' },
      { json: () => ({ id: 2 }), string: () => '{"id":2}' },
    ]
    let resolveIterator: () => void
    const iteratorDone = new Promise<void>(r => (resolveIterator = r))
    let msgIndex = 0

    const mockSub = {
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (msgIndex < messages.length) {
            return Promise.resolve({ value: messages[msgIndex++], done: false })
          }
          resolveIterator!()
          return new Promise(() => {}) // hang after messages delivered
        },
      }),
    } as any
    connection.subscribe.mockReturnValue(mockSub)

    const callback = vi.fn()
    const targetSubscriptions = new Map<string, SubjectSubscriptionConfig>([
      ['test.subject', { subject: 'test.subject', callback }],
    ])

    subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions: new Map(),
        targetSubscriptions,
      },
    })

    await iteratorDone
    // Allow microtasks to flush
    await new Promise(r => setTimeout(r, 10))
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenCalledWith({ id: 1 })
    expect(callback).toHaveBeenCalledWith({ id: 2 })
  })

  it('should handle callback errors in the message loop', async () => {
    const connection = createMockConnection()
    let resolveIterator: () => void
    const iteratorDone = new Promise<void>(r => (resolveIterator = r))
    let delivered = false

    const mockSub = {
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (!delivered) {
            delivered = true
            return Promise.resolve({
              value: { json: () => ({ id: 1 }), string: () => '{"id":1}' },
              done: false,
            })
          }
          resolveIterator!()
          return new Promise(() => {})
        },
      }),
    } as any
    connection.subscribe.mockReturnValue(mockSub)

    const callback = vi.fn(() => {
      throw new Error('callback error')
    })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions: new Map(),
        targetSubscriptions: new Map([['test.subject', { subject: 'test.subject', callback }]]),
      },
    })

    await iteratorDone
    await new Promise(r => setTimeout(r, 10))
    consoleSpy.mockRestore()

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should handle iterator errors in the message loop', async () => {
    const connection = createMockConnection()

    const mockSub = {
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('iterator broke')),
      }),
    } as any
    connection.subscribe.mockReturnValue(mockSub)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions: new Map(),
        targetSubscriptions: new Map([
          ['test.subject', { subject: 'test.subject', callback: vi.fn() }],
        ]),
      },
    })

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Iterator error'),
        expect.any(Error)
      )
    })
    consoleSpy.mockRestore()
  })

  it('should pass subscription opts to connection.subscribe', () => {
    const connection = createMockConnection()
    const mockSub = createMockSubscription('test.subject')
    connection.subscribe.mockReturnValue(mockSub)

    const opts = { max: 10 }
    const targetSubscriptions = new Map<string, SubjectSubscriptionConfig>([
      ['test.subject', { subject: 'test.subject', callback: vi.fn(), opts }],
    ])

    subjectConsolidateState({
      input: {
        connection,
        currentSubscriptions: new Map(),
        targetSubscriptions,
      },
    })

    expect(connection.subscribe).toHaveBeenCalledWith('test.subject', opts)
  })
})

describe('subjectRequest', () => {
  it('should throw when connection is null', () => {
    expect(() =>
      subjectRequest({
        input: {
          connection: null,
          subject: 'test',
          payload: {},
          callback: vi.fn(),
        },
      })
    ).toThrow('NATS connection is not available')
  })

  it('should call connection.request and invoke callback on success', async () => {
    const connection = createMockConnection()
    const mockMsg = { json: () => ({ result: 'ok' }), string: () => '{"result":"ok"}' }
    connection.request.mockResolvedValue(mockMsg)

    const callback = vi.fn()
    subjectRequest({
      input: {
        connection,
        subject: 'test.request',
        payload: { data: 1 },
        opts: { timeout: 5000 } as any,
        callback,
      },
    })

    // Wait for promise to resolve
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalled()
    })

    expect(connection.request).toHaveBeenCalledWith('test.request', { data: 1 }, { timeout: 5000 })
  })

  it('should handle request errors', async () => {
    const connection = createMockConnection()
    connection.request.mockRejectedValue(new Error('request failed'))

    const callback = vi.fn()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    subjectRequest({
      input: {
        connection,
        subject: 'test.fail',
        payload: {},
        callback,
      },
    })

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RequestReply error'), expect.any(Error))
    })

    consoleSpy.mockRestore()
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('subjectPublish', () => {
  it('should throw when connection is null', () => {
    expect(() =>
      subjectPublish({
        input: {
          connection: null,
          subject: 'test',
          payload: {},
        },
      })
    ).toThrow('NATS connection is not available')
  })

  it('should publish to connection', () => {
    const connection = createMockConnection()

    subjectPublish({
      input: {
        connection,
        subject: 'test.publish',
        payload: { msg: 'hello' },
      },
    })

    expect(connection.publish).toHaveBeenCalledWith('test.publish', { msg: 'hello' }, undefined)
  })

  it('should call onPublishResult with ok on success', () => {
    const connection = createMockConnection()
    const onPublishResult = vi.fn()

    subjectPublish({
      input: {
        connection,
        subject: 'test.publish',
        payload: 'data',
        onPublishResult,
      },
    })

    expect(onPublishResult).toHaveBeenCalledWith({ ok: true })
  })

  it('should pass publish options', () => {
    const connection = createMockConnection()
    const options = { headers: {} } as any

    subjectPublish({
      input: {
        connection,
        subject: 'test.publish',
        payload: 'data',
        options,
      },
    })

    expect(connection.publish).toHaveBeenCalledWith('test.publish', 'data', options)
  })

  it('should call onPublishResult with error on failure', () => {
    const connection = createMockConnection()
    const publishError = new Error('publish failed')
    connection.publish.mockImplementation(() => {
      throw publishError
    })
    const onPublishResult = vi.fn()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    subjectPublish({
      input: {
        connection,
        subject: 'test.fail',
        payload: 'data',
        onPublishResult,
      },
    })

    consoleSpy.mockRestore()
    expect(onPublishResult).toHaveBeenCalledWith({ ok: false, error: publishError })
  })

  it('should not throw when onPublishResult is not provided and publish succeeds', () => {
    const connection = createMockConnection()

    expect(() =>
      subjectPublish({
        input: {
          connection,
          subject: 'test.publish',
          payload: 'data',
        },
      })
    ).not.toThrow()
  })
})
