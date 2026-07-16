import { deadline, MsgHdrs } from '@nats-io/nats-core'
import { ActorRefFrom, assign, fromPromise, setup } from 'xstate'
import { type AuthConfig } from '../actions/types'
import { recordCredentialOperation, recordCredentialState, withSpan } from '../telemetry'

export interface NatsCredentials {
  auth?: AuthConfig
  requestHeaders?: MsgHdrs
  /** Epoch milliseconds after which these credentials must not be used. Use the earliest expiry. */
  expiresAt?: number
}

export interface NatsCredentialAdapter {
  load: () => Promise<NatsCredentials>
  refresh?: (current: NatsCredentials) => Promise<NatsCredentials>
}

export interface NatsCredentialConfig {
  adapter: NatsCredentialAdapter
  /** Refresh this long before expiry. Defaults to 60 seconds. */
  refreshBeforeExpiryMs?: number
  /** Maximum duration of one adapter load or refresh. Defaults to 30 seconds. */
  operationTimeoutMs?: number
  /** Called when credentials expire or cannot be loaded/refreshed. */
  onUnavailable?: (error: Error) => void
  /** Emit sanitized credential lifecycle debug logs. */
  diagnostics?: boolean
}

type CredentialResult = { ok: true; credentials: NatsCredentials } | { ok: false; error: Error }

type Waiter = (result: CredentialResult) => void

export interface CredentialContext {
  config: NatsCredentialConfig
  current?: NatsCredentials
  waiters: Waiter[]
  error?: Error
}

type Events = { type: 'CREDENTIALS.GET'; reply: Waiter } | { type: 'CREDENTIALS.RELOAD' }

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function operationTimeout(config: NatsCredentialConfig): number {
  return config.operationTimeoutMs ?? 30_000
}

function refreshBeforeExpiry(config: NatsCredentialConfig): number {
  return config.refreshBeforeExpiryMs ?? 60_000
}

function credentialDiagnostic(
  config: NatsCredentialConfig,
  event: string,
  attributes: Record<string, string | number | boolean>,
): void {
  if (config.diagnostics) console.debug('xstate-nats credentials', { event, ...attributes })
}

async function runCredentialOperation<T>(
  config: NatsCredentialConfig,
  operation: 'load' | 'refresh',
  fn: () => Promise<T>,
): Promise<T> {
  const timeout = operationTimeout(config)
  const startedAt = performance.now()
  credentialDiagnostic(config, 'operation.start', { operation, timeout_ms: timeout })
  let originalError: unknown

  try {
    const result = await withSpan(
      `xstate.nats.credentials.${operation}`,
      'xstate.nats.credentials.error',
      { 'credentials.operation': operation, 'credentials.timeout.ms': timeout },
      async (span) => {
        try {
          const value = await deadline(Promise.resolve().then(fn), timeout)
          span.setAttribute('credentials.outcome', 'success')
          return value
        } catch (error) {
          originalError = error
          span.setAttribute('credentials.outcome', 'error')
          // Keep provider error messages, stacks, tokens, and claims out of traces.
          throw new Error(`NATS credential ${operation} failed`)
        }
      },
    )
    const durationMs = performance.now() - startedAt
    recordCredentialOperation(operation, 'success', durationMs)
    credentialDiagnostic(config, 'operation.finish', {
      operation,
      outcome: 'success',
      duration_ms: durationMs,
    })
    return result
  } catch {
    const durationMs = performance.now() - startedAt
    recordCredentialOperation(operation, 'error', durationMs)
    credentialDiagnostic(config, 'operation.finish', {
      operation,
      outcome: 'error',
      duration_ms: durationMs,
    })
    throw originalError ?? new Error(`NATS credential ${operation} failed`)
  }
}

function credentialStateEntry(state: Parameters<typeof recordCredentialState>[0]) {
  return ({ context }: { context: CredentialContext }) => {
    recordCredentialState(state)
    credentialDiagnostic(context.config, 'state.enter', {
      state,
      pending_waiters: context.waiters.length,
    })
  }
}

function notify(waiter: Waiter, result: CredentialResult): void {
  try {
    waiter(result)
  } catch (error) {
    console.error('NATS credential waiter failed', error)
  }
}

