import { NatsConnection, QueuedIterator } from '@nats-io/nats-core'
import { Kvm, KvWatchEntry, KvWatchOptions } from '@nats-io/kv'
import { Pair } from '../utils'
import { fromPromise } from 'xstate'
import { recordError, withSpan } from '../telemetry'
import { byteLength } from '../traffic'
import { reconcileSubscriptionsAsync, SubscriptionSyncResult } from './subscriptions'

export class KvSubscriptionKey extends Pair<string, string> {}

export type KvSubscriptionConfig = {
  bucket: string
  key: string
  callback: (data: any) => void
  opts?: KvWatchOptions
  replayOnReconnect?: boolean
  onDownloadBytes?: (bytes: number) => void
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
  }): Promise<SubscriptionSyncResult<QueuedIterator<KvWatchEntry>>> => {
    if (!input.connection || !input.kvm) {
      throw new Error('NATS connection or KVM is not available')
    }

    const { currentState, targetState, kvm } = input
    return reconcileSubscriptionsAsync(currentState, targetState, {
      dispose: (subscription) => subscription.stop(),
      create: async (kvKey, config) => {
        const kv = await kvm.open(config.bucket)

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
                    let rawValue: string
                    try {
                      rawValue = e.string()
                      parsedValue = JSON.parse(rawValue)
                    } catch {
                      rawValue = e.string()
                      parsedValue = rawValue
                    }

                    try {
                      // KvWatchEntry does not expose the raw wire payload on this path; the
                      // UTF-8 byte length of string() is the measurable application payload.
                      config.onDownloadBytes?.(byteLength(rawValue))
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
        return watcher
      },
    })
  },
)
