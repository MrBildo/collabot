# Milestone F — MCP Tools (Agent-Callable Harness)

> **Parent spec:** `docs/specs/workflow-harness.md`
> **Predecessor:** Milestone E (complete — multi-agent handoff, context reconstruction, task-aware CLI, PM role)
> **Goal:** Expose harness primitives as MCP tools so dispatched agents can draft other agents, query task state, and manage the pool — the foundation for PM bot autonomy.
> **Status:** **Complete** — 2026-02-20
> **Research:** `.agents/research/mcp-tools/FINDINGS.md`

This is the third Phase 2 milestone. Milestone D made the harness interface-agnostic. Milestone E made it multi-agent-aware via human-driven CLI orchestration. Milestone F makes agents first-class participants — they can call back into the harness during execution.

Each step is independently verifiable. Don't move to the next step until the current one works.

---

## Design Decisions (from planning session 2026-02-20)

These decisions were made during the Milestone F spec-discuss session. Coding agents should treat them as constraints, not suggestions.

1. **In-process SDK server, no network.** The Agent SDK provides a `'sdk'` transport type via `createSdkMcpServer()` that runs the MCP server in the same Node.js process as the harness. Tool handlers execute directly in the harness — full access to pool, tasks, journals. No HTTP server, no localhost ports, no auth tokens. The SDK handles IPC between the CLI subprocess and the in-process server transparently.

2. **Injected at dispatch time via `options.mcpServers`.** The SDK's `query()` accepts `mcpServers` in its options — a record of server configs passed at dispatch time. Zero pollution to global or project settings files. The harness creates the server instance(s) and passes them through `dispatch()`.

3. **Full tool surface, day one.** Six tools: `draft_agent`, `await_agent`, `kill_agent`, `list_agents`, `list_tasks`, `get_task_context`. All are thin wrappers around functions that already exist. No reason to defer any.

4. **Async draft + await pattern.** `draft_agent` is non-blocking — fires off the dispatch and returns an agent ID immediately. `await_agent` blocks until the target agent completes and returns its result. This lets a PM bot dispatch agents in parallel (multiple `draft_agent` calls) then await each result, or do simple sequential orchestration. "Build for parallel, sequential is organic."

5. **Config-driven access control via role-specific server instances.** The MCP spec has no per-client tool filtering. Instead, the harness creates different server instances with different tool subsets. Config declares which role categories get which tools. Coordinator roles (PM) get the full set. Worker roles (devs) get read-only tools. The harness picks the right server instance at dispatch time based on the role's category.

6. **`CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` is a harness concern.** `await_agent` and synchronous `draft_agent` calls can take minutes. The SDK's default stream timeout (~60s) is too short. The harness sets this env var in `buildChildEnv()` to accommodate long-running tool calls. One line, mechanical, same pattern as `CLAUDECODE` and `CLAUDE_CODE_GIT_BASH_PATH`.

7. **Smoke test is automated.** Step 0 proves the wiring works without human intervention. The agent writes a test script or automated test that creates an MCP server, dispatches an agent, verifies the tool call flows end-to-end.

## Known Gaps (not bugs — document in handoff)

| Gap | Why | Closes When |
|-----|-----|-------------|
| No PM bot autonomy loop | PM can use tools but human still initiates the PM dispatch | PM autonomy milestone |
| No recursion depth limit | An agent could `draft_agent` → that agent `draft_agent` → infinite chain | Governance milestone or config guard |
| No cost/budget governance | `draft_agent` has no budget cap — caller can burn tokens | Budget management milestone |
| Slack thread role inheritance | Follow-ups re-route from scratch instead of inheriting thread's role | Slack UX milestone |
| No tool usage telemetry | We don't track which agents call which tools how often | Observability milestone |

---

## Step 0: Smoke Test Spike

**Who:** Agent

**Do:**

1. Verify the Agent SDK exports `createSdkMcpServer` and `tool` are available. Check imports against `@anthropic-ai/claude-agent-sdk`. If `zod` is not already a dependency in `harness/package.json`, install it (`npm install zod`).

2. Create a minimal smoke test: `harness/src/mcp-smoke.test.ts`

   - Create an MCP server using `createSdkMcpServer` with a single `echo` tool:
     ```typescript
     tool('echo', 'Returns the input message', { message: z.string() },
       async ({ message }) => ({
         content: [{ type: 'text', text: `echo: ${message}` }]
       })
     )
     ```
   - Verify the server instance is created successfully and has the expected shape (`McpSdkServerConfigWithInstance` or similar)
   - Verify the tool handler can be invoked directly and returns the expected result
   - Verify the server config can be passed to dispatch options (type-check: `{ mcpServers: { harness: server } }` is valid per `Options.mcpServers`)

3. Update `dispatch()` in `src/dispatch.ts` to accept and pass through `mcpServers` in its options:
   - Add `mcpServers?: Record<string, unknown>` to `DispatchOptions` in `src/types.ts` (use the actual SDK type if available; `unknown` as fallback for type flexibility)
   - Pass `mcpServers` through to the SDK `query()` call's options
   - When not provided, omit from options (backward compatible)

