# Symphony ACPX + Claude Code Integration Patches

## Patch 1: acpx_session.ex - Event Format Adapter

**File:** `elixir/lib/symphony_elixir/agent_runner/acpx_session.ex`

**Problem:** AcpxSession sends events in ACPX format `%{type: atom(), data: map(), raw: String.t()}`
but Orchestrator expects Codex app-server format `%{event: atom(), timestamp: DateTime.t(), usage: map(), payload: map()}`.
Without this patch, all ACPX events are silently dropped by the Orchestrator's catch-all handler.

**Replace** the `send_update` private functions (lines 529-533):

```elixir
# BEFORE (lines 529-533):
  defp send_update(nil, _issue_id, _event), do: :ok

  defp send_update(recipient, issue_id, event) do
    send(recipient, {:codex_worker_update, issue_id, event})
  end

# AFTER:
  defp send_update(nil, _issue_id, _event), do: :ok

  defp send_update(recipient, issue_id, %{type: type, data: data} = _event) do
    adapted = adapt_acpx_event(type, data)
    send(recipient, {:codex_worker_update, issue_id, adapted})
  end

  defp send_update(recipient, issue_id, event) do
    send(recipient, {:codex_worker_update, issue_id, event})
  end
```

**Add** the following private functions before `clean_port/1` (after the new `send_update` functions):

```elixir
  defp adapt_acpx_event(:session_update, data) do
    %{
      event: :session_started,
      timestamp: DateTime.utc_now(),
      session_id: data["sessionId"],
      payload: data
    }
  end

  defp adapt_acpx_event(:agent_message_chunk, data) do
    %{
      event: :agent_message,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp adapt_acpx_event(:agent_thought_chunk, data) do
    %{
      event: :agent_thought,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp adapt_acpx_event(:tool_call, data) do
    %{
      event: :tool_call,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp adapt_acpx_event(:tool_call_update, data) do
    %{
      event: :tool_call_update,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp adapt_acpx_event(:tool_result, data) do
    %{
      event: :tool_result,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp adapt_acpx_event(:usage_update, data) do
    %{
      event: :usage_update,
      timestamp: DateTime.utc_now(),
      usage: extract_usage_from_acpx(data),
      payload: data
    }
  end

  defp adapt_acpx_event(:result, data) do
    %{
      event: :turn_completed,
      timestamp: DateTime.utc_now(),
      usage: extract_usage_from_acpx(data["usage"]),
      payload: data
    }
  end

  defp adapt_acpx_event(:error, data) do
    %{
      event: :error,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp adapt_acpx_event(_type, data) do
    %{
      event: :unknown,
      timestamp: DateTime.utc_now(),
      payload: data
    }
  end

  defp extract_usage_from_acpx(nil), do: %{}

  defp extract_usage_from_acpx(usage) when is_map(usage) do
    %{
      input_tokens: usage["inputTokens"] || usage["input_tokens"] || 0,
      output_tokens: usage["outputTokens"] || usage["output_tokens"] || 0,
      total_tokens: usage["totalTokens"] || usage["total_tokens"] || 0
    }
  end

  defp extract_usage_from_acpx(_), do: %{}
```

---

## Patch 2: orchestrator.ex - Handle ACPX Event Types

**File:** `elixir/lib/symphony_elixir/orchestrator.ex`

**Problem:** The Orchestrator's `integrate_codex_update` and `summarize_codex_update` only know
about Codex app-server event types. ACPX produces different event types that need to be handled.

### 2a: Update summarize_codex_update (around line 1238)

**Replace:**

```elixir
# BEFORE:
  defp summarize_codex_update(update) do
    %{
      event: update[:event],
      message: update[:payload] || update[:raw],
      timestamp: update[:timestamp]
    }
  end

# AFTER:
  defp summarize_codex_update(update) do
    %{
      event: update[:event],
      message: summarize_payload(update[:payload]) || update[:raw],
      timestamp: update[:timestamp]
    }
  end

  defp summarize_payload(%{"content" => %{"text" => text}}) when is_binary(text) do
    String.slice(text, 0, 200)
  end

  defp summarize_payload(%{"content" => content}) when is_binary(content) do
    String.slice(content, 0, 200)
  end

  defp summarize_payload(payload) when is_map(payload) do
    case Jason.encode(payload) do
      {:ok, json} -> String.slice(json, 0, 200)
      _ -> nil
    end
  end

  defp summarize_payload(_), do: nil
```

### 2b: Update turn_count_for_update to handle ACPX session events (around line 1220)

**Add** a new clause after the existing `session_started` clause:

```elixir
  defp turn_count_for_update(existing_count, existing_session_id, %{
         event: :usage_update,
         session_id: session_id
       })
       when is_integer(existing_count) and is_binary(session_id) do
    if session_id == existing_session_id do
      existing_count
    else
      existing_count + 1
    end
  end
```

---

## Patch 3: config/schema.ex - Add ACPX Agent Options

**File:** `elixir/lib/symphony_elixir/config/schema.ex` (or wherever Config.acpx_agent_options/0 is defined)

Ensure the following config keys are supported in the WORKFLOW.md front matter:

```yaml
codex:
  agent: "claude"
  command: npx -y @agentclientprotocol/claude-agent-acp --app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
  model: sonnet
  max_turns: 20
```

The `Config.acpx_agent_options/0` function should return:

```elixir
%{
  model: config[:model],
  max_turns: config[:max_turns],
  allowed_tools: config[:allowed_tools],
  prompt_retries: config[:prompt_retries]
}
```

---

## How to Apply These Patches

1. Open a terminal in `D:\Code\symphony\elixir`
2. Apply Patch 1 to `lib/symphony_elixir/agent_runner/acpx_session.ex`
3. Apply Patch 2 to `lib/symphony_elixir/orchestrator.ex`
4. Apply Patch 3 if needed (may already be in place)
5. Run `mix compile` to verify no compilation errors
6. Run `mix test` to verify existing tests still pass

## Verification

After applying patches, start Symphony with:
```bash
cd D:\Code\symphony\elixir
mix run --no-halt
# Or via CLI:
symphony --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Check the dashboard at http://localhost:4000 to verify:
- ACPX sessions are created successfully
- Events flow through to the Orchestrator
- Token counts are tracked correctly
- Turn counts increment properly
