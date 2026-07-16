# @jr200-labs/xstate-nats

A state machine library that integrates [XState v5](https://xstate.js.org/) with [NATS](https://nats.io/) messaging system, providing a type-safe way to manage NATS connections, subscriptions, and Key-Value operations.

## Features

- **State Machine Management**: Built on XState for predictable state transitions and side effects
- **NATS Integration**: Full support for NATS Core, JetStream, and Key-Value operations
- **Authentication Support**: Multiple auth types (decentralised, userpass, token)
- **Connection Management**: Automatic connection handling with retry logic and error recovery
- **Subject Management**: Subscribe, publish, and request-reply operations with state tracking
- **Key-Value Store**: KV bucket and key management with real-time subscriptions

## Installation

```bash
pnpm add @jr200-labs/xstate-nats
```

## Quick Start

### Basic Setup

```typescript
import { natsMachine } from '@jr200-labs/xstate-nats'
import { useActor } from '@xstate/react'

function MyComponent() {
  const [state, send] = useActor(natsMachine)

  const connect = () => {
    send({
      type: 'CONFIGURE',
      config: {
        opts: {
          servers: ['nats://localhost:4222'],
        },
        auth: {
          type: 'userpass',
          user: 'myuser',
          pass: 'mypass',
        },
        maxRetries: 3,
      },
    })

    send({ type: 'CONNECT' })
  }

  return (
    <div>
      <p>Status: {state.value}</p>
      <button onClick={connect}>Connect</button>
    </div>
  )
}
```

### Subject Operations

```typescript
// Subscribe to a subject
send({
  type: 'SUBJECT.SUBSCRIBE',
  config: {
    subject: 'user.events',
    callback: (data) => {
      console.log('Received:', data)
    },
  },
})

// Publish to a subject
send({
  type: 'SUBJECT.PUBLISH',
  subject: 'user.events',
  payload: { userId: 123, action: 'login' },
})

// Request-reply pattern
send({
  type: 'SUBJECT.REQUEST',
  subject: 'user.get',
  payload: { userId: 123 },
  callback: (reply) => {
    console.log('Reply:', reply)
  },
})
```

For short-lived authentication, configure the built-in credential actor. The adapter is
product-neutral: an application can obtain credentials from OIDC, a service account, or another
source without teaching `xstate-nats` about that provider:

```typescript
credentials: {
  refreshBeforeExpiryMs: 60_000,
  diagnostics: true,
  adapter: {
    load: () => loadSessionCredentials(),
    refresh: (current) => refreshSessionCredentials(current),
  },
}
```

Both adapter methods return a `NatsCredentials` value:

```typescript
const requestHeaders = headers()
requestHeaders.set('authorization', `Bearer ${accessToken}`)

return {
  auth: {
    type: 'decentralised',
    sentinelB64,
    user: userId,
    pass: idToken,
  },
  requestHeaders,
  expiresAt: tokenExpiryEpochMs,
}
```

The credential actor loads once, shares concurrent callers, refreshes before expiry, and bounds
each adapter operation (30 seconds by default). `CONNECT` waits for ready credentials. Every
`SUBJECT.REQUEST` then obtains current headers immediately before sending; header preparation and
the NATS round trip share the request's `opts.timeout`. NATS reconnect authentication reads the
actor's current cached connection credential synchronously, as required by the NATS authenticator.

If loading or refresh fails, or unrefreshable credentials expire, requests fail closed and an
active NATS connection is closed. After the application has repaired its login/session, send
`CREDENTIALS.RELOAD`, then `CONNECT`. Static non-expiring `auth` configuration remains supported.

### Key-Value Operations

```typescript
// Create a KV bucket
send({
  type: 'KV.BUCKET_CREATE',
  bucket: 'user-sessions',
  onResult: (result) => {
    if (result.ok) {
      console.log('Bucket created successfully')
    }
  },
})

// Put a value
send({
  type: 'KV.PUT',
  bucket: 'user-sessions',
  key: 'user-123',
  value: { sessionId: 'abc123', expiresAt: Date.now() },
  onResult: (result) => {
    if (result.ok) {
      console.log('Value stored successfully')
    }
  },
})

// Get a value
send({
  type: 'KV.GET',
  bucket: 'user-sessions',
  key: 'user-123',
  onResult: (result) => {
    if ('error' in result) {
      console.error('Error:', result.error)
    } else {
      console.log('Value:', result)
    }
  },
})

// Subscribe to KV changes
send({
  type: 'KV.SUBSCRIBE',
  config: {
    bucket: 'user-sessions',
    key: 'user-123',
    callback: (entry) => {
      console.log('KV Update:', entry)
    },
  },
})
```

## State Machine States

The NATS machine operates in the following states:

- **`not_configured`**: Initial state, waiting for configuration
- **`configured`**: Configuration received, ready to connect
- **`connecting`**: Attempting to establish NATS connection
- **`initialise_managers`**: Setting up subject and KV managers
- **`connected`**: Fully connected and operational
- **`closing`**: Gracefully disconnecting
- **`closed`**: Connection closed, can reconnect
- **`error`**: Error state, can reset and retry

## API Reference

### Main Exports

- `natsMachine`: The main XState machine for NATS operations
- `credentialMachine`: Generic short-lived credential lifecycle machine
- `KvSubscriptionKey`: Type for KV subscription keys
- `parseNatsResult`: Utility for parsing NATS operation results
- `AuthConfig`: Type for authentication configuration
- `NatsCredentialAdapter`, `NatsCredentialConfig`, `NatsCredentials`: Credential actor contracts

### Authentication

```typescript
// Decentralised auth
auth: {
  type: 'decentralised',
  sentinelB64: 'base64-encoded-sentinel',
  user: 'username',
  pass: 'password'
}

// User/password auth
auth: {
  type: 'userpass',
  user: 'username',
  pass: 'password'
}

// Token auth
auth: {
  type: 'token',
  token: 'your-token'
}
```

### Events

#### Connection Events

- `CONFIGURE`: Set connection configuration
- `CONNECT`: Establish connection
- `DISCONNECT`: Close connection
- `RESET`: Reset to initial state
- `CREDENTIALS.RELOAD`: Reload credentials after the application repairs its session

#### Subject Events

- `SUBJECT.SUBSCRIBE`: Subscribe to a subject
- `SUBJECT.UNSUBSCRIBE`: Unsubscribe from a subject
- `SUBJECT.PUBLISH`: Publish to a subject
- `SUBJECT.REQUEST`: Send request-reply
- `SUBJECT.UNSUBSCRIBE_ALL`: Clear all subscriptions

#### KV Events

- `KV.BUCKET_CREATE`: Create a KV bucket
- `KV.BUCKET_DELETE`: Delete a KV bucket
- `KV.BUCKET_LIST`: List KV buckets
- `KV.PUT`: Store a value
- `KV.GET`: Retrieve a value
- `KV.DELETE`: Delete a value
- `KV.SUBSCRIBE`: Subscribe to KV changes
- `KV.UNSUBSCRIBE`: Unsubscribe from KV changes
- `KV.UNSUBSCRIBE_ALL`: Unsubscribe from all KV changes

## OpenTelemetry

This library emits OpenTelemetry spans for NATS operations and propagates W3C
trace context across the wire so a single trace can span publisher, subscriber,
and request/reply replier.

### Emitted spans

| Span name                         | Emitted by           | Attributes                                                               |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `xstate.nats.subscribe`           | `SUBJECT.SUBSCRIBE`  | `subject`                                                                |
| `xstate.nats.message`             | per received message | `subject`, `payload.bytes`                                               |
| `xstate.nats.publish`             | `SUBJECT.PUBLISH`    | `subject`, `payload.bytes`                                               |
| `xstate.nats.request`             | `SUBJECT.REQUEST`    | `subject`, `payload.bytes`, `timeout.ms`                                 |
| `xstate.nats.reconnect`           | NATS status loop     | `reconnect.type`                                                         |
| `xstate.nats.lifecycle`           | root machine         | `xstate.state`, `xstate.event`                                           |
| `xstate.nats.credentials.load`    | credential load      | `credentials.operation`, `credentials.timeout.ms`, `credentials.outcome` |
| `xstate.nats.credentials.refresh` | credential refresh   | `credentials.operation`, `credentials.timeout.ms`, `credentials.outcome` |
| `xstate.nats.kv.watch`            | `KV.SUBSCRIBE`       | `bucket`, `key`                                                          |
| `xstate.nats.kv.entry`            | per KV watch entry   | `bucket`, `key`, `operation`                                             |

All error paths record exceptions on the active span, set span status to
`ERROR`, and emit a named event (`xstate.nats.error` / `xstate.nats.kv.error`)
with a truncated stack.

### Credential metrics

| Metric name                                  | Type      | Attributes             |
| -------------------------------------------- | --------- | ---------------------- |
| `xstate.nats.credentials.operations`         | Counter   | `operation`, `outcome` |
| `xstate.nats.credentials.operation.duration` | Histogram | `operation`, `outcome` |
| `xstate.nats.credentials.state.transitions`  | Counter   | `state`                |

Operations are `load` or `refresh`; outcomes are `success` or `error`. Durations are recorded in
milliseconds. These low-cardinality metrics expose authentication rate, refresh frequency,
latency, failures, expiry, and recovery trends without recording credential contents.
A registered OpenTelemetry `MeterProvider` is required to export them.

### Lifecycle diagnostics

Root machine lifecycle diagnostics are opt-in and separate from raw NATS
protocol frame logging. Enable them on the connection config:

```ts
send({
  type: 'CONFIGURE',
  config: {
    opts: { servers: ['wss://example-nats'] },
    diagnostics: { lifecycle: true },
    maxRetries: 3,
  },
})
```

When enabled, the root machine emits sanitized `xstate.nats.lifecycle` spans and
`console.debug('xstate-nats lifecycle', attributes)` breadcrumbs for configure,
connect, close, manager initialization, and NATS status events. Diagnostics
include state, event type, server URLs, debug/verbose flags, retry count, auth
type, and manager readiness flags. They do not include credentials, JWTs, nkeys,
signatures, passwords, tokens, or raw protocol frames.

Set `credentials.diagnostics: true` for sanitized credential state and operation breadcrumbs.
They contain only operation, outcome, duration, timeout, state, and pending-waiter count. Adapter
error messages and credential contents are deliberately excluded from logs and traces.

### Enabling tracing

`@opentelemetry/api` is a peer dependency — the consumer controls the installed
version and registers the SDK. If no provider is registered all telemetry calls
become no-ops. Minimal setup:

```ts
import { trace, propagation, context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

const provider = new BasicTracerProvider({
  spanProcessors: [/* your exporter */],
})
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const ctxMgr = new AsyncLocalStorageContextManager()
ctxMgr.enable()
context.setGlobalContextManager(ctxMgr)
```

### Context propagation

Publish and request operations inject `traceparent` into the outgoing NATS
headers; received messages extract the traceparent and parent their
`xstate.nats.message` span on it. Downstream services that propagate the header
appear as children of the originating publisher/requester span.

## Examples

Check out the [React example](./examples/react-test/) for a complete working implementation.

## Development

### Prerequisites

- Node.js 22+
- pnpm

### Setup

```bash
make install
```

### Commands

```bash
make check          # Run prettier + lint (tsc --noEmit)
make test           # Run tests
make build          # Build the library
make bump PART=patch  # Bump version (major|minor|patch)
make release        # Tag, push, and create GitHub release
make publish        # Build, test, and publish to npm
```

## License

MIT
