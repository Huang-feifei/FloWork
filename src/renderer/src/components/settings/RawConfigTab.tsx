import { useEffect, useState } from "react";
import type { ConfigFileName } from "@shared/protocol";
import { errorText } from "../../api/client";
import { useApp } from "../../store";
import { Badge, Button, TextArea } from "../ui";
import { isMtimeConflict, useConfigFile } from "./useConfigFile";

/** 单个配置文件编辑器：白卡片 + 等宽编辑区 + 状态胶囊 + pill 动作 */
function FileEditor({ name, title, hint }: { name: ConfigFileName; title: string; hint: string }) {
	const { file, error, conflict, reload, save } = useConfigFile(name);
	const pushNotice = useApp((s) => s.pushNotice);
	const [text, setText] = useState("");
	const [parseError, setParseError] = useState<string | null>(null);

	useEffect(() => {
		if (file) setText(file.text || "{\n}\n");
	}, [file]);

	const validate = (value: string) => {
		try {
			JSON.parse(value);
			setParseError(null);
			return true;
		} catch (e) {
			setParseError(errorText(e));
			return false;
		}
	};

	const saveText = async (force: boolean) => {
		try {
			await save(text, { force });
			pushNotice("info", `${title} 已保存`);
		} catch (e) {
			// 冲突交给下面的内联提示处理（让用户选保留哪一份），其余错误沿用通知
			if (!isMtimeConflict(e)) pushNotice("error", errorText(e));
		}
	};

	const dirty = file !== null && text !== (file.text || "{\n}\n");

	return (
		<div className="fw-card p-6">
			<div className="flex items-center gap-3">
				<h3 className="shrink-0 text-[15px] font-semibold tracking-tight">{title}</h3>
				{file && !file.exists && <Badge tone="warn">尚未创建</Badge>}
				<span className="min-w-0 flex-1 truncate text-right font-mono text-[11.5px] text-faint">{file?.path}</span>
			</div>
			<p className="mt-1 text-[12.5px] leading-relaxed text-muted">{hint}</p>

			{error && <div className="mt-3 rounded-xl bg-err-soft px-3.5 py-2 text-[12.5px] text-err">{error}</div>}
			{conflict && (
				<div className="mt-3 rounded-xl bg-warn-soft p-3.5 text-[12.5px] leading-relaxed text-warn">
					<div>
						{title} 在你打开之后被其他程序改过，磁盘上的版本已经和下面显示的不一样了；直接保存会被拒绝，以免覆盖对方的改动。
					</div>
					<div className="mt-3 flex flex-wrap gap-2">
						<Button size="sm" onClick={() => void reload()}>
							重新加载磁盘版本（放弃我的修改）
						</Button>
						<Button size="sm" variant="primary" disabled={!!parseError} onClick={() => void saveText(true)}>
							用我的内容覆盖磁盘版本（丢弃对方的改动）
						</Button>
					</div>
				</div>
			)}

			<TextArea
				rows={16}
				spellCheck={false}
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					validate(e.target.value);
				}}
				className="mt-3"
			/>

			<div className="mt-3 flex items-center gap-2">
				{parseError ? (
					<Badge tone="err">JSON 错误：{parseError}</Badge>
				) : (
					<Badge tone="ok">✓ JSON 格式正确</Badge>
				)}
				<div className="flex-1" />
				<Button
					size="sm"
					disabled={!!parseError}
					onClick={() => validate(text) && setText(`${JSON.stringify(JSON.parse(text), null, 2)}\n`)}
				>
					格式化
				</Button>
				<Button size="sm" disabled={!dirty} onClick={() => file && setText(file.text || "{\n}\n")}>
					还原
				</Button>
				<Button size="sm" variant="primary" disabled={!dirty || !!parseError} onClick={() => void saveText(false)}>
					保存
				</Button>
			</div>
		</div>
	);
}

export function RawConfigTab() {
	return (
		<div className="space-y-6">
			<FileEditor
				name="settings"
				title="settings.json"
				hint="pi 的全局设置。字段说明见 pi 文档 docs/settings.md；保存后打开的会话会重新加载。"
			/>
			<FileEditor
				name="models"
				title="models.json"
				hint="自定义供应商与模型覆盖（providers / modelOverrides）。字段说明见 pi 文档 docs/models.md。"
			/>
			<FileEditor
				name="mcp"
				title="mcp.json"
				hint="MCP（Model Context Protocol）服务器配置。字段说明见 docs/mcp.md；保存后新建或切换会话时自动连接。"
			/>
			<div className="text-[12px] leading-5 text-faint">
				auth.json 含密钥，不在页面中显示；请通过“模型供应商”页登录或登出。
			</div>
		</div>
	);
}
