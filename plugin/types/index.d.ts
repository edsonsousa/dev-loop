export type LoopAgent = {
  id: string
  round: number
  role: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  tools: number
  verdict?: string
}

declare module 'claude-code' {
  interface PluginState {
    'dev-loop': { agents: Shaped<LoopAgent[]> }
  }
}
