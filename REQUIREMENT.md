# Arkidian Requirement

## Overview

Obsidian plugin that opens a Markdown document as a zoomable canvas and arranges section content as editable preview cards.

## Core Concept

- Parse the current Markdown document with `remark`.
- Detect the highest heading level used in the document.
- The global canvas uses the document's highest-level headings as Shells.
- The global canvas also shows the current file name as an orphan-style heading object.
- Markdown blocks that do not belong to any Shell are rendered as Shell-less containers.
- If a Shell-less region contains the current scope's highest-level headings, those headings should be used to split that Shell-less region into multiple Shell-less containers.

## Editing Model

- Current MVP uses preview-first cards on the canvas.
- Direct editing inside cards is a later-stage feature.
- YAML frontmatter is shown on the root canvas as an immediately editable property table card.
- Changes in the source `.md` document must resync the canvas view.
- Source-driven canvas refresh should avoid flashing an empty canvas between external file updates when possible.
- Double-clicking a Shell opens the source note in a separate Obsidian window focused on that section.
- Ctrl/Cmd-clicking a Shell enters that Shell's child canvas scope.
- Ctrl/Cmd-clicking an orphan that contains its own heading hierarchy enters that orphan's child canvas scope.
- Markdown embeds remain visually in-flow inside their parent Shell or orphan preview instead of becoming separate floating cards.
- Markdown embeds are still treated as independently selectable nodes for interaction, navigation, and layer management.
- Markdown image embeds rendered as plain images are selectable as embed nodes too.
- Ctrl/Cmd-clicking an embed enters the embedded target in the canvas when that target can be resolved.
- Double-clicking an embed opens the embedded source note in a separate Obsidian window focused on the embedded target.
- If the Zoom plugin is installed, the opened editor should zoom into the clicked heading section instead of showing the whole note.
- If the Zoom plugin is not installed, the opened editor window should still open already scrolled to the clicked source location.
- Double-clicking an orphan opens the current level's source note in a separate Obsidian window focused on that orphan block.
- Pressing `Delete` or `Backspace` while a canvas card or orphan is selected removes that source block from the Markdown document and removes the canvas item.

## Canvas Behavior

