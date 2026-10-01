import { Effect, Fiber } from "effect"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"

export interface RunInput {
  readonly bin: string
  readonly args: string[]
  readonly cwd: string
  readonly stdin?: string
  /** Called for every stdout line. JSON lines are parsed, anything else is passed through as a string. */
  readonly onLine?: (line: unknown) => Effect.Effect<void>
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class CliError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ""}`)
  }
}

const parse = (line: string): unknown => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return trimmed
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

/**
 * Spawn an external CLI (claude, codex, git), feed it stdin, and stream its stdout line by line.
 * The process is killed when the surrounding fiber is interrupted.
 */
export const run = Effect.fn("Orchestrator.cli.run")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: RunInput,
) {
  const cmd = ChildProcess.make(input.bin, input.args, {
    cwd: input.cwd,
    extendEnv: true,
    env: { NO_COLOR: "1", TERM: "dumb" },
    stdin: input.stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(input.stdin)),
    forceKillAfter: "3 seconds",
  })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(cmd)
      const stderrFiber = yield* Effect.forkScoped(AppProcess.collectStream(handle.stderr, 256 * 1024))
      let stdout = ""
      yield* Stream.runForEach(handle.stdout.pipe(Stream.decodeText, Stream.splitLines), (line) =>
        Effect.gen(function* () {
          stdout += line + "\n"
          if (input.onLine && line.trim()) yield* input.onLine(parse(line))
        }),
      )
      const exitCode = yield* handle.exitCode
      const stderr = (yield* Fiber.join(stderrFiber)).buffer.toString("utf8")
      return { exitCode, stdout, stderr } satisfies RunResult
    }),
  )
})

export const describe = (input: Pick<RunInput, "bin" | "args">) => [input.bin, ...input.args].join(" ")
