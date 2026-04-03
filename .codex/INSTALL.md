# Installing Git Oracle for Codex

1. Clone the repository:
   ```
   git clone https://github.com/gabriel/git-oracle.git ~/.codex/git-oracle
   ```

2. Install dependencies and build:
   ```
   cd ~/.codex/git-oracle && npm install && npm run build
   ```

3. Create skills symlink:
   ```
   ln -s ~/.codex/git-oracle/skills ~/.agents/skills/git-oracle
   ```

4. Add MCP server to your Codex config:
   ```json
   {
     "git-oracle": {
       "command": "sh",
       "args": ["~/.codex/git-oracle/bin/start-server.sh"]
     }
   }
   ```

5. **API keys for indexing:** Codex runs in a sandbox with restricted env.
   Set at least one of these in your Codex MCP server config's `env` block:
   - `ANTHROPIC_API_KEY` — for Claude (default)
   - `OPENAI_API_KEY` — for GPT-4.1 / compatible endpoints
   - `GOOGLE_API_KEY` — for Gemini
   - `GIT_ORACLE_BASE_URL` — for custom endpoints (Ollama, OpenRouter)

   If no key is available, indexing falls back to agent-mediated mode (zero cost).

6. Restart Codex.
