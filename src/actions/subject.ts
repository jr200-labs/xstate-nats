import {
  deadline,
  Msg,
  MsgHdrs,
  NatsConnection,
  PublishOptions,
  RequestOptions,
  Subscription,
  SubscriptionOptions,
  TimeoutError,
} from '@nats-io/nats-core'
import { parseNatsResult } from './connection'
import {
  extractContextFromHeaders,
  injectContextIntoHeaders,
  recordError,
  withSpan,
} from '../telemetry'
import { byteLength } from '../traffic'

export type SubjectSubscriptionConfig = {
  subject: string
  callback: (data: any) => void
  opts?: SubscriptionOptions
  onDownloadBytes?: (bytes: number) => void
}

export type RequestResult = { ok: true } | { ok: false; error: Error }

function notifyRequestResult(
  callback: ((result: RequestResult) => void) | undefined,
  result: RequestResult,
) {
  try {
    callback?.(result)
  } catch (error) {
    console.error('NATS request result callback failed', error)
  }
}

export function rejectUnavailableRequest(event: {
  onRequestResult?: (result: RequestResult) => void
}) {
  const error = new Error('NATS connection is not available')
  notifyRequestResult(event.onRequestResult, { ok: false, error })
  if (!event.onRequestResult) console.error(error.message)
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
        // Short span around the synchronous subscribe() call. The iterator
        // below is long-lived; we don't span its whole lifetime (indefinite
        // spans are anti-pattern in most tracing backends).
        const sub = withSpan('xstate.nats.subscribe', 'xstate.nats.error', { subject }, () =>
          connection.subscribe(subject, subscriptionConfig.opts),
        ) as Subscription

        // Message loop: each received message starts its own span, parented
        // on the traceparent extracted from the message headers (OTel
        // messaging semconv). If the publisher did not propagate context the
        // extracted context falls back to the ambient one, so the span
        // simply becomes a root.
        ;(async () => {
          try {
            for await (const msg of sub) {
              const parentCtx = extractContextFromHeaders((msg as Msg).headers)
              const payloadBytes = (msg as Msg).data?.length ?? 0
              await withSpan(
                'xstate.nats.message',
                'xstate.nats.error',
                {
                  subject,
                  'payload.bytes': payloadBytes,
                },
                (span) => {
                  try {
                    subscriptionConfig.onDownloadBytes?.(payloadBytes)
                    subscriptionConfig?.callback(parseNatsResult(msg))
                  } catch (callbackError) {
                    // Record on span AND preserve the existing console.error
                    // so consumers without OTel still see the failure.
                    recordError(span, 'xstate.nats.error', callbackError)
                    console.error(`Callback error for subject "${subject}"`, callbackError)
                  }
                },
                parentCtx,
              )
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
    onRequestResult?: (result: RequestResult) => void
    onDownloadBytes?: (bytes: number) => void
    requestHeaders?: () => Promise<MsgHdrs | undefined>
  }
}) => {
  const {
    connection,
    subject,
    payload,
    opts,
    callback,
    onRequestResult,
    onDownloadBytes,
    requestHeaders,
  } = input
  if (!connection) {
    throw new Error('NATS connection is not available')
  }

  const payloadBytes = byteLength(payload)

  void withSpan(
    'xstate.nats.request',
    'xstate.nats.error',
    {
      subject,
      'payload.bytes': payloadBytes,
      'timeout.ms': opts?.timeout,
    },
    (span) => {
      // Inject INSIDE the span so the replying service parents its handler
      // span on this request span (not on an ambient context). RequestOptions
      // declares `timeout` as required but nats-core only enforces it when
      // opts is provided; cast preserves the "no opts = use conn default"
      // contract.
      const request = (providedHeaders?: MsgHdrs, timeout = opts?.timeout) => {
        const headers = injectContextIntoHeaders(opts?.headers)
        providedHeaders?.keys().forEach((key) => {
          const value = providedHeaders.get(key)
          if (value) headers.set(key, value)
        })
        const requestOpts = (opts ? { ...opts, headers } : { headers }) as RequestOptions
        if (timeout !== undefined) requestOpts.timeout = timeout

        try {
          return connection.request(subject, payload, requestOpts)
        } catch (error) {
          return Promise.reject(error)
        }
      }

      const timeout = opts?.timeout
      const startedAt = performance.now()
      const preparedHeaders = requestHeaders ? Promise.resolve().then(requestHeaders) : undefined
      const send = preparedHeaders
        ? (timeout === undefined ? preparedHeaders : deadline(preparedHeaders, timeout)).then(
            (headers) => {
              if (timeout === undefined) return request(headers)
              const remaining = Math.floor(timeout - (performance.now() - startedAt))
              if (remaining <= 0) throw new TimeoutError()
              return request(headers, remaining)
            },
          )
        : request()

      const fail = (err: unknown) => {
        recordError(span, 'xstate.nats.error', err)
        const error = err instanceof Error ? err : new Error(String(err))
        notifyRequestResult(onRequestResult, { ok: false, error })
        if (!onRequestResult) {
          console.error(`RequestReply error for subject "${subject}"`, err)
        }
      }

      return send.then((msg: Msg) => {
        try {
          onDownloadBytes?.(msg.data?.length ?? 0)
          callback(parseNatsResult(msg))
        } catch (error) {
          fail(error)
          return
        }
        notifyRequestResult(onRequestResult, { ok: true })
      }, fail)
    },
  )
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

  const payloadBytes = byteLength(payload)

  try {
    withSpan(
      'xstate.nats.publish',
      'xstate.nats.error',
      { subject, 'payload.bytes': payloadBytes },
      () => {
        // Inject INSIDE the span so downstream subscribers see THIS span as
        // parent instead of whatever was ambient before publish.
        const headers = injectContextIntoHeaders(options?.headers)
        const publishOpts: PublishOptions = { ...(options ?? {}), headers }
        connection.publish(subject, payload, publishOpts)
      },
    )
    onPublishResult?.({ ok: true })
  } catch (callbackError) {
    console.error(`Publish callback error for subject "${subject}"`, callbackError)
    onPublishResult?.({ ok: false, error: callbackError as Error })
  }
}
