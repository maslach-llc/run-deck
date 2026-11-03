export type ActionKind = 'shell' | 'interactive' | 'manual' | 'slash' | 'reply'
export type ActionRisk = 'safe' | 'risky'
/** `skipped`: a reply not picked, because another reply of the deck was sent. */
export type ActionStatus = 'pending' | 'armed' | 'running' | 'done' | 'failed' | 'skipped'

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

/** One option of a choice. */
export type ChoiceOption = {
  id: string
  label: string
  description?: string
}

/**
 * A question with options: `isMulti` false is a radio group (pick one),
 * true a checkbox group (pick any). Picks are sent together by the send row.
 */
export type Choice = {
  id: string
  question: string
  isMulti: boolean
  options: ChoiceOption[]
  /** The ids of the picked options. */
  picked: string[]
}

export type Deck = {
  source: 'tool' | 'reply'
  summary: string
  actions: Action[]
  /** Questions the user answers with radio or checkbox rows under the actions. */
  choices?: Choice[]
  /** The answers to `choices` went to Claude. */
  isAnswered?: boolean
  /** Send was pressed with a pick-one question unanswered; a second press sends anyway. */
  isSendArmed?: boolean
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
