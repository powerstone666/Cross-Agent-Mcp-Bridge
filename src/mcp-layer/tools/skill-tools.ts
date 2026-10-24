// MCP tools that hand the markdown guides in skills/ to the calling model.
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, textResult } from "./agent-tools.js";

const defaultSkillsDirectory = fileURLToPath(new URL("../../../skills/", import.meta.url));

export function registerSkillTools(server: McpServer, skillsDirectory = defaultSkillsDirectory): void {
  server.registerTool("list_skills", {
    title: "List skills",
    description: "Lists the relay's usage guides. Call this first, then get_skill for the guides that match your task (direct agent messaging, rooms, and so on).",
  }, async () => textResult({ skills: await listSkills(skillsDirectory) }));

  server.registerTool("get_skill", {
    title: "Get a skill",
    description: "Returns the full markdown of one usage guide from list_skills. Read it before using the tools it covers.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Skill name from list_skills, for example \"rooms\"."),
    }),
  }, async ({ name }) => {
    const skills = await listSkills(skillsDirectory);
    const skill = skills.find((item) => item.name === name);
    if (!skill) return errorResult(`Unknown skill "${name}". Available: ${skills.map((item) => item.name).join(", ") || "none"}.`);
    return textResult(await readFile(join(skillsDirectory, skill.file), "utf8"));
  });
}

interface SkillSummary { name: string; file: string; title: string; summary: string }

async function listSkills(skillsDirectory: string): Promise<SkillSummary[]> {
  const files = (await readdir(skillsDirectory)).filter((file) => file.endsWith(".md")).sort();
  const skills = await Promise.all(files.map(async (file) => {
    const lines = (await readFile(join(skillsDirectory, file), "utf8")).split(/\r?\n/);
    const name = basename(file, ".md").toLowerCase();
    return {
      name,
      file,
      title: lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? name,
      // First prose line after the heading.
      summary: lines.find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "",
    };
  }));
  // The index goes first so a model reads it before choosing a guide.
  return skills.sort((a, b) => Number(b.name === "guide") - Number(a.name === "guide"));
}
