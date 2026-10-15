import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 200,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

function assistantLine(id: string, usage: object) {
  return JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage } })
}

const WRITE_1H = {
  input_tokens: 2,
  output_tokens: 300,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 20_000,
  cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 },
  output_tokens_details: { thinking_tokens: 120 },
}
const READ = {
  input_tokens: 3,
  output_tokens: 100,
  cache_read_input_tokens: 20_000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
  output_tokens_details: { thinking_tokens: 0 },
}
// The same response appears once per content block in the transcript.
const TRANSCRIPT =
  [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    assistantLine('msg_1', WRITE_1H),
    assistantLine('msg_1', WRITE_1H),
    assistantLine('msg_2', READ),
  ].join('\n') + '\n'

function answerSession(on: On) {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 150_000, window: 200_000, percent: 75 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23 }],
      cost: { usd: 1.5 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws context usage on ${surface}`, async ($, on) => {
    answerSession(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'context-hud', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ text: /75%/ })).toBeDefined()
    expect(await ui.find({ text: /150k\/200k/ })).toBeDefined()
    expect(await ui.find({ text: /23%/ })).toBeDefined()
    expect(await ui.find({ text: /\$1\.50/ })).toBeDefined()
    const kind = surface === 'terminal' ? 'bar' : 'ring'
    expect(await ui.find({ key: `${kind}-context` })).toBeDefined()
    expect(await ui.find({ key: `${kind}-five_hour` })).toBeDefined()
    expect(await ui.find({ text: /main: transcript not read yet/ })).toBeDefined()
  })
}

test('counts tokens from the transcript and the cache TTL it used', async ($, on) => {
  const clock = mock.clock(on)
  answerSession(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 's1' }))
  const calls: string[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv.join(' '))
    const ran = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'find') return { value: { ...ran, stdout: '/home/me/.claude/projects/p/s1.jsonl\n' } }
    const from = Number((e.argv[2] ?? '+1').slice(1)) - 1
    return { value: { ...ran, stdout: TRANSCRIPT.slice(from) } }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _ of step);
  const turn = { turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' as const }
  await $.turn.complete(turn)
  await $.turn.complete(turn)

  expect(calls).toEqual([
    'find /home/me/.claude/projects -name s1.jsonl -type f',
    'tail -c +1 /home/me/.claude/projects/p/s1.jsonl',
    `tail -c +${TRANSCRIPT.length + 1} /home/me/.claude/projects/p/s1.jsonl`,
  ])
  const ui = await $.ui.mount({ plugin: 'context-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ text: /cache 1h\/1h/ })).toBeDefined()
  expect(
    await ui.find({
      text: /main: reasoning 120 of 400 output \(30%\) · 2 requests · cache read 20k \/ write 21k · full misses 1/,
    }),
  ).toBeDefined()

  await clock.advance(61 * 60_000)
  expect(await ui.find({ text: /cache cold\/1h/ })).toBeDefined()
})

test('adds up finished Agent runs from their results', async ($, on) => {
  answerSession(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 's1' }))
  on('process.run', (_, e) => {
    const ran = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'find') return { value: { ...ran, stdout: `/home/me/.claude/projects/p/${e.argv[3]}\n` } }
    return { value: { ...ran, stdout: TRANSCRIPT } }
  })
  on('tool.call', () => ({
    result: { status: 'completed', agentId: 'a1', totalTokens: 52_000, totalToolUseCount: 7, totalDurationMs: 95_000 },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })

  const ui = await $.ui.mount({ plugin: 'context-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(
    await ui.find({ text: /agents: 1 finished · 52k tokens · 7 tool calls · 1m · reasoning 120 of 400 output \(30%\)/ }),
  ).toBeDefined()
})
