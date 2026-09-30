# Cosmos GUI design-system handoff

Audience: engineers and designers. This document is derived only from the current renderer code in this repo.

## Scope

This is a source-of-truth handoff for rebuilding the Cosmos desktop UI as a Figma design system and an example screen. It does **not** invent tokens, components, props, or states that are not present in code.

Primary sources read for this doc:

- `src/renderer/src/main.tsx`
- `src/renderer/src/App.tsx`
- `src/renderer/src/styles/tokens.css`
- `src/renderer/src/styles/app.css`
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/ChatView.tsx`
- `src/renderer/src/components/Composer.tsx`
- `src/renderer/src/components/SettingsModal.tsx`
- `src/renderer/src/components/Pickers.tsx`
- `src/renderer/src/components/ToolCard.tsx`
- `src/renderer/src/components/DialogCard.tsx`
- `src/renderer/src/components/ChangesPanel.tsx`
- `src/renderer/src/components/Markdown.tsx`
- `src/renderer/src/components/Transcript.tsx`
- `src/renderer/src/components/Toasts.tsx`
- `src/renderer/src/components/CosmosMark.tsx`

## Real code architecture

The renderer mounts `App` from `src/renderer/src/main.tsx`. The top-level shell in `src/renderer/src/App.tsx` is:

- optional left `Sidebar`
- main chat area (`ChatView` or `HomeView`)
- optional right `ChangesPanel`
- modal overlays like `SettingsModal`
- floating utilities like `Toasts` and `IconButtonTooltips`

That shell should be the basis for the first example screen in Figma.

## Foundations

### Color tokens

The app defines the following semantic tokens in `src/renderer/src/styles/tokens.css`.

#### Light mode

| Token | Value |
| --- | --- |
| `--color-surface-default` | `#f3f5fb` |
| `--color-surface-primary` | `#ffffff` |
| `--color-surface-secondary` | `#eef2fb` |
| `--color-surface-raised` | `#e8edf9` |
| `--color-background-neutral-default-normal-idle` | `#ffffff` |
| `--color-background-neutral-default-normal-hover` | `#f5f7fd` |
| `--color-background-neutral-default-subtle-idle` | `#eef2fb` |
| `--color-background-neutral-default-subtle-hover` | `#e6ecf8` |
| `--color-background-neutral-default-minimal-idle` | `#f6f8fd` |
| `--color-background-neutral-default-strong-idle` | `#20263a` |
| `--color-background-neutral-default-strong-hover` | `#2c334a` |
| `--color-background-brand-default-strong-idle` | `#635bff` |
| `--color-background-brand-default-strong-hover` | `#5148f5` |
| `--color-background-brand-default-subtle-idle` | `#ece9ff` |
| `--color-background-negative-default-normal-idle` | `#d84e39` |
| `--color-background-negative-default-subtle-idle` | `#fdecea` |
| `--color-background-warning-default-normal-idle` | `#b97816` |
| `--color-background-warning-default-subtle-idle` | `#fff0d8` |
| `--color-background-positive-default-normal-idle` | `#2f7f5f` |
| `--color-background-positive-default-subtle-idle` | `#e5f6ee` |
| `--color-foreground-neutral-default-strong` | `#1b2234` |
| `--color-foreground-neutral-default-normal` | `#5b6478` |
| `--color-foreground-neutral-default-subtle` | `#8690a6` |
| `--color-foreground-neutral-inverse-strong` | `#ffffff` |
| `--color-foreground-brand-strong` | `#635bff` |
| `--color-foreground-negative-default-strong` | `#d84e39` |
| `--color-foreground-warning-strong` | `#b97816` |
| `--color-foreground-positive-strong` | `#2f7f5f` |
| `--color-border-neutral-subtle` | `#d9e0ef` |
| `--color-border-neutral-normal` | `#c5cede` |
| `--color-border-neutral-strong` | `#635bff` |
| `--color-border-brand-strong` | `#635bff` |
| `--color-border-negative-default` | `#d84e39` |
| `--app-foreground-on-brand-strong` | `#ffffff` via alias |

#### Dark mode

