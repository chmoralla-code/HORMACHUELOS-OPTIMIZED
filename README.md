# Hormachuelos Optimized

The independent, installable FPS-focused edition of Hormachuelos. It starts from the verified v0.1.76 source and has its own product identifier, WebView profile, release channel, installers, and download page. The existing Hormachuelos repository and release remain separate.

[Download Hormachuelos Optimized](https://chmoralla-code.github.io/HORMACHUELOS-OPTIMIZED/) · [Optimized releases](https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases)

## FPS edition changes

- Incremental reasoning text instead of rebuilding the entire reasoning DOM on each tick.
- Full Markdown streaming limited to roughly 20 paints per second so the surrounding UI can sustain display cadence.
- Chat and reasoning scroll writes coalesced to one animation frame.
- All off-screen chat messages use paint containment.
- Session saves are less frequent and exponentially back off after quota failures.
- Source Lens hover work is frame-throttled, cached, and uses a smaller CSS-rule scan budget.
- Expensive blur, glow, orbit, pulse, and status animations are disabled by the default FPS profile.
- Rust release builds favor execution speed instead of minimum binary size.

## Independent installation

`Hormachuelos Optimized` uses `com.hormachuelos.optimized`, so it does not reuse the standard edition's WebView local storage. Both editions can be installed without sharing chat/session storage.

---

## Upstream project documentation
# AI-Forge

A monochrome agentic desktop studio. Natural language in → websites, games, and apps out.
Runs a hidden PowerShell agent backed by any LLM provider (OpenAI / Anthropic / Gemini).

## Build artifacts

| File | Size | Purpose |
|------|------|---------|
| `ai-forge.exe` | ~5.9 MB | Standalone executable |
| `AI-Forge_0.1.0_x64_en-US.msi` | ~2.4 MB | MSI installer |
| `AI-Forge_0.1.0_x64-setup.exe` | ~1.7 MB | NSIS setup wizard |

Located in `src-tauri/target/release/` (exe) and `src-tauri/target/release/bundle/` (installers).

## First run

1. Launch `ai-forge.exe`.
2. Click **Settings** (sidebar) → pick a provider → paste your API key → **Save key** → **Test connection** → **Save**.
3. Click **New Project** → choose a parent folder + name → **Create**.
4. Type a prompt like *"Make a portfolio website with dark theme"* and press Enter.
5. The agent scaffolds, writes files, and runs build commands. PowerShell runs **hidden** — output streams into the Console panel.

## What it does

- **Hidden PowerShell**: every `run_command` tool call spawns `powershell -NoProfile -NonInteractive` with `CREATE_NO_WINDOW=0x08000000`. No terminal window ever appears — stdout/stderr are captured and shown in the in-app Console.
- **Agentic loop**: think → tool_call → observe → repeat, up to 25 iterations (configurable). User can press Stop to cancel.
- **Verified providers**: test credentials and model access before a run, and refresh the provider's current model catalog from Settings.
- **Foundry Desk workspace**: responsive build ledger with an in-flow Forge Dock and a Files / Changes / Console inspector.
- **Project explorer and preview**: search a bounded project tree and inspect UTF-8 source files without leaving the app.
- **Run change ledger**: captures successful file tools and compares before/after project metadata, including command-driven changes.
- **Project inspector boundary**: file browsing derives paths from the active canonical project root, rejects traversal/symlink escapes, skips build/dependency folders, and caps tree and preview sizes.
- **Tools**: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_command`, `git_init`, `git_add_all`, `git_commit`, `git_status`, `done`.
- **API keys**: stored in the Windows Credential Manager via the `keyring` crate — never written to disk plaintext, never logged.

## Computer use

Preview Computer Use stays Preview-only: **Settings → Agent → Computer use** Off / Auto / On.

Desktop mode is a separate opt-in: **Settings → Agent → Desktop mode**. When enabled, the agent can control ordinary Windows apps outside Hormachuelos — including Settings (brightness, display) — with the cursor.

- Preview tools (`computer_observe`, `computer_actions`) never leave the active Preview tab.
- Desktop tools (`computer_list_windows`, `computer_observe_window`, click/type/scroll/drag) target native windows.
- Pin allowed apps in Settings, or leave the list empty to allow all ordinary windows except the safety blocklist.
- Terminal, Run, authentication, password-manager, Windows Security/privacy, ChatGPT, Codex, and Hormachuelos windows are blocked.
- Press **Ctrl+Alt+Esc** at any time to pause Preview and Desktop actions and stop active runs.

## Providers

| Provider | Default model | Key URL |
|----------|---------------|---------|
| DeepSeek | `deepseek-v4-pro` | https://platform.deepseek.com/api_keys |
| OpenRouter | tool-capable free models | https://openrouter.ai/keys |
| GLM / Z.AI | `glm-5.2` | https://open.bigmodel.cn/usercenter/apikeys |

All three use an OpenAI-compatible function-calling schema. A custom HTTPS `base_url` can be set for trusted proxies or compatible endpoints.

## Theme

“Foundry Desk” uses furnace-black surfaces, parchment text, one ember action color, etched dividers, and a subtle drafting grid. It relies on packaged Windows-native typography (`Segoe UI Variable`, `Bahnschrift`, and `Cascadia Code`), includes visible keyboard focus, reduced-motion support, selectable code/output, and a compact 900×600 inspector layout.

## Development

```bash
npm install          # frontend deps
npm run build        # build frontend (vite)
cargo tauri build    # full release build → exe + installers
cargo tauri dev      # dev mode with hot reload
```

## Architecture

```
src-tauri/src/
  lib.rs        Tauri commands + plugin registration
  agent.rs      Agentic loop orchestrator
  cursor_bridge.rs  Cursor SDK bridge + host approval protocol
  computer_use.rs  Native Windows observation/input safety broker
  config.rs     Settings + OS keychain API key storage
  state.rs      AppState (project root, settings, recents, cancel flag)
  tools.rs      Tool schemas + execution (incl. hidden PowerShell runner)
  workspace.rs  Project-root-contained file tree and read-only preview API
  llm/mod.rs    LlmProvider trait
  llm/openai.rs OpenAI provider (chat/completions + tool_calls)
  llm/anthropic.rs  Anthropic provider (messages + tool_use)
  llm/gemini.rs Gemini provider (generateContent + functionCall)

src/
  main.ts          App bootstrap, IPC glue, event routing
  ipc.ts           Typed invoke() wrappers + agent event listener
  app.css          App layout + component styles (monochrome)
  theme/tokens.css Design tokens (colors, fonts, motion)
  theme/globals.css Reset + utility classes
  components/      sidebar, chat, console, settings, picker, icons
  components/workspace.ts  file explorer, preview, inspector tabs, run review
  theme/workspace.css      Foundry Desk layout and responsive styling
```

## Tech

- Tauri 2.11 (Rust backend + WebView2 frontend)
- Vanilla TypeScript + Vite (no React → 23 KB JS bundle)
- reqwest for LLM API calls
- keyring for OS credential storage
- Native `std::process::Command` with `CREATE_NO_WINDOW` for hidden PowerShell
