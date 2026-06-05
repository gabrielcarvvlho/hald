# Installing Hald for Codex

1. Clone the repository:
   ```
   git clone https://github.com/gabrielcarvvlho/hald.git ~/.codex/hald
   ```

2. Install dependencies and build:
   ```
   cd ~/.codex/hald && npm install && npm run build
   ```

3. Create skills symlink:
   ```
   ln -s ~/.codex/hald/skills ~/.agents/skills/hald
   ```

4. Add MCP server to your Codex config:
   ```json
   {
     "hald": {
       "command": "sh",
       "args": ["~/.codex/hald/bin/start-server.sh"]
     }
   }
   ```

5. **API keys for indexing:** Codex runs in a sandbox with restricted env.
   Set at least one of these in your Codex MCP server config's `env` block:
   - `ANTHROPIC_API_KEY` — for Claude (default)
   - `OPENAI_API_KEY` — for GPT (default `gpt-5.4-mini`) / compatible endpoints
   - `GOOGLE_API_KEY` — for Gemini
   - `HALD_BASE_URL` — for custom endpoints (Ollama, OpenRouter)

   If no key is available, indexing falls back to agent-mediated mode (zero cost).

6. Restart Codex.