| Token | Value |
| --- | --- |
| `--color-surface-default` | `#0d1120` |
| `--color-surface-primary` | `#151a2f` |
| `--color-surface-secondary` | `#1a2138` |
| `--color-surface-raised` | `#0f162b` |
| `--color-background-neutral-default-normal-idle` | `#171e35` |
| `--color-background-neutral-default-normal-hover` | `#1d2540` |
| `--color-background-neutral-default-subtle-idle` | `#1a223b` |
| `--color-background-neutral-default-subtle-hover` | `#232d4a` |
| `--color-background-neutral-default-minimal-idle` | `#10162a` |
| `--color-background-neutral-default-strong-idle` | `#f3f5ff` |
| `--color-background-neutral-default-strong-hover` | `#e3e7f8` |
| `--color-background-brand-default-strong-idle` | `#8e88ff` |
| `--color-background-brand-default-strong-hover` | `#a29dff` |
| `--color-background-brand-default-subtle-idle` | `#2a2f58` |
| `--color-background-negative-default-normal-idle` | `#ff8a76` |
| `--color-background-negative-default-subtle-idle` | `#412520` |
| `--color-background-warning-default-normal-idle` | `#f2bd63` |
| `--color-background-warning-default-subtle-idle` | `#41331d` |
| `--color-background-positive-default-normal-idle` | `#7ad0a1` |
| `--color-background-positive-default-subtle-idle` | `#1d3528` |
| `--color-foreground-neutral-default-strong` | `#f3f5ff` |
| `--color-foreground-neutral-default-normal` | `#b6bfd4` |
| `--color-foreground-neutral-default-subtle` | `#7f8aa5` |
| `--color-foreground-neutral-inverse-strong` | `#111528` |
| `--color-foreground-brand-strong` | `#8e88ff` |
| `--color-foreground-negative-default-strong` | `#ff8a76` |
| `--color-foreground-warning-strong` | `#f2bd63` |
| `--color-foreground-positive-strong` | `#7ad0a1` |
| `--color-border-neutral-subtle` | `#2a3452` |
| `--color-border-neutral-normal` | `#394566` |
| `--color-border-neutral-strong` | `#8e88ff` |
| `--color-border-brand-strong` | `#8e88ff` |
| `--color-border-negative-default` | `#ff8a76` |
| `--app-foreground-on-brand-strong` | alias to strong foreground |

### Spacing tokens

Defined in `src/renderer/src/styles/tokens.css`.

| Token | Value |
| --- | --- |
| `--spacing-0` | `0px` |
| `--spacing-2` | `2px` |
| `--spacing-4` | `4px` |
| `--spacing-8` | `8px` |
| `--spacing-12` | `12px` |
| `--spacing-16` | `16px` |
| `--spacing-24` | `24px` |
| `--spacing-32` | `32px` |
| `--spacing-48` | `48px` |
| `--spacing-64` | `64px` |
| `--spacing-80` | `80px` |

### Size tokens

| Token | Value |
| --- | --- |
| `--size-4` | `4px` |
| `--size-8` | `8px` |
| `--size-12` | `12px` |
| `--size-16` | `16px` |
| `--size-20` | `20px` |
| `--size-24` | `24px` |
| `--size-28` | `28px` |
| `--size-32` | `32px` |
| `--size-36` | `36px` |
| `--size-40` | `40px` |
| `--size-44` | `44px` |
| `--size-48` | `48px` |
| `--size-52` | `52px` |
| `--size-64` | `64px` |

### Radius tokens

| Token | Value |
| --- | --- |
| `--border-radius-0` | `0px` |
| `--border-radius-2` | `2px` |
| `--border-radius-4` | `4px` |
| `--border-radius-8` | `8px` |
| `--border-radius-12` | `12px` |
| `--border-radius-16` | `16px` |
| `--border-radius-9999` | `9999px` |

### Typography tokens

Defined in `src/renderer/src/styles/tokens.css`.

#### Font families

| Token | Value |
| --- | --- |
| `--font-family-sans` | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif` |
| `--font-family-mono` | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` |

#### Semantic text styles

| Token group | Family | Size | Weight | Line height |
| --- | --- | --- | --- | --- |
| `--typography-body-normal-default-md-*` | sans | `14px` | `400` | `22px` |
| `--typography-label-normal-default-md-*` | sans | `14px` | `500` | `22px` |
| `--typography-label-strong-default-md-*` | sans | `14px` | `600` | `22px` |
| `--typography-label-normal-default-sm-*` | sans | `12px` | `500` | `18px` |
| `--typography-label-strong-default-sm-*` | sans | `12px` | `600` | `18px` |

