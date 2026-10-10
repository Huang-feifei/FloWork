import { useEffect, useState } from "react";
import type { ConfigFileName } from "@shared/protocol";
import { errorText } from "../../api/client";
import { useApp } from "../../store";
import { Button, TextArea } from "../ui";
import { useConfigFile } from "./useConfigFile";

function FileEditor({ name, title, hint }: { name: ConfigFileName; title: string; hint: string }) {
	const { file, error, save } = useConfigFile(name);
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

	const dirty = file !== null && text !== (file.text || "{\n}\n");

	return (
		<section className="space-y-2">
			<div className="flex items-center gap-2">
				<h3 className="text-sm font-semibold">{title}</h3>
				<span className="truncate font-mono text-[11px] text-muted">{file?.path}</span>
				{file && !file.exists && <span className="text-[11px] text-warn">（尚未创建）</span>}
			</div>
			<div className="text-[11px] text-muted">{hint}</div>
			{error && <div className="text-xs text-err">{error}</div>}
			<TextArea
				rows={16}
				spellCheck={false}
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					validate(e.target.value);
				}}
			/>
			<div className="flex items-center gap-2">
				{parseError ? <span className="text-xs text-err">JSON 错误：{parseError}</span> : <span className="text-xs text-muted">JSON 格式正确</span>}
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
				<Button
					size="sm"
					variant="primary"
					disabled={!dirty || !!parseError}
					onClick={() =>
						void save(text).then(
							() => pushNotice("info", `${title} 已保存`),
							(e: unknown) => pushNotice("error", errorText(e)),
						)
					}
				>
					保存
				</Button>
			</div>
		</section>
	);
}

export function RawConfigTab() {
	return (
		<div className="space-y-8">
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
			<div className="text-[11px] text-muted">auth.json 含密钥，不在页面中显示；请通过“模型供应商”页登录或登出。</div>
		</div>
	);
}
