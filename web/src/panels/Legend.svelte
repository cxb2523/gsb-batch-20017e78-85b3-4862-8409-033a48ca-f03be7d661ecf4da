<script lang="ts">
  // Footer legend: what brightness and the colours mean, and the main keys.
  import { ui } from '../ui.svelte';
  import Icon from './Icon.svelte';

  const models = $derived(ui.hello?.models ?? []);
</script>

<footer class="legend">
  <span class="item" title="Text brightness: the probability the model gave the token">
    <span class="lo">unlikely</span><span class="ramp"></span><span class="hi">likely</span>
  </span>
  {#each models as m (m.slot)}
    <span class="sep"></span>
    <span class="item model" class:b={m.slot === 'B'}>
      <span class="dot"></span><b>{m.slot}</b><span class="name">{m.name} {m.quant}</span>
    </span>
  {/each}
  {#if models.length > 1}
    <span class="sep"></span>
    <span class="item"><span class="tri"></span> A≠B pick</span>
  {/if}
  <span class="grow"></span>
  <span class="keys">
    <span><kbd>Space</kbd> run</span>
    <span><kbd class="arrow"><Icon name="arrowRight" size={12} /><span class="sr">Right arrow</span></kbd> step</span>
    {#if models.length > 1}<span><kbd>Tab</kbd> model</span>{/if}
    <span><kbd>?</kbd> help</span>
  </span>
</footer>

<style>
  .legend {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    min-height: 38px;
    padding: 6px var(--gutter);
    color: var(--muted);
    font-size: var(--fs-small);
    font-feature-settings: 'cv11';
  }
  .item {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: var(--hairline);
  }
  .ramp {
    width: 52px;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--unlikely), var(--high));
    box-shadow: 0 0 8px rgba(var(--high-rgb), 0.18);
  }
  .lo {
    color: var(--low);
  }
  .hi {
    color: var(--high);
  }
  .model {
    --c: var(--a);
  }
  .model.b {
    --c: var(--b);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 6px var(--c);
  }
  .model b {
    color: var(--c);
    font-weight: 600;
  }
  .name {
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The discrepancy mark: a small magenta triangle. */
  .tri {
    display: inline-block;
    width: 9px;
    height: 8px;
    background: var(--dis);
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
    filter: drop-shadow(0 0 3px rgba(var(--dis-rgb), 0.8));
  }
  .grow {
    flex: 1;
  }
  .keys {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 16px;
    color: var(--low);
  }
  .keys > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .keys kbd {
    color: var(--muted);
  }
  kbd.arrow {
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
</style>
