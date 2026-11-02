import type { ActionKind, ActionRisk } from '../types'

export type ParsedAction = {
  label: string
  command: string
  cwd?: string
  kind: ActionKind
  risk: ActionRisk
}

const FENCE_OPEN = /^\s*```(bash|sh|shell|zsh|console)\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const BARE_CD = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?/

const INTERACTIVE = [
  /\bgh auth login\b/,
  /\bgcloud auth\b/,
  /\bfirebase login\b/,
  /\bnpm (login|adduser)\b/,
  /\bwrangler login\b/,
  /\blpass login\b/,
  /\bssh\b/,
  /\b(vim|nvim|nano|less|more|htop|top)\b/,
  /^claude(\s|$)/,
  /\bpasswd\b/,
  /\bdocker (exec|run) [\s\S]*-it\b/,
]

const RISKY = [
  /\brm\s+-[a-zA-Z]*[rf]/,
  /\bgit\s+push\b/,
  /--force\b/,
  /\bsudo\b/,
  /\bprod/i,
  /\b(drop|truncate)\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bkill(all)?\b/,
  /\bsystemctl\s+(stop|restart|disable|mask)\b/,
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\b(gcloud|aws|az|wrangler|firebase)\b.*\b(delete|deploy|destroy)\b/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|branch\s+-D)\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
]

/** The last fenced shell block of a reply, or null when it has none. */
export function lastShellBlock(text: string): string | null {
  let isInBlock = false
  let buffer: string[] = []
  let last: string | null = null

  for (const line of text.split('\n')) {
    if (!isInBlock && FENCE_OPEN.test(line)) {
      isInBlock = true
      buffer = []
      continue
    }
    if (isInBlock && FENCE_CLOSE.test(line)) {
      isInBlock = false
      last = buffer.join('\n')
      continue
    }
    if (isInBlock) buffer.push(line)
  }

  return last
}

export function classifyKind(command: string): ActionKind {
  return INTERACTIVE.some(pattern => pattern.test(command)) ? 'interactive' : 'shell'
}

export function classifyRisk(command: string): ActionRisk {
  return RISKY.some(pattern => pattern.test(command)) ? 'risky' : 'safe'
}

/**
 * One action per command of a shell block. A `# comment` right above a
 * command is its label; a bare `cd <dir>` line sets the directory of the
 * commands after it instead of becoming one; `\` continuations and
 * heredocs stay one command.
 */
export function parseBlock(block: string): ParsedAction[] {
  const actions: ParsedAction[] = []
  const lines = block.split('\n')
  let comment: string | undefined
  let cwd: string | undefined

  const push = (command: string) => {
    actions.push({
      label: comment ?? shorten(command),
      command,
      cwd,
      kind: classifyKind(command),
      risk: classifyRisk(command),
    })
    comment = undefined
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      comment = undefined
      continue
    }
    if (trimmed.startsWith('#')) {
      comment = trimmed.replace(/^#+\s*/, '') || undefined
      continue
    }

    let command = trimmed
    while (command.endsWith('\\') && i + 1 < lines.length) {
      i += 1
      command += '\n' + (lines[i] ?? '').trimEnd()
    }

    const heredoc = HEREDOC.exec(command)
    if (heredoc) {
      const terminator = heredoc[1]
      while (i + 1 < lines.length) {
        i += 1
        const next = lines[i] ?? ''
        command += '\n' + next
        if (next.trim() === terminator) break
      }
    }

    const cd = BARE_CD.exec(command)
    if (cd) {
      cwd = cd[1] ?? cd[2] ?? cd[3]
      continue
    }

    push(command)
  }

  return actions
}

export function shorten(command: string, max = 60): string {
  const oneLine = command.replace(/\s*\n\s*/g, ' ')
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}
