import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Orchestrator } from "@/orchestrator"
import type { Agent } from "@/agent/agent"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node)))

const FAKE = path.join(import.meta.dir, "fake-cli.ts")

const agent = (options: Record<string, unknown> = {}): Agent.Info => ({
  name: "orchestrator",
  mode: "primary",
  permission: [],
  options: {
    orchestrator: true,
    maxReviewRounds: 3,
    claudeBin: process.execPath,
    claudeArgs: [FAKE],
    codexBin: process.execPath,
    codexArgs: [FAKE],
    ...options,
  },
})

const harness = (dir: string, env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const state = path.join(dir, ".fake-state")
    yield* Effect.promise(() => fs.mkdir(state, { recursive: true }))
    for (const key of ["FAKE_ROUTE", "FAKE_APPROVE_AT", "FAKE_CODEX_NOOP", "FAKE_CLAUDE_FAIL"]) delete process.env[key]
    Object.assign(process.env, { FAKE_STATE: state }, env)

    const parts = new Map<string, SessionV1.Part>()
    const messages = new Map<string, SessionV1.Info>()
    const errors: unknown[] = []
    const sessions = {
      updateMessage: (msg: SessionV1.Info) => Effect.sync(() => (messages.set(msg.id, structuredClone(msg)), msg)),
      updatePart: (part: SessionV1.Part) => Effect.sync(() => (parts.set(part.id, structuredClone(part)), part)),
    } as any
    const events = { publish: (_def: unknown, data: unknown) => Effect.sync(() => void errors.push(data)) } as any

    const sessionID = SessionID.make("ses_test")
    const user: SessionV1.User = {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "orchestrator",
      model: { providerID: "x" as any, modelID: "y" as any },
    }
    const msgs: SessionV1.WithParts[] = [
      {
        info: user,
        parts: [{ type: "text", id: PartID.ascending(), messageID: user.id, sessionID, text: "make hello.txt" }],
      },
    ]
    const count = (name: string) =>
      fs.readFile(path.join(state, name), "utf8").then(Number, () => 0)
    const run = (options?: Record<string, unknown>) =>
      Orchestrator.run(
        { sessions, spawner, events },
        { sessionID, lastUser: user, msgs, agent: agent(options), directory: dir, root: dir },
      )
    const tools = () => [...parts.values()].filter((p): p is SessionV1.ToolPart => p.type === "tool")
    const texts = () => [...parts.values()].flatMap((p) => (p.type === "text" ? [p.text] : []))
    return { run, parts, messages, errors, count, tools, texts }
  })

const gitRepo = tmpdirScoped({ git: true })

// git may convert line endings when applying the patch (core.autocrlf on Windows).
const readHello = (dir: string) =>
  fs.readFile(path.join(dir, "hello.txt"), "utf8").then((s) => s.replaceAll("\r\n", "\n"))

describe("orchestrator", () => {
  it.live("answers questions via codex without building", () =>
    Effect.gen(function* () {
      const dir = yield* gitRepo
      const h = yield* harness(dir, { FAKE_ROUTE: "answer" })
      const msg = yield* h.run()
      expect(msg.finish).toBe("stop")
      expect(h.texts()).toEqual(["It is a test repo."])
      expect(h.tools().map((t) => t.tool)).toEqual(["orchestrator_route"])
      expect(yield* Effect.promise(() => h.count("plan"))).toBe(0)
    }),
  )

  it.live("plans, builds, gets approved in round 1 and applies to the working tree", () =>
    Effect.gen(function* () {
      const dir = yield* gitRepo
      const h = yield* harness(dir, { FAKE_APPROVE_AT: "1" })
      const msg = yield* h.run()
      expect(msg.error).toBeUndefined()
      expect(h.tools().map((t) => [t.tool, t.state.status])).toEqual([
        ["orchestrator_route", "completed"],
        ["orchestrator_plan", "completed"],
        ["orchestrator_worktree", "completed"],
        ["orchestrator_build", "completed"],
        ["orchestrator_review", "completed"],
        ["orchestrator_apply", "completed"],
      ])
      const content = yield* Effect.promise(() => readHello(dir))
      expect(content).toBe("line build 1\n")
      expect(h.texts().at(-1)).toContain("Approved by Claude after 1 review round")
      expect(msg.cost).toBeCloseTo(0.03)
    }),
  )

  it.live("loops codex fixes until claude approves in round 2", () =>
    Effect.gen(function* () {
      const dir = yield* gitRepo
      const h = yield* harness(dir, { FAKE_APPROVE_AT: "2" })
      yield* h.run()
      expect(yield* Effect.promise(() => h.count("review"))).toBe(2)
      expect(yield* Effect.promise(() => h.count("fix"))).toBe(1)
      const content = yield* Effect.promise(() => readHello(dir))
      expect(content).toBe("line build 1\nline fix 1\n")
      expect(h.texts().at(-1)).toContain("Approved by Claude after 2 review rounds")
    }),
  )

  it.live("stops after max rounds, still applies codex code and reports claude's issues", () =>
    Effect.gen(function* () {
      const dir = yield* gitRepo
      const h = yield* harness(dir, { FAKE_APPROVE_AT: "0" })
      const msg = yield* h.run()
      expect(msg.finish).toBe("stop")
      expect(yield* Effect.promise(() => h.count("review"))).toBe(3)
      expect(yield* Effect.promise(() => h.count("fix"))).toBe(2)
      const summary = h.texts().at(-1)!
      expect(summary).toContain("Not approved after 3 review rounds")
      expect(summary).toContain("problem 3")
      expect(summary).toContain("consider a trailing newline")
      const content = yield* Effect.promise(() => readHello(dir))
      expect(content).toBe("line build 1\nline fix 1\nline fix 2\n")
    }),
  )

  it.live("fails cleanly when claude errors", () =>
    Effect.gen(function* () {
      const dir = yield* gitRepo
      const h = yield* harness(dir, { FAKE_CLAUDE_FAIL: "1" })
      const msg = yield* h.run()
      expect(msg.finish).toBe("error")
      expect(msg.error).toBeDefined()
      expect(h.errors.length).toBe(1)
      const plan = h.tools().find((t) => t.tool === "orchestrator_plan")!
      expect(plan.state.status).toBe("error")
    }),
  )

  it.live("requires a git repository to build", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const h = yield* harness(dir, {})
      const msg = yield* h.run()
      expect(msg.finish).toBe("error")
      const wt = h.tools().find((t) => t.tool === "orchestrator_worktree")!
      expect(wt.state.status).toBe("error")
      expect(wt.state.status === "error" && wt.state.error).toContain("git repository")
    }),
  )
})
