// Shared OpenTelemetry test harness.
//
// Each test registers an in-memory exporter so span emission can be asserted
// without a real backend. The global TracerProvider / Propagator are reset
// between tests to keep cases isolated.

import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'

export interface OtelTestHarness {
  exporter: InMemorySpanExporter
  provider: BasicTracerProvider
  /** Drop buffered spans without tearing down the provider. */
  reset: () => void
  /** Unregister provider + propagator. Call in afterEach. */
  teardown: () => void
}

// sdk-trace-base v2 removed `provider.register()`; wire up the global tracer
// provider, propagator, and context manager directly through the API package.
// Without the context manager, `startActiveSpan` would run the callback but
// never attach the span to `context.active()` — which breaks propagation.
export function setupInMemoryTracer(): OtelTestHarness {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
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
