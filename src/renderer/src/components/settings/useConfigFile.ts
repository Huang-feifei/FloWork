import { useCallback, useEffect, useState } from "react";
import { CONFIG_MTIME_CONFLICT, type ConfigFile, type ConfigFileName } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";

export interface SaveConfigOptions {
	/** 用户明确要求用本地内容覆盖磁盘版本：不传 expectedMtime，跳过 mtime 校验 */
	force?: boolean;
}

/** 是否为「磁盘 mtime 与打开时不一致」的冲突；判定只在这里做，调用方不要自己匹配文案 */
export function isMtimeConflict(error: unknown): boolean {
	return errorText(error).includes(CONFIG_MTIME_CONFLICT);
}

/** 读取 pi 配置文件（settings.json / models.json）；配置变更后自动重新读取 */
export function useConfigFile(name: ConfigFileName) {
	const configVersion = useApp((s) => s.configVersion);
	const [file, setFile] = useState<ConfigFile | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 保存时发现磁盘被外部改动；只有重新读取或保存成功才清除
	const [conflict, setConflict] = useState(false);

	const reload = useCallback(async () => {
		try {
			setFile(await api.service({ type: "get_config_file", name }));
			setError(null);
			setConflict(false);
		} catch (e) {
			setError(errorText(e));
		}
	}, [name]);

	useEffect(() => {
		void reload();
	}, [reload, configVersion]);

	const mtime = file?.mtime;
	const save = useCallback(
		async (text: string, options: SaveConfigOptions = {}) => {
			try {
				const saved = await api.service({
					type: "save_config_file",
					name,
					text,
					expectedMtime: options.force ? undefined : mtime,
				});
				setFile(saved);
				setConflict(false);
				return saved;
			} catch (e) {
				// 冲突时只记状态、不自动重读：重读会让调用方正在编辑的内容被磁盘版本覆盖掉。
				// 由调用方在界面上给用户选「重新加载磁盘版本」还是「用本地内容覆盖」。
				if (isMtimeConflict(e)) setConflict(true);
				throw e;
			}
		},
		[name, mtime],
	);

	return { file, error, conflict, reload, save };
}

/** 解析 JSON 对象；空文本视为 {} */
export function parseObject(text: string | undefined): Record<string, unknown> {
	if (!text?.trim()) return {};
	const parsed = JSON.parse(text) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
