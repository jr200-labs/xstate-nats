import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createActor, createMachine, assign, fromPromise, sendTo, setup } from 'xstate'
import { headers } from '@nats-io/nats-core'
import { subjectManagerLogic } from './subject'

vi.mock('@nats-io/nats-core', async () => {
  const actual = await vi.importActual<typeof import('@nats-io/nats-core')>('@nats-io/nats-core')
  return {
    ...actual,
    wsconnect: vi.fn(),
  }
})

function createMockConnection() {
  return {
    subscribe: vi.fn().mockReturnValue({
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
      }),
    }),
    request: vi
      .fn()
      .mockResolvedValue({ data: new Uint8Array([1, 2, 3]), json: () => ({}), string: () => '{}' }),
    publish: vi.fn(),
  } as any
}

// Create a parent machine that wraps the subject manager so sendParent works
function createParentMachine() {
  return setup({
    types: {
      context: {} as { childState: string },
      events: {} as any,
    },
    actors: {
      subject: subjectManagerLogic,
    },
  }).createMachine({
    initial: 'active',
    context: { childState: '' },
    invoke: {
      src: 'subject',
      id: 'subject',
    },
    on: {
      // Forward all events to the subject child
      'SUBJECT.*': {
        actions: sendTo('subject', ({ event, context }: any) => {
          return { ...event, connection: event.connection }
        }),
      },
      'SUBJECT.CONNECTED': {
        actions: assign({ childState: 'connected' }),
      },
      'SUBJECT.DISCONNECTED': {
        actions: [
          sendTo('subject', ({ event }: any) => {
            return { ...event }
          }),
          assign({ childState: 'disconnected' }),
        ],
      },
      'METRICS.*': {
        actions: sendTo('subject', ({ event }: any) => event),
      },
    },
    states: {
      active: {},
    },
  })
}

