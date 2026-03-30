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
       "command": "node",
       "args": ["~/.codex/git-oracle/dist/index.js"]
     }
   }
   ```

5. Restart Codex.
