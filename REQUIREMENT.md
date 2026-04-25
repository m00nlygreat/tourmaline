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

- Each card supports live Markdown preview on the canvas.
- Each card supports direct editing on the canvas.
- Edits made in cards must sync back to the source `.md` document.
- Changes in the source `.md` document must resync the canvas view.

## Canvas Behavior

- Canvas supports zoom and pan.
- Cards and orphan elements support selection and repositioning.
- Card size and position are user-adjustable.

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
- Support live preview and direct editing in cards.
- Persist canvas layout in `<filename>.meta.json`.
- Resync canvas state when the Markdown source changes.
