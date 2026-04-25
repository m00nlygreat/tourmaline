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
- Changes in the source `.md` document must resync the canvas view.
- Double-clicking a Shell opens the source note in a separate Obsidian window focused on that section.
- Ctrl/Cmd-double-clicking a Shell enters that Shell's child canvas scope.
- If the Zoom plugin is installed, the opened editor should zoom into the clicked heading section instead of showing the whole note.
- Double-clicking an orphan opens the current level's source note in a separate Obsidian window focused on that orphan block.

## Canvas Behavior

- Canvas supports zoom and pan.
- Mouse wheel zooms the canvas in and out using the cursor position as the anchor point.
- Wheel zoom must keep the content under the cursor visually pinned while surrounding content expands or contracts around that point.
- Zoom-out must stop before the stage becomes smaller than the visible canvas, so the canvas remains scrollable instead of collapsing into a no-scroll fit state.
- Opening the canvas defaults to a main workspace tab instead of a side panel leaf.
- On first open, the viewport and zoom default to a fitted view that shows all current content within one screen while still presenting the canvas around the world origin.
- Refresh/rebuild and file load must also refit the initial viewport so current content is visible without manual panning.
- The canvas uses a much larger world area, approximately 10x the earlier default workspace.
- The center of the world is `(0, 0)`, and item positions extend into negative and positive `x/y` coordinates from there.
- Holding the space bar enables drag-to-pan navigation.
- Middle mouse button drag also enables the same pan navigation without holding the space bar.
- Cards and orphan elements support selection and repositioning.
- Dragging inside a card should prioritize moving the card over native image drag behavior.
- Card width and position are user-adjustable.
- Adjusted card width is persisted in the sibling meta file and restored on reload.
- The canvas floor renders a simple dotted grid as a spatial reference.
- The dotted grid is rendered on a dedicated canvas overlay layer instead of a CSS background.
- Grid dot size remains fixed on screen while zoom only changes spacing between dots.
- When zoomed out, the grid thins in discrete steps so dots keep a readable minimum on-screen spacing.
- Grid alignment must stay locked to the world origin `(0, 0)` during pan, scroll, zoom, and fit operations.
- Cards and canvas objects remain regular DOM elements; only the background grid moves to canvas rendering for performance.
- The top toolbar shows breadcrumbs on the left and action buttons grouped on the right.

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
- Entering a Shell expands that Shell's body as a new canvas.
- Every entered canvas scope also renders the Shell heading that opened that scope as an orphan-style canvas object.
- The same rules repeat inside every scope:
  - find that scope's highest-level headings
  - render them as Shells
  - render non-Shell content as Shell-less containers
- Drill-down continues until the scope contains no headings.
- The maximum drill-down depth is determined from the deepest heading depth present in the document.

## MVP Scope

- Parse Markdown into heading tree plus orphan blocks.
- Render highest-level sections as cards on a canvas.
- Render orphan blocks as free canvas objects.
- Support markdown preview in cards.
- Use Obsidian Markdown preview rendering consistently for both section cards and orphan elements.
- Support double-click handoff from section cards and orphan elements to the native Obsidian editor in a popout window.
- Persist canvas layout in `<filename>.meta.json`.
- Resync canvas state when the Markdown source changes.
