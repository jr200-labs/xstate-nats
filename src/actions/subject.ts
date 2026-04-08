import {
  Msg,
  NatsConnection,
  PublishOptions,
  RequestOptions,
  Subscription,
  SubscriptionOptions,
} from '@nats-io/nats-core'
import { parseNatsResult } from './connection'

export type SubjectSubscriptionConfig = {
  subject: string
  callback: (data: any) => void
  opts?: SubscriptionOptions
}

export const subjectConsolidateState = ({
  input,
}: {
  input: {
    connection: NatsConnection | null
    currentSubscriptions: Map<string, Subscription>
    targetSubscriptions: Map<string, SubjectSubscriptionConfig>
  }
}) => {
  const { connection, currentSubscriptions, targetSubscriptions } = input
  if (!connection) {
    throw new Error('NATS connection is not available')
  }

  const syncedSubscriptions = new Map(currentSubscriptions)

  // Unsubscribe from subjects that are in currentSubscriptions but not in targetSubscriptions
  for (const [subject, subscription] of currentSubscriptions) {
    if (!targetSubscriptions.has(subject)) {
      try {
        syncedSubscriptions.delete(subject)
        subscription.unsubscribe()
      } catch (error) {
        console.error(`Error unsubscribing from subject "${subject}"`, error)
      }
    }
  }

  // Subscribe to new subjects that are in targetSubscriptions but not in currentSubscriptions
  for (const [subject, subscriptionConfig] of targetSubscriptions) {
    if (!currentSubscriptions.has(subject)) {
      try {
        const sub = connection.subscribe(subject, subscriptionConfig.opts)

        // Set up the message handler
        ;(async () => {
          try {
            for await (const msg of sub) {
              try {
                subscriptionConfig?.callback(parseNatsResult(msg))
              } catch (callbackError) {
                console.error(`Callback error for subject "${subject}"`, callbackError)
              }
            }
          } catch (iteratorError) {
            console.error(`Iterator error for subject "${subject}"`, iteratorError)
          }
        })()

        syncedSubscriptions.set(subject, sub)
      } catch (error) {
        console.error(`Error subscribing to subject "${subject}"`, error)
      }
    }
  }

  return {
    subscriptions: syncedSubscriptions,
  }
}

export const subjectRequest = ({
  input,
}: {
  input: {
    connection: NatsConnection | null
    subject: string
    payload: any
    opts?: RequestOptions
    callback: (data: any) => void
  }
}) => {
  const { connection, subject, payload, opts, callback } = input
  if (!connection) {
    throw new Error('NATS connection is not available')
  }

  connection
    .request(subject, payload, opts)
    .then((msg: Msg) => {
      callback(parseNatsResult(msg))
    })
    .catch((err) => {
      console.error(`RequestReply error for subject "${subject}"`, err)
    })
}

export const subjectPublish = ({
  input,
}: {
  input: {
    connection: NatsConnection | null
    subject: string
    payload: any
    options?: PublishOptions
    onPublishResult?: (result: { ok: true } | { ok: false; error: Error }) => void
  }
}) => {
  const { connection, subject, payload, options, onPublishResult } = input
  if (!connection) {
    throw new Error('NATS connection is not available')
  }

  try {
    connection.publish(subject, payload, options)
    onPublishResult?.({ ok: true })
  } catch (callbackError) {
    console.error(`Publish callback error for subject "${subject}"`, callbackError)
    onPublishResult?.({ ok: false, error: callbackError as Error })
  }
}
