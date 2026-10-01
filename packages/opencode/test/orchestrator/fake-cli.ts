// Stand-in for the `claude` and `codex` CLIs, driven by FAKE_* env vars.
import fs from "fs"
import path from "path"

const args = process.argv.slice(2)
const stdin = fs.readFileSync(0, "utf8")
const state = process.env.FAKE_STATE!
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")

const bump = (name: string) => {
  const file = path.join(state, name)
  const next = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1
  fs.writeFileSync(file, String(next))
  fs.appendFileSync(path.join(state, "prompts.log"), `--- ${name} ${next}\n${stdin}\n`)
  return next
}

if (args.includes("exec")) {
  out({ type: "thread.started", thread_id: "thread-1" })
  if (args.includes("read-only")) {
    bump("route")
    const route = process.env.FAKE_ROUTE ?? "build"
    const message = { kind: route, answer: route === "answer" ? "It is a test repo." : "", task: "create hello.txt" }
    out({ type: "item.completed", item: { id: "i0", type: "agent_message", text: JSON.stringify(message) } })
  } else {
    const n = bump(args.includes("resume") ? "fix" : "build")
    if (!process.env.FAKE_CODEX_NOOP) {
      fs.appendFileSync(path.join(process.cwd(), "hello.txt"), `line ${args.includes("resume") ? "fix" : "build"} ${n}\n`)
      out({ type: "item.completed", item: { id: "i1", type: "file_change", changes: [{ path: "hello.txt", kind: "add" }] } })
    }
    out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "done" } })
  }
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
  process.exit(0)
}

if (args.includes("-p")) {
  if (process.env.FAKE_CLAUDE_FAIL) {
    process.stderr.write("claude exploded\n")
    process.exit(1)
  }
  const usage = { input_tokens: 3, output_tokens: 4 }
  if (args.includes("--json-schema")) {
    const n = bump("review")
    const approveAt = Number(process.env.FAKE_APPROVE_AT ?? "1")
    const approved = approveAt > 0 && n >= approveAt
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "hello.txt" } }] } })
    out({
      type: "result",
      is_error: false,
      total_cost_usd: 0.01,
      usage,
      structured_output: {
        approved,
        summary: approved ? "Looks good." : `Round ${n} not good enough.`,
        issues: approved ? [] : [{ severity: "major", file: "hello.txt", problem: `problem ${n}`, fix: `fix ${n}` }],
        suggestions: ["consider a trailing newline"],
      },
    })
  } else {
    bump("plan")
    out({ type: "assistant", message: { content: [{ type: "text", text: "Planning..." }] } })
    out({ type: "result", is_error: false, total_cost_usd: 0.02, usage, result: "1. Create hello.txt" })
  }
  process.exit(0)
}

process.stderr.write(`fake-cli: unexpected args ${args.join(" ")}\n`)
process.exit(2)
