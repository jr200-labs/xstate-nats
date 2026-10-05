/// <reference types="node" />
import { it, expect } from 'vitest'
import { createActor, waitFor } from 'xstate'
import { wsconnect } from '@nats-io/nats-core'
import { Kvm } from '@nats-io/kv'
import { natsMachine, KvSubscriptionKey } from '@jr200-labs/xstate-nats'
import { reconnectWithSubscriptions } from './recovery'

// Run explicitly against a disposable local broker with JetStream enabled.
it.runIf(!!process.env.DEMO_NATS_WS)(
  'restores live KV delivery, removes watches, and resubscribes',
  async () => {
    const server = process.env.DEMO_NATS_WS!
    const bucket = `docs_recovery_${Date.now()}`
    const actor = createActor(natsMachine)
    const received: unknown[] = []
    const options = { timeout: 10_000 }
    const watchKey = KvSubscriptionKey.key(bucket, 'greeting')
    const put = (message: string) =>
      new Promise<void>((resolve, reject) =>
        actor.send({
          type: 'KV.PUT',
          bucket,
          key: 'greeting',
          value: new TextEncoder().encode(JSON.stringify({ message })),
          onResult: (result) => ('error' in result ? reject(result.error) : resolve()),
        }),
      )
    const watch = () =>
      actor.send({
        type: 'KV.SUBSCRIBE',
        config: {
          bucket,
          key: 'greeting',
          callback: (data) => received.push(data.value),
        },
      })
    actor.start()
    try {
      actor.send({ type: 'CONFIGURE', config: { opts: { servers: [server] }, maxRetries: 3 } })
      actor.send({ type: 'CONNECT' })
      await waitFor(actor, (s) => s.matches('connected'), options)
      await new Promise<void>((resolve, reject) =>
        actor.send({
          type: 'KV.BUCKET_CREATE',
          bucket,
          onResult: (result) => {
            if ('error' in result) reject(result.error)
            else if (result.ok) resolve()
            else reject(new Error('Test bucket already exists'))
          },
        }),
      )
      watch()
      const kv = actor.getSnapshot().children.kv!
      await waitFor(kv, (s) => s.context.subscriptions.has(watchKey), options)
      await put('before reconnect')
      await expect.poll(() => received).toContainEqual({ message: 'before reconnect' })
      await reconnectWithSubscriptions(actor, () => {})
      await put('new value after reconnect')
      await expect.poll(() => received).toContainEqual({ message: 'new value after reconnect' })
      actor.send({ type: 'KV.UNSUBSCRIBE', bucket, key: 'greeting' })
      await waitFor(
        kv,
        (s) => !s.context.subscriptions.size && !s.context.subscriptionConfigs.size,
        options,
      )
      await put('while unsubscribed')
      watch()
      await waitFor(kv, (s) => s.context.subscriptions.has(watchKey), options)
      await put('after resubscribe')
      await expect.poll(() => received).toContainEqual({ message: 'after resubscribe' })
      actor.send({ type: 'KV.UNSUBSCRIBE_ALL' })
      await waitFor(
        kv,
        (s) => !s.context.subscriptions.size && !s.context.subscriptionConfigs.size,
        options,
      )
    } finally {
      await actor.getSnapshot().context.connection?.close()
      actor.stop()
      const cleanup = await wsconnect({ servers: [server] })
      try {
        await (await new Kvm(cleanup).open(bucket)).destroy()
      } finally {
        await cleanup.close()
      }
    }
  },
  30_000,
)
