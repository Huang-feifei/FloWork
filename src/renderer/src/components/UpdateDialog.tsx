/**
 * 版本更新提示：应用启动时发现版本与上次运行不同，就弹一次当前版本的更新内容（取自 CHANGELOG.md）。
 * 首次运行只记录版本、不打扰；帮助菜单与命令面板可以随时重新打开。
 */
import { changelogFor } from "../lib/changelog";
import { useApp } from "../store";
import { Button, Modal } from "./ui";

export function UpdateDialog() {
	const version = useApp((s) => s.updatedTo);
	const close = () => useApp.getState().setUpdatedTo(null);
	if (!version) return null;
	const entry = changelogFor(version);

	return (
		<Modal
			title={`已更新到 v${version}`}
			width="w-[540px]"
			onClose={close}
			footer={
				<Button
					variant="primary"
					onClick={close}
				>
					知道了
				</Button>
			}
		>
			<div className="text-[13px] leading-relaxed">
				<div className="mb-2 text-muted">
					FloWork 已更新到 v{version}
					{entry?.date ? `（${entry.date}）` : ""}。本次更新内容：
				</div>
				{entry && entry.items.length > 0 ? (
					<ul className="list-disc space-y-1 pl-5">
						{entry.items.map((item, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 更新条目按顺序展示，顺序稳定
							<li key={i}>{item}</li>
						))}
					</ul>
				) : (
					<div className="text-muted">这个版本的更新说明还没有写进 CHANGELOG.md。</div>
				)}
				<div className="mt-3 text-[11.5px] text-muted">之后可以在「帮助 → 查看更新内容」里再看。</div>
			</div>
		</Modal>
	);
}
