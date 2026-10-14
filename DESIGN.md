---
version: alpha
name: Pubx
description: |
  pubX's design system embodies a bold, modern brand that prioritizes clarity
  and trust in the advertising infrastructure space. The visual language is
  assertive and energetic, built on a sharp, minimalist aesthetic with no
  rounded corners, creating a sense of precision and technical confidence. The
  primary orange accent (#F05223) acts as a confident call-to-action element,
  while warm earth tones and deep burgundy accents create visual depth and
  sophistication. Typography is generous and legible, using the modern Manrope
  family exclusively. The system embraces flat design—no shadows or
  gradients—allowing color and type to carry the narrative. Large display
  headlines paired with generous whitespace communicate authority and focus.
source:
  url: 'https://pubx.ai'
  pagesAnalyzed: 1
  extractedAt: 2026-10-13
  tokensMeasured: true
colors:
  primary: '#F05223'
  accent: '#475467'
  link: '#F37344'
  canvas: '#FFFFFF'
  on-primary: '#FEF4EE'
  ink: '#101828'
  body: '#475467'
  muted: '#FEF4EE'
  accent-1: '#E13615'
  accent-2: '#0D6EFD'
  accent-3: '#781D16'
  accent-4: '#410B09'
typography:
  display:
    fontFamily: Manrope
    fontSize: 60px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0px
  heading-md:
    fontFamily: Manrope
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: 0px
  heading-sm:
    fontFamily: Manrope
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0px
  heading-xs:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0px
  body-xl:
    fontFamily: Manrope
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  body-xl-tight:
    fontFamily: Manrope
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: 0px
  body-xl-strong:
    fontFamily: Manrope
    fontSize: 20px
    fontWeight: 900
    lineHeight: 1.5
    letterSpacing: 0px
  body-lg:
    fontFamily: Manrope
    fontSize: 18.6667px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0px
  body-md:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  body-md-strong:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: 600
    lineHeight: 2.75
    letterSpacing: 0px
  nav:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0px
rounded:
  none: 0px
spacing:
  xxs: 4px
  xs: 12px
  sm: 20px
  md: 24px
  lg: 32px
  xl: 48px
  xxl: 64px
  xxxl: 68px
  section: 72px
  band: 108px
elevationStrategy: color-blocking
themes:
  derived: dark # the other theme is the site's measured palette
  light:
    bg: '#FFFFFF'
    surface: '#F7F7F7'
    surfaceRaised: '#EEEEEF'
    text: '#101828'
    textMuted: '#475467'
    border: '#E2E3E5'
    accent: '#F05223'
    accentFg: '#000000'
    focusRing: '#F05223'
    elevation: shadow
  dark:
    bg: '#140C0A'
    surface: '#221B19'
    surfaceRaised: '#2E2725'
    text: '#FEF8F6'
    textMuted: '#A59E9C'
    border: '#3A3331'
    accent: '#F05223'
    accentFg: '#0B0B0C'
    focusRing: '#F05223'
    elevation: 'border+surface'
components:
  button-primary:
    typography: '{typography.body-md-strong}'
    textColor: '{colors.muted}'
    height: 44px
    padding: '0px 16px 0px 16px'
    backgroundColor: '{colors.primary}'
  card:
    typography: '{typography.body-md}'
    textColor: '{colors.body}'
    padding: '128px 12px 128px 12px'
    backgroundColor: 'rgb(249, 250, 251)'
  card-lg:
    typography: '{typography.body-md}'
    textColor: '{colors.body}'
    padding: '128px 12px 128px 12px'
    backgroundColor: '{colors.canvas}'
  navigation:
    typography: '{typography.body-md}'
    textColor: '{colors.body}'
    height: 24px
  footer:
    typography: '{typography.body-md}'
    textColor: '{colors.body}'
    padding: '64px 12px 48px 12px'
    backgroundColor: '{colors.accent-4}'
  link:
    typography: '{typography.body-md}'
    textColor: '{colors.accent-2}'
    padding: '0px 12px 0px 12px'
  link-sm:
    typography: '{typography.body-md}'
    textColor: '{colors.muted}'
states:
  link-hover:
    target: link
    state: hover
    textDecoration: none
  input-disabled:
    target: input
    state: disabled
    opacity: 1
  other-focus:
    target: other
    state: focus
    boxShadow: 'rgba(13, 110, 253, 0.25) 0px 0px 0px 0.25rem'
    borderColor: 'rgb(134, 183, 254)'
  other-disabled:
    target: other
    state: disabled
    opacity: 1
  input-focus:
    target: input
    state: focus
    boxShadow: 'rgba(13, 110, 253, 0.25) 0px 0px 0px 0.25rem'
    borderColor: 'rgb(134, 183, 254)'
  input-active:
    target: input
    state: active
    filter: 'brightness(90%)'
  button-disabled:
    target: button
    state: disabled
    filter: none
    opacity: 0.65
  other-active:
    target: other
    state: active
    backgroundColor: 'rgb(182, 212, 254)'
  nav-disabled:
    target: nav
    state: disabled
    borderColor: transparent
    backgroundColor: transparent
  other-hover:
    target: other
    state: hover
    textDecoration: none
  button-hover:
    target: button
    state: hover
    textDecoration: none
breakpoints:
  - width: 375
    containerWidth: 351
    gridColumns: 3
    navLinksVisible: 8
    menuToggleVisible: true
    headingPx: 30
    bodyPx: 16
    sectionPaddingX: 12
  - width: 768
    containerWidth: 744
    gridColumns: 7
    navLinksVisible: 15
    menuToggleVisible: false
    headingPx: 45
    bodyPx: 16
    sectionPaddingX: 12
  - width: 1024
    containerWidth: 1000
    gridColumns: 7
    navLinksVisible: 15
    menuToggleVisible: false
    headingPx: 45
    bodyPx: 16
    sectionPaddingX: 12
  - width: 1280
    containerWidth: 1256
    gridColumns: 8
    navLinksVisible: 15
    menuToggleVisible: false
    headingPx: 60
    bodyPx: 16
    sectionPaddingX: 12
  - width: 1440
    containerWidth: 1280
    gridColumns: 8
    navLinksVisible: 15
    menuToggleVisible: false
    headingPx: 60
    bodyPx: 16
    sectionPaddingX: 12
coverage:
  statesFound: 61
  gradientsFound: 0
  rolesUnassigned: 4
  archetypesUnnamed: 0
  archetypesDetected: 0
  responsiveMeasured: true
  stylesheetsBlocked: false
  semanticRampDeclared: false
---

# Design System Inspired by pubX

## 1. Visual Theme & Atmosphere

pubX's design system embodies a bold, modern brand that prioritizes clarity and trust in the advertising infrastructure space. The visual language is assertive and energetic, built on a sharp, minimalist aesthetic with no rounded corners, creating a sense of precision and technical confidence. The primary orange accent (`{colors.primary}` — `#F05223`) acts as a confident call-to-action element, while warm earth tones and deep burgundy accents create visual depth and sophistication. Typography is generous and legible, using the modern Manrope family exclusively. The system embraces flat design—no shadows or gradients—allowing color and type to carry the narrative. Large display headlines paired with generous whitespace communicate authority and focus.

**Key Characteristics**

- Sharp, right-angled geometry with zero border-radius throughout
- Bold orange brand accent with warm supporting palette
- Flat, color-driven hierarchy (no shadows or gradients)
- Single typeface across all scales (Manrope)
- High-contrast, minimal navigation and UI
- Generous spacing and breathing room for content
- Deep burgundy and neutral grays create refinement and trust

## 2. Color Palette & Roles

### Primary

- **Primary Brand** (`{colors.primary}` — `#F05223`): CTA buttons, brand mark accent, hero elements, active states. The defining accent that commands attention.

### Interactive & Links

- **Link** (`{colors.link}` — `#F37344`): Inline hyperlink text, secondary call-to-action emphasis.

### Accent & Decorative

- **Accent / Dark Burgundy** (`{colors.accent-1}` — `#E13615`): Decorative accent, used in hero wave illustrations and brand graphics.
- **Accent / Dark Burgundy** (`{colors.accent-3}` — `#781D16`): Decorative accent, part of hero hero band gradient system.
- **Accent / Very Dark Burgundy** (`{colors.accent-4}` — `#410B09`): Decorative accent, deep tone in layered hero graphics and footer background.
- **Accent / Blue** (`{colors.accent-2}` — `#0D6EFD`): Decorative accent, reserved for specific branded moments (not primary interactive use).

### Neutral Scale

- **Canvas** (`{colors.canvas}` — `#FFFFFF`): Default page background, card surfaces, primary content areas.
- **Ink** (`{colors.ink}` — `#101828`): Headings, primary body text, dominant text color on light backgrounds.
- **Accent / Secondary** (`{colors.accent}` — `#475467`): Body copy, secondary text, supporting content on neutral backgrounds.
- **Muted / On Primary** (`{colors.on-primary}` — `#FEF4EE`): Captions, secondary text, label text on branded surfaces, button text on primary brand buttons.

## 3. Typography Rules

### Font Family

**Primary Font:** Manrope (Google Fonts: https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap)  
Weights available: 400 (Regular), 500 (Medium), 600 (Semibold), 700 (Bold), 900 (Extra-bold)  
**Fallback Stack:** `Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

### Hierarchy

| Role           | Font    | Size    | Weight | Line Height | Letter Spacing | Notes                                               |
| -------------- | ------- | ------- | ------ | ----------- | -------------- | --------------------------------------------------- |
| Display        | Manrope | 60px    | 700    | 1.2         | 0px            | Hero headlines, h1 equivalent; commanding presence  |
| Heading MD     | Manrope | 36px    | 700    | 1.22        | 0px            | Section headings, h3 equivalent                     |
| Heading SM     | Manrope | 24px    | 700    | 1.5         | 0px            | Subheadings, h5 equivalent                          |
| Heading XS     | Manrope | 16px    | 600    | 1.5         | 0px            | Small headings, h6 equivalent                       |
| Body XL        | Manrope | 20px    | 400    | 1.5         | 0px            | Large body text, marketing copy                     |
| Body XL Tight  | Manrope | 20px    | 400    | 1.2         | 0px            | Large body text with compressed leading             |
| Body XL Strong | Manrope | 20px    | 900    | 1.5         | 0px            | Large body text, high-emphasis                      |
| Body LG        | Manrope | 18.67px | 700    | 1.5         | 0px            | Medium-large body text, bold emphasis               |
| Body MD        | Manrope | 16px    | 400    | 1.5         | 0px            | Default body text, standard paragraph               |
| Body MD Strong | Manrope | 16px    | 600    | 2.75        | 0px            | Standard body with semibold emphasis; loose leading |
| Navigation     | Manrope | 16px    | 700    | 1.5         | 0px            | Navigation menu links                               |

### Principles

- **Legibility First:** Generous line heights (1.2–2.75) ensure excellent readability at all scales.
- **Single Typeface:** Manrope is used exclusively across the system—no secondary font. Hierarchy is achieved through size, weight, and color.
- **High Contrast:** Text uses either `{colors.ink}` for maximum contrast on light backgrounds, or `{colors.on-primary}` on dark/branded surfaces.
- **Bold Weights on Display:** Display and heading sizes use weight 700 or higher; body defaults to weight 400 with 600/700 for emphasis.
- **No Artificial Tracking:** Letter-spacing is uniformly 0px; letter-forms are allowed to render naturally.

## 4. Component Stylings

### Buttons

**Primary Button**

- **Background:** `{colors.primary}` (`#F05223`)
- **Text Color:** `{colors.on-primary}` (`#FEF4EE`)
- **Font:** Manrope, 16px, weight 600
- **Padding:** 0px 16px
- **Height:** 44px
- **Border Radius:** `{rounded.none}` (0px)
- **Border:** None
- **Line Height:** 44px (vertically centered)
- **Box Shadow:** None
- **Width:** 161px (measured as content-fit)
- **Hover State:** Background color transitions (brightness/tone shift applied via `var(--bs-btn-hover-bg)`)
- **Focus State:** Outline removed; focus style applied via `var(--bs-btn-focus-box-shadow)`
- **Active State:** Background color shifts to active tone via `var(--bs-btn-active-bg)`
- **Disabled State:** Opacity reduced to `var(--bs-btn-disabled-opacity)` (~0.65)

### Navigation

**Default Navigation**

- **Background:** Transparent (`rgba(0, 0, 0, 0)`)
- **Text Color:** `{colors.accent}` (`#475467`)
- **Font:** Manrope, 16px, weight 400 (inherited from nav role; links override to weight 700 via nav link semantics)
- **Padding:** 0px (no inherent padding)
- **Border Radius:** `{rounded.none}` (0px)
- **Border:** None
- **Line Height:** 24px
- **Box Shadow:** None
- **Hover State:** Text color transitions to `var(--bs-nav-link-hover-color)` (typically darker or accent tint)
- **Layout:** Horizontal flexbox; 931px measured width at full viewport

### Links

**Inline Link (default)**

- **Text Color:** `#0D6EFD` (blue link color, measured as `rgb(13, 110, 253)`)
- **Background:** Transparent
- **Font:** Manrope, 16px, weight 400
- **Border Radius:** `{rounded.none}` (0px)
- **Text Decoration:** None
- **Hover State:** Text decoration remains none; color inherits or shifts per context
- **Padding:** 0px 12px (horizontal padding observed)

**Brand Link (footer/secondary contexts)**

- **Text Color:** `{colors.on-primary}` (`#FEF4EE`)
- **Background:** Transparent
- **Font:** Manrope, 16px, weight 400
- **Hover State:** Opacity shifts to 0.9; color becomes `rgb(255, 255, 255)`

### Cards & Containers

**Default Card (Light Background)**

- **Background:** `#F9FAFB` (light gray surface)
- **Text Color:** `{colors.accent}` (`#475467`)
- **Font:** Manrope, 16px, weight 400
- **Padding:** 128px 12px (top/bottom generous; left/right minimal for mobile)
- **Border Radius:** `{rounded.none}` (0px)
- **Border:** None
- **Box Shadow:** None
- **Line Height:** 24px
- **Height:** 597px (measured at 1440px viewport)

**Large Card (White Background)**

- **Background:** `{colors.canvas}` (`#FFFFFF`)
- **Text Color:** `{colors.accent}` (`#475467`)
- **Font:** Manrope, 16px, weight 400
- **Padding:** 128px 12px
- **Border Radius:** `{rounded.none}` (0px)
- **Border:** None
- **Box Shadow:** None
- **Height:** 811px (measured at 1440px viewport)

### Footer

**Footer Container**

- **Background:** `#410B09` (very dark burgundy, `{colors.accent-4}`)
- **Text Color:** `{colors.accent}` (`#475467`)
- **Font:** Manrope, 16px, weight 400
- **Padding:** 64px 12px 48px 12px
- **Border Radius:** `{rounded.none}` (0px)
- **Border:** None
- **Box Shadow:** None
- **Height:** 617px (measured at 1440px viewport)
- **Width:** 1440px (full container width)

## 5. Layout Principles

### Spacing System

The design uses a proportional scale built from a base unit of 4px:

- **`{spacing.xxs}`** = 4px — Micro-spacing, internal component padding
- **`{spacing.xs}`** = 12px — Small gaps, component-to-component spacing
- **`{spacing.sm}`** = 20px — Standard section gap
- **`{spacing.md}`** = 24px — Medium section spacing
- **`{spacing.lg}`** = 32px — Large content blocks
- **`{spacing.xl}`** = 48px — Section-level breathing room
- **`{spacing.xxl}`** = 64px — Major section separation (e.g., footer padding top)
- **`{spacing.xxxl}`** = 68px — Large layout divisions
- **`{spacing.section}`** = 72px — Full section padding (top/bottom on full-width blocks)
- **`{spacing.band}`** = 108px — Extra-large hero and feature sections

**Usage Context:**

- Component internal padding: `{spacing.xxs}` to `{spacing.xs}`
- Section vertical separation: `{spacing.md}` to `{spacing.section}`
- Hero blocks and feature sections: `{spacing.band}` or `{spacing.section}`
- Page margins: `{spacing.xs}` on mobile, `{spacing.md}` at larger viewports

### Grid & Container

- **Max Content Width:** 1280px (at 1440px viewport, container width 1256px content column; constrained at 1440px)
- **Mobile Content Width:** 351px (at 375px viewport)
- **Tablet Content Width:** 744px (at 768px viewport)
- **Desktop Content Width:** 1000px–1256px (768px–1440px)
- **Column Strategy:** Fluid single-column on mobile (3 columns grid at 375px); expands to 7–8 columns at tablet and desktop. Grid columns measured: 3 (375px), 7 (768px–1024px), 8 (1280px+).
- **Section Padding Horizontal:** Consistent 12px left/right at all breakpoints
- **Full-Width Blocks:** Hero bands, cards, and footer span edge-to-edge with 12px internal padding

### Whitespace Philosophy

The system prioritizes generous vertical breathing room. Section padding is consistently large (128px top/bottom on content cards, 64px on footer), allowing content to feel spacious and authoritative. Horizontal spacing is compressed on mobile (12px padding) but maintains breathing room at desktop through max-width constraints rather than large margins. This creates a modern, uncluttered appearance that emphasizes content hierarchy and reading comfort.

### Border Radius Scale

- **`{rounded.none}`** = 0px (applied to all interactive and container components: buttons, cards, images, overlays)

All elements in this system are sharp-cornered. No rounded variants exist.

### Border Widths

No border widths were extracted. The system uses flat design with no visible strokes or borders on primary components. Where borders appear (e.g., form inputs in focus state), they are applied via Bootstrap CSS variables (`var(--bs-success)`, `var(--bs-danger)`) rather than explicit border-width tokens.

## 6. Depth & Elevation

The pubX design system employs **flat, color-blocking strategy** for depth. There are no box-shadows, no multi-layer elevation ladders, and no gradients. Depth and hierarchy are communicated exclusively through color, typography size/weight, and vertical spatial separation.

| Level       | Treatment                        | Use                                              |
| ----------- | -------------------------------- | ------------------------------------------------ |
| Base / Flat | No shadow; background color only | Cards, buttons, body text, default page surfaces |
| None        | Transparent or inherited         | Navigation, links, overlays                      |

**Shadow Philosophy:**
The system intentionally avoids shadows. No `box-shadow` values are declared on primary components. Where focus states appear in form inputs (Bootstrap-driven), shadows are minimal and use semi-transparent overlays (e.g., `rgba(13, 110, 253, 0.25) 0px 0px 0px 0.25rem`) rather than drop shadows, creating a subtle glow rather than lift.

### Opacity Levels

Opacity adjustments are applied in specific interaction contexts:

- **Hover (buttons, links):** Opacity reduced to 0.9 (slight dimming)
- **Disabled (inputs, buttons):** Opacity reduced to 0.5–0.65 for reduced visual weight
- **Focus (form inputs):** Opacity maintained at 1 or 0.65 depending on interaction phase; overlay box-shadow at `rgba(13, 110, 253, 0.25)` creates focus indication

### Z-index / Layering

- **Base:** z-index 1–2 (default component stack)
- **Standard:** z-index 9 (sticky/elevated components)
- **Dropdown / Modal:** z-index 99 (menus, overlays, dropdowns above all content)

## 7. Do's and Don'ts

### Do

- **Use sharp, right-angled geometry.** All components have 0px border-radius; maintain this consistency for a modern, technical feel.
- **Rely on color and typography for hierarchy.** The system has no shadows—use bold weights, size shifts, and the primary orange to drive emphasis.
- **Respect generous spacing.** Section padding is large (128px top/bottom); do not compress content to save space.
- **Maintain the single-typeface discipline.** Use Manrope at weights 400, 600, 700, and 900; do not introduce secondary fonts.
- **Apply orange (`#F05223`) sparingly but confidently.** Reserve it for primary CTAs and key brand moments; it is the system's strongest accent.
- **Use the neutral palette for balance.** Gray (`#475467`), off-white (`#FEF4EE`), and dark backgrounds create sophisticated contrast.
- **Test at all breakpoints.** Navigation collapses at mobile; ensure button sizing and text sizes remain legible at 375px.

### Don't

- **Round corners.** Every component is sharp; do not add `border-radius` to buttons, cards, or containers.
- **Add drop shadows or layered depth effects.** Depth comes from color, position, and spacing—not shadows.
- **Use secondary typefaces.** Manrope is the system's only font; no serif or monospace replacements.
- **Overuse the primary orange.** It should accent, not dominate; too much reduces its impact.
- **Introduce undocumented colors.** Stick to the extracted palette; do not invent gradients, additional accent tones, or semantic status colors.
- **Compress spacing on desktop.** Large padding and margins are a defining characteristic; do not sacrifice breathing room for content.
- **Ignore the interaction states.** Hover, focus, and disabled states are defined; implement them to ensure accessibility and usability.
- **Apply transparency without purpose.** Opacity changes support disabled/hover states; do not use them arbitrarily.

## 8. Responsive Behavior

### Breakpoints

| Viewport               | Content Width | Grid Columns | Nav Visible                          | Menu Toggle | Display Size | Body Size | Section Padding X |
| ---------------------- | ------------- | ------------ | ------------------------------------ | ----------- | ------------ | --------- | ----------------- |
| 375px (Mobile)         | 351px         | 3            | No (8 links shown but nav collapses) | Yes         | 30px         | 16px      | 12px              |
| 768px (Tablet)         | 744px         | 7            | Yes (15 links)                       | No          | 45px         | 16px      | 12px              |
| 1024px (Desktop)       | 1000px        | 7            | Yes (15 links)                       | No          | 45px         | 16px      | 12px              |
| 1280px (Large Desktop) | 1256px        | 8            | Yes (15 links)                       | No          | 60px         | 16px      | 12px              |
| 1440px (Max Width)     | 1280px        | 8            | Yes (15 links)                       | No          | 60px         | 16px      | 12px              |

**Key Transitions:**

- **375px → 768px:** Display size increases from 30px to 45px; grid expands from 3 to 7 columns; navigation becomes visible and menu toggle disappears.
- **1024px → 1280px:** Display size increases from 45px to 60px; grid expands from 7 to 8 columns; content width expands.
- **1440px+:** Content width caps at 1280px; no further expansion.

### Touch Targets

Primary interactive elements (buttons, navigation links) are sized for touch:

- **Button Height:** 44px (sufficient for finger tap)
- **Link Padding:** 12px horizontal, implicit vertical padding via line-height (24px min.)
- **Navigation Link Target:** Implicit clickable area via navigation container; 16px font and 24px line-height provide ample touch surface

### Collapsing Strategy

- **Navigation:** At mobile (375px), the full navigation list collapses; a hamburger menu toggle appears. Links remain at 16px but are hidden in a mobile menu.
- **Display Heading:** Reduces from 60px (desktop, `{typography.display}`) to 45px (tablet, `{typography.heading-md}` level) to 30px (mobile).
- **Grid Layout:** Mobile uses 3-column grid; tablet/desktop use 7–8 columns. Content reflows but maintains 12px side padding.
- **Cards and Sections:** Full-width at all sizes; padding (128px vertical, 12px horizontal) remains constant to preserve whitespace rhythm.

## 9. Agent Prompt Guide

### Quick Color Reference

- **Primary CTA Buttons:** Primary (`#F05223`)
- **Primary Button Text:** On Primary (`#FEF4EE`)
- **Page Background:** Canvas (`#FFFFFF`)
- **Body Text:** Accent (`#475467`)
- **Headings:** Ink (`#101828`)
- **Inline Links:** Link blue (`#F37344`)
- **Footer Background:** Very Dark Burgundy (`#410B09`)
- **Secondary Cards:** Light Gray (`#F9FAFB`)
- **Decorative Accents:** Red (`#E13615`), Blue (`#0D6EFD`), Dark Burgundy (`#781D16`)

### Iteration Guide

1. **No rounded corners.** Every component uses `border-radius: 0px`. Buttons, cards, inputs, overlays—all sharp.
2. **Use Manrope exclusively.** All text uses the Manrope typeface at weights 400, 600, 700, or 900. No serif or secondary fonts.
3. **Primary orange is rare.** Reserve `#F05223` for primary CTAs, brand marks, and high-emphasis moments. Most text uses `#475467` or `#101828`.
4. **Spacing is generous.** Section padding is 128px top/bottom (or 64px on footer). Do not compress; breathing room is deliberate.
5. **Depth comes from color and typography.** No box-shadows. Use color contrast, size shifts, and bold weights to create hierarchy.
6. **Buttons are 44px tall.** Primary buttons use `height: 44px`, padding `0px 16px`, font 16px weight 600, text color `#FEF4EE`.
7. **Mobile navigation collapses.** At 375px, show hamburger menu; nav links hide. At 768px+, full navigation is visible.
8. **Display text scales with viewport.** 30px at mobile (375px), 45px at tablet (768px), 60px at desktop (1280px+).
9. **Flat design—no shadows or gradients.** Depth is visual, not physical. Transparency and opacity shifts support interaction states only.
10. **Breakpoint max-width is 1280px.** Content reaches max 1280px at 1440px viewport; no infinite expansion.

## 10. Known Gaps

- **No semantic status colors.** The extraction found no error, success, warning, or info colors declared in the site's primary stylesheet. No status ramp exists; if semantic colors are needed, they must be derived or sourced separately.
- **No interaction state colors explicitly defined.** Hover, focus, active, and disabled states are handled via CSS custom properties (`var(--bs-btn-hover-bg)`, etc.) and Bootstrap variables, not as hardcoded tokens. Exact hover/active colors are not measured; only the design intent (opacity/brightness shift) is captured.
- **Four accent colors assigned no role.** Colors `#0D6EFD` (blue), `#E13615` (red), `#781D16` (dark burgundy), and `#410B09` (very dark burgundy) appear in hero graphics and decorative elements but have no declared semantic use. They are described as decorative only.
- **No gradient or decorative mesh system.** The hero band and wave graphics use flat color blocks, not gradients. The extraction found no gradient declarations; if animated or layered graphics exist, they are not tokenized.
- **No form input components extracted.** Input fields, text areas, and checkboxes are not measured as primary components; their styling is delegated to Bootstrap CSS variables. Custom form styling is not documented here.
- **No animation or transition system defined.** Hover/focus state transitions exist (via CSS), but no animation durations, easing functions, or keyframe library is declared.
- **One page analyzed.** Only the home page (https://pubx.ai) was captured. Surfaces behind authentication, product pages, documentation, or secondary sections were not visited.
- **No dark mode or theme switching detected.** The system is light-mode only; no dark theme variant was observed or extracted.

---

```yaml
tokens:
  colors:
    primary:
      value: '#F05223'
      role: 'Primary Brand / CTA'
    accent:
      value: '#475467'
      role: 'Secondary Accent / Body Text'
    link:
      value: '#F37344'
      role: 'Link'
    accent-1:
      value: '#E13615'
      role: 'Decorative'
    accent-2:
      value: '#0D6EFD'
      role: 'Decorative'
    accent-3:
      value: '#781D16'
      role: 'Decorative'
    accent-4:
      value: '#410B09'
      role: 'Decorative / Footer Background'
    canvas:
      value: '#FFFFFF'
      role: 'Background / Canvas'
    ink:
      value: '#101828'
      role: 'Headings / Primary Text'
    on-primary:
      value: '#FEF4EE'
      role: 'Muted / Text on Primary'
  typography:
    display:
      family: 'Manrope'
      size: '60px'
      weight: 700
      lineHeight: 1.2
      letterSpacing: '0px'
    heading-md:
      family: 'Manrope'
      size: '36px'
      weight: 700
      lineHeight: 1.22
      letterSpacing: '0px'
    heading-sm:
      family: 'Manrope'
      size: '24px'
      weight: 700
      lineHeight: 1.5
      letterSpacing: '0px'
    heading-xs:
      family: 'Manrope'
      size: '16px'
      weight: 600
      lineHeight: 1.5
      letterSpacing: '0px'
    body-md:
      family: 'Manrope'
      size: '16px'
      weight: 400
      lineHeight: 1.5
      letterSpacing: '0px'
    nav:
      family: 'Manrope'
      size: '16px'
      weight: 700
      lineHeight: 1.5
      letterSpacing: '0px'
    body-xl:
      family: 'Manrope'
      size: '20px'
      weight: 400
      lineHeight: 1.5
      letterSpacing: '0px'
    body-xl-tight:
      family: 'Manrope'
      size: '20px'
      weight: 400
      lineHeight: 1.2
      letterSpacing: '0px'
    body-lg:
      family: 'Manrope'
      size: '18.67px'
      weight: 700
      lineHeight: 1.5
      letterSpacing: '0px'
    body-md-strong:
      family: 'Manrope'
      size: '16px'
      weight: 600
      lineHeight: 2.75
      letterSpacing: '0px'
    body-xl-strong:
      family: 'Manrope'
      size: '20px'
      weight: 900
      lineHeight: 1.5
      letterSpacing: '0px'
  spacing:
    xxs: '4px'
    xs: '12px'
    sm: '20px'
    md: '24px'
    lg: '32px'
    xl: '48px'
    xxl: '64px'
    xxxl: '68px'
    section: '72px'
    band: '108px'
  rounded:
    none: '0px'
  zIndex:
    base: 1
    base-elevated: 2
    sticky: 9
    dropdown: 99
```
