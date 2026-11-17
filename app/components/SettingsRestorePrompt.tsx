import React from 'react';
import { Btn } from './ui';
import { acceptRestore, declineRestore, useRestoreOffer } from '../utils/settingsBackup';

// 083：启动时发现本机设置几乎是空的、数据目录里却有之前拍的快照，就问一句要不要恢复。
const fmt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function SettingsRestorePrompt() {
  const offer = useRestoreOffer();
  if (!offer) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/35 p-0 sm:items-center sm:p-6" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="restore-settings-title" data-testid="restore-settings"
        className="max-h-[92vh] w-full overflow-y-auto break-words rounded-t-2xl bg-page p-5 shadow-card sm:max-w-md sm:rounded-2xl">
        <h2 id="restore-settings-title" className="text-lg font-semibold text-ink">发现之前的设置</h2>
        <p className="mt-2 text-sm leading-6 text-mute">
          这台设备上的设置看起来是空的，但找到了一份之前自动留下的备份（{fmt(offer.at)}，共 {offer.keys} 项，含 AI 设置、词典来源等）。恢复吗？
        </p>
        <p className="mt-2 text-xs leading-5 text-mute">备份只存在本机，不会上传。</p>
        <div className="mt-5 flex gap-3">
          <Btn className="flex-1" onClick={() => void declineRestore()} data-testid="restore-settings-no">不恢复</Btn>
          <Btn tone="ink" className="flex-1" onClick={acceptRestore} data-testid="restore-settings-yes">恢复</Btn>
        </div>
      </div>
    </div>
  );
}
