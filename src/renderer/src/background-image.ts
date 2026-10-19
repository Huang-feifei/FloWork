/**
 * 窗口背景图的本机存储：把用户选的图片以 Blob 存进 IndexedDB，运行时用 object URL 交给 CSS。
 *
 * 为什么不用 localStorage：localStorage 一个源只有几 MB，而且 data URL 是 base64，
 * 实际占用约等于「文件大小 × 1.33」，稍微像样一点的壁纸就塞不下。
 * IndexedDB 存 Blob 容量大得多（可落盘），也不做同步读写、不卡主线程。
 */

const DB_NAME = "flowork";
const DB_VERSION = 1;
const STORE = "assets";
const KEY = "bgImage";

/** 自定义背景图上限：超过就提示换一张。存 Blob，20 MB 很宽裕。 */
export const MAX_BG_IMAGE_BYTES = 20 * 1024 * 1024;

/** 长边超过这个像素就先等比缩小，避免超大图把显存 / 内存吃满 */
const MAX_BG_DIMENSION = 4096;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("无法打开本地数据库"));
	});
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await openDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const request = run(db.transaction(STORE, mode).objectStore(STORE));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("本地数据库读写失败"));
		});
	} finally {
		db.close();
	}
}

/** 读回已保存的背景图；没有或读取失败都返回 null */
export async function loadStoredImage(): Promise<Blob | null> {
	try {
		const value = await withStore<unknown>("readonly", (store) => store.get(KEY));
		return value instanceof Blob ? value : null;
	} catch {
		return null;
	}
}

export async function saveStoredImage(blob: Blob): Promise<void> {
	await withStore("readwrite", (store) => store.put(blob, KEY));
}

export async function clearStoredImage(): Promise<void> {
	try {
		await withStore("readwrite", (store) => store.delete(KEY));
	} catch {
		/* 删不掉也无所谓：下次选图会覆盖 */
	}
}

/**
 * 把选中的文件整理成要存的 Blob：超大图先等比缩到长边 4096 再重新编码（PNG/WebP 走 WebP 保留透明，
 * 其余走 JPEG）；尺寸正常就原样返回，避免无谓的有损重编码。
 */
export async function prepareBackgroundImage(file: File): Promise<Blob> {
	if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return file;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return file;
	}
	try {
		const longest = Math.max(bitmap.width, bitmap.height);
		if (longest <= MAX_BG_DIMENSION) return file;
		const scale = MAX_BG_DIMENSION / longest;
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const ctx = new OffscreenCanvas(width, height).getContext("2d");
		if (!ctx) return file;
		ctx.drawImage(bitmap, 0, 0, width, height);
		const type = file.type === "image/png" || file.type === "image/webp" ? "image/webp" : "image/jpeg";
		const blob = await ctx.canvas.convertToBlob({ type, quality: 0.92 });
		return blob.size > 0 ? blob : file;
	} catch {
		return file;
	} finally {
		bitmap.close();
	}
}