describe('subjectManagerLogic', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('should start in subject_idle state', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()
    const childSnap = parentActor.getSnapshot().children.subject?.getSnapshot()
    expect(childSnap?.value).toBe('subject_idle')
    parentActor.stop()
  })

  it('fails requests immediately while disconnected', () => {
    const parentActor = createActor(createParentMachine())
    const onRequestResult = vi.fn()
    parentActor.start()

    parentActor.send({
      type: 'SUBJECT.REQUEST',
      subject: 'test.req',
      payload: {},
      callback: vi.fn(),
      onRequestResult,
    })

    expect(onRequestResult).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ message: 'NATS connection is not available' }),
    })
    parentActor.stop()
  })

  it('should have empty subscriptions initially', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()
    const ctx = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx?.subscriptions.size).toBe(0)
    expect(ctx?.subscriptionConfigs.size).toBe(0)
    expect(ctx?.cachedConnection).toBeNull()
    expect(ctx?.syncRequired).toBe(0)
    parentActor.stop()
  })

  it('should transition to subject_connected on SUBJECT.CONNECT', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    const childSnap = parentActor.getSnapshot().children.subject?.getSnapshot()
    expect(childSnap?.value).toBe('subject_connected')
    expect(childSnap?.context.cachedConnection).toBe(connection)
    parentActor.stop()
  })

  it('should add subscription config on SUBJECT.SUBSCRIBE', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const callback = vi.fn()
    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'test.sub', callback },
    })

    const ctx = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx?.subscriptionConfigs.has('test.sub')).toBe(true)
    expect(ctx?.syncRequired).toBe(1)
    parentActor.stop()
  })

  it('should remove subscription config on SUBJECT.UNSUBSCRIBE', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'test.sub', callback: vi.fn() },
    })
    parentActor.send({ type: 'SUBJECT.UNSUBSCRIBE', subject: 'test.sub' })

    const ctx = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx?.subscriptionConfigs.has('test.sub')).toBe(false)
    expect(ctx?.syncRequired).toBe(2)
    parentActor.stop()
  })

  it('should clear all subscription configs on SUBJECT.UNSUBSCRIBE_ALL', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'test.sub1', callback: vi.fn() },
    })
    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'test.sub2', callback: vi.fn() },
    })
    parentActor.send({ type: 'SUBJECT.UNSUBSCRIBE_ALL' })

    const ctx = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx?.subscriptionConfigs.size).toBe(0)
    parentActor.stop()
  })

  it('should sync subscriptions when connecting with pending configs', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const callback = vi.fn()
    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'test.sub', callback },
    })

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    const childSnap = parentActor.getSnapshot().children.subject?.getSnapshot()
    expect(childSnap?.value).toBe('subject_connected')
    expect(connection.subscribe).toHaveBeenCalledWith('test.sub', undefined)
    parentActor.stop()
  })

  it('should resubscribe retained configs after disconnect and reconnect', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'test.sub', callback: vi.fn() },
    })

    const firstConnection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection: firstConnection })

    expect(firstConnection.subscribe).toHaveBeenCalledWith('test.sub', undefined)

    parentActor.send({ type: 'SUBJECT.DISCONNECTED' })
    const disconnectedCtx = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(disconnectedCtx?.subscriptionConfigs.has('test.sub')).toBe(true)
    expect(disconnectedCtx?.subscriptions.size).toBe(0)
    expect(disconnectedCtx?.syncRequired).toBe(1)

    const secondConnection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection: secondConnection })

    const childSnap = parentActor.getSnapshot().children.subject?.getSnapshot()
    expect(childSnap?.value).toBe('subject_connected')
    expect(secondConnection.subscribe).toHaveBeenCalledWith('test.sub', undefined)
    parentActor.stop()
  })

  it('should sync when new subscription added while connected', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'new.sub', callback: vi.fn() },
    })

    const childSnap = parentActor.getSnapshot().children.subject?.getSnapshot()
    expect(childSnap?.value).toBe('subject_connected')
    expect(connection.subscribe).toHaveBeenCalledWith('new.sub', undefined)
    parentActor.stop()
  })

  it('should handle SUBJECT.PUBLISH when connected', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    parentActor.send({
      type: 'SUBJECT.PUBLISH',
      subject: 'test.pub',
      payload: { msg: 'hello' },
    })

    expect(connection.publish).toHaveBeenCalledWith(
      'test.pub',
      { msg: 'hello' },
      expect.objectContaining({ headers: expect.anything() }),
    )
    parentActor.stop()
  })

  it('should count publish upload bytes', async () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({ type: 'SUBJECT.CONNECT', connection: createMockConnection() })
    parentActor.send({
      type: 'SUBJECT.PUBLISH',
      subject: 'test.pub',
      payload: { msg: 'hello' },
    })

    await vi.waitFor(() => {
      const metrics = parentActor.getSnapshot().children.subject?.getSnapshot()
        ?.context.trafficMetrics
      expect(metrics?.uploadBytes).toBe(15)
      expect(metrics?.bySource['nats.publish']).toEqual({ uploadBytes: 15, downloadBytes: 0 })
    })
    parentActor.stop()
  })

  it('should handle SUBJECT.REQUEST when connected', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    const callback = vi.fn()
    parentActor.send({
      type: 'SUBJECT.REQUEST',
      subject: 'test.req',
      payload: { data: 1 },
      callback,
    })

    expect(connection.request).toHaveBeenCalledWith(
      'test.req',
      { data: 1 },
      expect.objectContaining({ headers: expect.anything() }),
    )
    parentActor.stop()
  })

  it('gets request headers immediately before sending', async () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })
    const requestHeaders = vi.fn(async () => {
      const authHeaders = headers()
      authHeaders.set('authorization', 'Bearer refreshed-token')
      return authHeaders
    })
    const staleHeaders = headers()
    staleHeaders.set('authorization', 'Bearer stale-token')

    parentActor.send({
      type: 'SUBJECT.REQUEST',
      subject: 'test.req',
      payload: { data: 1 },
      opts: { headers: staleHeaders, timeout: 1000 },
      callback: vi.fn(),
      requestHeaders,
    })

    await vi.waitFor(() => {
      expect(connection.request).toHaveBeenCalledWith(
        'test.req',
        { data: 1 },
        expect.objectContaining({
          headers: expect.objectContaining({ get: expect.any(Function) }),
        }),
      )
    })
    expect(requestHeaders).toHaveBeenCalledOnce()
    expect(connection.request.mock.calls[0][2].headers.get('authorization')).toBe(
      'Bearer refreshed-token',
    )
    parentActor.stop()
  })

  it('should count request upload and reply download bytes', async () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({ type: 'SUBJECT.CONNECT', connection: createMockConnection() })
    parentActor.send({
      type: 'SUBJECT.REQUEST',
      subject: 'test.req',
      payload: { data: 1 },
      callback: vi.fn(),
    })

    await vi.waitFor(() => {
      const metrics = parentActor.getSnapshot().children.subject?.getSnapshot()
        ?.context.trafficMetrics
      expect(metrics?.uploadBytes).toBe(10)
      expect(metrics?.downloadBytes).toBe(3)
      expect(metrics?.bySource['nats.request']).toEqual({ uploadBytes: 10, downloadBytes: 3 })
    })
    parentActor.stop()
  })

  it('should reset upload and download metrics without disconnecting', async () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })
    parentActor.send({
      type: 'SUBJECT.REQUEST',
      subject: 'test.req',
      payload: { data: 1 },
      callback: vi.fn(),
    })

    await vi.waitFor(() => {
      const metrics = parentActor.getSnapshot().children.subject?.getSnapshot()
        ?.context.trafficMetrics
      expect(metrics?.downloadBytes).toBe(3)
    })

    parentActor.send({ type: 'METRICS.RESET_UPLOAD' })
    await vi.waitFor(() => {
      const snap = parentActor.getSnapshot().children.subject?.getSnapshot()
      expect(snap?.value).toBe('subject_connected')
      expect(snap?.context.cachedConnection).toBe(connection)
      expect(snap?.context.trafficMetrics.uploadBytes).toBe(0)
      expect(snap?.context.trafficMetrics.downloadBytes).toBe(3)
    })

    parentActor.send({ type: 'METRICS.RESET_DOWNLOAD' })
    await vi.waitFor(() => {
      const metrics = parentActor.getSnapshot().children.subject?.getSnapshot()
        ?.context.trafficMetrics
      expect(metrics?.uploadBytes).toBe(0)
      expect(metrics?.downloadBytes).toBe(0)
    })
    parentActor.stop()
  })

  it('should accept SUBJECT.SUBSCRIBE in idle state (global handler)', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'pre.connect', callback: vi.fn() },
    })

    const ctx = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx?.subscriptionConfigs.has('pre.connect')).toBe(true)
    parentActor.stop()
  })

  it('should notify parent of SUBJECT.CONNECTED', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    expect(parentActor.getSnapshot().context.childState).toBe('connected')
    parentActor.stop()
  })

  it('should handle multiple subscribe/unsubscribe cycles', () => {
    const parentActor = createActor(createParentMachine())
    parentActor.start()

    const connection = createMockConnection()
    parentActor.send({ type: 'SUBJECT.CONNECT', connection })

    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'sub1', callback: vi.fn() },
    })
    parentActor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'sub2', callback: vi.fn() },
    })

    const ctx1 = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx1?.subscriptionConfigs.size).toBe(2)

    parentActor.send({ type: 'SUBJECT.UNSUBSCRIBE', subject: 'sub1' })

    const ctx2 = parentActor.getSnapshot().children.subject?.getSnapshot()?.context
    expect(ctx2?.subscriptionConfigs.size).toBe(1)
    expect(ctx2?.subscriptionConfigs.has('sub2')).toBe(true)
    parentActor.stop()
  })
})
