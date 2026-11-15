// 083 设置 → 关于 →「复制诊断信息」：最近 20 行启动记录 + 当前版本，密钥原文已抹掉。
import { diagnosticsText } from './settingsBackup';

export async function copyDiagnostics(): Promise<boolean> {
  try { await navigator.clipboard.writeText(await diagnosticsText()); return true; } catch { return false; }
}
