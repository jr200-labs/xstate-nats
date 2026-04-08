# @jr200/xstate-nats

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
npm install @jr200/xstate-nats
# or
pnpm add @jr200/xstate-nats
# or
yarn add @jr200/xstate-nats
```

## Quick Start

### Basic Setup

```typescript
import { natsMachine } from '@jr200/xstate-nats'
import { useActor } from '@xstate/react'

function MyComponent() {
  const [state, send] = useActor(natsMachine)

  const connect = () => {
    send({
      type: 'CONFIGURE',
      config: {
        opts: {
          servers: ['nats://localhost:4222']
        },
        auth: {
          type: 'userpass',
          user: 'myuser',
          pass: 'mypass'
        },
        maxRetries: 3
      }
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
- `KvSubscriptionKey`: Type for KV subscription keys
- `parseNatsResult`: Utility for parsing NATS operation results
- `AuthConfig`: Type for authentication configuration

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

## Examples

Check out the [React example](./examples/react-test/) for a complete working implementation.

## Development

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- NATS server running locally

### Setup

```bash
# Install dependencies
pnpm install

# Start NATS server (if not already running)
nats-server -c nats-server.conf

# Run the React example
cd examples/react-test
pnpm dev
```

### Scripts

- `pnpm build`: Build the library
- `pnpm test`: Run tests
- `pnpm lint`: Run ESLint
- `pnpm format`: Format code with Prettier

## License

MIT

## Dependencies

- [XState](https://xstate.js.org/) - State machine library
- [@nats-io/nats-core](https://github.com/nats-io/nats.js) - NATS client
- [@nats-io/jetstream](https://github.com/nats-io/nats.js) - JetStream support
- [@nats-io/kv](https://github.com/nats-io/nats.js) - Key-Value store
