import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Snapshot, Tokens } from '../types'

const EMPTY_TOKENS: Tokens = {
  requests: 0,
  input: 0,
  write: 0,
  read: 0,
  output: 0,
  thinking: 0,
  fullMisses: 0,
}
const EMPTY_LEDGER: Ledger = {
  main: EMPTY_TOKENS,
  sub: EMPTY_TOKENS,
  agents: { runs: 0, tokens: 0, toolUses: 0, durationMs: 0 },
  transcriptPath: null,
  subagentFiles: [],
  offsets: {},
  lastMessageIds: {},
  cacheTtlMs: null,
  lastRequestAt: null,
  baseline: {},
}

const snapshot = atom({ plugin: 'context-hud', key: 'snapshot' } as const, null)
const ledger = atom({ plugin: 'context-hud', key: 'hudLedger' } as const, EMPTY_LEDGER)
const tick = atom({ plugin: 'context-hud', key: 'tick' } as const, 0)

const TICK_MS = 15_000
const BAR_WIDTH = 12
const RING_COLOR = '#d97757'
const RING_TRACK = 'rgba(128,128,128,0.3)'

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

// The cache_creation keys spell the TTL each write used, e.g. ephemeral_1h_input_tokens.
const TTL_KEY = /^ephemeral_(\d+)([mh])_input_tokens$/
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000 }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation?: Record<string, number>
  output_tokens_details?: { thinking_tokens?: number | null } | null
}

async function takeSnapshot($: EngineInterface): Promise<Snapshot> {
  const usage = await $.session.usage()
  return {
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
    percent: usage.context.percent ?? null,
    limits: usage.rateLimits.map(({ kind, percentUsed }) => ({ kind, percentUsed })),
    costUsd: usage.cost?.usd ?? null,
  }
}

async function refresh($: EngineInterface) {
  const snap = await takeSnapshot($)
  await update($, snapshot, () => snap)
  await update($, ledger, old => withBaseline(old, snap.limits))
}

// The first reading of each rate-limit window, so the band can show what this session added.
// A reading below the baseline means the window reset, so it becomes the new baseline.
function withBaseline(old: Ledger, limits: Snapshot['limits']): Ledger {
  const baseline = { ...old.baseline }
  for (const limit of limits) {
    const start = baseline[limit.kind]
    if (start === undefined || limit.percentUsed < start) baseline[limit.kind] = limit.percentUsed
  }
  return { ...old, baseline }
}

function ttlOf(usage: Usage) {
  for (const [key, count] of Object.entries(usage.cache_creation ?? {})) {
    const match = TTL_KEY.exec(key)
    if (match === null || count === 0) continue
    const [, amount, unit] = match
    const unitMs = UNIT_MS[unit as string]
    if (unitMs === undefined) throw new Error(`context-hud: unknown cache TTL unit in ${key}`)
    return Number(amount) * unitMs
  }
  return null
}

function addUsage(total: Tokens, usage: Usage): Tokens {
  return {
    requests: total.requests + 1,
    input: total.input + usage.input_tokens,
    write: total.write + usage.cache_creation_input_tokens,
    read: total.read + usage.cache_read_input_tokens,
    output: total.output + usage.output_tokens,
    thinking: total.thinking + (usage.output_tokens_details?.thinking_tokens ?? 0),
    fullMisses:
      total.fullMisses +
      (usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens > 0 ? 1 : 0),
  }
}

function assertUsage(usage: unknown, path: string): asserts usage is Usage {
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
  for (const field of fields) {
    if (typeof (usage as Record<string, unknown>)[field] !== 'number') {
      throw new Error(`context-hud: ${path} has a usage without ${field}`)
    }
  }
}

// Each API response is written as one line per content block, all carrying the same
// message id and usage, so only the first line of each run of equal ids is counted.
function parseChunk(chunk: string, path: string, lastId: string | undefined) {
  const usages: Usage[] = []
  let previousId = lastId
  for (const line of chunk.split('\n')) {
    if (line === '') continue
    const entry = JSON.parse(line)
    if (entry.type !== 'assistant' || entry.message?.usage === undefined) continue
    const id: string = entry.message.id
    if (id === previousId) continue
    previousId = id
    assertUsage(entry.message.usage, path)
    usages.push(entry.message.usage)
  }
  return { usages, lastId: previousId }
}

