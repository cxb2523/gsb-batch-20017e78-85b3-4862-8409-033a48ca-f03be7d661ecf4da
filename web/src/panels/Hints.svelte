<script lang="ts">
  // First-visit tips: one at a time, at the foot of the Stream, once there is
  // generated text. Each goes away when the visitor does what it says (or
  // closes it) and never comes back: the ones seen are kept per browser.
  import { onMount } from 'svelte';
  import type { IconName } from '../render/icons';
  import { readPref, ui, writePref } from '../ui.svelte';
  import Icon from './Icon.svelte';

  interface Hint {
    id: string;
    icon: IconName;
    text: string;
    // What counts as having done it: an event type and the element it lands on.
    on: 'pointerover' | 'click' | 'pointerdown';
    target: string;
  }

  const live = $derived(ui.mode === 'live');
  const hints = $derived<Hint[]>([
    {
      id: 'hover',
      icon: 'pointer',
      text: 'Hover any word to see what the model was choosing between.',
      on: 'pointerover',
      target: '.stream [data-g]',
    },
    live
      ? {
          id: 'branch',
          icon: 'branch',
          text: 'Click a candidate on the right to rewrite the text from there.',
          on: 'click',
          target: '.cand canvas',
        }
      : {
          id: 'pin',
          icon: 'target',
          text: 'Click a word to pin it, then walk the text with the arrow keys.',
          on: 'click',
          target: '.stream [data-g]',
        },
    {
      id: 'relief',
      icon: 'cube',
      text: 'Open Relief 3D below and drag: the whole text as a landscape.',
      on: 'pointerdown',
      target: '.relief canvas',
    },
  ]);

  let seen = $state<string[]>((readPref('hints') ?? '').split(',').filter(Boolean));
  // A short pause between tips, and before the first one.
  let ready = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const current = $derived(ui.generated && ready ? (hints.find((h) => !seen.includes(h.id)) ?? null) : null);

  function rest(ms: number): void {
    ready = false;
    clearTimeout(timer);
    timer = setTimeout(() => (ready = true), ms);
  }

  function done(id: string): void {
    if (seen.includes(id)) return;
    seen = [...seen, id];
    writePref('hints', seen.join(','));
    rest(1600);
  }

  function skipAll(): void {
    seen = hints.map((h) => h.id);
    writePref('hints', seen.join(','));
  }

  onMount(() => {
    rest(1200);
    const types = ['pointerover', 'click', 'pointerdown'] as const;
    const onEvent = (e: Event): void => {
      const h = current;
      if (h && e.type === h.on && e.target instanceof Element && e.target.closest(h.target)) done(h.id);
    };
    for (const t of types) document.addEventListener(t, onEvent, true);
    return () => {
      clearTimeout(timer);
      for (const t of types) document.removeEventListener(t, onEvent, true);
    };
  });
</script>

{#if current}
  {#key current.id}
    <div class="hint glass" role="status">
      <span class="badge"><Icon name={current.icon} size={16} /></span>
      <span class="text">{current.text}</span>
      <button class="ghost" onclick={() => done(current.id)}>Got it</button>
      <button class="ghost icon-only" onclick={skipAll} aria-label="Hide all tips" title="Hide all tips"
        ><Icon name="close" size={14} /></button
      >
    </div>
  {/key}
{/if}

<style>
  .hint {
    position: absolute;
    left: calc(var(--gutter) + 20px);
    bottom: 18px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(560px, calc(100% - 2 * var(--gutter) - 40px));
    padding: 8px 8px 8px 10px;
    border-color: rgba(var(--front-rgb), 0.35);
    font-size: var(--fs-body);
    animation: hint-in 320ms var(--ease) both;
  }
  .badge {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(var(--front-rgb), 0.14);
    color: var(--front);
    box-shadow: 0 0 14px rgba(var(--front-rgb), 0.35);
  }
  .text {
    color: var(--high);
    line-height: 1.4;
  }
  .hint button {
    flex: none;
    min-height: 26px;
  }
  @keyframes hint-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
