import { natsMachine } from '@jr200-labs/xstate-nats'

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
