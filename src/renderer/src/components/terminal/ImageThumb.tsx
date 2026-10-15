/**
 * 会话记录与工具结果里的图片缩略图。
 *
 * 图片以 base64 存放在消息内容块中，这里直接内联成 data URL，不落盘、不经过额外 IPC。
 * 默认按缩略图显示（截图往往很大），点击在缩略图与原始大小之间切换。
 */
import { useState } from "react";
import type { ImageAttachment } from "@shared/protocol";

interface Props {
	image: ImageAttachment;
	/** 无障碍描述；省略时按「图片」处理 */
	alt?: string;
	/** 缩略图高度类，默认 h-24 */
	thumbClassName?: string;
}

export function ImageThumb({ image, alt, thumbClassName = "h-24 max-w-[240px]" }: Props) {
	const [full, setFull] = useState(false);
	return (
		<button
			type="button"
			onClick={() => setFull((v) => !v)}
			title={full ? "点击缩小" : "点击查看原始大小"}
			className="block max-w-full rounded border border-border bg-panel p-0.5 text-left"
		>
			<img
				src={`data:${image.mimeType};base64,${image.data}`}
				alt={alt ?? "图片"}
				className={full ? "max-h-[70vh] max-w-full object-contain" : `${thumbClassName} object-contain`}
			/>
		</button>
	);
}