### Shadow tokens

Defined in `src/renderer/src/styles/tokens.css`.

| Token | Value |
| --- | --- |
| `--shadow-rest` | `0 2px 2px -2px rgb(0 0 0 / 40%), 0 0 1px 0 rgb(0 0 0 / 30%)` |
| `--shadow-lift` | `0 6px 6px -4px rgb(0 0 0 / 20%), 0 0 4px 0 rgb(0 0 0 / 10%)` |
| `--shadow-float` | `0 12px 12px -4px rgb(0 0 0 / 10%), 0 0 16px 0 rgb(0 0 0 / 10%)` |
| `--shadow-md` | alias to `--shadow-lift` |

In dark mode, all three shadow tokens resolve to zeroed shadows in `src/renderer/src/styles/tokens.css`.

## Layout primitives

Derived from `src/renderer/src/styles/app.css` and `src/renderer/src/App.tsx`.

| Primitive | Real code value |
| --- | --- |
| App shell | `.app { display: flex; height: 100%; }` |
| Main area | `.main { flex: 1; display: flex; flex-direction: column; }` |
| Header height | `.main-header { height: 48px; }` |
| Sidebar width | `.sidebar { width: 272px; }` |
| Changes panel width | `.changes { width: 400px; }` |
| Transcript content max width | `.transcript-inner { max-width: 780px; }` |
| Composer content max width | `.composer-inner { max-width: 780px; }` |
| Collapsed-sidebar header offset | `.sidebar-collapsed .main-header { padding-left: 84px; }` |

## Component inventory

Only components and styles present in code are listed.

### 1. Button (`.btn`)

Source:

- style: `src/renderer/src/styles/app.css`
- usage: `src/renderer/src/components/ChatView.tsx`, `SettingsModal.tsx`, `DialogCard.tsx`, `HomeView.tsx`, `ToolCard.tsx`

Base behavior:

- inline flex
- height `32px`
- horizontal padding `12px`
- radius `8px`
- border `1px solid var(--color-border-neutral-normal)`
- background `var(--color-background-neutral-default-normal-idle)`
- label md typography

Documented real variants from class usage:

| Variant | Source in code | Visual behavior |
| --- | --- | --- |
| default | `.btn` | neutral button |
| primary | `.btn.primary` | brand background and brand border |
| danger | `.btn.danger` | negative foreground |
| small | `.btn.small` | `26px` height, `9px` horizontal padding, small label typography |

### 2. Icon button (`.icon-btn`)

Source:

- style: `src/renderer/src/styles/app.css`
- usage across `App.tsx`, `ChatView.tsx`, `ChangesPanel.tsx`, `Markdown.tsx`, `ToolCard.tsx`, `Transcript.tsx`

Real states:

| State | Source in code | Behavior |
| --- | --- | --- |
| default | `.icon-btn` | `30x30`, transparent background |
| hover | `.icon-btn:hover` | subtle hover background |
| active | `.icon-btn.active` | same surface treatment as hover with strong foreground |
| disabled | `.icon-btn:disabled` | `opacity: 0.4` |

### 3. Chip (`.chip`)

Source:

- style: `src/renderer/src/styles/app.css`
- usage: `src/renderer/src/components/ChatView.tsx`, `src/renderer/src/components/Pickers.tsx`

Real behavior:

- height `26px`
- horizontal padding `8px`
- radius `7px`
- small label typography
- transparent background by default
- hover background uses neutral subtle hover token
- supports icon + text + optional chevron through composition in React

### 4. Keyboard key (`.kbd`)

Source: `src/renderer/src/styles/app.css`

Real behavior:

- small label typography
- subtle foreground
- subtle border
- `4px` radius
- horizontal padding `4px`

### 5. Sidebar shell (`.sidebar`)

Source:

- structure: `src/renderer/src/components/Sidebar.tsx`
- style: `src/renderer/src/styles/app.css`

Real composition:

- width `272px`
- vertical flex layout
- background is a real gradient from `surface-raised` to a color-mixed `surface-secondary`
- right border on the shell

Subparts present in code:

- `.sidebar-top`
- `.sidebar-top-row`
- `.search`
- `.sidebar-list`
- `.sidebar-section`
- `.sidebar-section-header`
- `.sidebar-footer`
- `.sidebar-empty`

