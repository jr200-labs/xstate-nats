// Shared OpenTelemetry test harness.
//
// Each test registers an in-memory exporter so span emission can be asserted
// without a real backend. The global TracerProvider / Propagator are reset
// between tests to keep cases isolated.

import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'

export interface OtelTestHarness {
  exporter: InMemorySpanExporter
  provider: TracerProvider
  /** Drop buffered spans without tearing down the provider. */
  reset: () => void
  /** Unregister provider + propagator. Call in afterEach. */
  teardown: () => void
}

// sdk-trace v3 replaces sdk-trace-base and exports TracerProvider. Wire up
// the provider, propagator, and context manager directly through the API.
// Without the context manager, `startActiveSpan` would run the callback but
// never attach the span to `context.active()` — which breaks propagation.
export function setupInMemoryTracer(): OtelTestHarness {
  const exporter = new InMemorySpanExporter()
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  })
  const ctxMgr = new AsyncLocalStorageContextManager()
  ctxMgr.enable()
  context.setGlobalContextManager(ctxMgr)
  trace.setGlobalTracerProvider(provider)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  return {
    exporter,
    provider,
    reset: () => exporter.reset(),
    teardown: () => {
      trace.disable()
      propagation.disable()
      context.disable()
      ctxMgr.disable()
      void provider.shutdown()
    },
  }
}