- Canvas supports zoom and pan.
- Mouse wheel zooms the canvas in and out using the cursor position as the anchor point.
- Wheel zoom must keep the content under the cursor visually pinned while surrounding content expands or contracts around that point.
- Zoom-out must stop before the stage becomes smaller than the visible canvas, so the canvas remains scrollable instead of collapsing into a no-scroll fit state.
- Opening the canvas defaults to a main workspace tab instead of a side panel leaf.
- On first open, the viewport and zoom default to a fitted view that shows all current content within one screen while still presenting the canvas around the world origin.
- Refresh/rebuild and file load must also refit the initial viewport so current content is visible without manual panning.
- The canvas uses a much larger world area, approximately 10x the earlier default workspace.
- Double-clicking empty canvas floor creates a new heading at the current canvas level, followed by two blank lines, and opens a source editor ready to rename it.
- The center of the world is `(0, 0)`, and item positions extend into negative and positive `x/y` coordinates from there.
- Holding the space bar enables drag-to-pan navigation.
- Middle mouse button drag also enables the same pan navigation without holding the space bar.
- Cards and orphan elements support selection and repositioning.
- Selected canvas elements are highlighted with the accent color on their outline.
- The selected canvas element is also highlighted in the layer panel.
- `Delete` and `Backspace` act on the currently selected canvas item when focus is not inside a text input.
- Selected embeds inside a preview are also highlighted in the layer panel using the same shared selection state.
- Selectable embeds inside a preview show a hover outline before selection.
- Dragging inside a card should prioritize moving the card over native image drag behavior.
- Card width and position are user-adjustable.
- Adjusted card width is persisted in the sibling meta file and restored on reload.
- Resize handles are available before selection and become more visible on hover or selection.
- The canvas floor renders a simple dotted grid as a spatial reference.
- The dotted grid is rendered on a dedicated canvas overlay layer instead of a CSS background.
- Grid dot size remains fixed on screen while zoom only changes spacing between dots.
- When zoomed out, the grid thins in discrete steps so dots keep a readable minimum on-screen spacing.
- Grid alignment must stay locked to the world origin `(0, 0)` during pan, scroll, zoom, and fit operations.
- Cards and canvas objects remain regular DOM elements; only the background grid moves to canvas rendering for performance.
- The top toolbar shows breadcrumbs on the left and action buttons grouped on the right.
- Breadcrumbs include the source-side file and scope chain when the current canvas was reached by entering an embed, without showing the raw embed syntax itself as a separate step.
- A Figma-style layer panel sits on the left side of the view.
- Collapsing the layer panel removes the panel body from the layout and leaves only a floating expand control over the canvas.
- The layer panel width can be adjusted within a constrained range by dragging its right edge.
- The layer panel header includes a control to expand or collapse all currently visible heading groups.
- The layer panel shows the current canvas scope's elements and their descendants as a nested tree.
- The layer panel also shows current-level markdown embeds as separate non-expandable child nodes under the Shell or orphan that visually contains them, after that node's own child structure.
- When a layer-panel orphan contains only embeds and no child scope structure, the panel shows the embed rows directly instead of an extra wrapper orphan.
- When a layer-panel orphan mixes regular Markdown content with embeds and has no child scope structure, the panel shows the regular Markdown row and embed rows as siblings in source order.
- Each markdown embed appears once in the layer panel under the nearest visible source item that contains its source line.
- Layer order follows the source document order instead of grouping Shells and Shell-less blocks separately.
- Dragging reorderable layer rows inside the panel updates the source markdown block order in the current scope.
- The layer panel should not repeat a Shell heading as both the Shell row and a child heading element.
- Single-clicking a drillable layer only expands that layer's tree in the panel.
- Double-clicking a layer opens its source block in the editor, matching canvas behavior.
- Ctrl/Cmd-clicking a drillable layer enters that child canvas scope, matching canvas behavior.
- Tree nodes can be folded and expanded with `>` and `v` controls.
- Layer row labels show readable content without Markdown syntax markers such as heading hashes, list bullets, ordered-list numbers, or link markup.
- Layer rows should prefer built-in iconography for toggles and content type markers when available.
- All Shell rows start collapsed by default in the layer panel.

## Metadata Storage

- The Markdown file is the source of truth for content.
- Canvas-specific metadata is stored in a sibling file named `<filename>.meta.json`.
- The metadata file stores only visualization and layout state.
- Layout state is stored per canvas scope, not as one flat document-wide coordinate map.

## Identity Strategy

- Content mapping should not rely only on line ranges.
- Prefer stable structural anchors such as heading path or section identity, with line-range fallback if needed.

## Canvas Levels

- Any Shell can be entered as a deeper canvas scope.
- Any Shell-less container that carries its own heading hierarchy can also be entered as a deeper canvas scope.
- Entering a Shell expands that Shell's body as a new canvas.
- Entering a Shell-less container expands that container's internal heading hierarchy as a new canvas.
- Every entered canvas scope also renders the Shell heading that opened that scope as an orphan-style canvas object.
- The same rules repeat inside every scope:
  - find that scope's highest-level headings
  - render them as Shells
  - render non-Shell content as Shell-less containers
- Drill-down continues until the scope contains no headings.
- The maximum drill-down depth is determined from the deepest heading depth present in the document.

## MVP Scope

- Parse Markdown into heading tree plus orphan blocks.
- Exclude YAML frontmatter from canvas body parsing.
- Render highest-level sections as cards on a canvas.
- Render orphan blocks as free canvas objects.
- Support markdown preview in cards.
- Use Obsidian Markdown preview rendering consistently for both section cards and orphan elements.
- Show frontmatter as a canvas card with immediate table editing and persist edits back into the source Markdown via Obsidian APIs.
- Support double-click handoff from section cards and orphan elements to the native Obsidian editor in a popout window.
- Persist canvas layout in `<filename>.meta.json`.
- Resync canvas state when the Markdown source changes.