### 6. Search field (`.search`)

Source: `src/renderer/src/styles/app.css`, `src/renderer/src/components/Sidebar.tsx`

Real properties:

- height `30px`
- horizontal padding `8px`
- radius `8px`
- neutral secondary background by default
- focus-within adds neutral border and normal background
- contains an `input` with transparent background and no border

### 7. Session row (`.session-row`)

Source:

- structure: `src/renderer/src/components/Sidebar.tsx`
- style: `src/renderer/src/styles/app.css`

Real row parts and states:

| Part or state | Real code |
| --- | --- |
| base row | `.session-row` |
| dragging | `.session-row.dragging` |
| hover | `.session-row:hover` |
| active | `.session-row.active` |
| unread | `.session-row.unread .title` |
| drop before | `.session-row.drop-before` |
| drop after | `.session-row.drop-after` |
| title slot | `.session-row .title` |
| meta slot | `.session-row .meta` |

Related adornments:

- `.status-dot`
- `.status-dot.unread`
- `.status-dot.attention`
- `.spinner`
- `.session-dropzone`
- `.session-dropzone.active`

### 8. Main header (`.main-header`)

Source:

- structure: `src/renderer/src/components/ChatView.tsx`
- style: `src/renderer/src/styles/app.css`

Real behavior:

- fixed header height `48px`
- horizontal layout with `8px` gaps
- translucent background using `color-mix(...)` over `surface-default`
- `backdrop-filter: blur(18px)`
- scrolled state adds bottom border color through `.main-header.scrolled`

Subparts present in code:

- `.header-title`
- `.header-title-input`
- `.spacer`
- project chip via `ProjectMenu`
- context meter from `ContextMeter`
- action icon buttons

### 9. Context meter

Source: `src/renderer/src/components/ChatView.tsx`

Real behavior:

- SVG ring meter inside text label
- ring uses percent-based circumference math in code
- text content shows context percent and optional session cost
- warning and danger thresholds are defined in code logic

Unresolved note: `ContextMeter` references CSS vars `--danger`, `--warning`, `--accent`, and `--border-strong` in inline styles. Those token names were not found in `src/renderer/src/styles/tokens.css` during this review. Do not normalize them in Figma without a code decision.

### 10. Transcript shell

Source:

- structure: `src/renderer/src/components/Transcript.tsx`
- style: `src/renderer/src/styles/app.css`

Real layout primitives:

- `.transcript`
- `.transcript-inner`
- grouped text and detail folds
- user messages and assistant messages are distinct render branches in React
- tool calls render through `ToolCard`
- markdown text renders through `Markdown`

### 11. Markdown / code block

Source:

- component: `src/renderer/src/components/Markdown.tsx`
- style: `src/renderer/src/styles/app.css`

Real parts:

- `.code-block`
- `.code-block-header`
- syntax color vars `--hl-keyword`, `--hl-string`, `--hl-number`, `--hl-comment`, `--hl-title`, `--hl-attr`
- `CopyButton` uses `.icon-btn`

### 12. Reasoning fold / tool fold (`.fold`)

Source:

- structure: `src/renderer/src/components/Transcript.tsx`, `src/renderer/src/components/ToolCard.tsx`
- style: `src/renderer/src/styles/app.css`

Real parts:

- `.fold`
- `.fold-header`
- `.fold-header.active-thread`
- `.fold-header-main`
- `.fold-header-sub`
- `.reasoning-body`
- `.reasoning-note`
- `.thinking-body`
- `.tool-body`

### 13. Diff view

Source:

- structure: `src/renderer/src/components/DiffView.tsx` via usage in `ToolCard.tsx`, `DialogCard.tsx`, `ChangesPanel.tsx`
- style: `src/renderer/src/styles/app.css`

Real parts visible in CSS:

- `.diff-line`
- `.diff-line .gutter`
- `.diff-line.add`
- `.diff-line.del`
- `.diff-line.hunk`
- `.diff-line .text`

### 14. Composer

Source:

- structure: `src/renderer/src/components/Composer.tsx`
- style: `src/renderer/src/styles/app.css`

Real layout and states:

| Part | Real code |
| --- | --- |
| wrapper | `.composer-wrap` |
| max-width container | `.composer-inner` |
| field shell | `.composer` |
| focused shell | `.composer:focus-within` |
| drag-over shell | `.composer.drop` |
| text area | `.composer textarea` |
| toolbar | `.composer-toolbar` |
| send button | `.send-btn` |
| send hover | `.send-btn:hover` |
| send disabled | `.send-btn:disabled` |
| stop variant | `.send-btn.stop` |
| attachments row | `.attachments` |
| attachment tile | `.attachment` |
| hint row | `.composer-hint` |
| queued item list | `.queue` |
| queued item | `.queue-item` |
| widget block | `.widget` |

Behavior verified in React code:

- supports slash suggestions and mention suggestions
- supports image attachments and file mentions
- send behavior changes while busy
- stop action is exposed on `Escape` while busy

### 15. Popover / menu patterns

Source:

- structure: `src/renderer/src/components/Pickers.tsx`, `src/renderer/src/components/ChatView.tsx`, `src/renderer/src/components/SettingsModal.tsx`
- style section: `src/renderer/src/styles/app.css`

Real patterns present in code:

- `.popover`
- `.popover.up`
- `.popover-label`
- `.menu-item`
- `.menu-item-stack`
- `.filter`
- segmented control `.segmented`

### 16. Switch

Source: `src/renderer/src/components/SettingsModal.tsx`, `src/renderer/src/styles/app.css`

Real component API:

- React component name: `Switch`
- props: `on`, `onChange`, `label`

Real visual states:

- `.switch`
- `.switch::after`
- `.switch.on`
- `.switch.on::after`

### 17. Settings row (`Setting`)

Source: `src/renderer/src/components/SettingsModal.tsx`, `src/renderer/src/styles/app.css`

Real component API:

- React component name: `Setting`
- props: `name`, `help`, `children`, `stacked`

Real style parts:

- `.setting`
- `.setting.stacked`
- `.setting-text`
- `.setting-text .name`
- `.setting-text .help`
- `.setting-control`

### 18. Dialog card

Source:

- structure: `src/renderer/src/components/DialogCard.tsx`
- style section: `src/renderer/src/styles/app.css`

Real modes in code:

- permission prompt
- confirm
- select
- input
- editor

Real parts in React:

- `.dialog-card`
- `.dialog-card.permission`
- `.dialog-card-header`
- `.dialog-card-body`
- `.dialog-card-actions`

### 19. Changes panel

Source:

- structure: `src/renderer/src/components/ChangesPanel.tsx`
- style: `src/renderer/src/styles/app.css`

Real shell:

- width `400px`
- border-left divider
- secondary surface background

Real parts:

- `.changes`
- `.changes-header`
- `.changes-body`
- `.change-file`
- `.change-file-header`

### 20. Empty-state patterns

Source:

- structure: `src/renderer/src/components/ChatView.tsx`, `src/renderer/src/components/HomeView.tsx`
- style: `src/renderer/src/styles/app.css`

Real elements seen in code/CSS:

- `.empty`
- `.empty-chat-welcome`
- `.cosmos-wordmark-hero`
- `.empty-chat-actions`
- `.empty-chat-action`
- `.welcome-card`
- Home cards like `.home-suggestion`, `.repo-card`

### 21. Toast

Source: `src/renderer/src/components/Toasts.tsx`, `src/renderer/src/styles/app.css`

Real parts:

- `.toasts`
- `.toast`
- `.toast.error` and other level classes if present in CSS
- text plus optional action plus dismiss button

### 22. Cosmos mark

Source: `src/renderer/src/components/CosmosMark.tsx`

Real component:

- SVG mark using `currentColor`
- not tokenized through a dedicated icon system in this repo
- composed from circle and path primitives

## Figma-ready page plan

This repo does not currently contain a Figma design-system file or Code Connect config. To rebuild it from code, create these Figma pages:

1. `Foundations`
2. `Components`
3. `Screens`
4. `Code Connect Mapping`

### Foundations page

Create local styles or variables for:

- light and dark semantic colors from `src/renderer/src/styles/tokens.css`
- spacing scale from `2` through `80`
- radius scale from `2` through `9999`
- typography styles matching the semantic token groups
- shadows `rest`, `lift`, `float`

### Components page

Create only the following components because they exist in code today:

