// OpenCode plugin: auto-registers skills + MCP server
const path = require("path");
const fs = require("fs");

module.exports = function gitOraclePlugin() {
  const pluginRoot = path.resolve(__dirname, "../..");

  return {
    name: "git-oracle",

    config(config) {
      // Register skills directory for OpenCode's discovery
      const skillsDir = path.join(pluginRoot, "skills");
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      config.skills.paths.push(skillsDir);
      return config;
    },

    "experimental.chat.system.transform"(system) {
      // Inject git-oracle awareness at session start
      const skillPath = path.join(
        pluginRoot,
        "skills/git-oracle-query/SKILL.md",
      );
      try {
        const content = fs.readFileSync(skillPath, "utf-8");
        return `${system}\n\n<git-oracle-skills>\n${content}\n</git-oracle-skills>`;
      } catch {
        return system;
      }
    },
  };
};
