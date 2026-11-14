/** @type {import('tailwindcss').Config} */
// 035/039 暖色主题：色值只在 index.css 的 :root 里定义一次（--c-* 是 RGB 三元组），这里只引用，
// 这样 bg-accent/30 这种透明度写法照样能用。只有浅色，不做深色。
const v = name => `rgb(var(--c-${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './*.tsx', './components/**/*.tsx', './hooks/**/*.{ts,tsx}', './utils/**/*.ts', './pro/**/*.{ts,tsx}', './mobile/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: v('paper'),   // 应用底色：暖纸
        page: v('page'),     // 卡片、弹窗、菜单、输入框
        shade: v('shade'),   // 安静的填充：胶囊、悬停
        line: v('line'),     // 细线
        faint: v('faint'),   // 占位、空槽
        mute: v('mute'),     // 次要文字
        ink: v('ink'),       // 正文
        accent: v('accent'), // 主色陶土橙（039）：主按钮、当前词、焦点、进度条
        'accent-soft': v('accent-soft'),
        success: v('success'), // 答对、成功：橄榄绿，不跟主色走（039）
        'success-soft': v('success-soft'),
        danger: v('danger'), // 错误、答错、失败：和主色分开
        'danger-soft': v('danger-soft'),
        clay: v('clay'),     // 提醒点缀（039 起是赭黄色，名字沿用）：提醒、标签
        'clay-soft': v('clay-soft'),
      },
      fontFamily: {
        sans: ['"Instrument Sans"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        // Only the lines being learned are serif; Chinese falls back to PingFang, never Songti.
        serif: ['"Source Serif 4"', '"PingFang SC"', 'Georgia', 'serif'],
        mono: ['"Instrument Sans"', '"PingFang SC"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgb(var(--c-shadow) / .10)',
        lift: '0 16px 40px rgb(var(--c-shadow) / .14)',
      },
    },
  },
}
