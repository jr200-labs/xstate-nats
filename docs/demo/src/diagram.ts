import { natsMachine, subjectManagerLogic, kvManagerLogic } from '@jr200-labs/xstate-nats'

const positions: Record<string, [number, number]> = {
  not_configured: [100, 35],
  configured: [320, 35],
  connecting: [540, 35],
  initialise_managers: [780, 35],
  error: [100, 145],
  closed: [320, 145],
  closing: [540, 145],
  connected: [780, 145],
}

export function childDiagram(kind: 'subject' | 'kv', active: string): string {
  const machine = kind === 'subject' ? subjectManagerLogic : kvManagerLogic
  const positions: Record<string, [number, number]> = {
    idle: [85, 30],
    check_sync: [255, 30],
    connected: [85, 105],
    syncing: [255, 105],
    disconnecting: [85, 180],
    error: [255, 180],
  }
  const edges = [
    ['M145 30 H195', 'CONNECT', 170, 22],
    ['M270 48 V87', 'pending', 294, 70],
    ['M235 48 V65 H85 V87', 'ready', 160, 60],
    ['M195 100 H145', 'synced', 170, 93],
    ['M145 118 Q170 150 195 118', 'subscribe / unsubscribe', 170, 147],
    ['M85 123 V162', 'DISCONNECTED', 129, 157],
    ['M25 180 H8 V30 H25', 'done', 23, 80],
    ['M255 123 V162', 'failed', 283, 152],
    ['M315 180 H338 V30 H315', 'CONNECT', 344, 106],
  ] as const
  return `<svg viewBox="0 0 350 210" role="img" aria-label="${kind} child state: ${active}">
    <defs><marker id="child-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#78929a"/></marker></defs>
    ${edges
      .filter(([, label]) => kind === 'kv' || label !== 'failed')
      .map(
        ([path, label, x, y]) =>
          `<path d="${path}" fill="none" stroke="#78929a" marker-end="url(#child-arrow)"/><text class="edge-label" x="${x}" y="${y}" ${x === 344 ? `transform="rotate(-90 ${x} ${y})"` : ''} text-anchor="middle">${label}</text>`,
      )
      .join('')}
    ${Object.values(machine.states)
      .map((node) => {
        const label = node.key.replace(`${kind}_`, '')
        const [x, y] = positions[label]
        return `<g class="${active === node.key ? 'active-node' : ''}"><rect x="${x - 60}" y="${y - 18}" width="120" height="36" rx="7"/><text x="${x}" y="${y + 4}" text-anchor="middle">${label}</text></g>`
      })
      .join('')}</svg>`
}
// Reverse transitions use different ports and lanes: never double-ended arrows.
const routes: [string, string, string, string, number, number][] = [
  ['not_configured', 'configured', 'CONFIGURE', 'M180 35 H240', 210, 24],
  ['configured', 'not_configured', 'RESET', 'M240 50 Q210 85 180 50', 210, 75],
  ['configured', 'connecting', 'CONNECT', 'M400 35 H460', 430, 24],
  ['connecting', 'initialise_managers', 'done', 'M620 35 H680', 650, 24],
  ['initialise_managers', 'connected', 'ready', 'M810 55 V125', 839, 94],
  ['connected', 'closing', 'DISCONNECT', 'M680 145 H620', 650, 135],
  ['closing', 'closed', 'done', 'M460 145 H400', 430, 135],
  ['closed', 'connecting', 'CONNECT', 'M350 125 V88 H515 V55', 431, 79],
  ['connecting', 'error', 'failed', 'M495 55 V99 H100 V125', 287, 110],
  ['error', 'configured', 'CONFIGURE', 'M135 125 V88 H290 V55', 210, 99],
]

export function diagram(active: string): string {
  return `<svg viewBox="0 0 895 183" role="img" aria-label="NATS state: ${active}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#78929a"/></marker></defs>
    ${routes.map(([, , label, path, x, y]) => `<path d="${path}" fill="none" stroke="#78929a" marker-end="url(#arrow)"/><text class="edge-label" x="${x}" y="${y}" text-anchor="middle">${label}</text>`).join('')}
    ${Object.values(natsMachine.states)
      .map((node) => {
        const [x, y] = positions[node.key]
        return `<g class="${active === node.key ? 'active-node' : ''}"><rect x="${x - (node.key === 'initialise_managers' || node.key === 'connected' ? 100 : 80)}" y="${y - 20}" width="${node.key === 'initialise_managers' || node.key === 'connected' ? 200 : 160}" height="40" rx="7"/><text x="${x}" y="${y + 4}" text-anchor="middle">${node.key}</text></g>`
      })
      .join('')}</svg>`
}
