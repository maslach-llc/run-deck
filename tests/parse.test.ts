import { expect, test } from 'claude-code/testing'

import { classifyKind, classifyRisk, lastShellBlock, parseBlock, stepKey } from '../hooks/parse'

const REPLY = `## Summary

Done.

\`\`\`bash
echo not this one
\`\`\`

## Run

\`\`\`bash
cd ~/project
# Log in first
gh auth login
npm run build && npm test
git push origin main
cat > note.txt <<'EOF'
hello
EOF
\`\`\`
`

test('the last shell block is the one parsed', async () => {
  const block = lastShellBlock(REPLY)
  expect(block).not.toBeNull()
  const actions = parseBlock(block!)

  expect(actions.map(a => a.command)).toEqual([
    'gh auth login',
    'npm run build && npm test',
    'git push origin main',
    "cat > note.txt <<'EOF'\nhello\nEOF",
  ])
  expect(actions[0]!.label).toBe('Log in first')
  expect(actions[0]!.kind).toBe('interactive')
  expect(actions.every(a => a.cwd === '~/project')).toBe(true)
  expect(actions[2]!.risk).toBe('risky')
  expect(actions[1]!.risk).toBe('safe')
})

test('a reply with no shell block parses to nothing', async () => {
  expect(lastShellBlock('just words\n```json\n{}\n```')).toBeNull()
  expect(parseBlock('# only a comment\n\n')).toEqual([])
})

test('continuations stay one command', async () => {
  const [one] = parseBlock('docker run \\\n  -it app')
  expect(one!.command).toBe('docker run \\\n  -it app')
  expect(one!.kind).toBe('interactive')
})

test('classifiers', async () => {
  expect(classifyRisk('rm -rf build')).toBe('risky')
  expect(classifyRisk('gcloud run deploy api --project my-prod')).toBe('risky')
  expect(classifyRisk('ls -la')).toBe('safe')
  expect(classifyKind('nvim .')).toBe('interactive')
  expect(classifyKind('npm run lint')).toBe('shell')
})

test('stepKey walks the rows and stops at the ends', () => {
  const keys = ['t1', 'c1-o1', 'c1-o2', 'send']
  expect(stepKey(keys, null, 1)).toBe('t1')
  expect(stepKey(keys, null, -1)).toBe('send')
  expect(stepKey(keys, 'move-down', 1)).toBe('t1')
  expect(stepKey(keys, 't1', 1)).toBe('c1-o1')
  expect(stepKey(keys, 'c1-o2', -1)).toBe('c1-o1')
  expect(stepKey(keys, 'send', 1)).toBe('send')
  expect(stepKey(keys, 't1', -1)).toBe('t1')
  expect(stepKey([], null, 1)).toBeUndefined()
})
