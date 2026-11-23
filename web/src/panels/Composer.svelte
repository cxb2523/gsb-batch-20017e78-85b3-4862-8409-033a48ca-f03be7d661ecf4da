<script lang="ts">
  // Composer: a card over the stage with the prompt, its format, the system
  // message (chat), max tokens and example prompts. Start sends `start` and
  // then `run`. It can be closed only once a session exists.
  import { hasSession, startPrompt } from '../app';
  import { ui } from '../ui.svelte';
  import Icon from './Icon.svelte';

  const EXAMPLES = [
    'Explain in two sentences why the sky is blue.',
    'Write a haiku about quantization.',
    'Hola, ¿qué tal? Respóndeme en español.',
  ];

  const d = ui.draft;
  const maxDefault = $derived(ui.config?.max_tokens ?? 256);
  const models = $derived(ui.hello?.models ?? []);
  const closable = $derived(hasSession());
  let promptEl: HTMLTextAreaElement;

  function close(): void {
    if (closable) ui.promptOpen = false;
  }

  function useExample(text: string): void {
    d.prompt = text;
    promptEl?.focus();
  }

  // Keys stay in the composer: typing must not reach the window shortcuts.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      startPrompt();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else {
      return;
    }
    e.stopPropagation();
  }
</script>


<div class="scrim">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form
    class="composer glass"
    aria-label="New prompt"
    onkeydown={onKey}
    onsubmit={(e) => {
      e.preventDefault();
      startPrompt();
    }}
  >
    <header>
      <span class="mark"><Icon name="logo" size={22} /></span>
      <div class="titles">
        <h1>See inside any GGUF</h1>
        <p class="sub">Watch what the model weighs at every token. With two models, see exactly where they part ways.</p>
      </div>
      {#if closable}
        <button type="button" class="ghost icon-only close" onclick={close} title="Close (Esc)" aria-label="Close"
          ><Icon name="close" size={16} /></button
        >
      {/if}
    </header>

    {#if models.length}
      <div class="models">
        {#each models as m (m.slot)}
          <span class="chip" class:b={m.slot === 'B'}
            ><span class="slot">{m.slot}</span><span class="name">{m.name}</span>
            <span class="quant">{m.quant}</span></span
          >
        {/each}
      </div>
    {/if}

    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      class="prompt"
      rows="5"
      placeholder="Type a prompt…"
      aria-label="Prompt"
      bind:value={d.prompt}
      bind:this={promptEl}
      autofocus
    ></textarea>

    <div class="examples">
      <span class="label"><Icon name="sparkle" size={13} />Try</span>
      <div class="cards">
        {#each EXAMPLES as ex (ex)}
          <button type="button" class="example" onclick={() => useExample(ex)}>
            <span class="ex-text">{ex}</span>
            <span class="ex-go"><Icon name="arrowRight" size={14} /></span>
          </button>
        {/each}
      </div>
    </div>

    <div class="options">
      <span class="seg" role="group" aria-label="Format">
        <button
          type="button"
          class:on={d.format === 'chat'}
          onclick={() => (d.format = 'chat')}
          data-tip="Wrapped in the model's chat template">Chat</button
        >
        <button
          type="button"
          class:on={d.format === 'raw'}
          onclick={() => (d.format = 'raw')}
          data-tip="The text as is, no template">Raw</button
        >
      </span>
      <label class="field">
        Max tokens
        <input
          type="number"
          min="1"
          step="1"
          placeholder={String(maxDefault)}
          value={d.maxTokens > 0 ? d.maxTokens : ''}
          oninput={(e) => (d.maxTokens = Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))}
        />
      </label>
    </div>

    {#if d.format === 'chat'}
      <textarea class="system" rows="1" placeholder="System message (optional)" aria-label="System message" bind:value={d.system}
      ></textarea>
    {/if}

    <footer>
      <span class="hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to start{#if closable}&nbsp;· <kbd>Esc</kbd> to close{/if}</span>
      {#if !ui.connected}<span class="warn"><Icon name="warning" size={14} />Not connected to the engine</span>{/if}
      <span class="grow"></span>
      <button type="submit" class="primary start" disabled={!d.prompt.trim() || !ui.connected}
        ><Icon name="play" size={14} filled />Start</button
      >
    </footer>
  </form>
</div>

<style>
  /* Covers everything under the bar (stage and dock), so the card has the
     room it needs; scrolls when the window is short. */
  .scrim {
    position: fixed;
    top: var(--bar-h, 56px);
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 30;
    display: flex;
    padding: var(--gutter);
    overflow-y: auto;
    background:
      radial-gradient(60% 50% at 50% 45%, rgba(var(--front-rgb), 0.08), transparent 70%),
      rgba(var(--bg-rgb), 0.6);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    animation: fade 180ms var(--ease);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(680px, 100%);
    margin: auto; /* centred, yet reachable from the top when taller than the window */
    padding: 26px 28px 22px;
    font-feature-settings: 'cv11';
    box-shadow:
      var(--edge),
      var(--shadow),
      0 0 90px -30px rgba(var(--front-rgb), 0.55);
    animation: rise 240ms var(--ease);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }
  .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid rgba(var(--front-rgb), 0.4);
    border-radius: 12px;
    background: radial-gradient(circle at 50% 30%, rgba(var(--front-rgb), 0.3), rgba(var(--front-rgb), 0.06) 70%);
    color: var(--front);
    box-shadow:
      var(--edge),
      0 0 24px -6px rgba(var(--front-rgb), 0.8);
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--fs-figure);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .sub {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: var(--fs-body);
    line-height: 1.55;
  }
  .close {
    margin: -4px -6px 0 0;
  }
  .models {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    --c: var(--a);
    --c-rgb: var(--a-rgb);
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 11px 3px 3px;
    border: 1px solid rgba(var(--c-rgb), 0.35);
    border-radius: 999px;
    background: rgba(var(--c-rgb), 0.08);
    box-shadow: 0 0 16px -8px rgba(var(--c-rgb), 0.8);
    color: var(--high);
    font-size: var(--fs-small);
  }
  .chip.b {
    --c: var(--b);
    --c-rgb: var(--b-rgb);
  }
  .slot {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--c);
    color: var(--bg);
    font-weight: 600;
  }
  .name {
    font-weight: 500;
  }
  .quant {
    color: rgba(var(--c-rgb), 0.9);
  }
  textarea {
    width: 100%;
    resize: vertical;
    border-color: var(--hairline);
    border-radius: 10px;
    background: rgba(var(--bg-rgb), 0.6);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
    transition:
      border-color 140ms var(--ease),
      box-shadow 140ms var(--ease);
  }
  textarea:hover {
    border-color: var(--line-strong);
  }
  textarea:focus {
    box-shadow:
      inset 0 1px 3px rgba(0, 0, 0, 0.35),
      0 0 0 3px rgba(var(--front-rgb), 0.14),
      0 0 24px -8px rgba(var(--front-rgb), 0.5);
  }
  textarea::placeholder {
    color: var(--low);
  }
  .prompt {
    min-height: 120px;
    padding: 12px 14px;
    font-size: var(--fs-text);
    line-height: 1.55;
  }
  .system {
    font-size: var(--fs-body);
  }
  .examples {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: var(--fs-label);
    font-weight: 500;
  }
  .label :global(svg) {
    color: var(--front);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 8px;
  }
  /* An example prompt: a small card that lifts and lights up when hovered. */
  .example {
    position: relative;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    min-height: 64px;
    padding: 10px 12px;
    border-color: var(--hairline);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(var(--surface-3-rgb), 0.55), rgba(var(--surface-rgb), 0.55));
    box-shadow: var(--edge);
    color: var(--muted);
    font-size: var(--fs-label);
    font-weight: 400;
    line-height: 1.45;
    white-space: normal;
    text-align: left;
  }
  .example:hover:not(:disabled),
  .example:focus-visible {
    border-color: rgba(var(--front-rgb), 0.45);
    background: linear-gradient(180deg, rgba(var(--front-rgb), 0.12), rgba(var(--surface-rgb), 0.6));
    box-shadow:
      var(--edge),
      0 8px 22px -10px rgba(var(--front-rgb), 0.6);
    color: var(--high);
    transform: translateY(-2px);
  }
  .example:active:not(:disabled) {
    transform: translateY(0) scale(0.985);
  }
  .ex-go {
    flex: none;
    margin-top: 1px;
    color: var(--low);
    opacity: 0.6;
    transition:
      color 140ms var(--ease),
      opacity 140ms var(--ease),
      transform 140ms var(--ease);
  }
  .example:hover .ex-go,
  .example:focus-visible .ex-go {
    color: var(--front);
    opacity: 1;
    transform: translateX(2px);
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 18px;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .field input {
    width: 9ch;
    border-color: var(--hairline);
    background: rgba(var(--bg-rgb), 0.6);
    font-variant-numeric: tabular-nums;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 2px;
    padding-top: 16px;
    border-top: 1px solid var(--hairline);
  }
  .hint {
    color: var(--low);
    font-size: var(--fs-small);
  }
  .warn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--high);
    font-size: var(--fs-small);
  }
  .grow {
    flex: 1;
  }
  .start {
    min-width: 116px;
    min-height: 36px;
    gap: 8px;
    font-size: var(--fs-body);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.985);
    }
  }
</style>
