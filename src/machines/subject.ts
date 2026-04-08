import { Subscription, PublishOptions, NatsConnection, RequestOptions } from '@nats-io/nats-core'
import { assign, sendParent, setup } from 'xstate'
import {
  SubjectSubscriptionConfig,
  subjectConsolidateState,
  subjectRequest,
  subjectPublish,
} from '../actions/subject'

// internal events and events from nats connection
type InternalEvents = { type: 'ERROR'; error: Error }

// events which can be sent to the machine from the user
export type ExternalEvents =
  | { type: 'SUBJECT.CONNECT'; connection: NatsConnection }
  | { type: 'SUBJECT.CONNECTED' }
  | { type: 'SUBJECT.DISCONNECTED' }
  | {
      type: 'SUBJECT.PUBLISH'
      subject: string
      payload: any
      opts?: PublishOptions
      onPublishResult?: (result: { ok: true } | { ok: false; error: Error }) => void
    }
  | {
      type: 'SUBJECT.REQUEST'
      subject: string
      payload: any
      opts?: RequestOptions
      callback: (data: any) => void
    }
  | { type: 'SUBJECT.SUBSCRIBE'; config: SubjectSubscriptionConfig }
  | { type: 'SUBJECT.UNSUBSCRIBE'; subject: string }
  | { type: 'SUBJECT.UNSUBSCRIBE_ALL' }

export type Events = InternalEvents | ExternalEvents

export interface Context {
  uid: string
  cachedConnection: NatsConnection | null
  subscriptions: Map<string, Subscription>
  subscriptionConfigs: Map<string, SubjectSubscriptionConfig>
  syncRequired: number
  error?: Error
}

export const subjectManagerLogic = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  guards: {
    hasPendingSync: ({ context }) => {
      return context.syncRequired > 0
    },
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAOlgFcAjAKzEwBcB9XCAGzAGIBlAVQCEAUgFEAwgBVGASQByksZICCAGUlchAbQAMAXUSgADgHtYuerkP49IAB6IATJs0kAnAFYAzAEY7rgDQgAT3tXTxJNAA53KOiYrwBfOP80LDxCUgoaOiYCU1x0VlwTfCgOa1h6dHowEnQAMyqAJ2RXRyIOZJwCYjIqWgZmfFz8woIoLV0kECMTMwsrWwQANk0AFhJPNy8ffyCEHzsSV0jY2M8EpIxOtJ7M-swLQgZIbn5hcUZePi4RACVJPg0Ois01yc0mC08jnCJAA7O4Vu4YX5AvYVjDDnZ4YjXOcQB1Ut0Mn0mPd8I8qhAXoJRBIeNJPt8-gDxsDjKDLODEEiDu5FjDPOEkTtEJ4Yc5cfiuulellGKTyc9Pm8JCIlEIFD8PvxGf9ARMDGzZhzQAs4a4SHY7ItXIttiiEN5oTjcfhDBA4FZJWlWTNzMabIgALSLYUIYMSy4E6W3bJsMA+9nzRArOyhy3QiInU4RlJSm7EgZDApFKAJo1JhArTzmzTV23I3bpsLHLNRM6JPGRvNE2XyrKQMt+iswpEkRaChv2eGHHNXQkyu4WWCGAoQSpgRjldeDsEmkWY0IrFYebyTvZomcdr3zmOMMANBqGBo7-0LFaLC0CoX26KHFuthIEiAA */
  initial: 'subject_idle',
  context: {
    uid: new Date().toISOString(),
    subscriptions: new Map<string, Subscription>(),
    subscriptionConfigs: new Map<string, SubjectSubscriptionConfig>(),
    cachedConnection: null,
    syncRequired: 0,
    error: undefined,
  },
  on: {
    'SUBJECT.SUBSCRIBE': {
      actions: [
        assign({
          subscriptionConfigs: ({ context, event }) => {
            const { config } = event
            const newConfigs = new Map(context.subscriptionConfigs)
            newConfigs.set(config.subject, config)
            return newConfigs
          },
          syncRequired: ({ context }) => context.syncRequired + 1,
        }),
      ],
    },
    'SUBJECT.UNSUBSCRIBE': {
      actions: [
        assign(({ context, event }) => {
          const newConfigs = new Map(context.subscriptionConfigs)
          newConfigs.delete(event.subject)
          return {
            subscriptionConfigs: newConfigs,
            syncRequired: context.syncRequired + 1,
          }
        }),
      ],
    },
    'SUBJECT.UNSUBSCRIBE_ALL': {
      actions: assign({
        subscriptionConfigs: new Map(),
        syncRequired: ({ context }) => context.syncRequired + 1,
      }),
    },
  },
  states: {
    subject_idle: {
      on: {
        'SUBJECT.CONNECT': {
          target: 'subject_check_sync',
          actions: [
            assign({
              cachedConnection: ({ event }) => event.connection,
            }),
          ],
        },
      },
    },
    subject_disconnecting: {
      target: 'subject_idle',
      entry: [
        // dont close the connection here, it will be closed by the nats connection machine
        assign({
          cachedConnection: null,
          subscriptions: new Map<string, Subscription>(),
        }),
        sendParent({ type: 'SUBJECT.DISCONNECTED' }),
      ],
    },
    subject_connected: {
      entry: [sendParent({ type: 'SUBJECT.CONNECTED' })],
      always: {
        target: 'subject_syncing',
        guard: 'hasPendingSync',
      },
      on: {
        'SUBJECT.REQUEST': {
          actions: assign(({ event, context }) => {
            subjectRequest({
              input: {
                connection: context.cachedConnection!,
                subject: event.subject,
                payload: event.payload,
                opts: event.opts,
                callback: event.callback,
              },
            })
            return {}
          }),
        },
        'SUBJECT.PUBLISH': {
          actions: [
            ({ context, event }) => {
              subjectPublish({
                input: {
                  connection: context.cachedConnection!,
                  subject: event.subject,
                  payload: event.payload,
                  options: event.opts,
                  onPublishResult: event.onPublishResult,
                },
              })
            },
          ],
        },
      },
    },
    subject_check_sync: {
      always: [
        {
          target: 'subject_syncing',
          guard: 'hasPendingSync',
        },
        {
          target: 'subject_connected',
        },
      ],
    },
    subject_syncing: {
      entry: [
        ({ context }) => {
          // either going to be 0 or 1 (if there were multiple syncs pending)
          context.syncRequired = Math.min(context.syncRequired - 1, 1)
        },
        assign(({ context }) => {
          const consolidatedContext = subjectConsolidateState({
            input: {
              connection: context.cachedConnection!,
              currentSubscriptions: context.subscriptions,
              targetSubscriptions: context.subscriptionConfigs,
            },
          })
          return {
            ...consolidatedContext,
          }
        }),
      ],
      always: {
        target: 'subject_connected',
      },
    },
    subject_error: {
      on: {
        'SUBJECT.CONNECT': {
          target: 'subject_check_sync',
        },
      },
    },
  },
})
