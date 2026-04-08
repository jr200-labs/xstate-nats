import { NatsConnection, QueuedIterator } from '@nats-io/nats-core'
import { jetstream } from '@nats-io/jetstream'
import { KvEntry, Kvm, KvOptions, KvStatus, KvWatchEntry } from '@nats-io/kv'
import { assign, sendParent, setup } from 'xstate'
import { KvSubscriptionKey, KvSubscriptionConfig, kvConsolidateState } from '../actions/kv'

// internal events and events from nats connection
type InternalEvents = { type: 'ERROR'; error: Error }

// events which can be sent to the machine from the user
export type ExternalEvents =
  | { type: 'KV.CONNECT'; connection: NatsConnection }
  | { type: 'KV.CONNECTED' }
  | { type: 'KV.DISCONNECTED' }
  | {
      type: 'KV.BUCKET_LIST'
      bucket?: string
      onResult: (result: KvStatus[] | string[] | { error: Error }) => void
    }
  | {
      type: 'KV.BUCKET_CREATE'
      bucket: string
      onResult: (result: { ok: true } | { ok: false } | { error: Error }) => void
    }
  | {
      type: 'KV.BUCKET_DELETE'
      bucket: string
      onResult: (result: { ok: true } | { ok: false } | { error: Error }) => void
    }
  | {
      type: 'KV.GET'
      bucket: string
      key: string
      onResult: (result: KvEntry | null | { error: Error }) => void
    }
  | {
      type: 'KV.PUT'
      bucket: string
      key: string
      value: any
      onResult: (result: { ok: true } | { error: Error }) => void
    }
  | {
      type: 'KV.DELETE'
      bucket: string
      key: string
      onResult: (result: { ok: true } | { error: Error }) => void
    }
  | { type: 'KV.SUBSCRIBE'; config: KvSubscriptionConfig }
  | { type: 'KV.UNSUBSCRIBE'; bucket: string; key: string }
  | { type: 'KV.UNSUBSCRIBE_ALL' }

export type Events = InternalEvents | ExternalEvents

