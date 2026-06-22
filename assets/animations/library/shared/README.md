# Shared Approved Animations

Store only approved, reusable animation assets in this directory.

- Files here are the canonical shared library used across characters.
- Every clip here should map to a stable semantic animation id.
- Do not place exploratory, generated, or character-specific motion here.
- Character packages may reference shared ids without duplicating assets locally.

## Third-party attribution

Some clips here are sourced from the **pixiv/VRoid VRMA Motion Pack** and are
used under its terms — **Animation credits to pixiv Inc.'s VRoid Project**
(キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト). Its license
forbids redistributing the extractable motion data, so those `.vrma` files are
**git-ignored and kept local-only** (see the root `.gitignore`); they are not
committed to this repository. Imported pixiv clips:
`emote.showcase.once`, `emote.spin.once`, `emote.pose.once`,
`greet.greeting.once`, `gesture.peace.once`.

Mixamo-derived clips (royalty-free) are committed as native `.vrma`.
