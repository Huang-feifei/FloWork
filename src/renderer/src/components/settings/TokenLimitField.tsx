import { useId } from "react";
import { parseTokenLimit, type TokenPreset } from "../../lib/token-limit";
import { Input } from "../ui";

/** 精确值 / K、M 简写 + 快捷单选；不在加载或编辑过程中改写已有数值。 */
export function TokenLimitField({
	label, value, onChange, placeholder, presets, hint,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	presets: readonly TokenPreset[];
	hint: string;
}) {
	const id = useId();
	const tokens = parseTokenLimit(value);
	return (
		<div>
			<label htmlFor={id} className="mb-1.5 block text-[12.5px] font-medium text-fg">{label}</label>
			<Input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				aria-describedby={`${id}-hint`}
				spellCheck={false}
				className="font-mono"
			/>
			<div role="group" aria-label={`${label}快捷选项`} className="mt-2 flex flex-wrap gap-1">
				{presets.map(({ label: preset, tokens: amount }) => {
					const selected = tokens === amount;
					return (
						<button
							type="button"
							key={preset}
							aria-pressed={selected}
							title={`${amount.toLocaleString("en-US")} token`}
							onClick={() => onChange(preset)}
							className={`rounded-full border px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
								selected ? "border-primary/40 bg-primary-soft font-medium text-primary" : "border-border text-muted hover:bg-panel-2 hover:text-fg"
							}`}
						>
							{preset}
						</button>
					);
				})}
			</div>
			<div id={`${id}-hint`} className="mt-1.5 text-[11.5px] leading-4 text-muted">
				{hint}
				{tokens !== undefined && <span className="block" aria-live="polite">实际值：{tokens.toLocaleString("en-US")} token。</span>}
			</div>
		</div>
	);
}
