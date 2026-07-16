import { fromPromise } from 'xstate'
import {
  ConnectionOptions,
  credsAuthenticator,
  Msg,
  NatsConnection,
  Status,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
  wsconnect,
} from '@nats-io/nats-core'
import { KvEntry } from '@nats-io/kv'
import { type AuthConfig } from './types'
import { withSpan } from '../telemetry'
import { CredentialActor, getCredentials } from '../machines/credentials'

const makeAuthConfig = (auth?: AuthConfig, getLatest?: () => AuthConfig | undefined) => {
  if (!auth) {
    return {}
  }

  if (auth.type === 'decentralised') {
    const decodedSentinel = atob(auth!.sentinelB64!)
    return {
      authenticator: [
        credsAuthenticator(new TextEncoder().encode(decodedSentinel)),
        usernamePasswordAuthenticator(
          () => getLatest?.()?.user ?? auth.user!,
          () => getLatest?.()?.pass ?? auth.pass!,
        ),
      ],
    }
  } else if (auth.type === 'userpass') {
    return {
      authenticator: usernamePasswordAuthenticator(
        () => getLatest?.()?.user ?? auth.user!,
        () => getLatest?.()?.pass ?? auth.pass!,
      ),
    }
  } else if (auth.type === 'token') {
    return {
      authenticator: tokenAuthenticator(() => getLatest?.()?.token ?? auth.token!),
    }
  }

  throw new Error(`Unsupported auth config type ${auth.type}`)
}

export type InternalStatusEvents =
  | { type: 'NATS_CONNECTION.DISCONNECTED'; status: Status }
  | { type: 'NATS_CONNECTION.RECONNECT'; status: Status }
  | { type: 'NATS_CONNECTION.ERROR'; status: Status }
  | { type: 'NATS_CONNECTION.CLOSE'; status: Status }
  | { type: 'NATS_CONNECTION.RECONNECTING'; status: Status }

export const connectToNats = fromPromise(
  async ({
    input,
  }: {
    input: {
      opts: ConnectionOptions
      auth?: AuthConfig
      credentialActor?: CredentialActor
      onStatus?: (event: InternalStatusEvents) => void
    }
  }): Promise<NatsConnection> => {
    const credentials = input.credentialActor
      ? await getCredentials(input.credentialActor)
      : undefined
    const auth = credentials?.auth ?? input.auth
    const mergedOpts: ConnectionOptions = {
      ...input.opts,
      ...makeAuthConfig(auth, () => {
        const current = input.credentialActor?.getSnapshot().context.current
        if (current?.expiresAt !== undefined && current.expiresAt <= Date.now()) {
          throw new Error('NATS credentials expired')
        }
        return current?.auth
      }),
    }
    const debug = Boolean(mergedOpts.debug)
    const nc = await wsconnect(mergedOpts)

    ;(async () => {
      for await (const status of nc.status()) {
        if (debug) {
          console.log('Status loop received status', status)
        }
        const { type } = status

        switch (type) {
          case 'disconnect':
            input.onStatus?.({ type: 'NATS_CONNECTION.DISCONNECTED', status })
            break
          case 'reconnect':
            // Per-event span so reconnect attempts become discoverable in
            // the trace backend (searchable, durations, span counts).
            withSpan(
              'xstate.nats.reconnect',
              'xstate.nats.error',
              { 'reconnect.type': type },
              () => {
                input.onStatus?.({ type: 'NATS_CONNECTION.RECONNECT', status })
              },
            )
            break
          case 'error':
            input.onStatus?.({ type: 'NATS_CONNECTION.ERROR', status })
            break
          case 'close':
            input.onStatus?.({ type: 'NATS_CONNECTION.CLOSE', status })
            break
          case 'ldm':
            console.debug('LDM', status)
            break
          case 'ping':
            // console.debug('Received ping, pong sent automatically')
            break
          case 'forceReconnect':
            withSpan(
              'xstate.nats.reconnect',
              'xstate.nats.error',
              { 'reconnect.type': type },
              () => {
                input.onStatus?.({ type: 'NATS_CONNECTION.RECONNECT', status })
              },
            )
            break
          case 'reconnecting':
            withSpan(
              'xstate.nats.reconnect',
              'xstate.nats.error',
              { 'reconnect.type': type },
              () => {
                input.onStatus?.({ type: 'NATS_CONNECTION.RECONNECTING', status })
              },
            )
            break
          case 'slowConsumer':
            console.debug('SLOW_CONSUMER', status)
            break
          case 'staleConnection':
            console.debug('STALE_CONNECTION', status)
            break
          case 'update':
            console.debug('NATS_CONNECTION.UPDATE', status)
            break
        }
      }
      if (debug) {
        console.log('Exiting nats status loop')
      }
    })()

    return nc
  },
)

export const disconnectNats = fromPromise(
  async ({ input }: { input: { connection: NatsConnection | null } }) => {
    if (input.connection) {
      await input.connection.drain()
      await input.connection.close()
    }
  },
)

export const parseNatsResult = (msg: Msg | KvEntry | null | Error) => {
  if (!msg) {
    return null
  }

  if (msg instanceof Error) {
    return msg
  }

  let data
  try {
    data = msg.json()
  } catch (jsonError) {
    // If JSON parsing fails, use the raw string
    data = msg.string()
  }
  return data
}
