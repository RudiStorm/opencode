export interface ReviewIssue {
  severity: "blocking" | "major" | "minor"
  file: string
  problem: string
  fix: string
}

export interface Review {
  approved: boolean
  summary: string
  issues: ReviewIssue[]
  suggestions: string[]
}

export interface Route {
  kind: "answer" | "build"
  answer: string
  task: string
}

// Codex --output-schema requires strict schemas: every property required, no additional properties.
export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["answer", "build"] },
    answer: { type: "string" },
    task: { type: "string" },
  },
  required: ["kind", "answer", "task"],
  additionalProperties: false,
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          file: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "file", "problem", "fix"],
        additionalProperties: false,
      },
    },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["approved", "summary", "issues", "suggestions"],
  additionalProperties: false,
}

const historyBlock = (history: string) =>
  history.trim() ? `<conversation_history>\n${history.trim()}\n</conversation_history>\n\n` : ""

export const router = (input: { history: string; message: string }) => `You are the router of a multi-agent coding orchestrator.
The user is working in the repository in your current directory. Decide what kind of request their latest message is:

- "answer": a question, explanation, investigation, or anything that does NOT require changing files.
  Investigate the repository as needed (read-only) and put your complete, well-formatted markdown answer in "answer".
  Set "task" to "".
- "build": the user wants code or files created, changed, fixed, refactored, or deleted.
  Do NOT make any changes. Put a precise, self-contained restatement of what must be built in "task"
  (resolve references to earlier conversation so it stands on its own). Set "answer" to "".

${historyBlock(input.history)}<latest_user_message>
${input.message}
</latest_user_message>`

export const plan = (input: { history: string; task: string }) => `You are the planner in a multi-agent coding pipeline.
Another agent (Codex) will implement your plan, and you will later review its diff against this plan.

Explore the repository in your current directory as much as needed, then write a concrete implementation plan for the task below.
Do not modify any files. Your final message must be the plan itself, in markdown, containing:
1. Goal - one or two sentences.
2. Files to change or create, with the specific changes for each.
3. Steps in order, referencing existing functions/utilities to reuse.
4. Acceptance criteria - checkable statements the reviewer will verify against the diff.
5. Tests to add or run.
Keep it tight: no preamble, no alternatives, no restating the task.

${historyBlock(input.history)}<task>
${input.task}
</task>`

export const build = (input: { task: string; plan: string }) => `Implement the following plan in this repository.
Follow the plan closely; if a step is wrong or impossible, make the smallest sensible deviation and say why in your final message.
Run relevant tests or type checks if they are quick. Do not commit. When done, reply with a short summary of what you changed.

<task>
${input.task}
</task>

<plan>
${input.plan}
</plan>`

export const review = (input: { task: string; plan: string; diff: string; round: number; max: number }) => `You are the reviewer in a multi-agent coding pipeline (review round ${input.round} of ${input.max}).
Codex implemented the plan below. The repository in your current directory contains its changes; the diff against the starting point is included.
You may read files for context, but do not modify anything.

Judge the diff against the plan:
- Is every step and acceptance criterion of the plan implemented?
- Is it correct (logic errors, edge cases, broken imports/types, obviously failing tests)?
- Is there scope creep or unrelated changes?

Set "approved" to true only if nothing blocking or major remains; minor nits alone must not block approval
(put them in "suggestions"). For each issue give the file, the problem, and a concrete fix Codex can apply.

<task>
${input.task}
</task>

<plan>
${input.plan}
</plan>

<diff>
${input.diff}
</diff>`

export const fix = (input: { review: Review; round: number }) => `The reviewer rejected your implementation (review round ${input.round}).

Reviewer summary: ${input.review.summary}

Fix every issue below, then reply with a short summary of what you changed. Do not commit.

${input.review.issues.map((issue, i) => `${i + 1}. [${issue.severity}] ${issue.file}\n   Problem: ${issue.problem}\n   Fix: ${issue.fix}`).join("\n")}`
