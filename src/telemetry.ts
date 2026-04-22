// OpenTelemetry helpers scoped to this package.
//
// `@opentelemetry/api` is declared as a peer dependency so the consumer
// controls the installed version. If the consumer never registers a
// TracerProvider / TextMapPropagator, every call here becomes a no-op.
//
// Design choices:
//   - Single module-level tracer, named and versioned from package.json.
//   - `withSpan` wraps the common try/catch/recordException/setStatus pattern
//     so call sites stay readable.
//   - `injectContextIntoHeaders` / `extractContextFromHeaders` bridge the
//     OTel propagation API onto NATS `MsgHdrs`. Outgoing messages carry the
//     active traceparent; incoming messages become the active context for
//     the per-message span so cross-process traces nest automatically.

import type { Context, Span, Tracer } from '@opentelemetry/api'
import { context as otelContext, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import type { MsgHdrs } from '@nats-io/nats-core'
import { headers as natsHeaders } from '@nats-io/nats-core'
import pkg from '../package.json' with { type: 'json' }

const TRACER_NAME = '@jr200-labs/xstate-nats'

// Do not cache — `trace.getTracer` already returns a lightweight ProxyTracer,
// and caching across global-provider swaps (e.g. test teardown / re-register)
// would pin the delegate to a retired provider and silently lose spans.
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, pkg.version)
}

// Truncate the stack trace before attaching it to a span event. Some backends
// (and the wire format itself) perform poorly with arbitrarily long strings;
// the first ~1KB is almost always enough to identify the site.
const MAX_STACK_LEN = 1024

function truncateStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined
  return err.stack.length > MAX_STACK_LEN
    ? err.stack.slice(0, MAX_STACK_LEN) + '...(truncated)'
    : err.stack
}

/**
 * Record an error on a span using the OTel canonical pattern:
 * recordException + ERROR status + a named event with the truncated stack.
 */
export function recordError(span: Span, errorEventName: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof Error) {
    span.recordException(err)
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message })
  const stack = truncateStack(err)
  span.addEvent(errorEventName, stack ? { stack } : undefined)
}

/**
 * Run `fn` inside an active span. On synchronous throw or async rejection the
 * error is recorded, the span status is set to ERROR, and the error is
 * re-thrown (callers keep their existing error-handling semantics).
 */
export function withSpan<T>(
  name: string,
  errorEventName: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => T | Promise<T>,
  parentContext?: Context,
): T | Promise<T> {
  const tracer = getTracer()
  const sanitized = sanitizeAttributes(attributes)
  const ctx = parentContext ?? otelContext.active()
  return tracer.startActiveSpan(name, { attributes: sanitized }, ctx, (span) => {
    try {
      const result = fn(span)
      if (result && typeof (result as Promise<T>).then === 'function') {
        return (result as Promise<T>).then(
          (value) => {
            span.end()
            return value
          },
          (err: unknown) => {
            recordError(span, errorEventName, err)
            span.end()
            throw err
          },
        ) as unknown as T
      }
      span.end()
      return result
    } catch (err) {
      recordError(span, errorEventName, err)
      span.end()
      throw err
    }
  })
}

// OTel attributes cannot be `undefined`; strip those so call sites can pass
// optional values without a pre-filter.
function sanitizeAttributes(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

// Carrier adapters: NATS `MsgHdrs` exposes `.set(k, v)`, `.get(k)`, `.keys()`
// which maps cleanly to the OTel TextMapSetter / TextMapGetter interface.
const natsHeaderSetter = {
  set: (carrier: MsgHdrs, key: string, value: string) => {
    carrier.set(key, value)
  },
}

const natsHeaderGetter = {
  get: (carrier: MsgHdrs | undefined, key: string): string | undefined => {
    const v = carrier?.get(key)
    return v || undefined
  },
  keys: (carrier: MsgHdrs | undefined): string[] => carrier?.keys() ?? [],
}

/**
 * Inject the active OTel context into a NATS headers object, creating one if
 * none was supplied. Returns the headers object so the caller can pass it to
 * `connection.publish` / `connection.request` via the `opts.headers` field.
 */
export function injectContextIntoHeaders(existing?: MsgHdrs): MsgHdrs {
  const hdrs = existing ?? natsHeaders()
  propagation.inject(otelContext.active(), hdrs, natsHeaderSetter)
  return hdrs
}

/**
 * Extract a parent OTel context from an incoming NATS message's headers. When
 * no traceparent is present the returned context is whatever was already
 * active — callers can use it as the parent for a new span without a branch.
 */
export function extractContextFromHeaders(hdrs: MsgHdrs | undefined): Context {
  if (!hdrs) return otelContext.active()
  return propagation.extract(otelContext.active(), hdrs, natsHeaderGetter)
}
