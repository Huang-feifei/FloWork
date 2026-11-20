// 在隔离的 Electron 窗口中验证图库；图片由同一套生图夹具提供。
export const imageLibraryRegression = `(async () => {
	const store = window.__floworkStore;
	const pause = () => new Promise(resolve => setTimeout(resolve, 40));
	const waitFor = async (test, message) => {
		for (let i = 0; i < 110; i++) { const result = test(); if (result) return result; await pause(); }
		throw new Error(message);
	};
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	const gallery = () => document.querySelector('.fw-gallery');
	const tiles = () => [...(gallery()?.querySelectorAll('[data-gallery-image]') ?? [])];
	const button = (root, label) => [...(root?.querySelectorAll('button') ?? [])].find(node => node.textContent.trim() === label);
	const dialog = () => document.querySelector('[role="dialog"]');
	const detail = () => gallery()?.querySelector('[aria-label="图片预览"]');
	await waitFor(() => tiles().length === 2, '没有加载两张隔离图片');
	check(tiles().every(tile => !tile.querySelector('button, a, input')), '缩略图内部仍有嵌套控件');
	tiles()[1].click();
	await waitFor(() => {
		const img = detail()?.querySelector('.fw-gallery-stage img');
		return img?.naturalWidth > 0 && getComputedStyle(img).objectFit === 'contain';
	}, '无法解码原比例预览');
	check(button(detail(), '插入会话')?.disabled, '没有项目时仍允许向会话插入');
	button(detail(), '收藏').click();
	store.getState().setImageFilter('favorite');
	await waitFor(() => tiles().length === 1, '收藏筛选未生效');
	button(detail(), '已收藏').click();
	await waitFor(() => gallery()?.textContent.includes('还没有收藏的图片'), '收藏空状态未出现');
	button(gallery(), '查看全部图片').click();
	await waitFor(() => tiles().length === 2, '未能返回全部图片');
	button(detail(), '删除').click();
	await waitFor(dialog, '删除没有询问确认');
	button(dialog(), '取消').click();
	await waitFor(() => !dialog() && !button(gallery(), '清空图片库')?.disabled, '取消删除后操作没有恢复');
	check(tiles().length === 2, '取消后图片被删除');
	button(gallery(), '清空图片库').click();
	await waitFor(dialog, '清空没有询问确认');
	button(dialog(), '清空图片库').click();
	await waitFor(() => gallery()?.textContent.includes('图片库还是空的'), '确认清空后未到达空状态');
	check(store.getState().imageFilter === 'all', '清空后筛选未复位');
	const reload = button(document.querySelector('.fw-gallery'), '生成图片');
	check(reload, '空态没有生成入口');
})()`;
