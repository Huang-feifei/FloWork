import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ className = "" }: { className?: string }) {
	const [i, setI] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
		return () => clearInterval(timer);
	}, []);
	return <span className={className}>{FRAMES[i]}</span>;
}

/** 从 since 开始计时的秒数 */
export function useElapsed(since: number | null): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (since === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [since]);
	return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}
