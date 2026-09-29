import { isRecord, jsonBytes } from "./web-common.ts";

export interface NativeWebSearchRecord {
  id: string;
  completion_events: string[];
  action?: Record<string, unknown>;
}
export interface NativeUrlCitation {
  item_id: string;
  content_index: number;
  annotation_index: number;
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}
class ActionLimit extends Error {}
class MalformedAction extends Error {}
function copyAction(root: unknown): Record<string, unknown> | undefined {
  if (!isRecord(root)) return undefined;
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (size: number) => { bytes += size; if (bytes > 16_384) throw new ActionLimit(); };
  const token = (value: unknown) => {
    try { add(jsonBytes(value, 16_384 - bytes)); }
    catch (error) { if (error instanceof RangeError) throw new ActionLimit(); throw new MalformedAction(); }
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 8 || ++nodes > 256) throw new ActionLimit();
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) { token(value); return value; }
    if (typeof value !== "object" || !value || ancestors.has(value)) throw new MalformedAction();
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype) throw new MalformedAction();
    const conversion = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (conversion && (!("value" in conversion) || typeof conversion.value === "function")) throw new MalformedAction();
    ancestors.add(value);
    add(2);
    const output: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    let first = true;
    const child = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new MalformedAction();
      if (!first) add(1);
      first = false;
      if (!array) { token(key); add(1); }
      const result = copy(descriptor.value, depth + 1);
      if (Array.isArray(output)) output.push(result);
      else output[key] = result;
    };
    if (array) for (let i = 0; i < value.length; i++) child(String(i));
    else for (const key in value) if (Object.hasOwn(value, key)) child(key);
    ancestors.delete(value);
    return output;
  };
  try { return copy(root, 1) as Record<string, unknown>; }
  catch (error) { if (error instanceof ActionLimit) throw error; return undefined; }
}
export function createNativeWebEvidenceCollector() {
  const searches = new Map<string, NativeWebSearchRecord>();
  const citations = new Map<string, NativeUrlCitation>();
  let limited = false;
  const field = (value: string, max: number) => {
    if (Buffer.byteLength(value) > max) { limited = true; return false; }
    return true;
  };
  const search = (id: unknown, event: string, action?: unknown) => {
    if (limited || typeof id !== "string" || !id.length) return;
    if (!field(id, 128)) return;
    if (!searches.has(id) && searches.size === 32) { limited = true; return; }
    let copied: Record<string, unknown> | undefined;
    try { copied = copyAction(action); } catch { limited = true; return; }
    const previous = searches.get(id);
    const completion_events = previous ? [...previous.completion_events] : [];
    if (!completion_events.includes(event)) completion_events.push(event);
    searches.set(id, { id, completion_events, ...(copied ? { action: copied } : previous?.action ? { action: previous.action } : {}) });
  };
  const index = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const citation = (annotation: unknown, id: unknown, content: unknown, position: unknown) => {
    if (limited || !isRecord(annotation) || annotation.type !== "url_citation"
      || typeof id !== "string" || !id.length || !index(content) || !index(position)
      || typeof annotation.url !== "string" || !annotation.url.length || typeof annotation.title !== "string"
      || !index(annotation.start_index) || !index(annotation.end_index) || annotation.start_index > annotation.end_index) return;
    if (!field(id, 128) || !field(annotation.url, 4096) || !field(annotation.title, 1024)) return;
    const key = JSON.stringify([id, content, position]);
    if (!citations.has(key) && citations.size === 128) { limited = true; return; }
    citations.set(key, { item_id: id, content_index: content, annotation_index: position,
      url: annotation.url, title: annotation.title, start_index: annotation.start_index, end_index: annotation.end_index });
  };
  const part = (part: unknown, id: unknown, content: unknown) => {
    if (!isRecord(part) || part.type !== "output_text" || !Array.isArray(part.annotations)) return;
    for (let i = 0; i < part.annotations.length && !limited; i++) citation(part.annotations[i], id, content, i);
  };
  const item = (value: unknown, event: string) => {
    if (!isRecord(value)) return;
    if (value.type === "web_search_call" && value.status === "completed") search(value.id, event, value.action);
    if (value.type === "message" && Array.isArray(value.content)) {
      for (let i = 0; i < value.content.length && !limited; i++) part(value.content[i], value.id, i);
    }
  };
  return {
    observe(data: unknown): void {
      if (limited) return;
      try {
        if (!isRecord(data)) return;
        if (data.type === "response.web_search_call.completed") search(data.item_id, data.type);
        else if (data.type === "response.output_item.done") item(data.item, data.type);
        else if (data.type === "response.output_text.annotation.added") citation(data.annotation, data.item_id, data.content_index, data.annotation_index);
        else if (data.type === "response.content_part.done") part(data.part, data.item_id, data.content_index);
        else if ((data.type === "response.completed" || data.type === "response.done") && isRecord(data.response)
          && data.response.status === "completed" && Array.isArray(data.response.output)) {
          for (const value of data.response.output) { if (limited) break; item(value, data.type); }
        }
      } catch { /* Ignore malformed provider data. */ }
    },
    limitExceeded: () => limited,
    searches: () => [...searches.values()],
    citations: () => [...citations.values()],
  };
}
