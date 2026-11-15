// 083 更新前保护：点「现在更新」时先拍设置快照；已加入同步就先推一次，推送失败要用户确认。
// 逻辑和依赖分开，方便单测（依赖在 update.ts 里接真实的同步和对话框）。

export interface GuardDeps {
  /** 拍设置快照（失败也不挡更新）。 */
  snapshot: () => Promise<unknown>;
  /** 有没有加入同步空间。 */
  hasSync: () => boolean;
  /** 推送本机改动并等结束；成功 true。 */
  syncNow: () => Promise<boolean>;
  /** 弹确认框；用户点「仍要安装」true，点「先不装」或关掉 false。 */
  confirmUnsynced: () => Promise<boolean>;
}

/** 返回 true = 可以继续下载/安装；false = 用户选了「先不装」。没加入同步时不拦，只在界面上提示一句。 */
export async function guardBeforeInstall(d: GuardDeps): Promise<boolean> {
  try { await d.snapshot(); } catch { /* 快照失败不挡更新 */ }
  if (!d.hasSync()) return true;
  let ok = false;
  try { ok = await d.syncNow(); } catch { ok = false; }
  if (ok) return true;
  return d.confirmUnsynced();
}
