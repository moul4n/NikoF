# Next Steps

Updated: 2026-05-14

1. Use the landed control and display shell split to deepen display-only composition without moving backend-confirmed character state or `speech.lifecycle` consumption out of `App.tsx`.
2. Keep the current local `surface` branch as the navigation seam until the shell needs real deep-linkable routes; do not add a router just to restate the current two-surface branch.
3. If the display surface needs more structure, extract presentation-only components first and keep App as the single owner of backend sync, active-character confirmation, and live speech lifecycle state.
4. Keep backend transport, cursor flow, manifest-local asset resolution, and the canonical `speech.lifecycle` envelope unchanged while that display-only follow-up batch lands.
