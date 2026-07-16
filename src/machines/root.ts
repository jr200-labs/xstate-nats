import { ConnectionOptions, MsgHdrs, NatsConnection } from '@nats-io/nats-core'
import { assign, sendTo, setup } from 'xstate'
import { kvManagerLogic, ExternalEvents as KvExternalEvents } from './kv'
import { subjectManagerLogic, ExternalEvents as SubjectExternalEvents } from './subject'
import { connectToNats, disconnectNats } from '../actions/connection'
import { type AuthConfig } from '../actions/types'
import { InternalStatusEvents as NatsStatusEvents } from '../actions/connection'
import { withSpan } from '../telemetry'
import { NatsTrafficResetEvent } from '../traffic'

export interface NatsDiagnosticsConfig {
  lifecycle?: boolean
}

export interface NatsConnectionConfig {
  opts: ConnectionOptions
  auth?: AuthConfig
  requestHeaders?: () => Promise<MsgHdrs | undefined>
  maxRetries: number
  diagnostics?: NatsDiagnosticsConfig
}

export interface Context {
  connection: NatsConnection | null
  error?: Error
  natsConfig?: NatsConnectionConfig
  retries: number
  subjectManagerReady: boolean
  kvManagerReady: boolean
  configureAfterClose: boolean
  connectAfterClose: boolean
}

// internal events and events from nats connection
type InternalEvents =
  | { type: 'CONNECTED'; connection: NatsConnection }
  | { type: 'DISCONNECTED' }
  | { type: 'FAIL'; error: Error }
  | { type: 'RECONNECT' }
  | { type: 'CLOSE' }
  | NatsStatusEvents

// events which can be sent to the machine from the user
export type ExternalEvents =
  | { type: 'CONFIGURE'; config: NatsConnectionConfig }
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'RESET' }
  | NatsTrafficResetEvent
  | SubjectExternalEvents
  | KvExternalEvents

type Events = InternalEvents | ExternalEvents

function lifecycleDiagnosticsEnabled(context: Context): boolean {
  return Boolean(context.natsConfig?.diagnostics?.lifecycle)
}

function serverUrls(config: NatsConnectionConfig | undefined): string | undefined {
  const servers = config?.opts.servers
  return Array.isArray(servers) ? servers.join(',') : servers
}

function lifecycleAttributes(
  context: Context,
  event: { type: string },
  state: string,
): Record<string, string | number | boolean | undefined> {
  return {
    'xstate.state': state,
    'xstate.event': event.type,
    'nats.server.urls': serverUrls(context.natsConfig),
    'nats.debug': Boolean(context.natsConfig?.opts.debug),
    'nats.verbose': Boolean(context.natsConfig?.opts.verbose),
    'nats.max_retries': context.natsConfig?.maxRetries,
    'nats.auth.type': context.natsConfig?.auth?.type,
    'nats.has_connection': context.connection !== null,
    'nats.subject_manager_ready': context.subjectManagerReady,
    'nats.kv_manager_ready': context.kvManagerReady,
    'nats.configure_after_close': context.configureAfterClose,
    'nats.connect_after_close': context.connectAfterClose,
  }
}

function recordLifecycle(context: Context, event: { type: string }, state: string): void {
  if (!lifecycleDiagnosticsEnabled(context)) return

  const attributes = lifecycleAttributes(context, event, state)
  console.debug('xstate-nats lifecycle', attributes)
  withSpan('xstate.nats.lifecycle', 'xstate.nats.error', attributes, (span) => {
    span.addEvent(`xstate.nats.${state}.${event.type}`, attributes)
  })
}

function lifecycleAction(state: string) {
  return ({ context, event }: { context: Context; event: { type: string } }) => {
    recordLifecycle(context, event, state)
  }
}

