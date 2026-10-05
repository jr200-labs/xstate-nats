import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import { natsMachine } from '@jr200-labs/xstate-nats'
import { sandboxConnection } from './sandbox'

describe('browser sandbox using the library actors', () => {
  it('connects both real managers, delivers a publish, replies, and restores subscriptions after reconnect', async () => {
    const actor = createActor(
      natsMachine.provide({
        actors: { connectToNats: fromPromise(async () => sandboxConnection()) },
      }),
    )
    actor.start()
    actor.send({ type: 'CONFIGURE', config: { opts: {}, maxRetries: 3 } })
    actor.send({ type: 'CONNECT' })
    await waitFor(actor, (s) => s.matches('connected'))
    expect(actor.getSnapshot().context.kvManagerReady).toBe(true)
    const received: unknown[] = []
    actor.send({
      type: 'SUBJECT.SUBSCRIBE',
      config: { subject: 'demo.events', callback: (data) => received.push(data) },
    })
    const bytes = new TextEncoder().encode('{"hello":"browser"}')
    actor.send({ type: 'SUBJECT.PUBLISH', subject: 'demo.events', payload: bytes })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toEqual([{ hello: 'browser' }])
    const reply = await new Promise((resolve, reject) =>
      actor.send({
        type: 'SUBJECT.REQUEST',
        subject: 'demo.echo',
        payload: bytes,
        callback: resolve,
        onRequestResult: (result) => {
          if (!result.ok) reject(result.error)
        },
      }),
    )
    expect(reply).toEqual({ echo: '{"hello":"browser"}', transport: 'browser sandbox' })
    actor.send({ type: 'DISCONNECT' })
    await waitFor(actor, (s) => s.matches('closed'))
    actor.send({ type: 'CONNECT' })
    await waitFor(actor, (s) => s.matches('connected'))
    actor.send({ type: 'SUBJECT.PUBLISH', subject: 'demo.events', payload: bytes })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toHaveLength(2)
    actor.send({ type: 'DISCONNECT' })
    await waitFor(actor, (s) => s.matches('closed'))
    actor.stop()
  })

  it('reports an unavailable sandbox responder without inventing a successful reply', async () => {
    await expect(
      sandboxConnection().request('unknown.subject', new Uint8Array(), { timeout: 1 }),
    ).rejects.toThrow('no responder')
  })
})
