import path from "path"
import os from "os"
import fs from "fs/promises"
import { ulid } from "ulid"
import { Cause, Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Global } from "@opencode-ai/core/global"
import { NamedError } from "@opencode-ai/core/util/error"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Agent } from "@/agent/agent"
import * as Cli from "./cli"
import * as Prompts from "./prompts"

export interface Options {
  claudeBin: string
  codexBin: string
  /** Extra leading arguments, e.g. to run the CLI through a wrapper. */
  claudeArgs: string[]
  codexArgs: string[]
  claudeModel?: string
  codexModel?: string
  maxReviewRounds: number
  keepWorktree: boolean
  historyMessages: number
  maxDiffChars: number
}

export interface Deps {
  readonly sessions: Session.Interface
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly events: EventV2Bridge.Service["Service"]
}

export interface RunInput {
  readonly sessionID: SessionID
  readonly lastUser: SessionV1.User
  readonly msgs: SessionV1.WithParts[]
  readonly agent: Agent.Info
  readonly directory: string
  readonly root: string
}

export const isOrchestrator = (agent: Agent.Info) => agent.options.orchestrator === true

export const options = (agent: Agent.Info): Options => {
  const o = agent.options
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
  return {
    claudeBin: str(o.claudeBin) ?? process.env.OPENCODE_ORCHESTRATOR_CLAUDE ?? "claude",
    codexBin: str(o.codexBin) ?? process.env.OPENCODE_ORCHESTRATOR_CODEX ?? "codex",
    claudeArgs: list(o.claudeArgs),
    codexArgs: list(o.codexArgs),
    claudeModel: str(o.claudeModel),
    codexModel: str(o.codexModel),
    maxReviewRounds: Math.max(1, Math.floor(num(o.maxReviewRounds, 3))),
    keepWorktree: o.keepWorktree === true,
    historyMessages: Math.max(0, Math.floor(num(o.historyMessages, 10))),
    maxDiffChars: Math.max(1000, Math.floor(num(o.maxDiffChars, 150_000))),
  }
}

class OrchestratorError extends Error {}

const fail = (message: string) => Effect.fail(new OrchestratorError(message))

const toError = (e: unknown): Error =>
  e instanceof Error ? e : new OrchestratorError(typeof e === "object" && e && "message" in e ? String(e.message) : String(e))

const textOf = (msg: SessionV1.WithParts) =>
  msg.parts
    .flatMap((p) => (p.type === "text" && !p.synthetic && !p.ignored ? [p.text] : []))
    .join("\n")
    .trim()

/** Last N user/assistant exchanges as plain text, excluding the current user message. */
export const history = (msgs: SessionV1.WithParts[], lastUserID: string, limit: number) =>
  msgs
    .filter((m) => m.info.id !== lastUserID)
    .map((m) => ({ role: m.info.role, text: textOf(m) }))
    .filter((m) => m.text)
    .slice(-limit)
    .map((m) => `[${m.role}]\n${m.text.length > 4000 ? m.text.slice(0, 4000) + "\n…(truncated)" : m.text}`)
    .join("\n\n")

const shortInput = (input: unknown) => {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  const v = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.url ?? o.description
  return typeof v === "string" ? v.slice(0, 200) : ""
}

