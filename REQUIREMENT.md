# Arkidian Requirement

## Overview

Obsidian plugin that opens a Markdown document as a zoomable canvas and arranges section content as editable preview cards.

## Core Concept

- Parse the current Markdown document into a heading-based tree.
- Detect the highest heading level used in the document.
- Create canvas cards for each section at that highest heading level.
- Each card contains:
  - the section heading
  - sibling Markdown elements belonging to that section
  - nested child headings and their content, grouped inside the same card
- Markdown blocks that do not belong to any parent heading are treated as orphan elements and rendered as freely movable text-like canvas objects.

## Editing Model

- Current MVP uses preview-first cards on the canvas.
- Direct editing inside cards is a later-stage feature.
- Changes in the source `.md` document must resync the canvas view.

## Canvas Behavior

- Canvas supports zoom and pan.
- Mouse wheel zooms the canvas in and out using the cursor position as the anchor point.
- Wheel zoom must keep the content under the cursor visually pinned while surrounding content expands or contracts around that point.
- Opening the canvas defaults to a main workspace tab instead of a side panel leaf.
- On first open, the viewport and zoom default to a fitted view that shows all current content within one screen while still presenting the canvas around the world origin.
- Refresh/rebuild and file load must also refit the initial viewport so current content is visible without manual panning.
- The canvas uses a much larger world area, approximately 10x the earlier default workspace.
- The center of the world is `(0, 0)`, and item positions extend into negative and positive `x/y` coordinates from there.
- Holding the space bar enables drag-to-pan navigation.
- Cards and orphan elements support selection and repositioning.
- Card size and position are user-adjustable.
- The canvas floor renders a simple dotted grid as a spatial reference.
- The dotted grid is rendered on a dedicated canvas overlay layer instead of a CSS background.
- Grid dot size remains fixed on screen while zoom only changes spacing between dots.
- When zoomed out, the grid thins in discrete steps so dots keep a readable minimum on-screen spacing.
- Grid alignment must stay locked to the world origin `(0, 0)` during pan, scroll, zoom, and fit operations.
- Cards and canvas objects remain regular DOM elements; only the background grid moves to canvas rendering for performance.

## Metadata Storage

- The Markdown file is the source of truth for content.
- Canvas-specific metadata is stored in a sibling file named `<filename>.meta.json`.
- The metadata file stores only visualization and layout state, such as:
  - card and orphan ids
  - mapping anchors to source content
  - positions and sizes
  - collapsed or expanded state
  - viewport or zoom state

## Identity Strategy

- Content mapping should not rely only on line ranges.
- Prefer stable structural anchors such as heading path or section identity, with line-range fallback if needed.

## MVP Scope

- Parse Markdown into heading tree plus orphan blocks.
- Render highest-level sections as cards on a canvas.
- Render orphan blocks as free canvas objects.
- Support markdown preview in cards.
- Persist canvas layout in `<filename>.meta.json`.
- Resync canvas state when the Markdown source changes.
