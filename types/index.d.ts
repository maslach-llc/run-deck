export type ActionKind = 'shell' | 'interactive' | 'manual'
export type ActionRisk = 'safe' | 'risky'
export type ActionStatus = 'pending' | 'armed' | 'running' | 'done' | 'failed'

export type Action = {
  id: string
  label: string
  command: string
  kind: ActionKind
  risk: ActionRisk
  why?: string
  cwd?: string
  status: ActionStatus
  exitCode?: number | null
  tail?: string
  isReported: boolean
}

export type Deck = {
  source: 'tool' | 'reply'
  summary: string
  actions: Action[]
  isHidden: boolean
  isContinued?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'run-deck': {
      deck: Shaped<Deck | null>
      log: Shaped<string[]>
    }
  }
}