export const run = Effect.fn("Orchestrator.run")(function* (deps: Deps, input: RunInput) {
  const { sessions, spawner, events } = deps
  const opts = options(input.agent)

  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    parentID: input.lastUser.id,
    role: "assistant",
    mode: input.agent.name,
    agent: input.agent.name,
    path: { cwd: input.directory, root: input.root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "claude+codex" as SessionV1.Assistant["modelID"],
    providerID: "orchestrator" as SessionV1.Assistant["providerID"],
    time: { created: Date.now() },
    sessionID: input.sessionID,
  }
  yield* sessions.updateMessage(msg)

  const running: SessionV1.ToolPart[] = []

  const text = (value: string) =>
    sessions.updatePart({
      type: "text",
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      text: value,
      time: { start: Date.now(), end: Date.now() },
    } satisfies SessionV1.TextPart)

  /** Run one pipeline phase as a live tool part in the session. */
  const phase = <A>(
    tool: string,
    title: string,
    body: (log: (line: string) => Effect.Effect<void>) => Effect.Effect<A, Error>,
    output?: (a: A) => string,
  ) =>
    Effect.gen(function* () {
      const start = Date.now()
      const part: SessionV1.ToolPart = {
        type: "tool",
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        tool: `orchestrator_${tool}`,
        callID: ulid(),
        state: { status: "running", input: { title }, title, metadata: { output: "" }, time: { start } },
      }
      yield* sessions.updatePart(part)
      running.push(part)
      let log = ""
      const append = (line: string) =>
        Effect.gen(function* () {
          if (!line.trim()) return
          log += (log ? "\n" : "") + line.trimEnd()
          if (log.length > 60_000) log = "…\n" + log.slice(-50_000)
          if (part.state.status !== "running") return
          part.state.metadata = { output: log }
          yield* sessions.updatePart(part)
        })
      const exit = yield* body(append).pipe(Effect.exit)
      running.splice(running.indexOf(part), 1)
      if (exit._tag === "Success") {
        part.state = {
          status: "completed",
          input: { title },
          title,
          output: output ? output(exit.value) : log,
          metadata: { output: log },
          time: { start, end: Date.now() },
        }
        yield* sessions.updatePart(part)
        return exit.value
      }
      const error = Cause.prettyErrors(exit.cause)
        .map((e) => e.message)
        .join("\n")
      part.state = {
        status: "error",
        input: { title },
        error: error || "failed",
        metadata: { output: log },
        time: { start, end: Date.now() },
      }
      yield* sessions.updatePart(part)
      return yield* Effect.failCause(exit.cause)
    })

  // ---------- process helpers ----------

  const exec = (bin: string, args: string[], cwd: string, opts?: { stdin?: string; onLine?: (l: unknown) => Effect.Effect<void> }) =>
    Cli.run(spawner, { bin, args, cwd, stdin: opts?.stdin, onLine: opts?.onLine }).pipe(Effect.mapError(toError))

  const git = (args: string[], cwd: string, stdin?: string) =>
    Effect.gen(function* () {
      const result = yield* exec("git", ["-c", "core.quotepath=false", ...args], cwd, { stdin })
      if (result.exitCode !== 0) return yield* Effect.fail(new Cli.CliError(`git ${args.join(" ")}`, result.exitCode, result.stderr))
      return result.stdout.trim()
    })

  const schemaFile = (name: string, schema: object) =>
    Effect.promise(async () => {
      const dir = path.join(os.tmpdir(), "opencode-orchestrator")
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${name}.json`)
      await fs.writeFile(file, JSON.stringify(schema))
      return file
    })

  const addUsage = (usage: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; cost?: number }) =>
    Effect.gen(function* () {
      msg.tokens.input += usage.input ?? 0
      msg.tokens.output += usage.output ?? 0
      msg.tokens.reasoning += usage.reasoning ?? 0
      msg.tokens.cache.read += usage.cacheRead ?? 0
      msg.tokens.cache.write += usage.cacheWrite ?? 0
      msg.cost += usage.cost ?? 0
      yield* sessions.updateMessage(msg)
    })

  // ---------- codex ----------

  interface CodexResult {
    threadID?: string
    message: string
  }

  const codex = (args: string[], cwd: string, prompt: string, log: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      let threadID: string | undefined
      let message = ""
      let failure: string | undefined
      const model = opts.codexModel ? ["-m", opts.codexModel] : []
      const result = yield* exec(opts.codexBin, [...opts.codexArgs, ...args, ...model], cwd, {
        stdin: prompt,
        onLine: (line) =>
          Effect.gen(function* () {
            if (typeof line === "string") return yield* log(line)
            const ev = line as Record<string, any>
            switch (ev.type) {
              case "thread.started":
                threadID = ev.thread_id
                return
              case "item.started":
                if (ev.item?.type === "command_execution") yield* log(`$ ${ev.item.command}`)
                return
              case "item.completed": {
                const item = ev.item ?? {}
                if (item.type === "agent_message") {
                  message = item.text ?? ""
                  return yield* log(message)
                }
                if (item.type === "command_execution" && item.exit_code !== 0 && item.exit_code != null)
                  return yield* log(`  ↳ exit ${item.exit_code}`)
                if (item.type === "file_change")
                  return yield* log(
                    (item.changes ?? []).map((c: any) => `✎ ${c.kind ?? "update"} ${c.path}`).join("\n"),
                  )
                if (item.type === "error") return yield* log(`⚠ ${item.message}`)
                return
              }
              case "turn.completed":
                return yield* addUsage({
                  input: (ev.usage?.input_tokens ?? 0) - (ev.usage?.cached_input_tokens ?? 0),
                  output: ev.usage?.output_tokens,
                  reasoning: ev.usage?.reasoning_output_tokens,
                  cacheRead: ev.usage?.cached_input_tokens,
                })
              case "turn.failed":
                failure = ev.error?.message ?? "Codex turn failed"
                return yield* log(`⚠ ${failure}`)
              case "error":
                failure = ev.message ?? "Codex error"
                return yield* log(`⚠ ${failure}`)
            }
          }),
      })
      if (result.exitCode !== 0 || failure)
        return yield* Effect.fail(new Cli.CliError("codex", result.exitCode, failure ?? result.stderr))
      return { threadID, message } satisfies CodexResult
    })

  // ---------- claude ----------

  const claude = (args: string[], cwd: string, prompt: string, log: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      let final: Record<string, any> | undefined
      const model = opts.claudeModel ? ["--model", opts.claudeModel] : []
      const result = yield* exec(
        opts.claudeBin,
        [...opts.claudeArgs, "-p", "--output-format", "stream-json", "--verbose", ...model, ...args],
        cwd,
        {
          stdin: prompt,
          onLine: (line) =>
            Effect.gen(function* () {
              if (typeof line === "string") return yield* log(line)
              const ev = line as Record<string, any>
              if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
                for (const block of ev.message.content) {
                  if (block.type === "text" && block.text) yield* log(block.text)
                  if (block.type === "tool_use" && block.name !== "StructuredOutput")
                    yield* log(`→ ${block.name} ${shortInput(block.input)}`)
                }
              }
              if (ev.type === "result") final = ev
            }),
        },
      )
      if (final) {
        const u = final.usage ?? {}
        yield* addUsage({
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
          cost: final.total_cost_usd,
        })
      }
      if (!final || final.is_error || result.exitCode !== 0)
        return yield* Effect.fail(
          new Cli.CliError("claude", result.exitCode, (final?.result as string | undefined) ?? result.stderr),
        )
      return final
    })

  // ---------- pipeline ----------

  const userText = textOf({ info: input.lastUser, parts: input.msgs.find((m) => m.info.id === input.lastUser.id)?.parts ?? [] })
  const hist = history(input.msgs, input.lastUser.id, opts.historyMessages)

  const pipeline = Effect.gen(function* () {
    if (!userText) return yield* fail("The orchestrator needs a text message.")

    // 1. Route (Codex, read-only)
    const routerSchema = yield* schemaFile("router", Prompts.ROUTER_SCHEMA)
    const route = yield* phase(
      "route",
      "Codex · routing request",
      (log) =>
        Effect.gen(function* () {
          const result = yield* codex(
            ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "--output-schema", routerSchema, "-"],
            input.directory,
            Prompts.router({ history: hist, message: userText }),
            log,
          )
          const parsed = yield* Effect.try({
            try: () => JSON.parse(result.message) as Prompts.Route,
            catch: () => new OrchestratorError(`Router returned invalid JSON: ${result.message.slice(0, 500)}`),
          })
          if (parsed.kind !== "answer" && parsed.kind !== "build")
            return yield* fail(`Router returned unknown kind: ${String(parsed.kind)}`)
          return parsed
        }),
      (r) => (r.kind === "answer" ? "answer" : `build: ${r.task}`),
    )

    if (route.kind === "answer") {
      yield* text(route.answer || "(Codex returned an empty answer.)")
      return
    }
    const task = route.task.trim() || userText

    // 2. Plan (Claude, read-only)
    const plan = yield* phase(
      "plan",
      "Claude · planning",
      (log) =>
        claude(
          ["--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob,LS"],
          input.directory,
          Prompts.plan({ history: hist, task }),
          log,
        ).pipe(Effect.map((final) => String(final.result ?? "").trim())),
      (plan) => plan,
    )
    if (!plan) return yield* fail("Claude returned an empty plan.")
    yield* text(`## Plan\n\n${plan}`)

    // 3. Isolated worktree
    const wt = yield* phase(
      "worktree",
      "Creating isolated git worktree",
      (log) =>
        Effect.gen(function* () {
          const root = yield* git(["rev-parse", "--show-toplevel"], input.directory).pipe(
            Effect.mapError(
              () =>
                new OrchestratorError(
                  "The orchestrator builds in an isolated git worktree, so the project must be a git repository with at least one commit.",
                ),
            ),
          )
          const head = yield* git(["rev-parse", "HEAD"], root).pipe(
            Effect.mapError(() => new OrchestratorError("The repository has no commits yet. Make an initial commit first.")),
          )
          // Carry uncommitted tracked changes into the worktree without touching the user's tree.
          const stash = yield* git(["stash", "create"], root)
          const base = stash || head
          const slug = `orch-${Date.now().toString(36)}`
          const branch = `orchestrator/${slug}`
          const dir = path.join(Global.Path.data, "orchestrator", slug)
          yield* git(["worktree", "add", "-b", branch, dir, base], root)
          yield* log(`branch ${branch}\npath   ${dir}\nbase   ${base}${stash ? " (includes your uncommitted changes)" : ""}`)
          return { root, base, branch, dir, cwd: path.join(dir, path.relative(root, input.directory)) }
        }),
      (wt) => `${wt.branch} at ${wt.dir}`,
    )

    const diff = Effect.gen(function* () {
      yield* git(["add", "-A"], wt.dir)
      const files = (yield* git(["diff", "--cached", "--name-only", wt.base], wt.dir)).split("\n").filter(Boolean)
      const stat = yield* git(["diff", "--cached", "--stat", wt.base], wt.dir)
      let patch = yield* git(["diff", "--cached", wt.base], wt.dir)
      if (patch.length > opts.maxDiffChars)
        patch =
          patch.slice(0, opts.maxDiffChars) +
          `\n\n…(diff truncated at ${opts.maxDiffChars} characters; read the remaining files directly)\n\nFull stat:\n${stat}`
      return { files, stat, patch }
    })

    // 4. Build (Codex, workspace-write in the worktree)
    const built = yield* phase(
      "build",
      "Codex · building",
      (log) =>
        codex(
          ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", wt.cwd, "-"],
          wt.cwd,
          Prompts.build({ task, plan }),
          log,
        ),
      (r) => r.message,
    )

    // 5. Review loop (Claude reviews, Codex fixes)
    const reviewSchema = JSON.stringify(Prompts.REVIEW_SCHEMA)
    let review: Prompts.Review | undefined
    let changes = yield* diff
    let rounds = 0
    for (let round = 1; round <= opts.maxReviewRounds; round++) {
      rounds = round
      if (changes.files.length === 0) {
        review = {
          approved: false,
          summary: "Codex made no changes.",
          issues: [{ severity: "blocking", file: "-", problem: "The diff is empty.", fix: "Implement the plan." }],
          suggestions: [],
        }
      } else {
        const diffNow = changes
        review = yield* phase(
          "review",
          `Claude · review ${round}/${opts.maxReviewRounds}`,
          (log) =>
            claude(
              ["--json-schema", reviewSchema, "--allowedTools", "Read,Grep,Glob,LS", "--add-dir", wt.dir],
              wt.cwd,
              Prompts.review({ task, plan, diff: diffNow.patch, round, max: opts.maxReviewRounds }),
              log,
            ).pipe(
              Effect.flatMap((final) =>
                final.structured_output
                  ? Effect.succeed(final.structured_output as Prompts.Review)
                  : fail("Claude did not return a structured review."),
              ),
            ),
          (r) => (r.approved ? `approved: ${r.summary}` : `changes requested: ${r.summary}`),
        )
      }
      if (review.approved || round === opts.maxReviewRounds) break
      const current = review
      yield* phase(
        "fix",
        `Codex · fixing review ${round} feedback`,
        (log) =>
          built.threadID
            ? codex(
                ["exec", "resume", "--json", "-c", 'sandbox_mode="workspace-write"', "--skip-git-repo-check", built.threadID, "-"],
                wt.cwd,
                Prompts.fix({ review: current, round }),
                log,
              )
            : codex(
                ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", wt.cwd, "-"],
                wt.cwd,
                Prompts.build({ task, plan }) + "\n\n" + Prompts.fix({ review: current, round }),
                log,
              ),
        (r) => r.message,
      )
      changes = yield* diff
    }

    // 6. Bring Codex's changes into the user's working tree
    const applied = yield* phase(
      "apply",
      "Applying changes to your working tree",
      (log) =>
        Effect.gen(function* () {
          if (changes.files.length === 0) {
            yield* log("No changes to apply.")
            return { ok: true, files: [] as string[] }
          }
          yield* git(
            ["-c", "user.name=opencode-orchestrator", "-c", "user.email=orchestrator@opencode.local", "commit", "--no-verify", "-q", "-m", `orchestrator: ${task.slice(0, 72)}`],
            wt.dir,
          )
          const patch = (yield* git(["diff", "--binary", wt.base, "HEAD"], wt.dir)) + "\n"
          const plain = yield* exec("git", ["apply", "--whitespace=nowarn", "-"], wt.root, { stdin: patch })
          if (plain.exitCode === 0) {
            yield* log(changes.stat)
            return { ok: true, files: changes.files }
          }
          const threeWay = yield* exec("git", ["apply", "--3way", "--whitespace=nowarn", "-"], wt.root, { stdin: patch })
          yield* log(changes.stat)
          if (threeWay.exitCode === 0) {
            yield* log("Applied with 3-way merge (changes are staged).")
            return { ok: true, files: changes.files }
          }
          yield* log(`Could not apply cleanly:\n${threeWay.stderr.trim()}`)
          return { ok: false, files: changes.files }
        }),
      (r) => (r.ok ? `${r.files.length} file(s) applied` : "conflict: changes left on branch"),
    )

    if (applied.ok && !opts.keepWorktree)
      yield* git(["worktree", "remove", "--force", wt.dir], wt.root).pipe(Effect.ignore)

    // 7. Summary
    const lines: string[] = []
    const approved = review?.approved === true
    lines.push(
      approved
        ? `## ✅ Approved by Claude after ${rounds} review round${rounds === 1 ? "" : "s"}`
        : `## ⚠️ Not approved after ${rounds} review round${rounds === 1 ? "" : "s"}. Here is Codex's code, plus Claude's remaining concerns`,
    )
    if (review?.summary) lines.push("", review.summary)
    if (changes.files.length) lines.push("", "**Changed files**", ...changes.files.map((f) => `- \`${f}\``))
    lines.push(
      "",
      applied.ok
        ? `Changes were applied to your working tree as uncommitted edits. A backup is on branch \`${wt.branch}\`.`
        : `Could not apply the changes cleanly to your working tree. They are committed on branch \`${wt.branch}\` (worktree: \`${wt.dir}\`). Merge them with \`git merge ${wt.branch}\` or \`git cherry-pick ${wt.branch}\`.`,
    )
    if (!approved && review) {
      if (review.issues.length)
        lines.push(
          "",
          "### Outstanding issues",
          ...review.issues.map((i) => `- **[${i.severity}]** \`${i.file}\`: ${i.problem}\n  - *Suggested fix:* ${i.fix}`),
        )
    }
    if (review?.suggestions.length) lines.push("", "### Suggestions", ...review.suggestions.map((s) => `- ${s}`))
    yield* text(lines.join("\n"))
  })

  const finish = Effect.gen(function* () {
    for (const part of running.splice(0)) {
      if (part.state.status !== "running") continue
      part.state = {
        status: "error",
        input: part.state.input,
        error: "Aborted",
        metadata: { ...part.state.metadata, interrupted: true },
        time: { start: part.state.time.start, end: Date.now() },
      }
      yield* sessions.updatePart(part)
    }
    if (!msg.time.completed) {
      msg.time.completed = Date.now()
      msg.finish ??= "stop"
      yield* sessions.updateMessage(msg)
    }
  })

  yield* pipeline.pipe(
    Effect.catch((error: Error) =>
      Effect.gen(function* () {
        const err = new NamedError.Unknown({ message: `Orchestrator: ${error.message}` })
        msg.error = MessageV2.fromError(err, { providerID: msg.providerID })
        msg.finish = "error"
        yield* sessions.updateMessage(msg)
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: err.toObject() })
      }),
    ),
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
          providerID: msg.providerID,
          aborted: true,
        })
      }),
    ),
    Effect.ensuring(Effect.uninterruptible(finish)),
  )
  return msg
})

export * as Orchestrator from "."
