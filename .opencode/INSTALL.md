# Installing Hald for OpenCode

1. Clone the repository into your OpenCode plugins directory:
   ```
   git clone https://github.com/gabrielcarvvlho/hald.git ~/.opencode/plugins/hald
   ```

2. Install dependencies and build:
   ```
   cd ~/.opencode/plugins/hald && npm install && npm run build
   ```

3. The plugin auto-registers via `.opencode/plugins/hald.js`.

4. Restart OpenCode. The hald skills and MCP tools will be available.
