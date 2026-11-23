<script lang="ts">
  // Brief notices for the engine's error and warning events.
  import { ui } from '../ui.svelte';
  import Icon from './Icon.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as t (t.id)}
    <div class="toast glass {t.kind}">
      <span class="badge"><Icon name={t.kind === 'error' ? 'warning' : 'info'} size={15} /></span>
      <span class="text"><b>{t.kind}</b> {t.text}</span>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: var(--gutter);
    bottom: 50px; /* above the legend */
    z-index: 80;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(520px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 14px 10px 10px;
    font-size: var(--fs-label);
    line-height: 1.45;
    font-feature-settings: 'cv11';
    animation: toast-in 220ms var(--ease);
  }
  .badge {
    flex: none;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--surface-3-rgb), 0.9);
    color: var(--muted);
  }
  /* An error stands out in white; a warning stays quiet. */
  .error {
    border-color: rgba(var(--high-rgb), 0.28);
  }
  .error .badge {
    border-color: rgba(var(--high-rgb), 0.35);
    color: var(--high);
    box-shadow: 0 0 12px -2px rgba(var(--high-rgb), 0.35);
  }
  .text {
    padding-top: 3px;
    color: var(--high);
  }
  b {
    margin-right: 6px;
    color: var(--muted);
    font-weight: 600;
    text-transform: capitalize;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
</style>
