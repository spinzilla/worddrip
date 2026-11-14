// 桌面窗口和安卓共用界面；电脑专用入口统一在这里分流。
import { AppState } from '../types';

export function isMobilePlatform(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent);
}

export const IS_MOBILE = isMobilePlatform();
export const IS_WINDOWS = !IS_MOBILE && typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);

// 手机只做「复习和记词」：导航只有词库、设置（用户 2026-11-12 定）。
export function navStates(mobile: boolean, podcasts: boolean): AppState[] {
  return mobile
    ? [AppState.VOCAB, AppState.SETTINGS]
    : [AppState.UPLOAD, ...(podcasts ? [AppState.PODCASTS] : []), AppState.LIBRARY, AppState.VOCAB, AppState.COACH, AppState.SETTINGS];
}

// 设置分页：手机不显示「练习」（视频分段、精听、日语分词）、导入、快捷键。
export type SettingsTab = 'practice' | 'lookup' | 'cards' | 'import' | 'transfer' | 'ai' | 'shortcuts';
export function settingsTabs(mobile: boolean): SettingsTab[] {
  return mobile
    ? ['lookup', 'cards', 'transfer', 'ai']
    : ['practice', 'lookup', 'cards', 'import', 'transfer', 'ai', 'shortcuts'];
}
