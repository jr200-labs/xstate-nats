import { createActor, fromPromise, type ActorRefFrom } from 'xstate'
import { natsMachine, parseNatsResult, type NatsEvent } from '@jr200-labs/xstate-nats'
import { sandboxConnection } from './sandbox'
import { diagram } from './diagram'
import './style.css'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="playground">
    <header><div><span class="eyebrow">XSTATE / NATS</span><h1>Messaging playground</h1></div><span id="status" class="status" role="status">not_configured</span></header>
    <section class="connection card" aria-label="Connection controls">
      <label>Transport<select id="mode"><option value="sandbox">Browser sandbox</option><option value="live">Live WebSocket</option></select></label>
      <div id="live-settings" hidden><label>WebSocket URL<input id="server" value="ws://localhost:42222" type="url" /></label><label>Token (optional)<input id="token" type="password" autocomplete="off" /></label></div>
      <div class="buttons"><button id="configure">Configure</button><button id="connect" class="primary">Connect</button><button id="disconnect">Disconnect</button><button id="reset">Reset</button></div>
      <p id="transport-note" class="note">In-memory transport · real library actors · no broker or sign-in needed.</p>
    </section>
    <section class="diagram card"><div class="section-heading"><h2>Connection lifecycle</h2><span>Main paths · active state in teal</span></div><div id="diagram"></div></section>
    <div class="workbench">
      <section class="editor card">
        <div class="section-heading"><h2>Send an event</h2><nav class="tabs" aria-label="Operation"><button id="subjects-tab" aria-pressed="true">Subjects</button><button id="kv-tab" aria-pressed="false">Key-value</button></nav></div>
        <div id="subject-fields"><label>Subject<input id="subject" value="demo.events" /></label><div class="buttons"><button id="subscribe">Subscribe</button><button id="unsubscribe">Unsubscribe</button></div><label>Request subject<input id="request-subject" value="demo.echo" /></label></div>
        <div id="kv-fields" hidden><p class="note">KV needs a live NATS connection with JetStream enabled.</p><div class="field-pair"><label>Bucket<input id="bucket" value="demo" /></label><label>Key<input id="key" value="greeting" /></label></div><div class="buttons"><button id="create-bucket">Create bucket</button><button id="get">Get</button><button id="watch">Watch</button></div></div>
        <label class="payload-label">Message<textarea id="payload" spellcheck="false">{"message":"Hello from the browser"}</textarea></label>
        <div class="buttons"><button id="publish" class="primary">Publish</button><button id="request">Request reply</button><button id="put" class="primary" hidden>Put value</button><button id="fail" class="quiet">Try connection failure</button></div>
        <p id="feedback" role="status">Start with Configure, then Connect.</p>
      </section>
      <aside class="details card">
        <details open><summary>Output <span id="event-count">0 events</span></summary><div id="output" aria-live="polite" aria-relevant="additions"><p class="empty">Subscribe, then publish to see a message arrive.</p></div></details>
        <details><summary>State <span>actor details</span></summary><pre id="state"></pre></details>
      </aside>
    </div>
  </main>`

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T
const value = (id: string) => element<HTMLInputElement>(id).value.trim()
let actor: ActorRefFrom<typeof natsMachine>
let failNext = false
let kvTab = false
let eventCount = 0
let previousState = ''
let unsubscribeActor: (() => void) | undefined
const encoder = new TextEncoder()

function log(label: string, data?: unknown) {
  eventCount++
  element('event-count').textContent = `${eventCount} events`
  const output = element('output')
  output.querySelector('.empty')?.remove()
  const entry = document.createElement('div')
  entry.className = 'log-entry'
  const title = document.createElement('strong')
  title.textContent = label
  entry.append(title)
  if (data !== undefined) {
    const pre = document.createElement('pre')
    pre.textContent = data instanceof Error ? data.message : JSON.stringify(data, null, 2)
    entry.append(pre)
  }
  output.prepend(entry)
  while (output.childElementCount > 50) output.lastElementChild?.remove()
}

function feedback(text: string, error = false) {
  element('feedback').textContent = text
  element('feedback').classList.toggle('error', error)
}

function send(event: NatsEvent) {
  log(event.type)
  actor.send(event)
}

function refresh() {
  const snapshot = actor.getSnapshot()
  const state = String(snapshot.value)
  const connected = snapshot.matches('connected')
  const sandbox = value('mode') === 'sandbox'
  element('status').textContent = state
  element('status').classList.toggle('connected', connected)
  element('diagram').innerHTML = diagram(state)
  // The root forwards wildcard events, so snapshot.can() alone can accept
  // controls that have no lifecycle transition in the current state.
  element<HTMLButtonElement>('connect').disabled = !['configured', 'closed', 'error'].includes(
    state,
  )
  element<HTMLButtonElement>('disconnect').disabled = ![
    'connected',
    'initialise_managers',
  ].includes(state)
  element<HTMLButtonElement>('reset').disabled = !['configured', 'closed', 'error'].includes(state)
  const busy = ['connecting', 'initialise_managers', 'closing'].includes(state)
  element<HTMLButtonElement>('configure').disabled = busy || connected
  element<HTMLSelectElement>('mode').disabled = busy || connected
  for (const id of ['subscribe', 'unsubscribe', 'publish', 'request'])
    element<HTMLButtonElement>(id).disabled = !connected
  for (const id of ['create-bucket', 'get', 'watch', 'put'])
    element<HTMLButtonElement>(id).disabled = !connected || sandbox
  element<HTMLButtonElement>('fail').disabled = !sandbox || busy || connected
  const subject = snapshot.children.subject?.getSnapshot()
  const kv = snapshot.children.kv?.getSnapshot()
  element('state').textContent = JSON.stringify(
    {
      state: snapshot.value,
      retries: snapshot.context.retries,
      error: snapshot.context.error?.message,
      managers: {
        subjects: snapshot.context.subjectManagerReady,
        kv: snapshot.context.kvManagerReady,
      },
      subjectState: subject?.value,
      subscriptions: subject ? [...subject.context.subscriptionConfigs.keys()] : [],
      traffic: subject?.context.trafficMetrics,
      kvState: kv?.value,
    },
    null,
    2,
  )
  if (snapshot.context.error) feedback(snapshot.context.error.message, true)
  else if (connected && previousState !== state)
    feedback('Connected. Subscribe, then publish a message or request a reply.')
  previousState = state
}

function startActor() {
  unsubscribeActor?.()
  if (actor) {
    void actor.getSnapshot().context.connection?.close()
    actor.stop()
  }
  const machine =
    value('mode') === 'sandbox'
      ? natsMachine.provide({
          actors: {
            connectToNats: fromPromise(async () => {
              await new Promise((resolve) => setTimeout(resolve, 180))
              if (failNext) {
                failNext = false
                throw new Error('Simulated connection failure. Connect again to recover.')
              }
              return sandboxConnection()
            }),
          },
        })
      : natsMachine
  actor = createActor(machine)
  const subscription = actor.subscribe({
    next: refresh,
    error: (error) => feedback(String(error), true),
  })
  unsubscribeActor = () => subscription.unsubscribe()
  actor.start()
}

function operate(fn: () => void) {
  try {
    fn()
  } catch (error) {
    feedback(error instanceof Error ? error.message : String(error), true)
  }
}

function payload() {
  const text = value('payload')
  try {
    JSON.parse(text)
  } catch {
    throw new Error('Enter a valid JSON message.')
  }
  return encoder.encode(text)
}

element('configure').onclick = () =>
  operate(() => {
    const server = value('server')
    if (value('mode') === 'live' && !/^wss?:\/\//.test(server))
      throw new Error('Use a ws:// or wss:// WebSocket URL.')
    if (value('mode') === 'live' && location.protocol === 'https:' && !server.startsWith('wss://'))
      throw new Error('This HTTPS page needs wss://. Preview locally to use ws://localhost.')
    send({
      type: 'CONFIGURE',
      config: {
        opts: { servers: [server], timeout: 3000, reconnect: true, maxReconnectAttempts: 3 },
        auth:
          value('mode') === 'live' && value('token')
            ? { type: 'token', token: value('token') }
            : undefined,
        maxRetries: 3,
      },
    })
    feedback('Configured. Connect to start messaging.')
  })
element('connect').onclick = () => send({ type: 'CONNECT' })
element('disconnect').onclick = () => {
  send({ type: 'DISCONNECT' })
  feedback('Disconnected. Connect again to restore subscriptions.')
}
element('reset').onclick = () => {
  send({ type: 'RESET' })
  feedback('Configure a new connection.')
}
element('mode').onchange = () => {
  const live = value('mode') === 'live'
  element('live-settings').hidden = !live
  element('transport-note').textContent = live
    ? 'Real NATS over WebSocket · use your own broker and permissions.'
    : 'In-memory transport · real library actors · no broker or sign-in needed.'
  failNext = false
  startActor()
  feedback('Start with Configure, then Connect.')
}
element('subscribe').onclick = () =>
  send({
    type: 'SUBJECT.SUBSCRIBE',
    config: {
      subject: value('subject'),
      callback: (data) => {
        log('Message received', data)
        refresh()
      },
    },
  })
element('unsubscribe').onclick = () =>
  send({ type: 'SUBJECT.UNSUBSCRIBE', subject: value('subject') })
element('publish').onclick = () =>
  operate(() =>
    send({
      type: 'SUBJECT.PUBLISH',
      subject: value('subject'),
      payload: payload(),
      onPublishResult: (result) => {
        feedback(
          result.ok ? 'Published. Check Output for subscribed messages.' : result.error.message,
          !result.ok,
        )
        refresh()
      },
    }),
  )
element('request').onclick = () =>
  operate(() =>
    send({
      type: 'SUBJECT.REQUEST',
      subject: value('request-subject'),
      payload: payload(),
      opts: { timeout: 1500 },
      callback: (data) => log('Reply received', data),
      onRequestResult: (result) => {
        feedback(result.ok ? 'Reply received.' : result.error.message, !result.ok)
        log(
          result.ok ? 'Request completed' : 'Request failed',
          result.ok ? undefined : result.error,
        )
        refresh()
      },
    }),
  )
element('fail').onclick = () => {
  failNext = true
  if (!actor.getSnapshot().context.natsConfig) element('configure').click()
  send({ type: 'CONNECT' })
}
function tab(kv: boolean) {
  kvTab = kv
  element('kv-fields').hidden = !kv
  element('subject-fields').hidden = kv
  for (const id of ['publish', 'request']) element(id).hidden = kv
  element('put').hidden = !kv
  element('subjects-tab').setAttribute('aria-pressed', String(!kv))
  element('kv-tab').setAttribute('aria-pressed', String(kv))
}
element('subjects-tab').onclick = () => tab(false)
element('kv-tab').onclick = () => tab(true)
function result(data: unknown) {
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    const error = data.error instanceof Error ? data.error.message : String(data.error)
    feedback(error, true)
    log('KV failed', error)
    return
  }
  log(
    'KV result',
    data && typeof data === 'object' && 'json' in data
      ? parseNatsResult(data as Parameters<typeof parseNatsResult>[0])
      : data,
  )
  refresh()
}
element('create-bucket').onclick = () =>
  send({ type: 'KV.BUCKET_CREATE', bucket: value('bucket'), onResult: result })
element('get').onclick = () =>
  send({ type: 'KV.GET', bucket: value('bucket'), key: value('key'), onResult: result })
element('watch').onclick = () =>
  send({
    type: 'KV.SUBSCRIBE',
    config: { bucket: value('bucket'), key: value('key'), callback: result },
  })
element('put').onclick = () =>
  operate(() =>
    send({
      type: 'KV.PUT',
      bucket: value('bucket'),
      key: value('key'),
      value: payload(),
      onResult: result,
    }),
  )
window.addEventListener('pagehide', () => {
  void actor.getSnapshot().context.connection?.close()
  actor.stop()
})
startActor()
tab(kvTab)