// Reads only what was appended to the transcript since the last read; tail's output is
// capped at 4 MiB per call, so a long backlog is read in several passes.
async function ingest($: EngineInterface, path: string, bucket: 'main' | 'sub') {
  for (;;) {
    const book = await read($, ledger)
    const offset = book.offsets[path] ?? 0
    const ran = await $.process.run(['tail', '-c', `+${offset + 1}`, path])
    if (ran.exitCode !== 0) throw new Error(`context-hud: tail ${path}: ${ran.stderr}`)
    const end = ran.stdout.lastIndexOf('\n')
    if (end < 0) return
    const chunk = ran.stdout.slice(0, end + 1)
    const { usages, lastId } = parseChunk(chunk, path, book.lastMessageIds[path])
    const bytes = new TextEncoder().encode(chunk).length

    await update($, ledger, old => {
      let tokens = bucket === 'main' ? old.main : old.sub
      let cacheTtlMs = old.cacheTtlMs
      for (const usage of usages) {
        tokens = addUsage(tokens, usage)
        if (bucket === 'main') cacheTtlMs = ttlOf(usage) ?? cacheTtlMs
      }
      return {
        ...old,
        main: bucket === 'main' ? tokens : old.main,
        sub: bucket === 'sub' ? tokens : old.sub,
        transcriptPath: bucket === 'main' ? path : old.transcriptPath,
        subagentFiles:
          bucket === 'sub' && !old.subagentFiles.includes(path)
            ? [...old.subagentFiles, path]
            : old.subagentFiles,
        offsets: { ...old.offsets, [path]: offset + bytes },
        lastMessageIds: lastId === undefined ? old.lastMessageIds : { ...old.lastMessageIds, [path]: lastId },
        cacheTtlMs,
      }
    })
    if (!ran.isStdoutTruncated) return
  }
}

// Claude Code keeps transcripts under <config dir>/projects, the config dir being
// CLAUDE_CONFIG_DIR or ~/.claude when it is unset; the mod API exposes no path.
async function projectsDir($: EngineInterface) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured !== undefined) return `${configured}/projects`
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('context-hud: neither CLAUDE_CONFIG_DIR nor HOME is set')
  return `${home}/.claude/projects`
}

async function findOne($: EngineInterface, dir: string, name: string) {
  const ran = await $.process.run(['find', dir, '-name', name, '-type', 'f'])
  if (ran.exitCode !== 0) throw new Error(`context-hud: find ${name}: ${ran.stderr}`)
  const found = ran.stdout.split('\n').filter(line => line !== '')
  if (found.length !== 1) throw new Error(`context-hud: expected one ${name} under ${dir}, found ${found.length}`)
  return found[0] as string
}

async function ingestMain($: EngineInterface) {
  const known = (await read($, ledger)).transcriptPath
  const path = known ?? (await findOne($, await projectsDir($), `${await $.session.id()}.jsonl`))
  await ingest($, path, 'main')
}

async function ingestSubagent($: EngineInterface, agentId: string) {
  const path = await findOne($, await projectsDir($), `*${agentId}.jsonl`)
  await ingest($, path, 'sub')
}

function numberField(record: Record<string, unknown>, field: string) {
  const value = record[field]
  if (typeof value !== 'number') throw new Error(`context-hud: Agent result without ${field}`)
  return value
}

function ringSvg(percent: number) {
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const filled = (Math.min(100, percent) / 100) * circumference
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">` +
    `<circle cx="9" cy="9" r="${radius}" fill="none" stroke="${RING_TRACK}" stroke-width="3"/>` +
    `<circle cx="9" cy="9" r="${radius}" fill="none" stroke="${RING_COLOR}" stroke-width="3" stroke-linecap="round" ` +
    `stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 9 9)"/>` +
    `</svg>`
  )
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}

