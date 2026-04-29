# Memory

- Keep this file selective. Only record repeated pitfalls or major implementation/debugging takeaways that are likely to matter again.

## Canvas And Viewport

- Keep zoom math, scroll offsets, and card positioning on one shared scroll coordinate system. Mixing viewport and stage responsibilities breaks cursor-anchored zoom and initial fit behavior.
- Render the dotted grid as a viewport overlay that reads scroll and zoom state. Let DOM items stay on the scroll content instead of trying to move both grid and cards the same way.
- Scope layout metadata must stay per-scope. A flat document-wide layout map causes different drill-down levels to fight over positions.

## Markdown Rendering

- Route both section cards and orphan blocks through `MarkdownRenderer`, and keep `markdown-rendered` plus `markdown-preview-view` on the container. Without both, preview output diverges from normal Obsidian rendering.
- Disable native image dragging inside previews and prevent card `dragstart`. Browser drag behavior otherwise steals pointer intent from canvas repositioning.
- Treat YAML frontmatter as note properties, not canvas body content. Parse markdown after removing frontmatter so it does not become bogus orphan blocks.
- Use `app.fileManager.processFrontMatter()` for frontmatter edits. Direct text replacement is more likely to fight Obsidian formatting and cache updates.

## Scope And Navigation

- Recursive drill-down stays understandable when every scope repeats the same shell-versus-shell-less parsing rules on a scoped markdown slice.
- Reinsert the heading that opened a child scope as a scope-local orphan so entered canvases keep their context anchor.
- Shell-less containers with internal heading hierarchy need their own child scopes too, otherwise drill-down behavior becomes inconsistent outside normal shell sections.
- Keep source opening and scope entry on separate gestures. Double-click opens source, while Ctrl/Cmd-click enters the child scope.

## Layer Panel And Selection

- Layer order should follow source order, not grouped item type order. Grouping by kind makes the tree feel untrustworthy against the document.
- Filter scope-heading orphans out of the layer tree when that heading already appears as the scope row. Showing both creates duplicate structure noise.
- Single click in the layer panel should be lightweight, with explicit expand/collapse and Ctrl/Cmd-click scope entry. Immediate navigation on plain click feels too eager.
- Selection should be one shared state between canvas items and layer rows. If the panel and canvas can disagree, the interface quickly feels unreliable.
- Keep resize handles hidden until selection, use hover only as a soft preview, and reserve Obsidian accent color for explicit selection state.
- For markdown embeds, keep the DOM visually in-flow inside the preview and add node identity on top. Pulling embeds out into separate canvas cards breaks shell readability even if interaction becomes easier.
- When layer structure looks wrong, first verify parsed shell line ranges. A bad section `endLine` makes embed ownership look like a layer-tree bug.
- Stop embed pointer events before they bubble to parent cards; otherwise the card selection immediately overwrites the embed selection.
