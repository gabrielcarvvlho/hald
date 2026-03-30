# Installing Git Oracle for OpenCode

1. Clone the repository into your OpenCode plugins directory:
   ```
   git clone https://github.com/gabriel/git-oracle.git ~/.opencode/plugins/git-oracle
   ```

2. Install dependencies and build:
   ```
   cd ~/.opencode/plugins/git-oracle && npm install && npm run build
   ```

3. The plugin auto-registers via `.opencode/plugins/git-oracle.js`.

4. Restart OpenCode. The git-oracle skills and MCP tools will be available.