export interface Context {
  uid: string
  cachedConnection: NatsConnection | null
  cachedKvm: Kvm | null
  kvmOpts?: KvOptions
  subscriptions: Map<string, QueuedIterator<KvWatchEntry>>
  subscriptionConfigs: Map<string, KvSubscriptionConfig>
  syncRequired: number
  error?: Error
}
export const kvManagerLogic = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actors: {
    kvConsolidateState: kvConsolidateState,
  },
  guards: {
    hasPendingSync: ({ context }) => {
      return context.syncRequired > 0
    },
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAOlgFcAjAKzEwBcB9XCAGzAGIBlAVQCEAUgFEAwgBVGASQByksZICCAGUlchAbQAMAXUSgADgHtYuerkP49IAB6IATJs0kAnAFYAzAEY7rgDQgAT3tXTxJNAA53KOiYrwBfOP80LDxCUgoaOiYCU1x0VlwTfCgOa1h6dHowEnQAMyqAJ2RXRyIOZJwCYjIqWgZmfFz8woIoLV0kECMTMwsrWwQANk0AFhJPNy8ffyCEHzsSV0jY2M8EpIxOtJ7M-swLQgZIbn5hcUZePi4RACVJPg0Ois01yc0mC08jnCJAA7O4Vu4YX5AvYVjDDnZ4YjXOcQB1Ut0Mn0mPd8I8qhAXoJRBIeNJPt8-gDxsDjKDLODEEiDu5FjDPOEkTtEJ4Yc5cfiuulellGKTyc9Pm8JCIlEIFD8PvxGf9ARMDGzZhzQAs4a4SHY7ItXIttiiEN5oTjcfhDBA4FZJWlWTNzMabIgALSLYUIYMSy4E6W3bJsMA+9nzRArOyhy3QiInU4RlJSm7EgZDApFKAJo1JhArTzmzTV23I3bpsLHLNRM6JPGRvNE2XyrKQMt+iswpEkRaChv2eGHHNXQkyu4WWCGAoQSpgRjldeDsEmkWY0IrFYebyTvZomcdr3zmOMMANBqGBo7-0LFaLC0CoX26KHFuthIEiAA */
  initial: 'kv_idle',
  context: {
    uid: new Date().toISOString(),
    cachedConnection: null,
    cachedKvm: null,
    kvmOpts: undefined,
    subscriptions: new Map<string, QueuedIterator<KvWatchEntry>>(),
    subscriptionConfigs: new Map<string, KvSubscriptionConfig>(),
    syncRequired: 0,
  },
  on: {
    'KV.SUBSCRIBE': {
      actions: [
        assign({
          subscriptionConfigs: ({ context, event }) => {
            const { config } = event
            const newConfigs = new Map(context.subscriptionConfigs)
            const newKvKey = KvSubscriptionKey.key(config.bucket, config.key)
            newConfigs.set(newKvKey, config)
            return newConfigs
          },
          syncRequired: ({ context }) => context.syncRequired + 1,
        }),
      ],
    },
    'KV.UNSUBSCRIBE': {
      actions: assign(({ context, event }) => {
        const newConfigs = new Map(context.subscriptionConfigs)
        const newKvKey = KvSubscriptionKey.key(event.bucket, event.key)
        newConfigs.delete(newKvKey)
        return {
          subscriptionConfigs: newConfigs,
          syncRequired: context.syncRequired + 1,
        }
      }),
    },
    'KV.UNSUBSCRIBE_ALL': {
      actions: assign({
        subscriptionConfigs: new Map(),
        syncRequired: ({ context }) => context.syncRequired + 1,
      }),
    },
  },
  states: {
    kv_idle: {
      on: {
        'KV.CONNECT': {
          target: 'kv_check_sync',
          actions: [
            assign({
              cachedConnection: ({ event }) => event.connection,
              cachedKvm: ({ event }) => new Kvm(event.connection),
            }),
          ],
        },
      },
    },
    kv_disconnecting: {
      target: 'kv_idle',
      entry: [
        // dont close the connection here, it will be closed by the nats connection machine
        assign({
          cachedConnection: null,
          cachedKvm: null,
          subscriptions: new Map<string, QueuedIterator<KvWatchEntry>>(),
        }),
        sendParent({ type: 'KV.DISCONNECTED' }),
      ],
    },
    kv_connected: {
      entry: [sendParent({ type: 'KV.CONNECTED' })],
      always: {
        target: 'kv_syncing',
        guard: 'hasPendingSync',
      },
      on: {
        'KV.BUCKET_LIST': {
          actions: async ({ context, event }) => {
            try {
              if (!context.cachedKvm) {
                event.onResult({ error: new Error('KVM not initialized') })
                return
              }

              const results = []
              if (event.bucket) {
                const bucket = await context.cachedKvm.open(event.bucket)
                for await (const key of await bucket.keys()) {
                  results.push(key)
                }
                event.onResult(results)
              } else {
                for await (const status of await context.cachedKvm.list()) {
                  results.push(status)
                }
                event.onResult(results)
              }
            } catch (error) {
              event.onResult({ error: error as Error })
            }
          },
        },
        'KV.BUCKET_CREATE': {
          actions: async ({ context, event }) => {
            try {
              if (!context.cachedKvm) throw new Error('KVM not initialized')

              for await (const status of context.cachedKvm.list()) {
                if (status.bucket === event.bucket) {
                  event.onResult?.({ ok: false })
                  return
                }
              }

              await context.cachedKvm.create(event.bucket)
              event.onResult?.({ ok: true })
            } catch (error) {
              event.onResult?.({ error: error as Error })
            }
          },
        },
        'KV.BUCKET_DELETE': {
          actions: async ({ event }) => {
            try {
              try {
                // workaround: theres no delete bucket method on the kvm
                const connection = (event as any).connection as NatsConnection
                const js = jetstream(connection!)
                const jsm = await js.jetstreamManager()
                const res = await jsm.streams.delete(`KV_${event.bucket}`)
                event.onResult({ ok: res })
              } catch (streamError) {
                // Stream deletion might fail, but that's okay
                event.onResult({ ok: false })
              }
            } catch (error) {
              event.onResult({ error: error as Error })
            }
          },
        },
        'KV.GET': {
          actions: async ({ context, event }) => {
            try {
              const kv = await context.cachedKvm?.open(event.bucket)
              if (!kv) {
                event.onResult({ error: new Error(`Bucket '${event.bucket}' not found`) })
                return
              }
              const entry = await kv.get(event.key)
              event.onResult(entry)
            } catch (error) {
              event.onResult({ error: error as Error })
            }
          },
        },
        'KV.PUT': {
          actions: async ({ context, event }) => {
            try {
              const kv = await context.cachedKvm?.open(event.bucket)
              if (!kv) {
                event.onResult({ error: new Error(`Bucket '${event.bucket}' not found`) })
                return
              }

              await kv.put(event.key, event.value)
              event.onResult({ ok: true })
            } catch (error) {
              event.onResult({ error: error as Error })
            }
          },
        },
        'KV.DELETE': {
          actions: async ({ context, event }) => {
            try {
              const kv = await context.cachedKvm?.open(event.bucket)
              if (!kv) {
                event.onResult({ error: new Error(`Bucket '${event.bucket}' not found`) })
                return
              }
              await kv.delete(event.key)
              event.onResult({ ok: true })
            } catch (error) {
              event.onResult({ error: error as Error })
            }
          },
        },
      },
    },
    kv_check_sync: {
      always: [
        {
          target: 'kv_syncing',
          guard: 'hasPendingSync',
        },
        {
          target: 'kv_connected',
        },
      ],
    },
    kv_syncing: {
      entry: [
        ({ context }) => {
          // either going to be 0 or 1 (if there were multiple syncs pending)
          context.syncRequired = Math.min(context.syncRequired - 1, 1)
        },
      ],
      invoke: {
        id: 'single-instance-sync',
        src: 'kvConsolidateState',
        input: ({ context }: { context: Context }) => ({
          kvm: context.cachedKvm!,
          connection: context.cachedConnection!,
          currentState: context.subscriptions,
          targetState: context.subscriptionConfigs,
        }),
        onDone: {
          target: 'kv_connected',
          actions: [
            () => {
              // console.log('kvConsolidateState onDone')
            },
            assign(({ event }) => ({
              subscriptions: event.output.subscriptions,
            })),
          ],
        },
        onError: {
          target: 'kv_error',
          actions: [
            assign({
              error: ({ event }) => {
                console.error('kvConsolidateState onError', event.error)
                return event.error as Error
              },
            }),
          ],
        },
      },
    },
    kv_error: {
      on: {
        'KV.CONNECT': {
          target: 'kv_check_sync',
        },
      },
    },
  },
})
