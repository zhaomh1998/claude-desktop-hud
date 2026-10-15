export type Snapshot = {
  tokens: number | null
  window: number
  percent: number | null
  limits: { kind: string; percentUsed: number }[]
  costUsd: number | null
}

export type Tokens = {
  requests: number
  input: number
  write: number
  read: number
  output: number
  thinking: number
  fullMisses: number
}

export type Agents = {
  runs: number
  tokens: number
  toolUses: number
  durationMs: number
}

export type Ledger = {
  main: Tokens
  sub: Tokens
  agents: Agents
  transcriptPath: string | null
  subagentFiles: string[]
  offsets: Record<string, number>
  lastMessageIds: Record<string, string>
  cacheTtlMs: number | null
  lastRequestAt: number | null
  baseline: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'context-hud': {
      snapshot: Snapshot | null
      hudLedger: Ledger
      tick: number
    }
  }
}
