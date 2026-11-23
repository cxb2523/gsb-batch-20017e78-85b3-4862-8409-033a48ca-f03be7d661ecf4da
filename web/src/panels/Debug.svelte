<script lang="ts">
  // ?debug: frame rate and the longest gap between two frames of the last
  // sample, frames received, nodes and connected browsers.
  import { ui } from '../ui.svelte';
</script>

<div class="debug glass">
  <span>fps</span><b>{ui.fps}</b>
  <span>max ms</span><b>{ui.maxFrameMs}</b>
  <span>frames</span><b>{ui.frames}</b>
  <span>nodes</span><b>{ui.nodes}</b>
  <span>clients</span><b>{ui.status?.clients ?? '–'}</b>
</div>

<style>
  .debug {
    position: fixed;
    /* One line at the bottom right, over the legend's key hints: it covers no data. */
    right: var(--gutter);
    bottom: 6px;
    z-index: 80;
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 5px 12px;
    border-radius: var(--radius-control);
    font-size: var(--fs-small);
    font-variant-numeric: tabular-nums;
  }
  span {
    color: var(--muted);
  }
  b {
    min-width: 3ch;
    margin-right: 8px;
    color: var(--high);
    font-weight: 500;
    text-align: right;
  }
</style>
