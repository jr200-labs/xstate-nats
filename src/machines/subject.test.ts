import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createActor, createMachine, assign, fromPromise, sendTo, setup } from 'xstate'
import { subjectManagerLogic } from './subject'

vi.mock('@nats-io/nats-core', () => ({
  wsconnect: vi.fn(),
}))

function createMockConnection() {
  return {
    subscribe: vi.fn().mockReturnValue({
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
      }),
    }),
    request: vi.fn().mockResolvedValue({ json: () => ({}), string: () => '{}' }),
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
        actions: assign({ childState: 'disconnected' }),
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

    expect(connection.publish).toHaveBeenCalledWith('test.pub', { msg: 'hello' }, undefined)
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

    expect(connection.request).toHaveBeenCalledWith('test.req', { data: 1 }, undefined)
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
