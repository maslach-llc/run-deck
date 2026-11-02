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
  /** The last lines the command wrote, for the output pane. */
  output?: string[]
  /** What Claude is told: the tail of the output, or a note. */
  tail?: string
  isReported: boolean
}

export type Deck = {
  source: 'tool' | 'reply'
  summary: string
  actions: Action[]
  isHidden: boolean
  isContinued?: boolean
  /** Run all was pressed once over a risky command; a second press runs everything. */
  isAllArmed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'run-deck': {
      deck: Shaped<Deck | null>
      /** The action whose output the pane shows. */
      selected: Shaped<string | null>
    }
  }
}
