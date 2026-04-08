import { ConnectionOptions, NatsConnection } from '@nats-io/nats-core'
import { assign, sendTo, setup } from 'xstate'
import { kvManagerLogic, ExternalEvents as KvExternalEvents } from './kv'
import { subjectManagerLogic, ExternalEvents as SubjectExternalEvents } from './subject'
import { connectToNats, disconnectNats } from '../actions/connection'
import { type AuthConfig } from '../actions/types'
import { InternalStatusEvents as NatsStatusEvents } from '../actions/connection'

export interface NatsConnectionConfig {
  opts: ConnectionOptions
  auth?: AuthConfig
  maxRetries: number
}

export interface Context {
  connection: NatsConnection | null
  error?: Error
  natsConfig?: NatsConnectionConfig
  retries: number
  subjectManagerReady: boolean
  kvManagerReady: boolean
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
  | SubjectExternalEvents
  | KvExternalEvents

type Events = InternalEvents | ExternalEvents

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
    }),
  },
  guards: {
    allManagersReady: ({ context }) => {
      const hasValidConnection = context.connection !== null
      const subjectReady = context.subjectManagerReady
      const kvReady = context.kvManagerReady
      return hasValidConnection && subjectReady && kvReady
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
  },
  invoke: [
    { src: 'subject', id: 'subject', systemId: 'subject' },
    { src: 'kv', id: 'kv' },
  ],
  on: {
    'NATS_CONNECTION.*': {
      actions: [
        ({ event }: { event: any }) => {
          console.log('root received NATS status event', event)
        },
      ],
    },
  },
  states: {
    not_configured: {
      on: {
        CONFIGURE: {
          target: 'configured',
          actions: [
            assign({
              natsConfig: ({ event }) => event.config,
            }),
          ],
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
      on: {
        CONNECT: {
          target: 'connecting',
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
      invoke: [
        {
          src: 'connectToNats',
          input: ({ context }) => ({
            opts: context.natsConfig!.opts,
            auth: context.natsConfig!.auth,
          }),
          onDone: {
            target: 'initialise_managers',
            actions: [
              assign({
                connection: ({ event }) => event.output,
                retries: (_) => 0,
              }),
            ],
          },
          onError: {
            target: 'error',
            actions: assign({
              error: ({ event }) => event.error as Error,
              retries: ({ context }) => context.retries + 1,
            }),
          },
        },
      ],
    },
    initialise_managers: {
      entry: [
        sendTo('subject', ({ context }) => ({
          type: 'SUBJECT.CONNECT',
          connection: context.connection!,
        })),
        sendTo('kv', ({ context }) => ({ type: 'KV.CONNECT', connection: context.connection! })),
      ],
      on: {
        'SUBJECT.CONNECTED': {
          actions: [assign({ subjectManagerReady: (_) => true })],
        },
        'KV.CONNECTED': {
          actions: [assign({ kvManagerReady: (_) => true })],
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
        (event) => {
          console.log('CONNECTED', event.context.connection?.getServer())
        },
      ],
      on: {
        DISCONNECT: {
          target: 'closing',
        },
        CLOSE: {
          target: 'closing',
        },
        'SUBJECT.*': {
          actions: [
            ({ event }: any) => {
              console.log('xstat-nats forwarding subject event', event)
            },
            sendTo(
              'subject',
              ({ event, context }: { event: SubjectExternalEvents; context: Context }) => {
                return { ...event, connection: context.connection }
              },
            ),
          ],
        },
        'KV.*': {
          actions: [
            ({ event }: any) => {
              console.log('xstat-nats forwarding kv event', event)
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
          console.log('CLOSING', event.context.connection?.getServer())
        },
        sendTo('subject', { type: 'SUBJECT.DISCONNECTED' }),
        sendTo('kv', { type: 'KV.DISCONNECTED' }),
      ],
      invoke: {
        src: 'disconnectNats',
        input: ({ context }) => ({ connection: context.connection }),
        onDone: {
          target: 'closed',
        },
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
    },
    closed: {
      on: {
        RESET: {
          target: 'not_configured',
          actions: ['doReset'],
        },
        CONNECT: {
          target: 'connecting',
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
      on: {
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
