/** 在真实生产 Electron renderer 中执行；用可重现数据度量首挂、流式、追加和 DOM 窗口。 */
(async () => {
	const store = window.__floworkStore;
	if (!store) throw new Error("缺少隔离截图测试桥");
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const frame = () => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("帧时钟暂停：压测窗口必须可见")), 3000);
		requestAnimationFrame(now => { clearTimeout(timer); resolve(now); });
	});
	const until = async predicate => {
		const end = performance.now() + 10000;
		while (!predicate()) { if (performance.now() > end) throw new Error("等待 transcript 提交超时"); await frame(); }
	};
	const stats = xs => {
		const sorted = [...xs].sort((a,b) => a-b);
		return { min: sorted[0], median: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))], max: sorted.at(-1) };
	};
	const usage = {input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{total:0}};
	const assistant = (id, text, content = [{type:"text",text}]) => ({role:"assistant",entryId:id,content,usage,provider:"fixture",model:"fixture",stopReason:"stop",timestamp:1700000000000});
	const fixtures = n => {
		const out = [];
		for (let i=0;i<n/5;i++) {
			out.push({role:"user",entryId:`u-${i}`,timestamp:1700000000000,content:[{type:"text",text:`任务 ${i}：检查状态、修改代码并运行测试。`}]});
			out.push(assistant(`a-${i}`, "", [{type:"thinking",thinking:"先读文件并检查边界。".repeat(20)}, {type:"toolCall",id:`call-${i}`,name:"edit",arguments:{path:`src/file-${i % 40}.ts`}}]));
			out.push({role:"toolResult",toolCallId:`call-${i}`,toolName:"edit",content:[{type:"text",text:`结果 ${i}\n` + "output line\n".repeat(300)}],details:{diff:"@@ -1 +1 @@\n-old\n+new"},isError:false,timestamp:1700000001000});
			out.push(assistant(`b-${i}`, `已完成第 **${i}** 项。\n\n- 保留状态\n- 检查结果\n\n\`npm test\` 通过。`));
			out.push({role:"note",entryId:`n-${i}`,kind:"fixture",text:`任务 ${i} 结束`,timestamp:1700000001000});
		}
		return out;
	};
	const longTasks = [];
	const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({start:e.startTime,ms:e.duration}))));
	if (PerformanceObserver.supportedEntryTypes.includes("longtask")) observer.observe({type:"longtask"});
	const result = { userAgent:navigator.userAgent, time:new Date().toISOString(), scenarios:[] };
	for (const count of [1000,10000,30000]) {
		const messages = fixtures(count);
		const begin = performance.now();
		store.setState({view:"chat",activeProjectId:"benchmark",handleId:null,cwd:"/fixture",connecting:false,sidebarOpen:false,rightPanel:null,railVisible:false,preview:null,
			messages,streaming:null,foldProcess:true,isRunning:false,state:{sessionId:`bench-${count}`,sessionFile:`fixture-${count}`,cwd:"/fixture",messageCount:count,sessionName:"性能压测",model:null,thinkingLevel:"off",availableThinkingLevels:[],isStreaming:false}});
		await until(() => document.querySelector(`[data-entry-id="n-${count/5-1}"]`));
		await frame(); await frame();
		const mountMs = performance.now()-begin;
		const mountedRows = document.querySelectorAll("[data-entry-id]").length;
		if (mountedRows > 80) throw new Error("初次消息挂载窗口失效："+mountedRows);
		const latency = [], appendLatency = [], frameGaps = [];
		let lastFrame = performance.now(), recording = true;
		const watchFrame = now => { frameGaps.push(now-lastFrame);lastFrame=now;if(recording)requestAnimationFrame(watchFrame); };
		requestAnimationFrame(watchFrame);
		const streamingBegin = performance.now();
		for (let tick=0;tick<150;tick++) {
			const marker = `BENCH-${count}-${tick}`;
			const started = performance.now();
			const patch = {streaming:assistant("stream", "持续输出 ".repeat(20+tick)+marker),isRunning:true};
			const append = tick%10===9;
			if (append) patch.messages = [...store.getState().messages, assistant(`appended-${count}-${tick}`,"新完成的回复")];
			store.setState(patch);
			await until(() => [...document.querySelectorAll(".term-md")].at(-1)?.textContent.includes(marker));
			const duration = performance.now()-started;
			latency.push(duration); if(append)appendLatency.push(duration);
			await sleep(Math.max(0,33-(performance.now()-started)));
		}
		recording=false; await frame();
		const streamingMs=performance.now()-streamingBegin;
		await sleep(100);
		result.scenarios.push({messages:count,toolResultChars:300*12,streamingUpdates:150,targetHz:30,mountMs,mountedRows,streamingMs,
			updateMs:stats(latency),appendMs:stats(appendLatency),frameGapMs:stats(frameGaps),longTasks:longTasks.filter(e=>e.start>=begin),
			heapUsedBytes:performance.memory?.usedJSHeapSize,domNodes:document.querySelectorAll("*").length});
		store.setState({streaming:null,isRunning:false});
	}
	observer.disconnect();
	return result;
})()