export const credentialMachine = setup({
  types: {
    context: {} as CredentialContext,
    events: {} as Events,
    input: {} as NatsCredentialConfig,
  },
  actors: {
    load: fromPromise(({ input }: { input: NatsCredentialConfig }) =>
      runCredentialOperation(input, 'load', input.adapter.load),
    ),
    refresh: fromPromise(
      ({ input }: { input: { config: NatsCredentialConfig; current: NatsCredentials } }) => {
        const refresh = input.config.adapter.refresh
        if (!refresh) throw new Error('NATS credentials cannot be refreshed')
        return runCredentialOperation(input.config, 'refresh', async () => {
          const credentials = await refresh(input.current)
          const expiresAt = credentials.expiresAt
          if (
            expiresAt !== undefined &&
            expiresAt - refreshBeforeExpiry(input.config) <= Date.now()
          ) {
            throw new Error('Refreshed NATS credentials are already expired or too close to expiry')
          }
          return credentials
        })
      },
    ),
  },
  delays: {
    credentialDeadline: ({ context }) => {
      const expiresAt = context.current?.expiresAt
      if (expiresAt === undefined) return 2_147_483_647
      const advance = context.config.adapter.refresh ? refreshBeforeExpiry(context.config) : 0
      return Math.max(0, expiresAt - advance - Date.now())
    },
  },
  guards: {
    canRefresh: ({ context }) => Boolean(context.current && context.config.adapter.refresh),
    hasExpiry: ({ context }) => context.current?.expiresAt !== undefined,
    shouldRefreshNow: ({ context }) => {
      const expiresAt = context.current?.expiresAt
      return Boolean(
        context.config.adapter.refresh &&
        expiresAt !== undefined &&
        expiresAt - refreshBeforeExpiry(context.config) <= Date.now(),
      )
    },
    isExpired: ({ context }) => {
      const expiresAt = context.current?.expiresAt
      return expiresAt !== undefined && expiresAt <= Date.now()
    },
    outputShouldRefresh: ({ context, event }) => {
      if (!('output' in event) || !context.config.adapter.refresh) return false
      const expiresAt = (event.output as NatsCredentials).expiresAt
      return (
        expiresAt !== undefined && expiresAt - refreshBeforeExpiry(context.config) <= Date.now()
      )
    },
    outputExpired: ({ event }) => {
      if (!('output' in event)) return false
      const expiresAt = (event.output as NatsCredentials).expiresAt
      return expiresAt !== undefined && expiresAt <= Date.now()
    },
  },
  actions: {
    queue: assign({
      waiters: ({ context, event }) =>
        event.type === 'CREDENTIALS.GET' ? [...context.waiters, event.reply] : context.waiters,
    }),
    replyReady: ({ context, event }) => {
      if (event.type === 'CREDENTIALS.GET' && context.current) {
        notify(event.reply, { ok: true, credentials: context.current })
      }
    },
    acceptCredentials: assign(({ context, event }) => {
      if (!('output' in event)) return {}
      const credentials = event.output as NatsCredentials
      context.waiters.forEach((waiter) => notify(waiter, { ok: true, credentials }))
      return { current: credentials, waiters: [], error: undefined }
    }),
    storeCredentials: assign(({ event }) =>
      'output' in event ? { current: event.output as NatsCredentials, error: undefined } : {},
    ),
    rejectWaiters: assign(({ context, event }) => {
      const error =
        'error' in event
          ? asError(event.error)
          : (context.error ?? new Error('NATS credentials are unavailable'))
      context.waiters.forEach((waiter) => notify(waiter, { ok: false, error }))
      return { waiters: [], error }
    }),
    markExpired: assign({
      error: (_) => new Error('NATS credentials expired'),
    }),
    notifyUnavailable: ({ context }) => {
      const error = context.error ?? new Error('NATS credentials are unavailable')
      try {
        context.config.onUnavailable?.(error)
      } catch (callbackError) {
        console.error('NATS credential unavailable callback failed', callbackError)
      }
    },
  },
}).createMachine({
  id: 'credentials',
  initial: 'loading',
  context: ({ input }) => ({ config: input, waiters: [] }),
  states: {
    loading: {
      entry: credentialStateEntry('loading'),
      on: {
        'CREDENTIALS.GET': { actions: 'queue' },
      },
      invoke: {
        src: 'load',
        input: ({ context }) => context.config,
        onDone: [
          { guard: 'outputShouldRefresh', target: 'refreshing', actions: 'storeCredentials' },
          { guard: 'outputExpired', target: 'expired', actions: 'storeCredentials' },
          { target: 'ready', actions: 'acceptCredentials' },
        ],
        onError: { target: 'failed', actions: 'rejectWaiters' },
      },
    },
    ready: {
      entry: credentialStateEntry('ready'),
      after: {
        credentialDeadline: [
          { guard: 'canRefresh', target: 'refreshing' },
          { guard: 'hasExpiry', target: 'expired' },
        ],
      },
      on: {
        'CREDENTIALS.GET': [
          { guard: 'shouldRefreshNow', target: 'refreshing', actions: 'queue' },
          { guard: 'isExpired', target: 'expired', actions: 'queue' },
          { actions: 'replyReady' },
        ],
        'CREDENTIALS.RELOAD': { target: 'loading' },
      },
    },
    refreshing: {
      entry: credentialStateEntry('refreshing'),
      on: {
        'CREDENTIALS.GET': { actions: 'queue' },
      },
      invoke: {
        src: 'refresh',
        input: ({ context }) => ({ config: context.config, current: context.current! }),
        onDone: { target: 'ready', actions: 'acceptCredentials' },
        onError: { target: 'failed', actions: 'rejectWaiters' },
      },
    },
    expired: {
      entry: [credentialStateEntry('expired'), 'markExpired', 'rejectWaiters', 'notifyUnavailable'],
      on: {
        'CREDENTIALS.GET': {
          actions: ({ event }) =>
            notify(event.reply, { ok: false, error: new Error('NATS credentials expired') }),
        },
        'CREDENTIALS.RELOAD': { target: 'loading' },
      },
    },
    failed: {
      entry: [credentialStateEntry('failed'), 'notifyUnavailable'],
      on: {
        'CREDENTIALS.GET': {
          actions: ({ context, event }) =>
            notify(event.reply, {
              ok: false,
              error: context.error ?? new Error('NATS credentials are unavailable'),
            }),
        },
        'CREDENTIALS.RELOAD': { target: 'loading' },
      },
    },
  },
})

export type CredentialActor = ActorRefFrom<typeof credentialMachine>

export function getCredentials(actor: CredentialActor): Promise<NatsCredentials> {
  if (actor.getSnapshot().status === 'stopped') {
    return Promise.reject(new Error('NATS credential actor is stopped'))
  }
  return new Promise((resolve, reject) => {
    actor.send({
      type: 'CREDENTIALS.GET',
      reply: (result) => (result.ok ? resolve(result.credentials) : reject(result.error)),
    })
  })
}
