<script lang="ts">
  // Help modal (key ?): how to read the screen, the legend, the keys and
  // the About sheet. Escape and ? close it (app.ts); so does the backdrop.
  import { date } from '../format';
  import { ui } from '../ui.svelte';
  import Icon from './Icon.svelte';

  const KEYS: [string[], string][] = [
    [['Space'], 'Run / pause'],
    [['→'], 'One step, or move the pinned selection'],
    [['←'], 'Move the pinned selection back'],
    [['Tab'], 'Switch the model in front'],
    [['M'], 'Switch mode: Same text / Each its own'],
    [['B'], "At a disagreement: follow B's pick from there"],
    [['Enter'], 'Resume here: generate from the viewed branch'],
    [['Esc'], 'Follow the model again, unpin'],
    [['F'], 'Relief 3D full screen'],
    [['L'], 'Models: choose, download and load'],
    [['?'], 'This help'],
  ];

  const models = $derived(ui.hello?.models ?? []);
  let closeEl: HTMLButtonElement;

  $effect(() => {
    closeEl?.focus();
  });

  function close(): void {
    ui.helpOpen = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="modal glass" role="dialog" aria-modal="true" aria-labelledby="help-title">
    <header>
      <span class="mark"><Icon name="help" size={18} /></span>
      <h1 id="help-title">How to read inside-llm</h1>
      <button class="ghost icon-only close" bind:this={closeEl} onclick={close} title="Close (Esc)" aria-label="Close"
        ><Icon name="close" size={16} /></button
      >
    </header>

    <div class="body">
      <section>
        <h2>How to read it</h2>
        <ul class="read">
          <li>
            <span class="glyph"><span class="grad-text">Aa</span></span>
            <span><b>Text brightness</b> is the probability the model gave each token: white is sure, grey is an unlikely pick.</span>
          </li>
          <li>
            <span class="glyph"><span class="dot a"></span><span class="dot b"></span></span>
            <span>
              Candidates shows <b>column A</b> (cyan) and <b>column B</b> (amber): the bars face each other, so the asymmetry
              is the difference between the models.
            </span>
          </li>
          <li>
            <span class="glyph dis-glyph"><span class="tri"></span></span>
            <span>
              In <b>Same text</b> mode both read one text; the right column shows what the other model would have picked.
              <span class="m">Magenta</span> marks where the picks differ.
            </span>
          </li>
          <li>
            <span class="glyph"><Icon name="pointer" size={16} /></span>
            <span><b>Hover</b> a token to inspect its candidates, <b>click</b> to pin it, click a candidate to <b>branch</b> with it.</span>
          </li>
          <li>
            <span class="glyph"><Icon name="activity" size={16} /></span>
            <span>
              <b>Timeline</b>: entropy and divergence per position, and the branches. <b>Relief 3D</b>: the candidates, or
              the logit lens layers, as a surface.
            </span>
          </li>
        </ul>
      </section>

      <div class="cols">
        <section>
          <h2>Legend</h2>
          <dl class="legend">
            <dt><span class="ramp"></span></dt>
            <dd class="with-icon">unlikely <Icon name="arrowRight" size={12} /> likely</dd>
            <dt><span class="dot a"></span></dt>
            <dd>A {models[0] ? `· ${models[0].name} ${models[0].quant}` : ''}</dd>
            <dt><span class="dot b"></span></dt>
            <dd>B {models[1] ? `· ${models[1].name} ${models[1].quant}` : '(second model, if loaded)'}</dd>
            <dt><span class="tri"></span></dt>
            <dd>A and B picked differently</dd>
            <dt><span class="prompt">abc</span></dt>
            <dd>prompt tokens (no decision)</dd>
          </dl>
        </section>

        <section>
          <h2>Keys</h2>
          <dl class="keys">
            {#each KEYS as [keys, what] (what)}
              <dt>
                {#each keys as k (k)}
                  {#if k === '→'}
                    <kbd class="arrow"><Icon name="arrowRight" size={12} /><span class="sr">Right arrow</span></kbd>
                  {:else if k === '←'}
                    <kbd class="arrow"><Icon name="arrowLeft" size={12} /><span class="sr">Left arrow</span></kbd>
                  {:else}
                    <kbd>{k}</kbd>
                  {/if}
                {/each}
              </dt>
              <dd>{what}</dd>
            {/each}
          </dl>
        </section>
      </div>

      <section>
        <h2>About</h2>
        <dl class="about">
          <dt>app</dt>
          <dd>{ui.hello?.app ?? '–'}</dd>
          <dt>llama.cpp</dt>
          <dd>{ui.hello?.llama_cpp ?? '–'}</dd>
          <dt>session</dt>
          <dd>{ui.hello ? date(ui.hello.created) : '–'}</dd>
          <dt>protocol</dt>
          <dd>{ui.hello?.protocol ?? '–'}</dd>
        </dl>
      </section>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    padding: var(--gutter);
    background: rgba(var(--bg-rgb), 0.62);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    animation: fade 160ms var(--ease);
  }
  .modal {
    display: flex;
    flex-direction: column;
    width: min(780px, 100%);
    max-height: min(86vh, 900px);
    overflow: hidden;
    font-feature-settings: 'cv11';
    animation: rise 240ms var(--ease);
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 20px 16px 22px;
    border-bottom: 1px solid var(--hairline);
    background: linear-gradient(180deg, rgba(var(--front-rgb), 0.06), transparent);
  }
  .mark {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid rgba(var(--front-rgb), 0.4);
    border-radius: 10px;
    background: rgba(var(--front-rgb), 0.12);
    color: var(--front);
    box-shadow: 0 0 18px -6px rgba(var(--front-rgb), 0.8);
  }
  h1 {
    flex: 1;
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .body {
    overflow-y: auto;
    padding: 4px 22px 24px;
    scrollbar-color: var(--line-strong) transparent;
    scrollbar-width: thin;
  }
  section {
    margin-top: 20px;
  }
  h2 {
    margin: 0 0 12px;
    color: var(--high);
    font-size: var(--fs-body);
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .read {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: var(--muted);
    font-size: var(--fs-body);
    line-height: 1.55;
  }
  .read li {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .read b {
    color: var(--high);
    font-weight: 600;
  }
  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 26px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--surface-3-rgb), 0.7);
    box-shadow: var(--edge);
    color: var(--high);
  }
  .dis-glyph {
    border-color: rgba(var(--dis-rgb), 0.35);
    background: rgba(var(--dis-rgb), 0.1);
  }
  .grad-text {
    background: linear-gradient(90deg, var(--unlikely), var(--high));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-weight: 600;
  }
  .m {
    color: var(--dis);
  }
  /* The discrepancy mark: a small magenta triangle. */
  .tri {
    display: inline-block;
    width: 10px;
    height: 9px;
    background: var(--dis);
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
    filter: drop-shadow(0 0 4px rgba(var(--dis-rgb), 0.8));
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .dot.a {
    background: var(--a);
    box-shadow: 0 0 6px var(--a);
  }
  .dot.b {
    background: var(--b);
    box-shadow: 0 0 6px var(--b);
  }
  .ramp {
    display: inline-block;
    width: 44px;
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--unlikely), var(--high));
  }
  .prompt {
    color: var(--prompt);
    font-family: var(--font-mono);
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0 20px;
    align-items: start;
  }
  .cols section {
    padding: 14px 16px 16px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.35);
  }
  .cols h2 {
    margin-bottom: 12px;
  }
  dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px 14px;
    margin: 0;
  }
  dt {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    color: var(--muted);
  }
  dd {
    margin: 0;
    color: var(--high);
  }
  .with-icon {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .with-icon :global(svg) {
    color: var(--muted);
  }
  .legend dt {
    justify-content: center;
    min-width: 44px;
  }
  .keys dd {
    color: var(--muted);
  }
  .keys kbd.arrow {
    display: inline-grid;
    place-items: center;
    height: 18px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .about {
    grid-template-columns: auto minmax(0, 1fr);
    padding: 12px 16px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.35);
  }
  .about dt {
    justify-content: flex-start;
  }
  .about dd {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
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
