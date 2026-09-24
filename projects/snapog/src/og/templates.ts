// SnapOG — OG image element templates
// Returns plain objects compatible with workers-og / satori

import type { OGParams } from '../types';

type StyleObject = Record<string, string | number | undefined>;

type VNode = {
  type: string;
  props: {
    style?: StyleObject;
    children?: unknown;
    [key: string]: unknown;
  };
};

// ─── Manual text wrapping ──────────────────────────────────────────────────
//
// ROOT CAUSE (found in cycle6, superseding the theory below): this was never
// a wrapping bug. It was `lineHeight` being passed as a unitless numeric
// STRING (e.g. '1.2'), which is how every style object in this file wrote
// it — completely reasonable-looking CSS-in-JS. Satori's bundled style
// normalizer (workers-og 0.0.14 -> satori ^0.10.3) has an asymmetric code
// path for `lineHeight`: a raw JS *number* (`1.2`) is preserved as the
// intended unitless multiplier, but a *string* (`'1.2'`) gets routed
// through the generic CSS length parser and re-divided by the font size,
// silently corrupting it down to a tiny fraction (e.g. ~0.03 instead of
// 1.2). Yoga then computes a near-zero line-box height, so every line —
// whether Satori's own auto-wrap or our own hand-split sibling <div>s below
// — gets stacked at (approximately) the same y-offset instead of below the
// previous one. Confirmed empirically with a minimal two-sibling-div repro
// (see /tmp/og-repro) via row-level ink-density profiling: `lineHeight:
// '1.2'` produced one 16px overlapping band; `lineHeight: 1.2` (number)
// produced two cleanly separated 30px bands. Also confirmed this was the
// *entire* cause of the "sibling divs still overlap" failure from the
// previous attempt — no other flex/JSX layout issue was involved.
//
// The fix: every `lineHeight` in this file is now a plain number, not a
// string. That alone fixes stacking for both Satori's native auto-wrap and
// the manual per-line rendering below.
//
// We still pre-compute line breaks ourselves (rather than deleting this and
// leaning on Satori's now-working native wrapping) to keep the existing,
// already-verified-correct-per-QA line-break math and the `maxLines`
// overflow cap — no font is embedded in this renderer (see render.ts), so
// there's no real glyph-metrics access at request time; this uses a
// deliberately conservative average-character-width-per-em estimate per
// font weight rather than exact measurement. It only needs to be good
// enough to choose reasonable wrap points; a slightly-early or slightly-late
// wrap is a cosmetic nit, not a correctness bug.
const AVG_CHAR_WIDTH_EM: Record<number, number> = {
  400: 0.52,
  700: 0.58,
  800: 0.62,
};

function wrapLines(
  text: string,
  maxWidthPx: number,
  fontSizePx: number,
  weight: number,
  maxLines: number
): string[] {
  const emFactor = AVG_CHAR_WIDTH_EM[weight] ?? 0.55;
  const charsPerLine = Math.max(1, Math.floor(maxWidthPx / (fontSizePx * emFactor)));

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (lines.length === maxLines - 1) {
      // Last allowed line — keep appending rather than silently dropping
      // trailing words. It may overflow the frame width; that's a much
      // smaller problem than losing text entirely.
      current = current ? `${current} ${word}` : word;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > charsPerLine) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines;
}

// Renders `text` as a column of single-line divs instead of one multi-line
// text node. `textStyle` (font/color/spacing) is applied to each line;
// `containerStyle` (flex/margin/etc.) is applied to the wrapping column.
function wrappedTextBlock(
  text: string,
  textStyle: StyleObject,
  containerStyle: StyleObject,
  maxWidthPx: number,
  maxLines = 3
): VNode {
  const fontSizePx = parseFloat(String(textStyle.fontSize));
  const weight = Number(textStyle.fontWeight) || 400;
  const lines = wrapLines(text, maxWidthPx, fontSizePx, weight, maxLines);

  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', ...containerStyle },
      children: lines.map(line => ({
        type: 'div',
        props: {
          style: { display: 'flex', ...textStyle },
          children: line,
        },
      })),
    },
  };
}

