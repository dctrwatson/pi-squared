export async function createBundle() {
  return { tools: [{
    name: "broken",
    label: "Broken",
    description: "This tool has no executor.",
    parameters: { type: "object", properties: {} },
  }] };
}