4. Add `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` to `buildChildEnv()` in `dispatch.ts` — set to `600000` (10 minutes). Add a comment explaining why.

**Verify:** `npx tsc --noEmit` clean. Smoke test passes. Existing 71 tests still pass. No manual intervention required.

---

## Step 1: MCP Server Foundation + Read-Only Tools

**Who:** Agent

**Do:**

1. Create `harness/src/mcp.ts` — the MCP server factory.

2. Define a server creation function:
   ```typescript
   export function createHarnessServer(options: {
     pool: AgentPool;
     tasksDir: string;
     tools: 'full' | 'readonly';
   }): McpSdkServerConfigWithInstance
   ```
   Use `createSdkMcpServer` from the Agent SDK. The `tools` parameter controls which tools are registered (for access control in Step 3).

3. Implement three read-only tools:

   **`list_agents`** — returns currently active agents from the pool.
   - Input: none (empty schema)
   - Output: JSON array of `{ id, role, taskSlug, startedAt }`
   - Handler: calls `pool.list()`

   **`list_tasks`** — returns task inventory.
   - Input: none (empty schema)
   - Output: JSON array of `{ slug, created, description, dispatchCount }`
   - Handler: reads task directories from `tasksDir`, parses each `task.json`

   **`get_task_context`** — returns reconstructed context for a task.
   - Input: `{ taskSlug: string }`
   - Output: the markdown string from `buildTaskContext(taskDir)`
   - Handler: validates task exists, calls `buildTaskContext()`

4. Wire the server into `draftAgent()` in `src/core.ts`:
   - `draftAgent` accepts an optional `mcpServer` parameter
   - Passes it through to `dispatch()` as `mcpServers: { harness: mcpServer }`
   - `handleTask` creates or receives the server and passes it to `draftAgent`

5. Add unit tests for each tool handler (mock pool and filesystem):
   - `list_agents` with 0 agents, with 2 agents
   - `list_tasks` with 0 tasks, with multiple tasks
   - `get_task_context` with valid slug, with invalid slug (error)

**Verify:** `npx tsc --noEmit` clean. All tests pass. Read-only tools are defined and wired through dispatch.

---

## Step 2: Draft & Lifecycle Tools

**Who:** Agent

**Do:**

This is the core step. `draft_agent` and `await_agent` require a dispatch tracking mechanism.

1. Create a `DispatchTracker` in `src/mcp.ts` (or a separate file if it gets large):

   ```typescript
   class DispatchTracker {
     private pending: Map<string, {
       promise: Promise<DispatchResult>;
       role: string;
       startedAt: Date;
     }>;

     /** Track a new dispatch. Returns the agent ID. */
     track(agentId: string, role: string, promise: Promise<DispatchResult>): void;

     /** Wait for a tracked dispatch to complete. */
     async await(agentId: string): Promise<DispatchResult>;

     /** Check if an agent ID is being tracked. */
     has(agentId: string): boolean;

     /** Clean up completed entries (optional, for memory hygiene). */
     prune(): void;
   }
   ```

2. Implement three lifecycle tools:

   **`draft_agent`** — dispatches a new agent asynchronously.
   - Input: `{ role: string, prompt: string, taskSlug?: string }`
   - Output: `{ agentId: string, role: string, taskSlug: string }`
   - Handler:
     - Validates role exists
     - Generates agent ID
     - Calls `draftAgent()` — does NOT await the result
     - Stores the promise in `DispatchTracker`
     - Returns the agent ID immediately
   - Note: the `draftAgent` call needs access to adapter, roles, config. These are captured in a closure when creating the server (passed via `createHarnessServer` options).

   **`await_agent`** — blocks until a dispatched agent completes.
   - Input: `{ agentId: string }`
   - Output: `{ status: string, result?: { summary, changes, issues, questions } }`
   - Handler:
     - Looks up agent ID in `DispatchTracker`
     - If not found, returns error
     - Awaits the stored promise
     - Returns the dispatch result (status + structured result if available)

   **`kill_agent`** — aborts a running agent.
   - Input: `{ agentId: string }`
   - Output: `{ success: boolean, message: string }`
   - Handler:
     - Calls `pool.kill(agentId)`
     - Returns success/failure

3. Update `createHarnessServer` to accept additional context needed by draft tools:
   ```typescript
   export function createHarnessServer(options: {
     pool: AgentPool;
     tasksDir: string;
     tools: 'full' | 'readonly';
     // Needed for draft_agent:
     adapter: CommAdapter;
     roles: Map<string, RoleDefinition>;
     config: Config;
     tracker: DispatchTracker;
   }): McpSdkServerConfigWithInstance
   ```

4. Add unit tests (mock dispatch, no real SDK calls):
   - `draft_agent` returns agent ID without blocking
   - `await_agent` on a completed dispatch returns result
   - `await_agent` on unknown ID returns error
   - `kill_agent` calls pool.kill()
   - `draft_agent` with invalid role returns error

**Verify:** `npx tsc --noEmit` clean. All tests pass. Lifecycle tools are defined with proper async/await semantics.

---

## Step 3: Access Control & Config

**Who:** Agent

**Do:**

