// 界面字号（小 / 标准 / 大 / 特大）：存 localStorage；启动时在第一次渲染前套到 html 的 font-size 上。
// 界面用 rem，改 html 的 font-size 就能整体缩放。不依赖 React，电脑和手机入口都能用。

export const FONT_SCALES = ['small', 'normal', 'large', 'xlarge'] as const;
export type FontScale = typeof FONT_SCALES[number];
export const FONT_SCALE_KEY = 'linguaclip_font_scale';
export const FONT_PERCENT: Record<FontScale, number> = { small: 90, normal: 100, large: 115, xlarge: 130 };

export const getFontScale = (): FontScale => {
  try {
    const v = localStorage.getItem(FONT_SCALE_KEY);
    return (FONT_SCALES as readonly string[]).includes(v ?? '') ? v as FontScale : 'normal';
  } catch { return 'normal'; }
};

/** 把字号套到页面上（没有 document 时什么也不做，方便单测）。 */
export const applyFontScale = (s: FontScale = getFontScale()): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${FONT_PERCENT[s]}%`;
};

/** 存下来并立刻生效。 */
export const saveFontScale = (s: FontScale): void => {
  try { localStorage.setItem(FONT_SCALE_KEY, s); } catch { /* 存不下也先让本次生效 */ }
  applyFontScale(s);
};