function formatDuration(ms: number) {
  if (ms >= 3_600_000) {
    const minutes = Math.floor((ms % 3_600_000) / 60_000)
    return `${Math.floor(ms / 3_600_000)}h${minutes === 0 ? '' : `${minutes}m`}`
  }
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 1000)}s`
}

function reasoningText(tokens: Tokens) {
  if (tokens.output === 0) return 'reasoning 0'
  const share = Math.round((tokens.thinking / tokens.output) * 100)
  return `reasoning ${formatTokens(tokens.thinking)} of ${formatTokens(tokens.output)} output (${share}%)`
}

export const register: Register = on => {
  // Two hooks can ingest at once (parallel tool calls); queueing them keeps offsets consistent.
  // A failed read still rejects for the hook that awaited it; the queue only moves past it.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (job: () => Promise<void>) => {
    const run = queue.then(job)
    queue = run.catch(() => undefined)
    return run
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    $.clock.every(TICK_MS, () => update($, tick, n => n + 1))
    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    // Agent calls made by subagents are already inside their parent's totals.
    if (e.agentId !== undefined) return ran
    await enqueue(() => ingestMain($))
    if (e.tool !== 'Agent') return ran
    // next(e) is typed for any tool here, so the Agent record's fields are checked at run time.
    const record = ran.result as Record<string, unknown> | undefined
    if (record?.status === 'completed') {
      const tokens = numberField(record, 'totalTokens')
      const toolUses = numberField(record, 'totalToolUseCount')
      const durationMs = numberField(record, 'totalDurationMs')
      const agentId = record.agentId
      if (typeof agentId !== 'string') throw new Error('context-hud: Agent result without agentId')
      await enqueue(() => ingestSubagent($, agentId))
      await update($, ledger, old => ({
        ...old,
        agents: {
          runs: old.agents.runs + 1,
          tokens: old.agents.tokens + tokens,
          toolUses: old.agents.toolUses + toolUses,
          durationMs: old.agents.durationMs + durationMs,
        },
      }))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    if (e.agentId === undefined) await enqueue(() => ingestMain($))
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      // The cache TTL counts from the start of the request that read or wrote the entry.
      const startedAt = await $.clock.now()
      await update($, ledger, old => ({ ...old, lastRequestAt: startedAt }))
    }
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null) {
      return next(e)
    }
    await read($, tick)
    const book = await read($, ledger)
    const elapsedMs = book.lastRequestAt === null ? null : (await $.clock.now()) - book.lastRequestAt

    const { Box, Text } = $.ui.resolve(e)
    const percent = snap.percent ?? 0
    // The terminal has no Svg element, so it gets a filled bar instead of a ring.
    const gauge = (name: string, value: number) =>
      e.surface === 'terminal' ? (
        <Box key={`bar-${name}`} width={BAR_WIDTH} height={1} backgroundColor="inactive">
          <Box width={`${Math.min(100, value)}%`} height={1} backgroundColor="claude" />
        </Box>
      ) : (
        <Box key={`ring-${name}`}>
          {(() => {
            const { Svg } = $.ui.resolve(e)
            return <Svg source={ringSvg(value)} alt={`${name} ${value}%`} width={18} height={18} />
          })()}
        </Box>
      )

    let cacheText: string | null = null
    if (elapsedMs !== null && book.cacheTtlMs !== null) {
      const ttl = book.cacheTtlMs
      cacheText = `cache ${elapsedMs >= ttl ? 'cold' : formatDuration(ttl - elapsedMs)}/${formatDuration(ttl)}`
    }

    const agentsRan = book.agents.runs > 0 || book.subagentFiles.length > 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          {gauge('context', percent)}
          <Text> {snap.percent === null ? '--' : `${percent}%`}</Text>
          {snap.tokens !== null && (
            <Text dimColor>
              {' '}
              {formatTokens(snap.tokens)}/{formatTokens(snap.window)}
            </Text>
          )}
          {cacheText !== null && <Text>{` │ ${cacheText}`}</Text>}
          {snap.limits.map(limit => {
            const added = limit.percentUsed - (book.baseline[limit.kind] ?? limit.percentUsed)
            return (
              <Box key={`limit-${limit.kind}`} flexDirection="row" alignItems="center">
                <Text>{` │ ${LIMIT_LABELS[limit.kind] ?? limit.kind} `}</Text>
                {gauge(limit.kind, limit.percentUsed)}
                <Text>
                  {' '}
                  {limit.percentUsed}%{added > 0 ? ` (+${Math.round(added * 10) / 10})` : ''}
                </Text>
              </Box>
            )
          })}
          {snap.costUsd !== null && <Text dimColor>{` │ $${snap.costUsd.toFixed(2)}`}</Text>}
        </Box>
        <Text dimColor wrap="wrap">
          {book.transcriptPath === null
            ? 'main: transcript not read yet'
            : `main: ${reasoningText(book.main)} · ${book.main.requests} requests` +
              ` · cache read ${formatTokens(book.main.read)} / write ${formatTokens(book.main.write)}` +
              ` · full misses ${book.main.fullMisses}`}
        </Text>
        {agentsRan && (
          <Text dimColor wrap="wrap">
            {`agents: ${book.agents.runs} finished · ${formatTokens(book.agents.tokens)} tokens` +
              ` · ${book.agents.toolUses} tool calls · ${formatDuration(book.agents.durationMs)}`}
            {book.subagentFiles.length > 0 ? ` · ${reasoningText(book.sub)}` : ''}
          </Text>
        )}
      </Box>
    )
  })
}