1. Add `mcp` section to `config.yaml`:
   ```yaml
   mcp:
     streamTimeout: 600000        # CLAUDE_CODE_STREAM_CLOSE_TIMEOUT (ms)
     fullAccessCategories:         # role categories that get all tools
       - conversational            # PM / coordinator roles
     # All other categories get read-only tools (list_agents, list_tasks, get_task_context)
   ```

2. Update `Config` type and `loadConfig()` in `src/config.ts`:
   - `mcp` section is optional (defaults: `streamTimeout: 600000`, `fullAccessCategories: ['conversational']`)
   - Validate that categories are strings

3. Update `createHarnessServer` to accept a `tools` parameter:
   - `'full'` → registers all 6 tools
   - `'readonly'` → registers only `list_agents`, `list_tasks`, `get_task_context`

4. Update the dispatch path:
   - When `draftAgent` is called, look up the role's category from its definition
   - If category is in `config.mcp.fullAccessCategories`, pass the full server
   - Otherwise, pass the readonly server
   - Create both server instances once at harness startup (not per-dispatch)

5. Update `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` in `buildChildEnv()` to read from `config.mcp.streamTimeout` instead of hardcoded value.

6. Add config tests:
   - Config loads with `mcp` section
   - Config loads without `mcp` section (defaults)
   - Full access role gets full server, worker role gets readonly server

**Verify:** `npx tsc --noEmit` clean. All tests pass. Config-driven tool access works.

---

## Step 4: Integration & Wiring

**Who:** Agent

**Do:**

1. Update `handleTask()` in `src/core.ts`:
   - Accept the MCP server instances (full + readonly) or the factory
   - Pass the appropriate server to `draftAgent()` based on role category

2. Update `cli.ts`:
   - Create server instances at startup (same as Slack path)
   - Pass through to `handleTask()`

3. Update `index.ts` / `slack.ts`:
   - Create server instances at startup
   - Pass through to `handleTask()` calls

4. Create the `DispatchTracker` instance once at startup, share across all server instances.

5. Write an integration test that exercises the full flow without a real SDK dispatch:
   - Mock `dispatch()` to return a canned `DispatchResult` after a short delay
   - Create the full MCP server with all tools
   - Call `draft_agent` tool handler → get agent ID
   - Call `list_agents` → verify the agent appears
   - Call `await_agent` with the agent ID → verify the result comes back
   - Call `get_task_context` → verify task history is returned

6. Verify Slack and CLI regressions — both paths should work with the MCP server wired in. Agents that don't use the tools should be unaffected (tools are available but optional).

**Verify:**
- `npx tsc --noEmit` clean
- All tests pass
- Integration test exercises the full tool call flow
- Slack path still works (regression)
- CLI path still works (regression)

---

## E2E Verification (Human)

**Checklist:**

- [ ] Smoke: dispatch a dev agent with MCP tools available, verify it can call `list_tasks` and get a response
- [ ] PM flow: dispatch PM agent (`--role product-analyst`), PM calls `draft_agent` to spawn a dev agent, calls `await_agent` to get the result
- [ ] Read-only enforcement: dispatch a dev agent, verify it does NOT have `draft_agent` / `kill_agent` available (only read-only tools)
- [ ] Parallel draft: PM calls `draft_agent` twice (two different roles), then `await_agent` on each — both complete
- [ ] Kill: PM calls `draft_agent`, then `kill_agent` on the running agent — clean abort
- [ ] CLI regression: `npx tsx src/cli.ts --role api-dev "prompt"` works as before
- [ ] Slack regression: DM the bot, same behavior as before

---

## Tool Reference

| Tool | Access | Input | Output |
|------|--------|-------|--------|
| `draft_agent` | full | `{ role, prompt, taskSlug? }` | `{ agentId, role, taskSlug }` |
| `await_agent` | full | `{ agentId }` | `{ status, result? }` |
| `kill_agent` | full | `{ agentId }` | `{ success, message }` |
| `list_agents` | all | `{}` | `{ agents: [{ id, role, taskSlug, startedAt }] }` |
| `list_tasks` | all | `{}` | `{ tasks: [{ slug, created, description, dispatchCount }] }` |
| `get_task_context` | all | `{ taskSlug }` | `{ context: string }` |

---

## Vision Context (not in scope — captured for architectural awareness)

### PM Autonomy Loop
With MCP tools, the PM bot has the primitives to run an entire plan autonomously: analyze → draft agents → await results → feed results forward → draft next agent. The missing piece is the trigger — who dispatches the PM and tells it "execute this plan"? Today, the human. Next milestone: the PM can be dispatched with a plan and run it end-to-end.

### Agent Recursion
Nothing prevents a drafted agent from calling `draft_agent` itself. This is powerful (delegating sub-tasks) but dangerous (infinite recursion, runaway costs). A recursion depth limit and budget cap are needed before this is used in production. Captured in Known Gaps.

### Bot-Level Tool Access
When the bot abstraction arrives (bot = persistent identity above roles), tool access may shift from role-category-based to bot-level. A trusted senior bot might get full access regardless of role. The config structure (`fullAccessCategories`) is designed to be replaceable without changing the server creation pattern.
