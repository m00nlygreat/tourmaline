# History

## 2026-04-25

- Wheel zoom and initial fit issues came from mixing layout roles between viewport, scroll container, grid layer, and scaled stage.
- Cursor-anchored zoom became reliable after using one shared scroll coordinate system for cards and zoom math.
- Grid rendering became reliable after separating it from the scroll content and keeping it as a viewport overlay that only reads scroll and zoom state.
- Orphan blocks looked inconsistent because they were inserted as plain text; routing them through `MarkdownRenderer` aligned their rendering behavior with section cards and embeds.
- Matching Obsidian preview output also required preview container classes; without `markdown-rendered` and `markdown-preview-view`, the same renderer still looked visually different under theme CSS.
- Middle mouse drag now follows the same pan path as space-drag, and preventing default auxclick avoids the browser autoscroll behavior interfering with canvas navigation.
- Card dragging lost priority over embedded images because browser-native dragstart still fired inside previews; preventing dragstart on cards and disabling image dragging restored reliable repositioning.
- Reusing Obsidian Live Preview inside cards would require internal editor embedding, so handing section cards off to a real Markdown window was the lower-risk path.
- Zoom integration is simplest through the plugin's exported `window.ObsidianZoomPlugin.zoomIn(editor, line)` API after opening a popout Markdown editor on the target file.
- Recursive canvas drill-down is easier to reason about when every canvas works on a scoped Markdown slice and repeats the same Shell versus Shell-less rules.
- Scope-specific layout persistence avoids different drill-down levels fighting over one shared coordinate map.
- Entered Shell scopes lost context when their opening heading disappeared; reinserting that heading as a scope-local orphan keeps each drill-down level anchored.
- Global scope also needs an anchor, so showing the file name as a root orphan and moving navigation into breadcrumbs made each canvas level's context visible without crowding the action buttons.
- Canvas navigation felt backwards with a dedicated Open button, so default double-click now opens source context, modifier double-click drills into Shells, and orphan blocks follow the same source-opening path.
- Shell-less containers with internal headings also need recursive scopes; giving headed orphans their own child scopes keeps drill-down behavior consistent outside normal Shell boundaries.

## 2026-04-26

- Frontmatter should be treated as note properties, not canvas content; stripping it before Markdown scope parsing avoids bogus orphan blocks.
- Editing frontmatter is safer through `app.fileManager.processFrontMatter()` than raw text replacement because Obsidian keeps YAML formatting and cache updates coherent.
- A detached properties panel felt out of place; rendering frontmatter as a draggable root-canvas card keeps metadata editing in the same spatial workflow as the rest of Arkidian.
- Frontmatter table interactions felt too modal; making each row directly editable inputs removed the extra Edit step and fit canvas manipulation better.
- Frontmatter card actions read cleaner when addition is a thin full-width footer affordance and deletion collapses to a small inline close control.
- Frontmatter reads closer to the document flow when it is styled shell-less like an orphan block instead of a full shell card, with subdued inline controls.
- Inline property editing feels lighter when the trailing add affordance disappears and the last row grows the table naturally via Enter or Tab.
- Layer navigation only feels trustworthy when the left panel mirrors source order exactly; sorting visible items by source position avoids misleading Shell-first grouping.
- Layer trees scan faster when folding is explicit and type pills are removed; source-like glyphs such as `##`, `>`, and `-` keep the panel readable without adding badge noise.
- Literal text markers felt too raw in the layer panel; switching to Obsidian's built-in icon set keeps the tree cleaner while preserving the same structural cues.
- Treating every clickable thing as a native button blurred UI intent; role-appropriate controls with shared keyboard handling keep semantics and styling easier to separate.
- Layer panel navigation was too eager when single-click entered scopes immediately; making single-click expand only and reserving double-click / modifier-double-click for the same open-versus-enter split as the canvas keeps the mental model consistent.
- Layer trees became noisy when entered scopes repeated their opening heading as both a Shell row and a child element; filtering scope-heading orphans out of the panel keeps the hierarchy readable without changing the canvas content.
- Scope entry feels lighter as a modifier-click than a modifier-double-click; moving all enter actions to Ctrl/Cmd-click keeps drill-down fast while leaving plain double-click dedicated to opening source.
