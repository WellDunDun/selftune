# Stitch Design System: The Cognitive Loom

## Named Color Tokens

| Token | Hex |
|-------|-----|
| background | #111317 |
| surface | #111317 |
| surface_dim | #111317 |
| surface_bright | #37393e |
| surface_container_lowest | #0c0e12 |
| surface_container_low | #1a1c20 |
| surface_container | #1e2024 |
| surface_container_high | #282a2e |
| surface_container_highest | #333539 |
| surface_variant | #333539 |
| surface_tint | #00dbe9 |
| primary | #4ff2ff |
| primary_container | #00d5e3 |
| primary_fixed | #7df4ff |
| primary_fixed_dim | #00dbe9 |
| on_primary | #00363a |
| on_primary_container | #00585e |
| on_primary_fixed | #002022 |
| on_primary_fixed_variant | #004f54 |
| secondary | #cdc5bc |
| secondary_container | #4d4841 |
| secondary_fixed | #e9e1d7 |
| secondary_fixed_dim | #cdc5bc |
| on_secondary | #343029 |
| on_secondary_container | #beb7ae |
| on_secondary_fixed | #1e1b15 |
| on_secondary_fixed_variant | #4b463f |
| tertiary | #73f0f6 |
| tertiary_container | #52d3d9 |
| tertiary_fixed | #79f5fb |
| tertiary_fixed_dim | #59d8de |
| on_tertiary | #003739 |
| on_tertiary_container | #00585c |
| on_tertiary_fixed | #002021 |
| on_tertiary_fixed_variant | #004f52 |
| error | #ffb4ab |
| error_container | #93000a |
| on_error | #690005 |
| on_error_container | #ffdad6 |
| on_background | #e2e2e8 |
| on_surface | #e2e2e8 |
| on_surface_variant | #bbc9cf |
| outline | #859399 |
| outline_variant | #3c494e |
| inverse_primary | #006970 |
| inverse_surface | #e2e2e8 |
| inverse_on_surface | #2f3035 |

## Font Strategy
- **Headlines/Display/Labels:** Space Grotesk
- **Body/Titles:** Manrope
- **Color Mode:** DARK
- **Roundness:** ROUND_FOUR (0.125rem default, md/lg 0.25rem, xl 0.5rem, full 0.75rem)

## Design System Strategy: The Cognitive Loom

## 1. Overview & Creative North Star

### Creative North Star: "The Cognitive Loom"
This design system is built on the metaphor of a "Cognitive Loom" — a space where raw data is woven into intelligence. Unlike standard dashboard templates that feel static and rigid, this system prioritizes **Atmospheric Technicality**. It blends the cold precision of high-density data with the fluid, ethereal nature of AI "thought."

We move beyond the "grid-of-boxes" by employing intentional asymmetry, overlapping layers, and high-contrast typography scales. The goal is an interface that feels like a high-end editorial piece: authoritative, deep, and alive. We achieve this through tonal depth rather than structural lines, ensuring the UI feels like a single cohesive environment rather than a collection of disparate components.

## 2. Colors

The palette is a sophisticated interplay between the void of deep space and the electric spark of a neural firing.

### Surface Hierarchy & Nesting
To achieve a "bespoke" feel, we prohibit traditional 1px borders for sectioning (**The No-Line Rule**). Instead, boundaries are defined by shifting between the surface tiers.
- **Background (`#111317`):** The base canvas.
- **Surface Container Lowest (`#0c0e12`):** Used for "recessed" areas like sidebars or secondary navigation.
- **Surface Container High (`#282a2e`):** Used for primary workspace cards or active focal points.

### The Glass & Gradient Rule
Standard flat colors are insufficient for representing "thinking" AI.
- **Glassmorphism:** Use semi-transparent variants of `surface` with a 12px to 20px backdrop-blur for floating panels or modals. This creates a sense of physical depth.
- **Signature Gradients:** Main CTAs and data visualizations should utilize a "Core-to-Aura" gradient, transitioning from `primary` (`#4ff2ff`) to `primary_container` (`#00d5e3`). This represents the concentration of energy/data.

## 3. Typography

The system utilizes a dual-font strategy to balance technical precision with modern editorial flair.

* **Display & Headlines (Space Grotesk):** A geometric sans-serif with a technical, "monospaced-adjacent" soul. The high-contrast scale (from `display-lg` at 3.5rem to `headline-sm` at 1.5rem) should be used to create clear entry points in data-dense views.
* **Body & Titles (Manrope):** A versatile, modern grotesque designed for legibility. Its high x-height ensures that even at `body-sm` (0.75rem), complex data strings remain readable.

**Editorial Tip:** Use `label-md` in all-caps with increased letter-spacing for category headers to create a "technical blueprint" aesthetic.

## 4. Elevation & Depth

We reject the "drop shadow" defaults of the early 2010s. Depth in this system is a result of light physics and tonal layering.

* **The Layering Principle:** Rather than using lines, stack your surfaces. A `surface_container_highest` (`#333539`) card sitting atop a `surface_dim` (`#111317`) background provides all the separation the eye needs.
* **Ambient Shadows:** If a card must "float" (e.g., a context menu), use a shadow with a blur radius of 32px or higher and an opacity of 6%. The shadow color must be a tinted version of `on_surface` to simulate a natural glow rather than a muddy grey.
* **The Ghost Border:** If accessibility requires a stroke, use a "Ghost Border" — the `outline_variant` (`#3c494e`) at 15% opacity. This defines the edge without breaking the "No-Line" atmospheric flow.

## 5. Components

### Buttons
* **Primary:** A vibrant `primary` (`#4ff2ff`) fill with `on_primary` text. Apply a subtle outer glow (bloom) using the primary color at 20% opacity.
* **Secondary:** A "Ghost" style. No fill, `outline_variant` border, and `on_surface` text.
* **Tertiary:** Text-only with an underline that appears only on hover, using the `spacing.px` scale.

### Cards & Lists
* **Rule:** Forbid divider lines.
* **Execution:** Use `spacing.4` (0.9rem) or `spacing.6` (1.3rem) to separate list items. Use a subtle background shift (`surface_container_low` to `surface_container`) on hover to indicate interactivity.
* **Corner Radii:** Use `xl` (0.5rem) for main containers and `md` (0.25rem) for internal elements like inputs or nested chips.

### Inputs & Fields
* **States:** Default state uses `surface_container_highest` with no border. On focus, the container should transition to `surface_bright` with a `primary` "Ghost Border" at 40% opacity.
* **AI Thinking State:** Incorporate a subtle, horizontal "pulse" gradient across the bottom 2px of the input field using the `tertiary` (`#73f0f6`) token.

### Additional Signature Component: The "Pulse Chip"
A variant of the selection chip that features a 4px breathing dot (using `primary_fixed`). This is used to indicate active AI processes or "learning" states within a data dashboard.
