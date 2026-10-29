import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function getGithubToken() {
	if (process.env.FLOWORK_KERNEL_GITHUB_TOKEN) return process.env.FLOWORK_KERNEL_GITHUB_TOKEN;
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
	const p = spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
	for (const line of p.stdout.split("\n")) {
		if (line.startsWith("password=")) return line.slice("password=".length).trim();
	}
	throw new Error("未能从环境或 Git Credential Manager 获取 GitHub 访问令牌");
}

async function main() {
	const token = getGithubToken();
	const repo = "Huang-feifei/FloWork";
	const tag = "kernel-v1.0.1";
	const title = "Pi 内核更新 1.4.0 (批次 1.0.1)";
	const body = [
		"### FloWork 独立内核更新包",
		"",
		"- **内核版本**：`@earendil-works/pi-coding-agent@1.4.0`",
		"- **放行批次**：`1.0.1`",
		"- **适用应用**：FloWork 1.1.3",
		"- **平台架构**：win32-x64",
		"",
		"本 Release 包含经维护者 Ed25519 签名批准的完整内核运行时包与签名清单，客户端可在「设置 → 内核更新」中自动检查并一键更新。",
	].join("\n");

	const authHeaders = {
		"User-Agent": "FloWork-Release-Publisher",
		"Authorization": `token ${token}`,
		"Accept": "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};

	console.log(`检查 Release ${tag}…`);
	let releaseRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: authHeaders });
	let release;
	if (releaseRes.status === 200) {
		release = await releaseRes.json();
		console.log(`Release ${tag} 已存在 (id: ${release.id})`);
	} else if (releaseRes.status === 404) {
		console.log(`创建 Release ${tag}…`);
		const createRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				tag_name: tag,
				target_commitish: "master",
				name: title,
				body,
				draft: false,
				prerelease: false,
			}),
		});
		if (!createRes.ok) {
			const err = await createRes.text();
			throw new Error(`创建 Release 失败 (${createRes.status}): ${err}`);
		}
		release = await createRes.json();
		console.log(`Release 创建成功 (id: ${release.id})`);
	} else {
		throw new Error(`检查 Release 出错 (${releaseRes.status}): ${await releaseRes.text()}`);
	}

	const files = [
		{
			name: "flowork-kernel-win32-x64.json",
			path: join(import.meta.dirname, "../release/kernels/1.0.1/flowork-kernel-win32-x64.json"),
			contentType: "application/json",
		},
		{
			name: "flowork-kernel-win32-x64.tar.gz",
			path: join(import.meta.dirname, "../release/kernels/1.0.1/flowork-kernel-win32-x64.tar.gz"),
			contentType: "application/gzip",
		},
	];

	for (const file of files) {
		const existing = (release.assets || []).find((a) => a.name === file.name);
		if (existing) {
			console.log(`删除已存在的旧附件 ${file.name} (id: ${existing.id})…`);
			const delRes = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${existing.id}`, {
				method: "DELETE",
				headers: authHeaders,
			});
			if (!delRes.ok && delRes.status !== 404) {
				console.warn(`删除旧附件失败: ${delRes.status}`);
			}
		}

		console.log(`读取 ${file.name}…`);
		const content = readFileSync(file.path);
		console.log(`正在上传 ${file.name} (${(content.length / 1024 / 1024).toFixed(2)} MB)…`);

		// GitHub upload_url: https://uploads.github.com/repos/owner/repo/releases/id/assets{?name,label}
		const uploadUrl = release.upload_url.replace(/\{.*?\}$/, `?name=${encodeURIComponent(file.name)}`);
		const uploadRes = await fetch(uploadUrl, {
			method: "POST",
			headers: {
				...authHeaders,
				"Content-Type": file.contentType,
				"Content-Length": String(content.length),
			},
			body: content,
		});

		if (!uploadRes.ok) {
			const err = await uploadRes.text();
			throw new Error(`上传 ${file.name} 失败 (${uploadRes.status}): ${err}`);
		}
		const asset = await uploadRes.json();
		console.log(`✓ ${file.name} 上传成功 (asset id: ${asset.id})`);
	}

	console.log(`\n🎉 Release ${tag} 发布完成！`);
	console.log(`查看地址: ${release.html_url}`);
}

main().catch((e) => {
	console.error("\n❌ 发布失败:", e);
	process.exit(1);
});
