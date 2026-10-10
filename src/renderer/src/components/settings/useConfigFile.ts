import { useCallback, useEffect, useState } from "react";
import type { ConfigFile, ConfigFileName } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";

/** 读取 pi 配置文件（settings.json / models.json）；配置变更后自动重新读取 */
export function useConfigFile(name: ConfigFileName) {
	const configVersion = useApp((s) => s.configVersion);
	const [file, setFile] = useState<ConfigFile | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			setFile(await api.service({ type: "get_config_file", name }));
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	}, [name]);

	useEffect(() => {
		void reload();
	}, [reload, configVersion]);

	const save = useCallback(
		async (text: string) => {
			const saved = await api.service({ type: "save_config_file", name, text });
			setFile(saved);
			return saved;
		},
		[name],
	);

	return { file, error, reload, save };
}

/** 解析 JSON 对象；空文本视为 {} */
export function parseObject(text: string | undefined): Record<string, unknown> {
	if (!text?.trim()) return {};
	const parsed = JSON.parse(text) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