export const natsMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actions: {
    doReset: assign({
      natsConfig: (_) => undefined,
      connection: (_) => null,
      error: (_) => undefined,
      retries: (_) => 0,
      subjectManagerReady: (_) => false,
      kvManagerReady: (_) => false,
      configureAfterClose: (_) => false,
      connectAfterClose: (_) => false,
    }),
    configureNats: assign({
      natsConfig: ({ event }) => {
        if (event.type !== 'CONFIGURE') {
          return undefined
        }
        return event.config
      },
      connection: (_) => null,
      error: (_) => undefined,
      retries: (_) => 0,
      subjectManagerReady: (_) => false,
      kvManagerReady: (_) => false,
      configureAfterClose: (_) => false,
      connectAfterClose: (_) => false,
    }),
    configureNatsAfterClose: assign({
      natsConfig: ({ event }) => {
        if (event.type !== 'CONFIGURE') {
          return undefined
        }
        return event.config
      },
      error: (_) => undefined,
      retries: (_) => 0,
      subjectManagerReady: (_) => false,
      kvManagerReady: (_) => false,
      configureAfterClose: (_) => true,
    }),
    reconnectAfterClose: assign({
      connectAfterClose: (_) => true,
    }),
    clearDeferredCloseActions: assign({
      configureAfterClose: (_) => false,
      connectAfterClose: (_) => false,
    }),
  },
  guards: {
    allManagersReady: ({ context }) => {
      const hasValidConnection = context.connection !== null
      const subjectReady = context.subjectManagerReady
      const kvReady = context.kvManagerReady
      return hasValidConnection && subjectReady && kvReady
    },
    shouldConnectAfterClose: ({ context }) => {
      return context.connectAfterClose && context.natsConfig !== undefined
    },
    shouldConfigureAfterClose: ({ context }) => {
      return context.configureAfterClose && context.natsConfig !== undefined
    },
  },
  actors: {
    connectToNats: connectToNats,
    disconnectNats: disconnectNats,
    subject: subjectManagerLogic,
    kv: kvManagerLogic,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAOnwHsAXAfU3PwDNcoBXAJ0gGIBhAeQDkAYgEkA4gFUASgFEA2gAYAuolAAHcrFyVc9FSAAeiABwBOeSQBsAdgCMRgMwAmRxftWALPYCsAGhABPRHd3c3cvext7IwsveRCrAF8EvzQsPEJSOkZmdi4+fn5pbgAVBWUkEHVNbV0KwwQbGw9LJysLExNHSPkjP0CEdzaSMwsXaPt5LxMbeQsklIwcAmISLMJMbXwoTgh6MBICADdyAGt91KWM1fp1zagEI-JMdBr8MrK9Kq0dfD16m3CVhIUUcVis8isJjCjlmfUQ4XcLUcRiakXcJicc2SIAu6RWazAGwI2zAbDY5DYJFUABsXgwKagSLjlpkboS7g98Mdnq93kpPhpvrVQP9AcCjKDwZDobCAkF3DYSE0TNZ2p1ptF3PMcYs8az8Lc8gAZXgAZTk-IqX1ef0QNlGQK60TMEUGVi8NjhCFciJmGIxRmlYJs2uZV0w1MFWx2ewOXNO511LNWkc0W053JePz55TUgptdUQyK8JDiFiMXhC8hco3k9i9mJIVk17Rs03LYPsoaT4dTxM4pPJlJpdIZTJ7+L76cePOzSg+VvzP1tCGLpfc5cr8mrFlr9blDUrJFi2-kKs6NlB3bSyYjGi4MnNpUteeqy8LCCm9mB3kDtjBPRhA21bAme7bupukzXpcKyDhSnCPtIz65pUS7CgYdoWI0x4RG2IRNJ4jjuF6jgqk2LheJCbQRPYWrahQEBwHoYbEAKb7ofUAC0Fhetx0F6mQVC0PQTCsBwEBsUKvwflYXTkTE9qdq49gmA2jgls2FgbhuowmB4-G3iJOTiZJBYinacSKtYKoWHW7pGIGPEHm6JAhKMXikXYNieHRCw3uGbJElspnvuZDQRI4JAokRHkqjCG69M54TDLMXT2CpERmIk2IsfqhoSYu7HSWFTQqcMTrpVhKkool-SVhYx4uKlMylXYBm9lGUAhRxQSOF69omEq8gAruESTB5kTtZO94Fa+UkruiiqpdCHSOLhTn9E4GktjppH6TlE6kHBbDdcVGENFYZUXg49hVSYNVqeYMIRW07TqR42VJEAA */
  initial: 'not_configured',
  context: {
    connection: null,
    error: undefined,
    natsConfig: undefined,
    retries: 0,
    subjectManagerReady: false,
    kvManagerReady: false,
    configureAfterClose: false,
    connectAfterClose: false,
  },
  invoke: [
    { src: 'subject', id: 'subject', systemId: 'subject' },
    { src: 'kv', id: 'kv' },
  ],
    on: {
      'NATS_CONNECTION.CLOSE': {
        target: '.closed',
        actions: [
          assign({
            connection: (_) => null,
            subjectManagerReady: (_) => false,
            kvManagerReady: (_) => false,
          }),
          lifecycleAction('closed'),
        ],
      },
      'NATS_CONNECTION.*': {
      actions: [
        ({ context, event }: { context: Context; event: any }) => {
          recordLifecycle(context, event, 'status')
          if (context.natsConfig?.opts.debug) {
            console.log('root received NATS status event', event)
          }
        },
      ],
    },
    'METRICS.RESET_UPLOAD': {
      actions: [sendTo('subject', ({ event }) => event), sendTo('kv', ({ event }) => event)],
    },
    'METRICS.RESET_DOWNLOAD': {
      actions: [sendTo('subject', ({ event }) => event), sendTo('kv', ({ event }) => event)],
    },
    'METRICS.RESET_ALL': {
      actions: [sendTo('subject', ({ event }) => event), sendTo('kv', ({ event }) => event)],
    },
  },
  states: {
    not_configured: {
      on: {
        CONFIGURE: {
          target: 'configured',
          actions: ['configureNats'],
          '*': {
            actions: [
              ({ event }: { event: any }) => {
                console.error('root not_configured received unexpected event', event)
              },
            ],
          },
        },
      },
    },
    configured: {
      entry: ['clearDeferredCloseActions'],
      on: {
        CONFIGURE: {
          actions: ['configureNats', lifecycleAction('configured')],
        },
        CONNECT: {
          target: 'connecting',
          actions: lifecycleAction('configured'),
        },
        RESET: {
          target: 'not_configured',
          actions: ['doReset'],
        },
        '*': {
          actions: [
            ({ event }: { event: any }) => {
              console.error('root configured received unexpected event', event)
            },
          ],
        },
      },
    },
    connecting: {
      entry: ['clearDeferredCloseActions', lifecycleAction('connecting')],
      on: {
        CONFIGURE: {
          target: 'connecting',
          reenter: true,
          actions: ['configureNats', lifecycleAction('connecting')],
        },
        CONNECT: {
          actions: lifecycleAction('connecting'),
        },
      },
      invoke: [
        {
          src: 'connectToNats',
          input: ({ context, self }) => ({
            opts: context.natsConfig!.opts,
            auth: context.natsConfig!.auth,
            onStatus: (event: NatsStatusEvents) => self.send(event),
          }),
          onDone: {
            target: 'initialise_managers',
            actions: [
              lifecycleAction('connecting'),
              assign({
                connection: ({ event }) => event.output,
                retries: (_) => 0,
              }),
            ],
          },
          onError: {
            target: 'error',
            actions: [
              lifecycleAction('connecting'),
              assign({
                error: ({ event }) => event.error as Error,
                retries: ({ context }) => context.retries + 1,
              }),
            ],
          },
        },
      ],
    },
    initialise_managers: {
      entry: [
        lifecycleAction('initialise_managers'),
        sendTo('subject', ({ context }) => ({
          type: 'SUBJECT.CONNECT',
          connection: context.connection!,
        })),
        sendTo('kv', ({ context }) => ({ type: 'KV.CONNECT', connection: context.connection! })),
      ],
      on: {
        CONFIGURE: {
          target: 'closing',
          actions: [
            'configureNatsAfterClose',
            'reconnectAfterClose',
            lifecycleAction('initialise_managers'),
          ],
        },
        CONNECT: {
          actions: lifecycleAction('initialise_managers'),
        },
        DISCONNECT: {
          target: 'closing',
          actions: ['clearDeferredCloseActions', lifecycleAction('initialise_managers')],
        },
        CLOSE: {
          target: 'closing',
          actions: ['clearDeferredCloseActions', lifecycleAction('initialise_managers')],
        },
        'SUBJECT.CONNECTED': {
          actions: [
            assign({ subjectManagerReady: (_) => true }),
            lifecycleAction('initialise_managers'),
          ],
        },
        'KV.CONNECTED': {
          actions: [
            assign({ kvManagerReady: (_) => true }),
            lifecycleAction('initialise_managers'),
          ],
        },
      },
      always: [
        {
          guard: 'allManagersReady',
          target: 'connected',
        },
      ],
    },
    connected: {
      entry: [
        'clearDeferredCloseActions',
        lifecycleAction('connected'),
        (event) => {
          if (event.context.natsConfig?.opts.debug) {
            console.log('CONNECTED', event.context.connection?.getServer())
          }
        },
      ],
      on: {
        'NATS_CONNECTION.CLOSE': {
          target: 'closed',
          actions: [
            assign({
              connection: (_) => null,
              subjectManagerReady: (_) => false,
              kvManagerReady: (_) => false,
            }),
            lifecycleAction('closed'),
          ],
        },
        CONFIGURE: {
          target: 'closing',
          actions: ['configureNatsAfterClose', 'reconnectAfterClose', lifecycleAction('connected')],
        },
        DISCONNECT: {
          target: 'closing',
          actions: ['clearDeferredCloseActions', lifecycleAction('connected')],
        },
        CLOSE: {
          target: 'closing',
          actions: ['clearDeferredCloseActions', lifecycleAction('connected')],
        },
        'SUBJECT.*': {
          actions: [
            ({ context, event }: { context: Context; event: any }) => {
              if (context.natsConfig?.opts.debug) {
                console.log('xstate-nats forwarding subject event', event)
              }
            },
            sendTo(
              'subject',
              ({ event, context }: { event: SubjectExternalEvents; context: Context }) => {
                return {
                  ...event,
                  connection: context.connection,
                  requestHeaders: context.natsConfig?.requestHeaders,
                }
              },
            ),
          ],
        },
        'KV.*': {
          actions: [
            ({ context, event }: { context: Context; event: any }) => {
              if (context.natsConfig?.opts.debug) {
                console.log('xstate-nats forwarding kv event', event)
              }
            },
            sendTo('kv', ({ event, context }: { event: KvExternalEvents; context: Context }) => {
              return { ...event, connection: context.connection }
            }),
          ],
        },
        '*': {
          actions: [
            ({ event }: { event: any }) => {
              console.error('root connected received unexpected event', event)
            },
          ],
        },
      },
    },
    closing: {
      entry: [
        (event) => {
          if (event.context.natsConfig?.opts.debug) {
            console.log('CLOSING', event.context.connection?.getServer())
          }
        },
        lifecycleAction('closing'),
        sendTo('subject', { type: 'SUBJECT.DISCONNECTED' }),
        sendTo('kv', { type: 'KV.DISCONNECTED' }),
      ],
      invoke: {
        src: 'disconnectNats',
        input: ({ context }) => ({ connection: context.connection }),
        onDone: [
          {
            guard: 'shouldConnectAfterClose',
            target: 'connecting',
            actions: lifecycleAction('closing'),
          },
          {
            guard: 'shouldConfigureAfterClose',
            target: 'configured',
            actions: lifecycleAction('closing'),
          },
          {
            target: 'closed',
            actions: lifecycleAction('closing'),
          },
        ],
        onError: {
          target: 'error',
          actions: [
            lifecycleAction('closing'),
            assign({
              error: ({ event }) => event.error as Error,
            }),
          ],
        },
      },
      on: {
        'NATS_CONNECTION.*': {
          actions: lifecycleAction('closing'),
        },
        CONFIGURE: {
          actions: ['configureNatsAfterClose', lifecycleAction('closing')],
        },
        CONNECT: {
          actions: ['reconnectAfterClose', lifecycleAction('closing')],
        },
      },
    },
    closed: {
      entry: [
        lifecycleAction('closed'),
        sendTo('subject', { type: 'SUBJECT.DISCONNECTED' }),
        sendTo('kv', { type: 'KV.DISCONNECTED' }),
        assign({
          connection: (_) => null,
          subjectManagerReady: (_) => false,
          kvManagerReady: (_) => false,
          configureAfterClose: (_) => false,
          connectAfterClose: (_) => false,
        }),
      ],
      on: {
        CONFIGURE: {
          target: 'configured',
          actions: ['configureNats', lifecycleAction('closed')],
        },
        RESET: {
          target: 'not_configured',
          actions: ['doReset'],
        },
        CONNECT: {
          target: 'connecting',
          actions: lifecycleAction('closed'),
        },
      },
      '*': {
        actions: [
          ({ event }: { event: any }) => {
            console.error('root closing received unexpected event', event)
          },
        ],
      },
    },
    error: {
      entry: ['clearDeferredCloseActions', lifecycleAction('error')],
      on: {
        CONNECT: {
          target: 'connecting',
          actions: lifecycleAction('error'),
        },
        CONFIGURE: {
          target: 'configured',
          actions: ['configureNats', lifecycleAction('error')],
        },
        RESET: {
          target: 'not_configured',
          actions: ['doReset'],
        },
      },
      '*': {
        actions: [
          ({ event }: { event: any }) => {
            console.error('root error received unexpected event', event)
          },
        ],
      },
    },
  },
})
