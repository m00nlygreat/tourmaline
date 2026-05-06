# Current Work

## Default Layout Improvement

When no `.meta.json` exists, the current fallback layout feels unbalanced because title, frontmatter, orphans, and section cards all depend on a simple source-order index.

Proposed direction:

- Compute a dedicated automatic layout only when metadata is missing for the current scope.
- Keep file title and frontmatter out of the main section-card grid.
- Place file title and frontmatter in a small supporting area near the upper-left of the canvas.
- Arrange section cards in a cleaner responsive grid or shortest-column masonry layout.
- Use rendered card heights when possible so tall cards do not visually collide or create awkward gaps.
- Treat automatically generated positions as provisional.
- Persist positions only after user movement, resize, zoom, or another intentional layout change.

Expected result:

- Deleting metadata should produce a useful visual reset.
- First-open canvas layout should feel centered, readable, and balanced.
- Manual user layout should continue to override automatic layout.
