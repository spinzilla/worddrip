// Pro features. This folder is only in the private repo (linguaclip-pro); the public
// repo is the same code without it, and `@pro` then resolves to utils/proStub.ts
// (vite.config.ts / tsconfig.json). Keep the exports in step with the stub.
import ReaderPage from './ReaderPage';
import ListenPage from './ListenPage';
import PodcastPickerView from './PodcastPicker';
import type { ProListen, ProPodcastPicker, ProReader } from '../utils/proStub';
import type React from 'react';

export const Reader: ProReader | null = ReaderPage;
export { cancelTrans } from './transPrep';
export const PodcastPicker: ProPodcastPicker | null = PodcastPickerView;
export const Listen: ProListen | null = ListenPage;
export { podcastRate } from './ListenCoach';
export { default as ProFooter } from './ProFooter';
export { ProHost } from './LicenseDialogs';
export { StarterHost } from './Starter';
// 原版 LinguaClip 从 linguaclipapp.com 自动更新（docs/update.md）。English Studio
// 是自己编译的，不接原版的更新：置 false 后启动不检查、界面不显示更新入口，
// 后端也已去掉 updater 插件（src-tauri/src/lib.rs）。要恢复原版行为才改回 true。
export const UPDATES = false;
