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
