# Design System Specification: The Architectural Ledger

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Precision Curator."** 

In high-end finance, luxury is defined by the absence of noise and the presence of absolute clarity. This system rejects the "template" look of generic fintech by embracing an editorial, data-dense aesthetic that mirrors a bespoke Swiss timepiece or a premium broadsheet. We move beyond flat UI by utilizing **Tonal Architecture**—defining space through shifting values of light rather than heavy structural lines.

The system breaks the grid through **Intentional Asymmetry**: using wide margins for narrative elements contrasted against hyper-dense, monospaced data modules. The result is an interface that feels authoritative, permanent, and surgically precise.

---

## 2. Colors & Surface Philosophy
The palette is rooted in a "Paper & Ink" philosophy. We use the contrast between a sterile, clinical light base and a deep, intellectual navy to command attention.

### Tonal Hierarchy
- **Primary (`#4f6073`):** Used for structural authority and primary actions.
- **Surface (`#f9f9f9`):** The literal "canvas." Everything begins here.
- **Surface Container Lowest (`#ffffff`):** Reserved for the most important data "islands" to create a natural, bleached-white lift.
- **Surface Container High (`#e4e9ea`):** Used for recessed areas, like sidebars or utility panels, to create a sense of physical carving into the page.

### The "No-Line" Rule
Standard 1px borders are strictly prohibited for sectioning. Use background color shifts to define boundaries. A `surface-container-low` section sitting on a `surface` background provides all the separation a sophisticated eye needs.

### Glass & Gradient Implementation
To prevent the UI from feeling "dry," use **Glassmorphism** for floating utility elements (Modals, Popovers). Apply `surface-container-lowest` with a 70% opacity and a `20px` backdrop-blur. 
*Signature Touch:* For primary CTAs, apply a subtle linear gradient from `primary` to `primary_dim`. This adds a "weighted" feel to the button, suggesting a physical press.

---

## 3. Typography: The Editorial Engine
We use a tri-font system to separate intent: **Manrope** for impact, **Inter** for utility, and **Space Grotesk** for technical labeling.

- **Display & Headlines (Manrope):** High-contrast, geometric, and authoritative. Used for portfolio totals and section headers.
- **Body & Titles (Inter):** The workhorse. Inter’s tall x-height ensures legibility in dense financial tables.
- **Labels & Data (Space Grotesk/Mono):** All numerical data, tickers, and timestamps must use `label-md` or `label-sm`. The monospaced nature of these tokens ensures that fluctuating numbers don't "jump" visually, maintaining a sense of stability.

---

## 4. Elevation & Depth
In this system, depth is a result of **Tonal Layering**, not drop shadows.

- **The Layering Principle:** Stack surfaces to create hierarchy. 
  - *Level 0:* `surface` (The Floor)
  - *Level 1:* `surface-container-low` (Content Grouping)
  - *Level 2:* `surface-container-lowest` (The Active Card)
- **Ambient Shadows:** Only used for "Temporary" elements (Dropdowns). Use a `12px` blur, `4%` opacity, tinted with `primary`. It should feel like a breath of air under the element, not a shadow.
- **The "Ghost Border" Fallback:** If accessibility requires a stroke, use `outline-variant` at **15% opacity**. It must be felt, not seen.

---

## 5. Components

### Buttons
- **Primary:** `primary` fill, `on-primary` text. `0.25rem` (sm) radius. No shadow.
- **Secondary:** `surface-container-highest` fill. Defines the "recessed" look.
- **Tertiary:** Text-only, using `primary` weight 600.

### Input Fields
- **Architecture:** Use a "Minimalist Ledger" style. No containing box; only a `1px` `outline-variant` bottom stroke (Ghost Border). Upon focus, the stroke transitions to `primary` at 100% opacity.
- **Data Density:** Use `label-sm` for helper text to keep the footprint small.

### Cards & Modules
- **Forbid Dividers:** Do not use horizontal lines to separate list items. Use the **Spacing Scale `3` (0.6rem)** to create "negative air" or use alternating `surface` and `surface-container-low` rows for "Zebra" striping in high-density tables.

### Data Visualization (Signature Component)
- **Sparklines:** Use `info` (`#1E88E5`) for neutral trends.
- **Status Pills:** High-density, small-scale. Use `success` (`#00A650`) and `error` (`#9f403d`) with 10% opacity backgrounds and 100% opacity text for a "Modern Regulatory" look.

---

## 6. Do’s and Don’ts

### Do
- **Use "Bleeding" Layouts:** Allow data tables to bleed to the edge of containers to emphasize scale.
- **Embrace White Space:** Use the `16` (3.5rem) spacing token between major sections to let the financial data "breathe."
- **Align to Data:** Always right-align currency and numerical values for easy scanning.

### Don’t
- **No Heavy Rounded Corners:** Never exceed `xl` (0.75rem). This is a professional tool, not a social app.
- **No Pure Black:** Never use `#000000`. Use `on-surface` (`#2d3435`) for all primary text to maintain a high-end, "ink on paper" softness.
- **No Industrial Grays:** Avoid generic `#cccccc`. Always use the `surface-variant` and `outline` tokens which are tinted with the system's navy/cool undertones.