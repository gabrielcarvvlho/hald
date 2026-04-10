// OpenCode plugin: auto-registers skills + MCP server
const path = require("path");
const fs = require("fs");

module.exports = function haldPlugin() {
  const pluginRoot = path.resolve(__dirname, "../..");

  return {
    name: "hald",

    config(config) {
      // Register skills directory for OpenCode's discovery
      const skillsDir = path.join(pluginRoot, "skills");
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      config.skills.paths.push(skillsDir);
      return config;
    },

    "experimental.chat.system.transform"(system) {
      // Inject hald awareness at session start
      const skillPath = path.join(
        pluginRoot,
        "skills/hald-query/SKILL.md",
      );
      try {
        const content = fs.readFileSync(skillPath, "utf-8");
        return `${system}\n\n<hald-skills>\n${content}\n</hald-skills>`;
      } catch {
        return system;
      }
    },
  };
};