// Accent bar — left edge visual anchor
function AccentBar(color: string): VNode {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '6px',
        height: '100%',
        backgroundColor: color,
      },
      children: null,
    },
  };
}

// Header row: domain on left, tag pill on right
function Header(domain: string | undefined, tag: string | undefined, accent: string, surface: string, primary: string): VNode {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '48px',
        width: '100%',
      },
      children: [
        domain
          ? {
              type: 'div',
              props: {
                style: {
                  fontSize: '18px',
                  color: accent,
                  fontFamily: 'monospace',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                },
                children: domain,
              },
            }
          : { type: 'div', props: { style: { width: '1px' }, children: null } },
        tag
          ? {
              type: 'div',
              props: {
                style: {
                  fontSize: '13px',
                  color: primary,
                  backgroundColor: surface,
                  padding: '6px 16px',
                  borderRadius: '100px',
                  fontFamily: 'monospace',
                  letterSpacing: '0.04em',
                },
                children: tag,
              },
            }
          : { type: 'div', props: { style: { width: '1px' }, children: null } },
      ],
    },
  };
}

// Footer row: author on left, watermark on right
function Footer(
  author: string | undefined,
  watermark: boolean,
  secondary: string
): VNode {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: '48px',
        width: '100%',
      },
      children: [
        author
          ? {
              type: 'div',
              props: {
                style: {
                  fontSize: '18px',
                  color: secondary,
                  fontFamily: 'monospace',
                },
                children: `— ${author}`,
              },
            }
          : { type: 'div', props: { style: { width: '1px' }, children: null } },
        watermark
          ? {
              type: 'div',
              props: {
                style: {
                  fontSize: '14px',
                  color: secondary,
                  fontFamily: 'monospace',
                  opacity: '0.55',
                  letterSpacing: '0.06em',
                },
                children: 'snapog.dev',
              },
            }
          : { type: 'div', props: { style: { width: '1px' }, children: null } },
      ],
    },
  };
}

// Default template — general purpose
function defaultTemplate(params: OGParams, watermark: boolean): VNode {
  const { title, description, domain, author, tag, theme = 'dark' } = params;
  const isDark = theme === 'dark';

  const bg = isDark ? '#0A0A0A' : '#FAFAFA';
  const primary = isDark ? '#F5F5F5' : '#0A0A0A';
  const secondary = isDark ? '#737373' : '#737373';
  const accent = '#F59E0B';
  const surface = isDark ? '#1A1A1A' : '#E8E8E8';

  const fontSize = title.length > 60 ? '42px' : title.length > 40 ? '52px' : '62px';

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: bg,
        padding: '64px 72px 64px 84px',
        position: 'relative',
        fontFamily: '"Noto Sans", sans-serif',
      },
      children: [
        AccentBar(accent),
        Header(domain, tag, accent, surface, primary),
        // Title
        wrappedTextBlock(
          title,
          {
            fontSize,
            fontWeight: '700',
            color: primary,
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
          },
          { flex: '1' },
          1044
        ),
        // Description
        ...(description
          ? [
              wrappedTextBlock(
                description,
                {
                  fontSize: '22px',
                  color: secondary,
                  lineHeight: 1.5,
                },
                { marginTop: '24px', maxWidth: '900px' },
                900
              ),
            ]
          : []),
        Footer(author, watermark, secondary),
      ],
    },
  };
}

