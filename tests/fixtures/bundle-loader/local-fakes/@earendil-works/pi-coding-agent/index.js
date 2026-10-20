export const virtualMarker = "local-pi-coding-agent";
export function formatSkillsForPrompt() {
  return "adapter-local fake Pi SDK";
}
export function getAgentDir() {
  return "/tmp/adapter-local-fake-agent";
}
export function loadSkills() {
  return { skills: [], diagnostics: [] };
}
