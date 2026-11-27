import { expect, test } from 'claude-code/testing'

import { lastVerdict, seconds } from './register'

const PANE = {
  plugin: 'dev-loop',
  component: 'Pane',
  requestId: 'dev-loop',
  props: {
    title: 'dev-loop',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// Stands for the engine beneath the plugin.
const core = { plugin: 'engine', tier: 'core' } as const
const spawn = { tool_use_id: 't1', provider: core, parentModel: 'opus', background: true, fork: false } as const

const engine = (on: any) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('clock.now', () => ({ value: 1_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('the verdict is the last one in the report', () => {
  const text = 'example {"verdict": "approve"} ... final\n```json\n{"verdict": "changes", "blocking": []}\n```'
  expect(lastVerdict(text)).toBe('changes')
  expect(lastVerdict('no block')).toBe(undefined)
})

test('durations read as seconds, then minutes', () => {
  const a = { id: 'a', round: 1, role: 'reviewer', status: 'completed', startedAt: 0, tools: 0 } as const
  expect(seconds({ ...a, endedAt: 42_000 }, 0)).toBe('42s')
  expect(seconds(a, 65_000)).toBe('1m05s')
})

test('the pane is empty before any dev-loop agent, on every surface', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No dev-loop agents/ }))?.text).toBe(
      'No dev-loop agents yet. Run /dev-loop.',
    )
    await ui.unmount()
  }
})

test('a dev-loop agent shows with its round, role, tool calls and verdict', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))
  on('agent.report', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))

  await $.agent.spawn({ ...spawn, description: 'dev-loop r1 reviewer', prompt: 'review', subagentType: 'dev-reviewer' })
  await $.agent.spawn({ ...spawn, description: 'something else', prompt: 'x', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Bash', command: 'git diff', agentId: 'a1' })
  await $.agent.report({ provider: core, agentId: 'a1', subagentType: 'dev-reviewer', status: 'completed', text: '{"verdict": "approve"}' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /reviewer/ })
  expect(row?.text).toMatch(/^r1 reviewer\s+completed\s+1 tools\s+0s approve$/)
  expect((await ui.find({ type: 'Text', text: /Explore|else/ }))?.text).toBe(undefined)
  await ui.unmount()
})
