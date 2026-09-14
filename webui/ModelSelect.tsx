import { useState } from 'preact/hooks';
import { Modal } from './primitives';
import { IcCheck, IcChevron, IcEye } from './icons';

// The reasoning-effort levels the backend accepts in the chat body (mirrors
// REASONING_EFFORTS in src/llm.ts); [value, label] pairs for the toggle.
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'XHigh']];

// The header's model picker: a select-styled button that opens a modal with
// the model list + a reasoning-effort toggle. Both are pure client state —
// they apply to the *next* send (the values are sent in every POST body) and
// get pre-filled from the open session's last-used values. A model pick
// applies and closes; the effort toggle applies in place so both can be set
// in one open.
const ModelSelect = ({ models, model, effort, onPickModel, onPickEffort, visionModels = new Set() }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
              title={model ? `${model}${effort ? ` · reasoning effort: ${effort}` : ''}` : 'pick a model'}
              class="inline-flex items-center gap-[7px] h-7 pl-[11px] pr-[7px] rounded-[7px] border border-line bg-field text-[.78rem] cursor-pointer transition-colors hover:bg-card max-w-[220px]">
        <span class="text-[.78rem] text-ink truncate">{model}</span>
        {effort ? <span class="text-text3 text-[.68rem] whitespace-nowrap">{effort}</span> : null}
        <span class="text-text3 flex-none"><IcChevron /></span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Model">
        <div class="px-2 pb-2 max-h-[min(50vh,320px)] overflow-y-auto">
          {models.map((m) => (
            <button key={m} type="button" title={m}
                    class="flex items-center gap-[11px] w-full px-2.5 py-[7px] rounded-lg text-[.83rem] text-left cursor-pointer transition-colors hover:bg-material2"
                    onClick={() => { onPickModel(m); setOpen(false); }}>
              <span class="w-[17px] grid place-items-center flex-none text-accent">
                {m === model ? <IcCheck /> : null}
              </span>
              <span class="truncate text-ink">{m}</span>
              {visionModels.has(m)
                ? <span title="accepts image input" class="text-text3 flex-none"><IcEye /></span>
                : null}
            </button>
          ))}
        </div>
        <div class="px-4 pt-1.5 pb-4">
          <div class="text-[.62rem] font-bold tracking-[.05em] uppercase text-text3 mb-1.5">Reasoning effort</div>
          <div class="grid grid-cols-4 gap-1 p-1 rounded-lg bg-field border border-line">
            {EFFORTS.map(([v, label]) => (
              <button key={v} type="button" title={`reasoning effort: ${label}`}
                      class={`h-[26px] rounded-md text-[.74rem] font-medium cursor-pointer transition-colors ${effort === v ? 'bg-sel text-ink' : 'text-dim hover:text-ink'}`}
                      onClick={() => onPickEffort(v)}>{label}</button>
            ))}
          </div>
        </div>
      </Modal>
    </>
  );
};

export { ModelSelect };
