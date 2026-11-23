<script lang="ts">
  // Session gallery of the static build (no engine, no ?session=): one card
  // per entry of sessions/index.json, each opening its replay.
  import { onMount } from 'svelte';
  import { fileSize, loadIndex, sessionHref, type GalleryEntry } from '../gallery';
  import Icon from './Icon.svelte';

  let entries = $state.raw<GalleryEntry[] | null>(null);
  let error = $state('');

  onMount(() => {
    loadIndex()
      .then((list) => (entries = list))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)));
  });
</script>

<div class="gallery">
  <div class="sky" aria-hidden="true"></div>
  <header>
    <h1 class="logo">
      <span class="mark"><Icon name="logo" size={26} /></span>
      <span>inside-llm</span>
    </h1>
    <p class="lead">
      What a language model does while it writes: the candidates at each step, the gates that filter them, and where
      two models part ways. These are recorded sessions; they replay in the browser with nothing to install.
    </p>
  </header>

  <main>
    {#if error}
      <p class="state error" role="alert"><Icon name="warning" size={16} />Cannot load the session list: {error}</p>
    {:else if entries === null}
      <p class="state">Loading sessions…</p>
    {:else if entries.length === 0}
      <p class="state">No recorded sessions here.</p>
    {:else}
      <ul class="cards">
        {#each entries as e (e.file)}
          <li>
            <a class="card" class:two={e.models.length > 1} href={sessionHref(e)}>
              <span class="title">{e.title}</span>
              <span class="models">
                {#each e.models as m, i (i)}
                  <span class="model" class:b={i === 1}><span class="slot">{i === 0 ? 'A' : 'B'}</span>{m}</span>
                {/each}
              </span>
              <span class="desc">{e.description}</span>
              <span class="foot">
                <span class="open"><span class="play"><Icon name="play" size={12} filled /></span>Replay</span>
                {#if e.size !== undefined}<span class="size">{fileSize(e.size)}</span>{/if}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </main>
</div>

<style>
  .gallery {
    position: relative;
    isolation: isolate;
    height: 100%;
    overflow-y: auto;
    padding: 56px var(--gutter) 64px;
    font-feature-settings: 'cv11';
    scrollbar-color: var(--line-strong) transparent;
    scrollbar-width: thin;
  }
  /* The two model colours as faint halos behind the page. */
  .sky {
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
      radial-gradient(50vmax 40vmax at 8% -10%, rgba(var(--a-rgb), 0.16), transparent 70%),
      radial-gradient(50vmax 40vmax at 100% 110%, rgba(var(--b-rgb), 0.12), transparent 70%),
      radial-gradient(120% 80% at 50% -10%, rgba(var(--surface-3-rgb), 0.5), transparent 60%);
  }
  header,
  main {
    max-width: 1040px;
    margin: 0 auto;
  }
  header {
    animation: rise 320ms var(--ease);
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 0 0 14px;
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border: 1px solid rgba(var(--a-rgb), 0.4);
    border-radius: 14px;
    background: radial-gradient(circle at 50% 30%, rgba(var(--a-rgb), 0.3), rgba(var(--a-rgb), 0.06) 70%);
    color: var(--a);
    box-shadow:
      var(--edge),
      0 0 30px -6px rgba(var(--a-rgb), 0.8);
  }
  .mark :global(svg) {
    filter: drop-shadow(0 0 5px rgba(var(--a-rgb), 0.8));
  }
  .lead {
    max-width: 66ch;
    margin: 0 0 36px;
    color: var(--muted);
    font-size: var(--fs-text);
    line-height: 1.6;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 14px;
  }
  .error {
    padding: 12px 16px;
    border: 1px solid rgba(var(--high-rgb), 0.25);
    border-radius: var(--radius);
    background: rgba(var(--surface-2-rgb), 0.85);
    color: var(--high);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cards li {
    animation: rise 360ms var(--ease) backwards;
  }
  .cards li:nth-child(2) {
    animation-delay: 40ms;
  }
  .cards li:nth-child(3) {
    animation-delay: 80ms;
  }
  .cards li:nth-child(n + 4) {
    animation-delay: 120ms;
  }
  /* A card: translucent, lifts on hover with a glow in the colours of its
     models (cyan, and amber when there are two). */
  .card {
    --g1: var(--a-rgb);
    --g2: var(--a-rgb);
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    padding: 18px 18px 16px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: linear-gradient(180deg, rgba(var(--surface-2-rgb), 0.78), rgba(var(--surface-rgb), 0.82));
    box-shadow:
      var(--edge),
      var(--shadow-panel);
    color: var(--high);
    text-decoration: none;
    transition:
      border-color 200ms var(--ease),
      box-shadow 200ms var(--ease),
      transform 200ms var(--ease);
  }
  .card.two {
    --g2: var(--b-rgb);
  }
  .card::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background:
      radial-gradient(80% 60% at 0% 0%, rgba(var(--g1), 0.16), transparent 70%),
      radial-gradient(80% 60% at 100% 100%, rgba(var(--g2), 0.14), transparent 70%);
    opacity: 0;
    transition: opacity 220ms var(--ease);
  }
  .card:hover,
  .card:focus-visible {
    border-color: rgba(var(--high-rgb), 0.16);
    box-shadow:
      var(--edge),
      0 18px 40px -16px rgba(0, 0, 0, 0.7),
      -10px -8px 34px -18px rgba(var(--g1), 0.85),
      10px 10px 34px -18px rgba(var(--g2), 0.85);
    transform: translateY(-3px);
  }
  .card:hover::before,
  .card:focus-visible::before {
    opacity: 1;
  }
  .card:active {
    transform: translateY(-1px) scale(0.995);
  }
  .card:focus-visible {
    outline: 2px solid rgba(var(--high-rgb), 0.6);
    outline-offset: 2px;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .models {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .model {
    --c: var(--a);
    --c-rgb: var(--a-rgb);
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 2px 10px 2px 2px;
    border: 1px solid rgba(var(--c-rgb), 0.3);
    border-radius: 999px;
    background: rgba(var(--c-rgb), 0.07);
    font-size: var(--fs-small);
    font-weight: 500;
    white-space: nowrap;
  }
  .model.b {
    --c: var(--b);
    --c-rgb: var(--b-rgb);
  }
  .slot {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(var(--c-rgb), 0.2);
    color: var(--c);
    font-weight: 600;
    transition:
      background-color 200ms var(--ease),
      color 200ms var(--ease),
      box-shadow 200ms var(--ease);
  }
  .card:hover .slot,
  .card:focus-visible .slot {
    background: var(--c);
    color: var(--bg);
    box-shadow: 0 0 10px rgba(var(--c-rgb), 0.7);
  }
  .desc {
    flex: 1;
    color: var(--muted);
    font-size: var(--fs-body);
    line-height: 1.55;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--hairline);
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: var(--high);
    font-weight: 500;
  }
  .play {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding-left: 2px;
    border: 1px solid rgba(var(--high-rgb), 0.2);
    border-radius: 50%;
    background: rgba(var(--surface-3-rgb), 0.9);
    color: var(--high);
    transition:
      background-color 200ms var(--ease),
      color 200ms var(--ease),
      box-shadow 200ms var(--ease),
      transform 200ms var(--ease);
  }
  .card:hover .play,
  .card:focus-visible .play {
    background: var(--high);
    color: var(--bg);
    box-shadow: 0 0 18px rgba(var(--high-rgb), 0.35);
    transform: scale(1.08);
  }
  .size {
    color: var(--low);
    font-size: var(--fs-small);
    font-variant-numeric: tabular-nums;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }
</style>
