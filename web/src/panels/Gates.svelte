<script module lang="ts">
  import { defaultDraft as initialDraft } from './gate-draft';

  // The draft outlives the panel, so rows that are off keep their parameters
  // and order when it is closed and opened again.
  let kept = initialDraft();
</script>

<script lang="ts">
  // Gate configuration panel: one row per gate type with its switch, its
  // place in the chain and a slider per parameter; the grammar text and the
  // seed. Every change sends the whole chain (`config` command, `gates`); the
  // engine answers with a CONFIG, which the draft follows, or with an error,
  // after which the draft goes back to the current CONFIG. A recorded session
  // shows the chain and takes no changes.
  import { onDestroy, untrack } from 'svelte';
  import { sendConfig } from '../app';
  import type { Config, Gate } from '../source/frames';
  import { ui } from '../ui.svelte';
  import {
    chainText,
    draftFromConfig,
    formatParam,
    GATE_LABELS,
    gatesToSend,
    moveRow,
    PARAMS,
    SEED_MAX,
    sameGates,
    setRow,
    toggleRow,
    type DraftRow,
    type GateDraft,
    type NumericGateType,
    type ParamSpec,
  } from './gate-draft';
  import Icon from './Icon.svelte';
  import { JSON_GRAMMAR } from './json-grammar';

  const SLIDER_DELAY_MS = 150;

  const initial = ui.config ? draftFromConfig(ui.config.gates, kept) : kept;
  let draft = $state.raw<GateDraft>(initial);
  // The text being edited; it reaches the draft (and the engine) on Apply.
  let grammarText = $state(grammarOf(initial));
  let syncedGrammar = grammarOf(initial); // the grammar text of the draft at the last sync
  let seed = $state<number | null>(ui.config?.seed ?? null);

  let timer: ReturnType<typeof setTimeout> | null = null; // a slider change waiting to be sent
  let seenErrors = ui.configErrors;

  const replay = $derived(ui.mode === 'replay');
  const readonly = $derived(replay || !ui.connected);
  const current = $derived<Gate[]>(ui.config?.gates ?? []);
  const grammarRow = $derived(draft.find((r) => r.gate.type === 'grammar'));
  const grammarEdited = $derived(grammarText !== grammarOf(draft));
  // Apply sends edited text, or switches on a grammar that has text.
  const canApply = $derived(grammarEdited || (grammarText.trim() !== '' && !(grammarRow?.enabled ?? false)));

  function grammarOf(d: GateDraft): string {
    const g = d.find((r) => r.gate.type === 'grammar')?.gate;
    return g?.type === 'grammar' ? g.gbnf : '';
  }

  function setDraft(d: GateDraft): void {
    draft = d;
    kept = d;
  }

  // The draft back in line with a CONFIG. Text being edited in the grammar
  // field stays, also after a grammar the engine refused.
  function sync(c: Config | null): void {
    if (!c) return;
    const edited = grammarText !== syncedGrammar;
    setDraft(draftFromConfig(c.gates, draft));
    syncedGrammar = grammarOf(draft);
    if (!edited) grammarText = syncedGrammar;
    seed = c.seed;
  }

  // Follow every CONFIG, except while a slider change waits to be sent: it
  // would undo what the user is moving. Its own CONFIG comes after.
  $effect(() => {
    const c = ui.config;
    untrack(() => {
      if (timer === null) sync(c);
    });
  });

  // An error from the engine for `config`: nothing changed there, so the
  // draft goes back to the current CONFIG (the engine sends none).
  $effect(() => {
    const errors = ui.configErrors;
    if (errors === seenErrors) return;
    seenErrors = errors;
    untrack(() => {
      cancelTimer();
      sync(ui.config);
    });
  });

  onDestroy(cancelTimer);

  function cancelTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function sendGates(): void {
    if (!sendConfig({ gates: gatesToSend(draft) })) sync(ui.config);
  }

  // A change sent at once: switch, order, grammar. It also takes any slider
  // change still waiting. Sends nothing if the chain stays the same.
  function commit(next: GateDraft): void {
    const before = gatesToSend(draft);
    const waiting = timer !== null;
    cancelTimer();
    setDraft(next);
    if (waiting || !sameGates(before, gatesToSend(next))) sendGates();
  }

  // A slider change, sent a moment after the last movement.
  function slide(next: GateDraft): void {
    setDraft(next);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      sendGates();
    }, SLIDER_DELAY_MS);
  }

  function toggle(i: number, on: boolean): void {
    const row = draft[i];
    let gate = row.gate;
    // Switching the grammar on takes the text already written.
    if (on && gate.type === 'grammar') gate = { type: 'grammar', gbnf: grammarText };
    // Penalties or temp alone would draw from the whole vocabulary: the
    // standard cut-offs come on with them.
    commit(toggleRow(setRow(draft, i, { ...row, gate }), i, on).draft);
  }

  function move(i: number, delta: -1 | 1): void {
    commit(moveRow(draft, i, delta));
  }

  function setParam(i: number, p: ParamSpec, raw: number): void {
    if (!Number.isFinite(raw)) return;
    const v = p.int ? Math.round(raw) : raw;
    const row = draft[i];
    const gate = { ...row.gate, [p.key]: v } as Gate;
    const next = setRow(draft, i, { ...row, gate });
    // A row that is off is not in the chain: nothing to send.
    if (row.enabled) slide(next);
    else setDraft(next);
  }

  function applyGrammar(): void {
    const i = draft.findIndex((r) => r.gate.type === 'grammar');
    if (i < 0) return;
    commit(setRow(draft, i, { enabled: grammarText.trim() !== '', gate: { type: 'grammar', gbnf: grammarText } }));
  }

  // Sends a valid seed; anything else goes back to the current one.
  function applySeed(): void {
    const v = seed;
    const c = ui.config;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SEED_MAX) {
      if (c && v === c.seed) return;
      if (sendConfig({ seed: v })) return;
    }
    seed = c?.seed ?? null;
  }

  function valueOf(row: DraftRow, p: ParamSpec): number {
    return (row.gate as unknown as Record<string, number>)[p.key];
  }

  // Where a value sits between its bounds, for the filled part of a slider.
  function fill(p: ParamSpec, v: number): string {
    const span = p.max - p.min;
    return `${span > 0 ? Math.min(100, Math.max(0, ((v - p.min) / span) * 100)) : 0}%`;
  }

  function paramsOf(row: DraftRow): readonly ParamSpec[] {
    return row.gate.type === 'grammar' ? [] : PARAMS[row.gate.type as NumericGateType];
  }

  // Keys stay in the panel: Space must toggle a switch, Tab must move the
  // focus, not reach the window's shortcuts. Escape closes the panel.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      ui.gatesOpen = false;
    } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'number') {
      e.target.blur(); // the change event sends the seed
    }
    e.stopPropagation();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="sheet glass" aria-label="Samplers" onkeydown={onKey}>
  <header class="head">
    <span class="mark"><Icon name="sliders" size={18} /></span>
    <div class="titles">
      <h2 class="title">Samplers</h2>
      <p class="subtitle">The gate chain applied to each decision</p>
    </div>
    <button class="ghost icon-only close" onclick={() => (ui.gatesOpen = false)} title="Close (Esc)" aria-label="Close"
      ><Icon name="close" size={16} /></button
    >
  </header>
  <div class="row info">
    <Icon name="layers" size={15} />
    <span class="chain" title="The chain in force">{chainText(current)}</span>
    {#if replay}
      <span class="tag">Recorded session</span>
    {:else if !ui.connected}
      <span class="tag">Not connected</span>
    {/if}
  </div>
  <div class="row">
    <label class="field" title="Seed of the final draw (0 to {SEED_MAX})">
      Seed
      <input
        class="seed"
        type="number"
        min="0"
        max={SEED_MAX}
        step="1"
        disabled={readonly}
        bind:value={seed}
        onchange={applySeed}
      />
    </label>
    <span class="muted">Changes apply from the next token.</span>
  </div>

  <ol class="list">
    {#each draft as row, i (row.gate.type)}
      {@const label = GATE_LABELS[row.gate.type]}
      <li class="gate" class:off={!row.enabled}>
        <span class="order">
          <button
            class="arrow"
            disabled={readonly || i === 0}
            onclick={() => move(i, -1)}
            aria-label="Move {label} up"><Icon name="arrowUp" size={13} /></button
          ><button
            class="arrow"
            disabled={readonly || i === draft.length - 1}
            onclick={() => move(i, 1)}
            aria-label="Move {label} down"><Icon name="arrowDown" size={13} /></button
          >
        </span>
        <label class="name">
          <input
            class="switch"
            type="checkbox"
            checked={row.enabled}
            disabled={readonly}
            onchange={(e) => toggle(i, e.currentTarget.checked)}
          />
          {label}
        </label>
        {#if row.gate.type === 'grammar'}
          <span class="params">
            <button disabled={readonly} onclick={() => (grammarText = JSON_GRAMMAR)} title="Fill in a JSON grammar">
              <Icon name="edit" size={13} />JSON
            </button>
            <button
              disabled={readonly || !canApply}
              onclick={applyGrammar}
              title="Send the grammar and switch it on"><Icon name="check" size={13} />Apply</button
            >
            {#if grammarEdited}<span class="muted pending"><span class="led"></span>not applied</span>{/if}
          </span>
          <textarea
            class="gbnf"
            rows="3"
            spellcheck="false"
            placeholder={'GBNF with a root rule, e.g.  root ::= "yes" | "no"'}
            disabled={readonly}
            aria-label="Grammar (GBNF)"
            bind:value={grammarText}
          ></textarea>
        {:else}
          <span class="params">
            {#each paramsOf(row) as p (p.key)}
              {@const v = valueOf(row, p)}
              <label class="param">
                <span class="key">{p.label}</span>
                <input
                  type="range"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={v}
                  style:--p={fill(p, v)}
                  disabled={readonly}
                  aria-label="{label} {p.label}"
                  oninput={(e) => setParam(i, p, Number(e.currentTarget.value))}
                />
                <span class="figure">{formatParam(p, v)}</span>
              </label>
            {/each}
          </span>
        {/if}
      </li>
    {/each}
  </ol>
</aside>

<style>
  /* Slide-over on the right, under the bar; it does not push the page. */
  .sheet {
    position: fixed;
    top: calc(var(--bar-h, 56px) + 10px);
    right: 10px;
    bottom: 10px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(420px, calc(100vw - 20px));
    padding: 18px 18px 20px;
    overflow-y: auto;
    border-radius: 14px;
    box-shadow:
      var(--edge),
      -24px 0 60px rgba(0, 0, 0, 0.55),
      0 0 70px -30px rgba(var(--front-rgb), 0.45);
    font-size: var(--fs-label);
    font-feature-settings: 'cv11';
    scrollbar-color: var(--line-strong) transparent;
    scrollbar-width: thin;
    animation: slide-in 240ms var(--ease);
  }
  @keyframes slide-in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 1px solid rgba(var(--front-rgb), 0.4);
    border-radius: 10px;
    background: rgba(var(--front-rgb), 0.12);
    color: var(--front);
    box-shadow: 0 0 18px -6px rgba(var(--front-rgb), 0.8);
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  .title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .subtitle {
    margin: 2px 0 0;
    color: var(--muted);
  }
  .close {
    align-self: flex-start;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
  }
  .info {
    gap: 8px 10px;
    padding: 9px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.5);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
    color: var(--front);
  }
  .chain {
    flex: 1;
    min-width: 0;
    color: var(--high);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .tag {
    padding: 1px 9px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    background: rgba(var(--surface-3-rgb), 0.8);
    color: var(--muted);
    font-size: var(--fs-small);
    font-weight: 500;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-weight: 500;
  }
  .seed {
    width: 14ch;
    border-color: var(--hairline);
    background: rgba(var(--bg-rgb), 0.55);
    font-variant-numeric: tabular-nums;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gate {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 10px 10px;
    padding: 11px 12px 12px;
    border: 1px solid rgba(var(--front-rgb), 0.28);
    border-radius: var(--radius);
    background: linear-gradient(180deg, rgba(var(--front-rgb), 0.07), rgba(var(--surface-rgb), 0.55));
    box-shadow:
      var(--edge),
      0 6px 18px -12px rgba(var(--front-rgb), 0.6);
    transition:
      border-color 180ms var(--ease),
      background-color 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }
  .gate.off {
    border-color: var(--hairline);
    background: rgba(var(--surface-rgb), 0.45);
    box-shadow: var(--edge);
  }
  .gate.off:hover {
    border-color: var(--line-strong);
  }
  .gate.off .name,
  .gate.off .param {
    color: var(--low);
  }
  .order {
    display: inline-flex;
    gap: 2px;
  }
  .order .arrow {
    min-height: 24px;
    width: 24px;
    padding: 0;
    border-color: var(--hairline);
    background: rgba(var(--surface-3-rgb), 0.5);
    color: var(--muted);
  }
  .order .arrow:hover:not(:disabled) {
    color: var(--high);
  }
  .order .arrow:disabled {
    background: transparent;
    border-color: transparent;
    color: var(--faint);
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--high);
    font-size: var(--fs-body);
    font-weight: 600;
    cursor: pointer;
  }
  /* The on / off switch: a checkbox drawn as a small track with a knob. */
  .switch {
    position: relative;
    flex: none;
    width: 30px;
    height: 18px;
    margin: 0;
    padding: 0;
    appearance: none;
    -webkit-appearance: none;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: rgba(var(--bg-rgb), 0.7);
    cursor: pointer;
    transition:
      background-color 180ms var(--ease),
      border-color 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }
  .switch::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--muted);
    transition:
      transform 180ms var(--ease),
      background-color 180ms var(--ease);
  }
  .switch:checked {
    border-color: var(--front);
    background: rgba(var(--front-rgb), 0.85);
    box-shadow: 0 0 12px -2px rgba(var(--front-rgb), 0.8);
  }
  .switch:checked::before {
    background: var(--high);
    transform: translateX(12px);
  }
  .switch:hover:not(:disabled) {
    border-color: rgba(var(--front-rgb), 0.7);
  }
  .switch:focus {
    box-shadow: none;
  }
  .switch:focus-visible {
    outline: 2px solid rgba(var(--high-rgb), 0.6);
    outline-offset: 2px;
  }
  .switch:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .params {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
  }
  .params button {
    min-height: 28px;
    padding: 3px 10px;
    gap: 5px;
  }
  .param {
    flex: 1 1 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--muted);
  }
  .key {
    min-width: 8ch;
  }
  .figure {
    min-width: 6ch;
    color: var(--high);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .gate.off .figure {
    color: var(--muted);
  }
  .pending {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .pending .led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--high);
    box-shadow: 0 0 6px rgba(var(--high-rgb), 0.6);
  }

  /* Parameter sliders: a thin track filled up to the value, a lit thumb. */
  .param input {
    --p: 0%;
    flex: 1;
    min-width: 80px;
    height: 18px;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .param input:focus {
    box-shadow: none;
  }
  .param input::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--front) var(--p), rgba(var(--high-rgb), 0.14) var(--p));
  }
  .param input::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: rgba(var(--high-rgb), 0.14);
  }
  .param input::-moz-range-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--front);
  }
  .param input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border: 2px solid var(--front);
    border-radius: 50%;
    background: var(--high);
    box-shadow: 0 0 0 3px rgba(var(--front-rgb), 0.16);
    transition: box-shadow 140ms var(--ease);
  }
  .param input::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border: 2px solid var(--front);
    border-radius: 50%;
    background: var(--high);
    box-shadow: 0 0 0 3px rgba(var(--front-rgb), 0.16);
    transition: box-shadow 140ms var(--ease);
  }
  .param input:hover:not(:disabled)::-webkit-slider-thumb,
  .param input:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 6px rgba(var(--front-rgb), 0.2),
      0 0 14px rgba(var(--front-rgb), 0.8);
  }
  .param input:hover:not(:disabled)::-moz-range-thumb,
  .param input:focus-visible::-moz-range-thumb {
    box-shadow:
      0 0 0 6px rgba(var(--front-rgb), 0.2),
      0 0 14px rgba(var(--front-rgb), 0.8);
  }
  .param input:focus-visible {
    outline: none;
  }
  .gate.off .param input::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, rgba(var(--high-rgb), 0.35) var(--p), rgba(var(--high-rgb), 0.1) var(--p));
  }
  .gate.off .param input::-moz-range-progress {
    background: rgba(var(--high-rgb), 0.35);
  }
  .gate.off .param input::-webkit-slider-thumb {
    border-color: var(--muted);
    box-shadow: none;
  }
  .gate.off .param input::-moz-range-thumb {
    border-color: var(--muted);
    box-shadow: none;
  }
  .param input:disabled {
    cursor: default;
  }
  .gbnf {
    grid-column: 1 / -1;
    resize: vertical;
    width: 100%;
    border-color: var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.6);
    font-family: var(--font-mono);
    font-size: var(--fs-small);
  }
</style>
