/**
 * Everforest Hard Dark theme — centralized color constants.
 * Matches the centralized CSS at https://devinmlowe.github.io/theme-everforest/everforest-dark.css
 */

// Backgrounds (shifted to match iTerm2 bg_dim base)
export const BG_DEEP    = '#191d20';  // darker than bg_dim — headers, footers, canvas bg
export const BG         = '#1e2326';  // bg_dim — main background (matches iTerm2)
export const BG_SURFACE = '#272e33';  // bg0 — raised surfaces, panels, inputs
export const BG_OVERLAY = '#2e383c';  // bg1 — overlays, hover states
export const BG_BORDER  = '#374145';  // bg2 — borders, dividers
export const BG_MUTED   = '#414b50';  // bg3 — muted UI chrome
export const BG_SUBTLE  = '#495156';  // bg4 — subtle highlights

// Foreground / Text
export const FG       = '#d3c6aa';  // primary text
export const FG_MUTED = '#9da9a0';  // grey2 — secondary text
export const FG_DIM   = '#859289';  // grey1 — tertiary text
export const FG_FAINT = '#7a8478';  // grey0 — comments, inactive
export const FG_GHOST = '#5b6560';  // very faint

// Accents
export const RED    = '#e67e80';
export const ORANGE = '#e69875';
export const YELLOW = '#dbbc7f';
export const GREEN  = '#a7c080';
export const AQUA   = '#83c092';
export const BLUE   = '#7fbbb3';
export const PURPLE = '#d699b6';

// Entity type colors (graph nodes)
export const TYPE_COLORS: Record<string, string> = {
  project:    RED,
  tool:       BLUE,
  technology: GREEN,
  person:     ORANGE,
  concept:    PURPLE,
  file:       FG_FAINT,
  repo:       AQUA,
};

export const DEFAULT_COLOR = BG_SUBTLE;

// Word cloud / multi-color palette (12 slots)
export const PALETTE = [
  RED, BLUE, GREEN, ORANGE, PURPLE,
  AQUA, YELLOW, FG_MUTED, FG, FG_DIM,
  '#b6c19e', '#c1a8b4',
];
