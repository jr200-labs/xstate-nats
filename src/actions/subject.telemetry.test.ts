import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import { headers as natsHeaders } from '@nats-io/nats-core'
import { setupInMemoryTracer, type OtelTestHarness } from '../../test/otel-setup'
import { subjectConsolidateState, subjectPublish, subjectRequest } from './subject'
import type { SubjectSubscriptionConfig } from './subject'

vi.mock('./connection', () => ({
  parseNatsResult: vi.fn((msg: any) => {
    if (!msg) return null
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

describe('subject telemetry', () => {
  let harness: OtelTestHarness

  beforeEach(() => {
    harness = setupInMemoryTracer()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    harness.teardown()
    vi.restoreAllMocks()
  })

  it('emits xstate.nats.subscribe span when adding a subscription', () => {
    const connection = createMockConnection()
    connection.subscribe.mockReturnValue({
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    })

    const target = new Map<string, SubjectSubscriptionConfig>([
      ['t.sub', { subject: 't.sub', callback: vi.fn() }],
    ])

    subjectConsolidateState({
      input: { connection, currentSubscriptions: new Map(), targetSubscriptions: target },
    })

    const spans = harness.exporter.getFinishedSpans()
    const sub = spans.find((s) => s.name === 'xstate.nats.subscribe')
    expect(sub).toBeDefined()
    expect(sub!.attributes.subject).toBe('t.sub')
    expect(sub!.status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it('emits xstate.nats.publish span with payload bytes', () => {
    const connection = createMockConnection()
    subjectPublish({
      input: { connection, subject: 't.pub', payload: 'hello' },
    })

    const spans = harness.exporter.getFinishedSpans()
    const pub = spans.find((s) => s.name === 'xstate.nats.publish')
    expect(pub).toBeDefined()
    expect(pub!.attributes.subject).toBe('t.pub')
    expect(pub!.attributes['payload.bytes']).toBe(5)
  })

  it('injects traceparent into publish headers', () => {
    const connection = createMockConnection()
    subjectPublish({
      input: { connection, subject: 't.pub', payload: 'x' },
    })

    const call = connection.publish.mock.calls[0]
    const opts = call[2]
    expect(opts.headers).toBeDefined()
    // traceparent header is set by W3CTraceContextPropagator
    expect(opts.headers.get('traceparent')).toBeTruthy()
  })

  it('records error on publish span when connection.publish throws', () => {
    const connection = createMockConnection()
    connection.publish.mockImplementation(() => {
      throw new Error('boom')
    })

    subjectPublish({
      input: { connection, subject: 't.fail', payload: 'x' },
    })

    const spans = harness.exporter.getFinishedSpans()
    const pub = spans.find((s) => s.name === 'xstate.nats.publish')
    expect(pub).toBeDefined()
    expect(pub!.status.code).toBe(SpanStatusCode.ERROR)
    expect(pub!.events.some((e) => e.name === 'xstate.nats.error')).toBe(true)
  })

  it('emits xstate.nats.request span with request attrs', async () => {
    const connection = createMockConnection()
    connection.request.mockResolvedValue({
      json: () => ({ ok: true }),
      string: () => '{"ok":true}',
    })

    subjectRequest({
      input: {
        connection,
        subject: 't.req',
        payload: 'x',
        opts: { timeout: 2500 } as any,
        callback: vi.fn(),
      },
    })

    await vi.waitFor(() => {
      expect(
        harness.exporter.getFinishedSpans().some((s) => s.name === 'xstate.nats.request'),
      ).toBe(true)
    })

    const req = harness.exporter.getFinishedSpans().find((s) => s.name === 'xstate.nats.request')!
    expect(req.attributes.subject).toBe('t.req')
    expect(req.attributes['timeout.ms']).toBe(2500)
  })

  it('records error on request span when connection.request rejects', async () => {
    const connection = createMockConnection()
    connection.request.mockRejectedValue(new Error('nope'))

    subjectRequest({
      input: { connection, subject: 't.req', payload: 'x', callback: vi.fn() },
    })

    await vi.waitFor(() => {
      const req = harness.exporter.getFinishedSpans().find((s) => s.name === 'xstate.nats.request')
      expect(req?.status.code).toBe(SpanStatusCode.ERROR)
    })
  })

  it('parents per-message span on extracted traceparent', async () => {
    const connection = createMockConnection()
    // Craft a headers object containing a known traceparent so the extractor
    // has something to parent on.
    const incomingHdrs = natsHeaders()
    incomingHdrs.set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')

    let resolveIter: () => void
    const iterDone = new Promise<void>((r) => (resolveIter = r))
    let delivered = false
    connection.subscribe.mockReturnValue({
      unsubscribe: vi.fn(),
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (!delivered) {
            delivered = true
            return Promise.resolve({
              value: {
                headers: incomingHdrs,
                json: () => ({ hi: 1 }),
                string: () => '{"hi":1}',
                data: new Uint8Array([1, 2, 3]),
              },
              done: false,
            })
          }
          resolveIter!()
          return new Promise(() => {})
        },
      }),
    })

    const target = new Map<string, SubjectSubscriptionConfig>([
      ['t.msg', { subject: 't.msg', callback: vi.fn() }],
    ])
    subjectConsolidateState({
      input: { connection, currentSubscriptions: new Map(), targetSubscriptions: target },
    })

    await iterDone
    await vi.waitFor(() => {
      expect(
        harness.exporter.getFinishedSpans().some((s) => s.name === 'xstate.nats.message'),
      ).toBe(true)
    })

    const msgSpan = harness.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'xstate.nats.message')!
    expect(msgSpan.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(msgSpan.attributes.subject).toBe('t.msg')
  })
})
