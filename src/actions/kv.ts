import { NatsConnection, QueuedIterator } from '@nats-io/nats-core'
import { Kvm, KvWatchEntry, KvWatchOptions } from '@nats-io/kv'
import { Pair } from '../utils'
import { fromPromise } from 'xstate'
import { recordError, withSpan } from '../telemetry'

export class KvSubscriptionKey extends Pair<string, string> {}

export type KvSubscriptionConfig = {
  bucket: string
  key: string
  callback: (data: any) => void
  opts?: KvWatchOptions
  replayOnReconnect?: boolean
}

export const kvConsolidateState = fromPromise(
  async ({
    input,
  }: {
    input: {
      kvm: Kvm | null
      connection: NatsConnection | null
      currentState: Map<string, QueuedIterator<KvWatchEntry>>
      targetState: Map<string, KvSubscriptionConfig>
    }
  }): Promise<{
    subscriptions: Map<string, QueuedIterator<KvWatchEntry>>
  }> => {
    if (!input.connection || !input.kvm) {
      throw new Error('NATS connection or KVM is not available')
    }

    const { currentState, targetState } = input
    const syncedState = new Map(currentState)

    // Unsubscribe from items that are in currentState but not in targetState
    for (const [kvKey, subscription] of currentState) {
      if (!targetState.has(kvKey)) {
        try {
          syncedState.delete(kvKey)
          subscription.stop()
        } catch (error) {
          console.error(`Error unsubscribing from subject "${kvKey}"`, error)
        }
      }
    }

    // Subscribe to new subjects that are in targetState but not in currentState
    for (const [kvKey, config] of targetState) {
      if (!currentState.has(kvKey)) {
        // the problem is kv key is triggered on successive calls to consolidateState
        // the match is not working?
        try {
          const kv = await input.kvm.open(config.bucket)

          const watchOptions = config as KvWatchOptions
          // Short span around the synchronous-ish watch() setup — the watcher
          // iterator itself is long-lived, so each received entry gets its
          // own span below rather than one indefinite parent.
          const watcher = (await withSpan(
            'xstate.nats.kv.watch',
            'xstate.nats.kv.error',
            { bucket: config.bucket, key: config.key },
            () => kv.watch(watchOptions),
          )) as QueuedIterator<KvWatchEntry>

          syncedState.set(kvKey, watcher)
          ;(async () => {
            try {
              for await (const e of watcher) {
                if (e.operation !== 'DEL') {
                  await withSpan(
                    'xstate.nats.kv.entry',
                    'xstate.nats.kv.error',
                    {
                      bucket: config.bucket,
                      key: config.key,
                      operation: e.operation,
                    },
                    (span) => {
                      let parsedValue
                      try {
                        parsedValue = JSON.parse(e.string())
                      } catch {
                        parsedValue = e.string()
                      }

                      try {
                        config.callback({
                          bucket: config.bucket,
                          key: config.key,
                          value: parsedValue,
                        })
                      } catch (callbackError) {
                        recordError(span, 'xstate.nats.kv.error', callbackError)
                        console.error(
                          `KV_SUBSCRIBE (connected): Callback error for ${kvKey}:`,
                          callbackError,
                        )
                      }
                    },
                  )
                }
              }
            } catch (error) {
              console.error(`KV_SUBSCRIBE (connected): Watcher loop error for ${kvKey}:`, error)
            }
          })()
        } catch (error) {
          console.error(`Error subscribing to subject "${kvKey}"`, error)
        }
      }
    }

    return {
      subscriptions: syncedState,
    }
  },
)