- Button
- Icon Button
- Chip
- KBD
- Search Field
- Session Row
- Sidebar Section Header
- Header Title
- Composer
- Send Button
- Tool Fold
- Tool Card / Diff Block
- Dialog Card
- Switch
- Setting Row
- Changes File Group
- Empty Chat Action
- Repo Card
- Toast
- Cosmos Mark

Do not add a generic card, badge, tag, tab bar, or navigation rail unless you first map it to an existing code artifact.

## Example screen to build first

### Screen name

`Main Chat / With Sidebar / With Changes Panel`

### Source basis

- shell composition: `src/renderer/src/App.tsx`
- header and welcome/chat body: `src/renderer/src/components/ChatView.tsx`
- left nav: `src/renderer/src/components/Sidebar.tsx`
- bottom input area: `src/renderer/src/components/Composer.tsx`
- right panel: `src/renderer/src/components/ChangesPanel.tsx`

### Frame spec from code

| Region | Real code basis |
| --- | --- |
| Full app frame | `.app` flex shell |
| Left sidebar | width `272px` |
| Main content | fills remaining width |
| Right changes panel | width `400px` when open |
| Header | height `48px` |
| Transcript and composer content width | `max-width: 780px` centered |

### Recommended example content

Use existing interface concepts only:

- left sidebar with search field, grouped session rows, footer actions
- header with editable title, project chip, context meter, fork button, changes button
- transcript with at least:
  - one user bubble
  - one assistant markdown response
  - one reasoning/tool fold
  - one dialog card or welcome card
- composer with multiline input, picker chips, send button, and one queued item
- changes panel with at least two changed files and diff blocks

## Code Connect readiness

There is no existing Figma Code Connect package or config in this repo. Also, much of the current UI is implemented as CSS classes applied across screens rather than as a single reusable React component API.

That means the realistic Code Connect preparation is:

1. name Figma components to match real implementation artifacts
2. separate `react-component` mappings from `css-class` mappings
3. keep a manifest of source files, class names, and real variants

Use `docs/figma/code-connect-manifest.json` as the source-of-truth mapping seed.

### Important limitation

Not every Figma component will map to a single React component. Examples:

- `Button` is a CSS class pattern, not a dedicated `<Button />` component
- `Icon Button` is also a CSS class pattern
- `Session Row` is a JSX structure inside `Sidebar.tsx`, not an exported reusable component

For those, treat Code Connect readiness as naming and source mapping, not as a claim that an integration can be auto-wired today.

## Figma build checklist

- [ ] Create light and dark color variables from `src/renderer/src/styles/tokens.css`
- [ ] Create text styles from the semantic typography token groups
- [ ] Create spacing and radius variables from `src/renderer/src/styles/tokens.css`
- [ ] Rebuild the left sidebar using only `Sidebar.tsx` structure and `.sidebar*`, `.search`, `.session-row` styles
- [ ] Rebuild the main header from `ChatView.tsx` and `.main-header`, `.header-title`, `.chip`, `.icon-btn`
- [ ] Rebuild the composer from `Composer.tsx` and `.composer*`, `.send-btn`, `.queue-item`, `.attachment`
- [ ] Rebuild the changes panel from `ChangesPanel.tsx` and `.changes*`, `.change-file*`
- [ ] Create dialog card variants from `DialogCard.tsx`
- [ ] Create popover/menu patterns from `Pickers.tsx` and `.popover`, `.menu-item`, `.segmented`, `.switch`
- [ ] Build the example screen `Main Chat / With Sidebar / With Changes Panel`
- [ ] Revisit unresolved token references before publishing Code Connect mappings

## Unresolved items found during code review

These should be resolved in code or explicitly accounted for before a final Figma publish:

- `ContextMeter` in `src/renderer/src/components/ChatView.tsx` references `var(--danger)`, `var(--warning)`, `var(--accent)`, and `var(--border-strong)`, but those token names were not found in `src/renderer/src/styles/tokens.css` during this review.
- `ChangesPanel.tsx` uses `style={{ borderTop: "1px solid var(--border)" }}`, and `LoginDialog.tsx` uses `style={{ border: "1px solid var(--border)" }}`; `--border` was not found in `src/renderer/src/styles/tokens.css` during this review.

Those are real code references, so the Figma build should preserve them as unresolved until the codebase clarifies the intended token names.
