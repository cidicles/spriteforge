// Copied from diablow/scripts/sprite-prompts.js so the demo container does
// not need the game repo. Keep in sync by hand — it is two constants.

const SPRITE_STYLE = "dark gothic fantasy action RPG, Diablo II style hand-painted 2D game sprite, three-quarter isometric view from slightly above, facing the lower left, full body from head to toe, single character centered in frame, plain flat light grey studio background, crisp readable silhouette, even lighting, no ground shadow, no text, no watermark --no floor, ground shadow, scenery, text, cropped, photorealistic, photo, 3d render";

const PRESET_ANIMATIONS = [
  {
    "name": "idle",
    "motion": "The character breathes and shifts their weight in a ready stance, feet planted in place.",
    "frames": 16,
    "fps": 8,
    "cycle": true,
    "minCycle": 1,
    "scale": 0.6
  },
  {
    "name": "walk",
    "motion": "The character walks in place as if on a treadmill, a full natural stride with alternating legs and swinging arms; they do not travel across the frame.",
    "frames": 12,
    "fps": 12,
    "cycle": true,
    "minCycle": 0.6,
    "scale": 0.6
  },
  {
    "name": "attack",
    "motion": "The character performs one fast, powerful attack with their weapon, then recovers back to their ready stance.",
    "frames": 12,
    "fps": 15,
    "cycle": true,
    "minCycle": 0.8,
    "scale": 0.5
  },
  {
    "name": "cast",
    "motion": "The character raises a hand and casts a spell in a burst of magical energy, then returns to their ready stance.",
    "frames": 12,
    "fps": 15,
    "cycle": true,
    "minCycle": 0.8,
    "scale": 0.55
  },
  {
    "name": "hit",
    "motion": "The character flinches backward from a heavy blow, then recovers to their ready stance.",
    "frames": 8,
    "fps": 15,
    "cycle": true,
    "minCycle": 0.5,
    "scale": 0.6
  },
  {
    "name": "death",
    "motion": "The character collapses to the ground on the spot and lies still.",
    "frames": 16,
    "fps": 12,
    "cycle": false,
    "scale": 0.55
  }
];

module.exports = { SPRITE_STYLE, PRESET_ANIMATIONS };
