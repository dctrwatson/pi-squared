---
name: pdc-incident-note
description: Add a note to a PagerDuty incident with pdc. Use when asked to add or post an incident note.
compatibility: Requires configured pdc access on macOS or Linux.
---

# Add an incident note

1. Set `incident_id` from the request or context. For a PagerDuty URL, use the ID after `/incidents/`. Ask if the target or required note text is unclear.
2. Check the target with `pdc incident show "$incident_id"`. Do not change incident status or other fields.
3. Set `note` to the supplied text, or use only verified facts if asked to write it. Preserve line breaks and prevent shell expansion in the note text. Pass each variable as one quoted argument:

   ```bash
   pdc incident note add --content "$note" "$incident_id"
   ```

   Use the default API token user. Add `--from '<email>'` only when the user specifies the author.
4. Check the exit status and returned note. If the result is uncertain, run `pdc incident note list "$incident_id"` and check the content and creation time before a retry. Do not post a duplicate note. Report success only after confirmation.
