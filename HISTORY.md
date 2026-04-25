# History

## 2026-04-25

- Wheel zoom and initial fit issues came from mixing layout roles between viewport, scroll container, grid layer, and scaled stage.
- Cursor-anchored zoom became reliable after using one shared scroll coordinate system for cards and zoom math.
- Grid rendering became reliable after separating it from the scroll content and keeping it as a viewport overlay that only reads scroll and zoom state.
