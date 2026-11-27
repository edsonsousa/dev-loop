import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoopAgent } from '../types'

const PANE = 'dev-loop'
// The /dev-loop skill names every subagent call "dev-loop r<round> <role>".
const TAG = /^dev-loop r(\d+) (\S+)/
const VERDICT = /"verdict"\s*:\s*"(\w+)"/g

// Bump the tag when LoopAgent's fields change: it declines what an older version stored.
const agents = atom({ plugin: 'dev-loop', key: 'agents' } as const, [], { shape: 'agents-1' })

export const lastVerdict = (text: string): string | undefined =>
  [...text.matchAll(VERDICT)].pop()?.[1]

export const seconds = (a: LoopAgent, now: number): string => {
  const s = Math.round(((a.endedAt ?? now) - a.startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const refreshStatus = async ($: EngineInterface) => {
  const list = await read($, agents)
  if (list.length === 0) return $.ui.status(undefined)
  const round = Math.max(...list.map(a => a.round))
  const running = list.filter(a => a.status === 'running').map(a => a.role)
  const usd = (await $.session.usage()).cost?.usd
  $.ui.status(
    `dev-loop r${round} · ${running.length ? running.join(', ') : 'idle'}` +
      (usd === undefined ? '' : ` · $${usd.toFixed(2)}`),
  )
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'dev-loop' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dev-loop-view',
      description: 'Show the dev-loop agents in a pane (add "clear" to empty it)',
    })
    return next(e)
  })

  on('command.run', { command: 'dev-loop-view' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, () => [])
      await refreshStatus($)
      return { text: 'dev-loop view cleared.' }
    }
    await open($)
    return { text: 'dev-loop pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const tag = TAG.exec(e.description)
    const started = await next(e)
    if (!tag || started.deny !== undefined || !started.agentId) return started

    const row: LoopAgent = {
      id: started.agentId,
      round: Number(tag[1]),
      role: tag[2] ?? '?',
      status: 'running',
      startedAt: await $.clock.now(),
      tools: 0,
    }
    await update($, agents, list => [...list, row].slice(-60))
    void open($)
    await refreshStatus($)
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        list.some(a => a.id === id) ? list.map(a => (a.id === id ? { ...a, tools: a.tools + 1 } : a)) : list,
      )
    }
    return next(e)
  })

  on('agent.report', async ($, e, next) => {
    const endedAt = await $.clock.now()
    await update($, agents, list =>
      list.map(a =>
        a.id === e.agentId ? { ...a, status: e.status, endedAt, verdict: lastVerdict(e.text) } : a,
      ),
    )
    await refreshStatus($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const now = await $.clock.now()
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    const usd = (await $.session.usage()).cost?.usd

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No dev-loop agents yet. Run /dev-loop.</Text>}
        {list.slice(-room).map(a => (
          <Text
            color={
              a.status === 'running'
                ? 'suggestion'
                : a.status !== 'completed'
                  ? 'error'
                  : a.verdict === 'approve'
                    ? 'success'
                    : a.verdict
                      ? 'warning'
                      : undefined
            }
          >
            r{a.round} {a.role.padEnd(11)} {a.status.padEnd(9)} {String(a.tools).padStart(3)} tools{' '}
            {seconds(a, now).padStart(6)} {a.verdict ?? ''}
          </Text>
        ))}
        {usd !== undefined && <Text dimColor>session cost ~${usd.toFixed(2)}</Text>}
      </Box>
    )
  })
}
