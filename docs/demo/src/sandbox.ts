import type {
  Msg,
  NatsConnection,
  PublishOptions,
  RequestOptions,
  Subscription,
} from '@nats-io/nats-core'

// Demo-only transport boundary. The library actors stay unchanged; this adapter
// implements the small connection surface used by the messaging playground.
// It intentionally does not emulate JetStream, persistence, or broker routing.
class Inbox implements AsyncIterable<Msg> {
  private messages: Msg[] = []
  private waiting?: (result: IteratorResult<Msg>) => void
  private stopped = false

  push(message: Msg) {
    if (this.stopped) return
    if (this.waiting) {
      this.waiting({ done: false, value: message })
      this.waiting = undefined
    } else this.messages.push(message)
  }

  unsubscribe() {
    this.stopped = true
    this.messages = []
    this.waiting?.({ done: true, value: undefined })
    this.waiting = undefined
  }

  async *[Symbol.asyncIterator]() {
    while (!this.stopped) {
      const result = this.messages.length
        ? { done: false, value: this.messages.shift()! }
        : await new Promise<IteratorResult<Msg>>((resolve) => {
            this.waiting = resolve
          })
      if (result.done) return
      yield result.value
    }
  }
}

function message(subject: string, data: Uint8Array, options?: PublishOptions): Msg {
  const text = () => new TextDecoder().decode(data)
  return {
    subject,
    data,
    headers: options?.headers,
    string: text,
    json: () => JSON.parse(text()),
  } as Msg
}

export function sandboxConnection(): NatsConnection {
  const inboxes = new Map<string, Inbox[]>()
  let closed = false
  const requireOpen = () => {
    if (closed) throw new Error('Sandbox connection is closed')
  }
  const close = async () => {
    closed = true
    for (const inbox of [...inboxes.values()].flat()) inbox.unsubscribe()
    inboxes.clear()
  }
  const connection = {
    options: { inboxPrefix: '_INBOX' },
    getServer: () => 'browser sandbox',
    isClosed: () => closed,
    subscribe: (subject: string) => {
      requireOpen()
      const inbox = new Inbox()
      inboxes.set(subject, [...(inboxes.get(subject) ?? []), inbox])
      return inbox as unknown as Subscription
    },
    publish: (subject: string, data: Uint8Array, options?: PublishOptions) => {
      requireOpen()
      for (const inbox of inboxes.get(subject) ?? []) inbox.push(message(subject, data, options))
    },
    request: async (subject: string, data: Uint8Array, options?: RequestOptions) => {
      requireOpen()
      if (subject !== 'demo.echo') {
        await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 500))
        throw new Error(`Sandbox has no responder for ${subject}; use demo.echo`)
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
      requireOpen()
      const payload = new TextEncoder().encode(
        JSON.stringify({ echo: new TextDecoder().decode(data), transport: 'browser sandbox' }),
      )
      return message(subject, payload)
    },
    drain: close,
    close,
  }
  return connection as unknown as NatsConnection
}