// Blog template — date-focused, editorial feel
function blogTemplate(params: OGParams, watermark: boolean): VNode {
  const { title, description, domain, author, tag, theme = 'dark' } = params;
  const isDark = theme === 'dark';

  const bg = isDark ? '#0D0D0D' : '#FFFFFF';
  const primary = isDark ? '#FAFAFA' : '#111111';
  const secondary = isDark ? '#6B7280' : '#6B7280';
  const accent = '#F59E0B';
  const surface = isDark ? '#1F1F1F' : '#F3F4F6';

  const fontSize = title.length > 55 ? '44px' : title.length > 35 ? '54px' : '64px';

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: bg,
        padding: '72px 80px',
        position: 'relative',
        fontFamily: '"Noto Serif", serif',
      },
      children: [
        // Top band
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: '0',
              left: '0',
              right: '0',
              height: '4px',
              backgroundColor: accent,
            },
            children: null,
          },
        },
        // Site label + tag
        Header(domain, tag, accent, surface, primary),
        // Title
        wrappedTextBlock(
          title,
          {
            fontSize,
            fontWeight: '700',
            color: primary,
            lineHeight: 1.2,
            letterSpacing: '-0.01em',
          },
          { flex: '1' },
          1040
        ),
        // Description
        ...(description
          ? [
              wrappedTextBlock(
                description,
                {
                  fontSize: '21px',
                  color: secondary,
                  lineHeight: 1.6,
                  fontStyle: 'italic',
                },
                { marginTop: '28px' },
                1040
              ),
            ]
          : []),
        Footer(author, watermark, secondary),
      ],
    },
  };
}

// Article template — minimal, high-contrast, magazine aesthetic
function articleTemplate(params: OGParams, watermark: boolean): VNode {
  const { title, description, domain, author, tag, theme = 'dark' } = params;
  const isDark = theme === 'dark';

  const bg = isDark ? '#111111' : '#F8F8F8';
  const primary = isDark ? '#FFFFFF' : '#111111';
  const secondary = isDark ? '#9CA3AF' : '#4B5563';
  const accent = '#F59E0B';
  const _surface = isDark ? '#222222' : '#E5E7EB';
  void _surface;
  const divider = isDark ? '#2A2A2A' : '#D1D5DB';

  const fontSize = title.length > 60 ? '40px' : title.length > 40 ? '50px' : '60px';

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: bg,
        padding: '60px 72px',
        position: 'relative',
        fontFamily: '"Noto Sans", sans-serif',
      },
      children: [
        // Category row
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '32px',
            },
            children: [
              tag
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: '12px',
                        fontWeight: '700',
                        color: accent,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        fontFamily: 'monospace',
                      },
                      children: tag,
                    },
                  }
                : { type: 'div', props: { style: { width: '1px' }, children: null } },
              domain
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: '12px',
                        color: secondary,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        fontFamily: 'monospace',
                      },
                      children: `• ${domain}`,
                    },
                  }
                : { type: 'div', props: { style: { width: '1px' }, children: null } },
            ],
          },
        },
        // Divider
        {
          type: 'div',
          props: {
            style: {
              width: '48px',
              height: '3px',
              backgroundColor: accent,
              marginBottom: '32px',
            },
            children: null,
          },
        },
        // Title
        wrappedTextBlock(
          title,
          {
            fontSize,
            fontWeight: '800',
            color: primary,
            lineHeight: 1.15,
            letterSpacing: '-0.025em',
          },
          { flex: '1' },
          1056
        ),
        ...(description
          ? [
              wrappedTextBlock(
                description,
                {
                  fontSize: '20px',
                  color: secondary,
                  lineHeight: 1.5,
                },
                { marginTop: '20px', maxWidth: '850px' },
                850
              ),
            ]
          : []),
        // Footer divider + meta
        {
          type: 'div',
          props: {
            style: {
              width: '100%',
              height: '1px',
              backgroundColor: divider,
              marginTop: '36px',
            },
            children: null,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '16px',
              fontFamily: 'monospace',
            },
            children: [
              author
                ? {
                    type: 'div',
                    props: {
                      style: { fontSize: '16px', color: secondary },
                      children: author,
                    },
                  }
                : { type: 'div', props: { style: { width: '1px' }, children: null } },
              watermark
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: '13px',
                        color: secondary,
                        opacity: '0.5',
                        letterSpacing: '0.06em',
                      },
                      children: 'snapog.dev',
                    },
                  }
                : { type: 'div', props: { style: { width: '1px' }, children: null } },
            ],
          },
        },
      ],
    },
  };
}

export function buildElement(params: OGParams, watermark: boolean): VNode {
  switch (params.template) {
    case 'blog':
      return blogTemplate(params, watermark);
    case 'article':
      return articleTemplate(params, watermark);
    default:
      return defaultTemplate(params, watermark);
  }
}
