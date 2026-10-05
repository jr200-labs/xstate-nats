import { waitFor, type ActorRefFrom } from 'xstate'
import { natsMachine } from '@jr200-labs/xstate-nats'

// A deliberate client disconnect demonstrates restoration on a new connection.
// It does not pretend to stop a broker or simulate a network outage.
export async function reconnectWithSubscriptions(
  actor: ActorRefFrom<typeof natsMachine>,
  progress: (message: string) => void,
) {
  const before = actor.getSnapshot()
  if (!before.matches('connected')) throw new Error('Connect before trying recovery.')
  const subjects = [...before.children.subject!.getSnapshot().context.subscriptionConfigs.keys()]
  const watches = [...before.children.kv!.getSnapshot().context.subscriptionConfigs.keys()]
  if (!subjects.length && !watches.length)
    throw new Error('Subscribe to a subject or watch a KV key first.')
  const options = { timeout: 10_000 }
  progress('Disconnecting. Subscription targets are retained.')
  actor.send({ type: 'DISCONNECT' })
  await waitFor(actor, (snapshot) => snapshot.matches('closed'), options)
  const closed = actor.getSnapshot()
  if (
    !subjects.every((key) =>
      closed.children.subject!.getSnapshot().context.subscriptionConfigs.has(key),
    ) ||
    !watches.every((key) => closed.children.kv!.getSnapshot().context.subscriptionConfigs.has(key))
  )
    throw new Error('Subscription targets were lost during disconnect.')
  if (
    closed.children.subject!.getSnapshot().context.subscriptions.size ||
    closed.children.kv!.getSnapshot().context.subscriptions.size
  )
    throw new Error('Managers still have active subscriptions after disconnect.')
  progress('Disconnected: active subscriptions are empty. Reconnecting…')
  actor.send({ type: 'CONNECT' })
  await waitFor(actor, (snapshot) => snapshot.matches('connected'), options)
  const connected = actor.getSnapshot()
  await waitFor(
    connected.children.subject!,
    (snapshot) => subjects.every((key) => snapshot.context.subscriptions.has(key)),
    options,
  )
  await waitFor(
    connected.children.kv!,
    (snapshot) => watches.every((key) => snapshot.context.subscriptions.has(key)),
    options,
  )
  progress('Subscription handles restored. Verify delivery with a new message or KV value.')
}
