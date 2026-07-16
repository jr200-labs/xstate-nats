import { SpanStatusCode } from '@opentelemetry/api'
import { createActor, waitFor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupInMemoryTracer, type OtelTestHarness } from '../../test/otel-setup'
import * as telemetry from '../telemetry'
import { credentialMachine, getCredentials } from './credentials'

vi.mock('../telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry')>()
  return {
    ...actual,
    recordCredentialOperation: vi.fn(actual.recordCredentialOperation),
    recordCredentialState: vi.fn(actual.recordCredentialState),
  }
})

describe('credential telemetry', () => {
  let harness: OtelTestHarness

  beforeEach(() => {
    harness = setupInMemoryTracer()
    vi.mocked(telemetry.recordCredentialOperation).mockClear()
    vi.mocked(telemetry.recordCredentialState).mockClear()
  })

  afterEach(() => {
    harness.teardown()
    vi.restoreAllMocks()
  })

  it('records sanitized operation telemetry and diagnostics', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const secret = 'secret-token-value'
    const actor = createActor(credentialMachine, {
      input: {
        diagnostics: true,
        adapter: {
          load: async () => {
            throw new Error(`provider rejected ${secret}`)
          },
        },
      },
    }).start()

    await expect(getCredentials(actor)).rejects.toThrow(secret)
    await waitFor(actor, (snapshot) => snapshot.matches('failed'))

    expect(telemetry.recordCredentialOperation).toHaveBeenCalledWith(
      'load',
      'error',
      expect.any(Number),
    )
    expect(telemetry.recordCredentialState).toHaveBeenCalledWith('loading')
    expect(telemetry.recordCredentialState).toHaveBeenCalledWith('failed')
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret)

    const span = harness.exporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === 'xstate.nats.credentials.load')
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(
      JSON.stringify({ status: span?.status, attributes: span?.attributes, events: span?.events }),
    ).not.toContain(secret)
    actor.stop()
  })
})
