<script module lang="ts">
  import type { HfFiles, HfRepo } from '../models/hf';

  type Phase = 'idle' | 'busy' | 'done' | 'error';

  // The Hugging Face view outlives the panel: closing it and opening it
  // again keeps the search, the repo and the ticks.
  const hub = $state({
    query: '',
    phase: 'idle' as Phase,
    error: '',
    results: [] as HfRepo[],
    repo: null as string | null,
    filesPhase: 'idle' as Phase,
    filesError: '',
    files: null as HfFiles | null,
    ticks: [] as string[], // paths ticked to compare, in order: the first is A
  });
  let searchCtl: AbortController | null = null;
  let filesCtl: AbortController | null = null;
</script>

<script lang="ts">
  // Models panel (live only): choose A and B among the GGUFs of the engine's
  // folder, or download them from Hugging Face, and load them. Two tabs,
  // Local and Hugging Face, over a footer with the two slots, the VRAM
  // estimate, Load and the download queue. Rows of a different tokenizer
  // than A cannot be B. Loading and downloading are engine commands; the
  // search runs in the browser against the public hub API (models/hf.ts).
  import {
    cancelDownload,
    deleteModel,
    download,
    dropPending,
    fetchAndLoad,
    loadModels,
    requestCatalog,
  } from '../app';
  import {
    basename,
    compatible,
    ERROR_FAMILY,
    families,
    findFile,
    gb,
    progress,
    progressText,
    usable,
    vramFit,
    type Family,
  } from '../models/catalog';
  import { day, HfError, isAbort, repoFiles, repoUrl, searchRepos, shortCount } from '../models/hf';
  import { SUGGESTED, type RecentPair, type SuggestedPair } from '../models/suggested';
  import type { DownloadInfo, ModelFile } from '../source/messages';
  import { ui, type ModelsTab } from '../ui.svelte';
  import Icon from './Icon.svelte';

  const NO_GPU = { total: 0, available: 0 };

  const m = $derived(ui.models);
  const files = $derived(m?.files ?? []);
  const groups = $derived(families(files));
  const loaded = $derived(m?.loaded ?? { a: null, b: null });
  const busy = $derived((m?.loading ?? false) || ui.load?.state === 'loading');
  const canDownload = $derived(ui.connected && (m?.download ?? false));
  const pick = $derived(ui.pick);
  const fa = $derived(findFile(files, pick.a));
  const fb = $derived(findFile(files, pick.b));
  const fit = $derived(vramFit(files, pick.a, pick.b, m?.gpu ?? NO_GPU));
  const isLoadedPair = $derived(pick.a !== null && pick.a === loaded.a && pick.b === loaded.b);
  const canLoad = $derived(ui.connected && !busy && usable(fa) && ui.pending === null && !isLoadedPair);
  const recents = $derived(ui.recents.filter((r) => usable(findFile(files, r.a)) && (r.b === null || usable(findFile(files, r.b)))));

  let confirmDelete = $state<string | null>(null);

  const vramText = $derived.by(() => {
    if (!m || m.gpu.total <= 0) return 'unknown · no dedicated GPU';
    if (!pick.a) return `${gb(m.gpu.available)} available`;
    if (fit.state === 'over') return `${gb(fit.need)} needed · ${gb(fit.available)} available`;
    return `${gb(fit.need)} of ${gb(fit.available)}`;
  });

  const loadNote = $derived.by(() => {
    if (!ui.connected) return 'Not connected to the engine';
    if (isLoadedPair) return 'This pair is loaded';
    if (!pick.a) return 'Choose model A (B is optional)';
    if (!pick.b) return 'One model · add B to compare';
    return 'Two models · same tokenizer';
  });

  function familyMeta(g: Family): string {
    const parts = [g.arch, g.key === ERROR_FAMILY ? '' : `tokenizer ${g.key.slice(0, 8)}`];
    parts.push(`${g.files.length} ${g.files.length === 1 ? 'file' : 'files'}`);
    return parts.filter(Boolean).join(' · ');
  }

  function setTab(tab: ModelsTab): void {
    ui.modelsTab = tab;
  }

  // ------------------------------------------------------------ slots

  function choose(slot: 'A' | 'B', file: string): void {
    const { a, b } = ui.pick;
    if (slot === 'A') {
      if (a === file) {
        ui.pick = { a: null, b: null };
        return;
      }
      const next = findFile(files, file);
      ui.pick = { a: file, b: b !== file && compatible(next, findFile(files, b)) ? b : null };
    } else {
      ui.pick = { a, b: b === file ? null : file };
    }
  }

  function clearSlot(slot: 'A' | 'B'): void {
    ui.pick = slot === 'A' ? { a: null, b: null } : { a: ui.pick.a, b: null };
  }

  function swap(): void {
    const { a, b } = ui.pick;
    if (a && b) ui.pick = { a: b, b: a };
  }

  function load(): void {
    if (canLoad && pick.a) loadModels(pick.a, pick.b);
  }

  function queued(file: string): DownloadInfo | undefined {
    return ui.downloads.find((d) => d.file === file);
  }

  function nameOf(file: string): { name: string; quant: string } {
    const f = findFile(files, file);
    return f ? { name: f.name || f.file, quant: f.quant } : { name: file, quant: '' };
  }

  // ------------------------------------------------------------ pairs

  function pairState(p: SuggestedPair): { missing: number; bytes: number; loaded: boolean; waiting: boolean } {
    let missing = 0;
    let bytes = 0;
    [p.a, p.b].forEach((path, i) => {
      if (!findFile(files, basename(path))) {
        missing++;
        bytes += p.size[i];
      }
    });
    const a = basename(p.a);
    const b = basename(p.b);
    return {
      missing,
      bytes,
      loaded: loaded.a === a && loaded.b === b,
      waiting: ui.pending !== null && ui.pending.a === a && ui.pending.b === b,
    };
  }

  function recentLoaded(r: RecentPair): boolean {
    return loaded.a === r.a && loaded.b === r.b;
  }

  // ------------------------------------------------------ Hugging Face

  function hubError(e: unknown): string {
    return e instanceof HfError ? e.message : e instanceof Error ? e.message : String(e);
  }

  async function search(): Promise<void> {
    searchCtl?.abort();
    const ctl = (searchCtl = new AbortController());
    hub.phase = 'busy';
    hub.error = '';
    hub.repo = null;
    try {
      hub.results = await searchRepos(hub.query, { signal: ctl.signal });
      hub.phase = 'done';
    } catch (e) {
      if (isAbort(e)) return;
      hub.error = hubError(e);
      hub.phase = 'error';
    }
  }

  async function openRepo(repo: string): Promise<void> {
    filesCtl?.abort();
    const ctl = (filesCtl = new AbortController());
    hub.repo = repo;
    hub.files = null;
    hub.ticks = [];
    hub.filesPhase = 'busy';
    hub.filesError = '';
    try {
      hub.files = await repoFiles(repo, { signal: ctl.signal });
      hub.filesPhase = 'done';
    } catch (e) {
      if (isAbort(e)) return;
      hub.filesError = hubError(e);
      hub.filesPhase = 'error';
    }
  }

  function closeRepo(): void {
    filesCtl?.abort();
    hub.repo = null;
  }

  function tick(path: string): void {
    const i = hub.ticks.indexOf(path);
    if (i >= 0) hub.ticks = hub.ticks.filter((p) => p !== path);
    else hub.ticks = [...hub.ticks.slice(-1), path]; // two at most: the oldest goes
  }

  function inFolder(path: string): boolean {
    return findFile(files, basename(path)) !== undefined;
  }

  const ticksNeedDownload = $derived(hub.ticks.some((p) => !inFolder(p)));
  const canCompare = $derived(
    hub.repo !== null &&
      hub.ticks.length === 2 &&
      ui.connected &&
      !busy &&
      ui.pending === null &&
      (!ticksNeedDownload || canDownload),
  );

  function compare(): void {
    if (canCompare && hub.repo) fetchAndLoad(hub.repo, hub.ticks[0], hub.ticks[1]);
  }

  // Keys stay in the panel: typing must not reach the window shortcuts.
  // Escape closes it.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmDelete !== null) confirmDelete = null;
      else ui.modelsOpen = false;
    }
    e.stopPropagation();
  }
</script>

{#snippet fileRow(f: ModelFile)}
  {@const isA = pick.a === f.file}
  {@const isB = pick.b === f.file}
  {@const ok = usable(f)}
  {@const other = ok && fa !== undefined && !isA && !compatible(fa, f)}
  {@const slot = loaded.a === f.file ? 'A' : loaded.b === f.file ? 'B' : null}
  {@const busyFile = queued(f.file) !== undefined}
  <li class="row file" class:is-a={isA} class:is-b={isB} class:other class:broken={!ok}>
    <div class="info">
      <div class="line1">
        <span class="fname">{f.name || f.file}</span>
        {#if f.quant}<span class="quant">{f.quant}</span>{/if}
        {#if slot}<span class="tag lit" class:b={slot === 'B'}>loaded as {slot}</span>{/if}
      </div>
      <div class="line2">
        <span class="mono">{f.file}</span><span class="sep"></span>{gb(f.size)}{#if f.arch}<span class="sep"></span>{f.arch}{/if}{#if f.size_label}&nbsp;{f.size_label}{/if}
      </div>
      {#if f.error}
        <div class="why"><Icon name="warning" size={13} />Cannot read the header: {f.error}</div>
      {:else if other}
        <div class="why"><Icon name="unlink" size={13} />Different tokenizer from A</div>
      {/if}
    </div>
    <div class="acts">
      {#if confirmDelete === f.file}
        <span class="ask">Delete the file?</span>
        <button
          class="danger"
          onclick={() => {
            deleteModel(f.file);
            confirmDelete = null;
          }}>Delete</button
        >
        <button class="ghost" onclick={() => (confirmDelete = null)}>Cancel</button>
      {:else}
        {#if ok}
          <button
            class="pickbtn"
            class:on={isA}
            aria-pressed={isA}
            aria-label="Use {f.file} as A"
            onclick={() => choose('A', f.file)}
            data-tip={isA ? 'Clear A' : 'Use as model A'}>A</button
          >
          <button
            class="pickbtn b"
            class:on={isB}
            disabled={!fa || other || isA}
            aria-pressed={isB}
            aria-label="Use {f.file} as B"
            onclick={() => choose('B', f.file)}
            data-tip={!fa ? 'Choose A first' : other ? 'Different tokenizer from A' : isB ? 'Clear B' : 'Use as model B'}
            >B</button
          >
        {/if}
        <button
          class="ghost icon-only trash"
          disabled={slot !== null || busyFile || !ui.connected}
          aria-label="Delete {f.file}"
          data-tip={slot ? 'Loaded: cannot delete' : 'Delete from the folder'}
          data-tip-end
          onclick={() => (confirmDelete = f.file)}><Icon name="trash" size={15} /></button
        >
      {/if}
    </div>
  </li>
{/snippet}

{#snippet slotBox(slot: 'A' | 'B')}
  {@const file = slot === 'A' ? pick.a : pick.b}
  {@const f = slot === 'A' ? fa : fb}
  <div class="slot-box" class:b={slot === 'B'} class:empty={!file}>
    <span class="badge">{slot}</span>
    {#if file}
      <span class="s-text">
        <span class="s-name">{f ? f.name || f.file : file}</span>
        <span class="s-meta">{f ? `${f.quant} · ${gb(f.size)}` : 'after the download'}</span>
      </span>
      <button class="ghost icon-only clear" aria-label="Clear {slot}" data-tip="Clear {slot}" onclick={() => clearSlot(slot)}
        ><Icon name="close" size={13} /></button
      >
    {:else}
      <span class="s-text"><span class="s-empty">{slot === 'A' ? 'Choose a model' : 'Optional · same tokenizer'}</span></span>
    {/if}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="sheet glass" aria-label="Models" onkeydown={onKey}>
  <header class="head">
    <span class="mark"><Icon name="chip" size={18} /></span>
    <div class="titles">
      <h2 class="title">Models</h2>
      <p class="subtitle">
        {#if m}<Icon name="folder" size={13} /><span class="mono">{m.dir}</span> · {files.length}
          {files.length === 1 ? 'file' : 'files'}{:else}Waiting for the engine…{/if}
      </p>
    </div>
    <button
      class="ghost icon-only"
      onclick={requestCatalog}
      disabled={!ui.connected}
      aria-label="Re-read the folder"
      data-tip="Re-read the folder"
      data-tip-end><Icon name="reset" size={15} /></button
    >
    <button class="ghost icon-only" onclick={() => (ui.modelsOpen = false)} title="Close (Esc)" aria-label="Close"
      ><Icon name="close" size={16} /></button
    >
  </header>

  <div class="tabs" role="tablist" aria-label="Where from">
    <button class="tab" class:on={ui.modelsTab === 'local'} role="tab" aria-selected={ui.modelsTab === 'local'} onclick={() => setTab('local')}
      ><Icon name="folder" />Local</button
    >
    <button class="tab" class:on={ui.modelsTab === 'hub'} role="tab" aria-selected={ui.modelsTab === 'hub'} onclick={() => setTab('hub')}
      ><Icon name="cloud" />Hugging Face</button
    >
  </div>

  <div class="body">
    {#if ui.modelsTab === 'local'}
      <section>
        <h3>Suggested pairs</h3>
        <ul class="list">
          {#each SUGGESTED as p (p.title)}
            {@const st = pairState(p)}
            <li class="row pair">
              <div class="info">
                <div class="line1"><span class="fname">{p.title}</span><span class="pair-note">{p.note}</span></div>
                <div class="line2">
                  {#if st.loaded}
                    Loaded
                  {:else if st.waiting}
                    Loads when its downloads finish
                  {:else if st.missing === 0}
                    In the folder
                  {:else}
                    {st.missing === 2 ? 'Both files' : 'One file'} to download · {gb(st.bytes)}
                  {/if}
                  <span class="sep"></span><span class="mono">{p.repo}</span>
                </div>
              </div>
              <div class="acts">
                {#if st.loaded}
                  <span class="tag lit"><Icon name="check" size={12} />Loaded</span>
                {:else}
                  <button
                    disabled={!ui.connected || busy || ui.pending !== null || (st.missing > 0 && !canDownload)}
                    onclick={() => fetchAndLoad(p.repo, p.a, p.b)}
                    >{#if st.missing > 0}<Icon name="download" size={14} />Get & load{:else}Load{/if}</button
                  >
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>

      {#if recents.length}
        <section>
          <h3>Recent</h3>
          <ul class="list">
            {#each recents as r (`${r.a}|${r.b}`)}
              {@const na = nameOf(r.a)}
              {@const nb = r.b ? nameOf(r.b) : null}
              <li class="row pair">
                <div class="info">
                  <div class="line1 recent">
                    <span class="mini">A</span><span class="fname">{na.name}</span><span class="quant">{na.quant}</span>
                    {#if nb}
                      <span class="vs">vs</span><span class="mini b">B</span><span class="fname">{nb.name}</span><span class="quant b">{nb.quant}</span>
                    {/if}
                  </div>
                </div>
                <div class="acts">
                  {#if recentLoaded(r)}
                    <span class="tag lit"><Icon name="check" size={12} />Loaded</span>
                  {:else}
                    <button disabled={!ui.connected || busy || ui.pending !== null} onclick={() => loadModels(r.a, r.b)}>Load</button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <section>
        <h3>In the folder</h3>
        {#if !m}
          <p class="empty">Waiting for the engine’s list…</p>
        {:else if files.length === 0}
          <p class="empty">
            No GGUF files in <span class="mono">{m.dir}</span> yet. Get a suggested pair, or search Hugging Face.
          </p>
        {:else}
          {#each groups as g (g.key)}
            <div class="family">
              <div class="fam-head">
                <span class="fam-name">{g.label}</span>
                <span class="fam-meta">{familyMeta(g)}</span>
              </div>
              <ul class="list">
                {#each g.files as f (f.file)}
                  {@render fileRow(f)}
                {/each}
              </ul>
            </div>
          {/each}
        {/if}
      </section>
    {:else}
      <form
        class="search"
        onsubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label class="search-box">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Search GGUF models, e.g. qwen3.5" aria-label="Search Hugging Face" bind:value={hub.query} />
        </label>
        <button type="submit" disabled={hub.phase === 'busy'}>Search</button>
      </form>
      {#if m && !m.download}
        <p class="note"><Icon name="info" size={14} />This engine was built without downloads: you can browse, not download.</p>
      {/if}

      {#if hub.repo}
        <div class="repo-head">
          <button class="ghost back" onclick={closeRepo}><Icon name="arrowLeft" size={14} />Results</button>
          <span class="repo-id mono">{hub.repo}</span>
          <a
            class="button ghost icon-only"
            href={repoUrl(hub.repo)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open on Hugging Face"
            data-tip="Open on Hugging Face"
            data-tip-end><Icon name="external" size={14} /></a
          >
        </div>
        {#if hub.filesPhase === 'busy'}
          <p class="empty">Reading the repository…</p>
        {:else if hub.filesPhase === 'error'}
          <p class="empty err"><Icon name="warning" size={14} />{hub.filesError}</p>
          <button onclick={() => hub.repo && openRepo(hub.repo)}>Try again</button>
        {:else if hub.files}
          {#if hub.files.files.length === 0}
            <p class="empty">No single-file GGUF models in this repository.</p>
          {:else}
            <p class="hint">Tick two files to compare them: the first one is A.</p>
            <ul class="list">
              {#each hub.files.files as f (f.path)}
                {@const t = hub.ticks.indexOf(f.path)}
                {@const here = inFolder(f.path)}
                {@const q = queued(f.file)}
                <li class="row hub-file" class:is-a={t === 0} class:is-b={t === 1}>
                  <button
                    class="tick"
                    class:b={t === 1}
                    class:on={t >= 0}
                    aria-pressed={t >= 0}
                    aria-label="Pick {f.path} to compare"
                    onclick={() => tick(f.path)}
                    >{#if t === 0}A{:else if t === 1}B{/if}</button
                  >
                  <div class="info">
                    <div class="line1">
                      <span class="quant solo">{f.quant || 'GGUF'}</span><span class="fname mono">{f.file}</span>
                    </div>
                    <div class="line2">{gb(f.size)}{#if f.folder}<span class="sep"></span>in {f.folder}/{/if}</div>
                    {#if q}
                      {@const pr = progress(q)}
                      <div class="bar-row">
                        <span class="track"><span class="fill" style:width="{(pr ?? 0) * 100}%"></span></span>
                        <span class="figure">{progressText(q)}</span>
                      </div>
                    {/if}
                  </div>
                  <div class="acts">
                    {#if here}
                      <span class="tag"><Icon name="check" size={12} />In folder</span>
                    {:else if q}
                      <button class="ghost" onclick={() => hub.repo && cancelDownload(hub.repo, f.path)}>Cancel</button>
                    {:else}
                      <button disabled={!canDownload} onclick={() => hub.repo && download(hub.repo, f.path)}
                        ><Icon name="download" size={14} />Download</button
                      >
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
          {#if hub.files.split > 0}
            <p class="hint">
              {hub.files.split} split GGUF {hub.files.split === 1 ? 'part is' : 'parts are'} not listed: only single-file models can be loaded.
            </p>
          {/if}
        {/if}
      {:else if hub.phase === 'busy'}
        <p class="empty">Searching…</p>
      {:else if hub.phase === 'error'}
        <p class="empty err"><Icon name="warning" size={14} />{hub.error}</p>
      {:else if hub.phase === 'done' && hub.results.length === 0}
        <p class="empty">No GGUF repositories match “{hub.query}”.</p>
      {:else if hub.phase === 'done'}
        <ul class="list">
          {#each hub.results as r (r.id)}
            {@const cut = r.id.indexOf('/')}
            <li>
              <button class="row repo" aria-label="Open {r.id}" onclick={() => openRepo(r.id)}>
                <span class="info">
                  <span class="line1"><span class="owner mono">{r.id.slice(0, cut + 1)}</span><span class="fname mono">{r.id.slice(cut + 1)}</span></span>
                  <span class="line2">
                    {shortCount(r.downloads)} downloads<span class="sep"></span>{shortCount(r.likes)} likes{#if day(r.updated)}<span class="sep"
                      ></span>updated {day(r.updated)}{/if}
                  </span>
                </span>
                <Icon name="chevronRight" size={16} />
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">Search the GGUF repositories on Hugging Face, open one and download a file, or tick two to compare.</p>
      {/if}
    {/if}
  </div>

  <footer class="foot">
    {#if hub.repo && ui.modelsTab === 'hub'}
      <div class="compare-row">
        <span class="note-inline">
          {hub.ticks.length === 2 ? `${ticksNeedDownload ? 'Download, then load' : 'Load'} the two ticked files` : `Ticked ${hub.ticks.length} of 2`}
        </span>
        <button disabled={!canCompare} onclick={compare}
          ><Icon name="compare" size={14} />{ticksNeedDownload ? 'Download & compare' : 'Compare'}</button
        >
      </div>
    {/if}

    <div class="slots">
      {@render slotBox('A')}
      <button class="ghost icon-only swap" disabled={!pick.a || !pick.b} onclick={swap} aria-label="Swap A and B" data-tip="Swap A and B"
        ><Icon name="swap" size={15} /></button
      >
      {@render slotBox('B')}
    </div>

    <div class="vram" class:over={fit.state === 'over'} class:unknown={fit.state === 'unknown'}>
      <span class="v-label">VRAM</span>
      <span class="track"><span class="fill" style:width="{Math.min(1, fit.ratio) * 100}%"></span></span>
      <span class="figure">
        {#if fit.state === 'over'}<Icon name="warning" size={13} />{/if}{vramText}
      </span>
    </div>

    {#if ui.pending}
      <div class="status">
        <Icon name="download" size={14} /><span class="grow">Loads when the downloads finish</span>
        <button class="ghost" onclick={dropPending}>Don’t load</button>
      </div>
    {/if}
    {#if busy}
      <div class="status"><span class="dot"></span><span class="grow">Loading models…</span></div>
    {:else if ui.modelsError}
      <div class="status err"><Icon name="warning" size={14} /><span class="grow">{ui.modelsError}</span></div>
    {/if}

    <div class="load-row">
      <span class="note-inline">{loadNote}</span>
      <button class="primary load" disabled={!canLoad} onclick={load}>{busy ? 'Loading…' : 'Load'}</button>
    </div>

    {#if ui.downloads.length}
      <div class="queue">
        <h3>Downloads</h3>
        <ul>
          {#each ui.downloads as d (`${d.repo}/${d.path}`)}
            {@const pr = progress(d)}
            <li>
              <span class="q-name mono" title="{d.repo}/{d.path}">{d.file}</span>
              <span class="track"><span class="fill" class:queued={d.state === 'queued'} style:width="{(pr ?? 0) * 100}%"></span></span>
              <span class="figure">{progressText(d)}</span>
              <button class="ghost icon-only" aria-label="Cancel {d.file}" data-tip="Cancel" data-tip-end onclick={() => cancelDownload(d.repo, d.path)}
                ><Icon name="close" size={13} /></button
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </footer>
</aside>

<style>
  /* Slide-over on the right, under the bar, like Samplers but wider: a
     fixed head and tabs, a scrolling body and a fixed footer. */
  .sheet {
    position: fixed;
    top: calc(var(--bar-h, 56px) + 10px);
    right: 10px;
    bottom: 10px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    width: min(540px, calc(100vw - 20px));
    overflow: hidden;
    border-radius: 14px;
    box-shadow:
      var(--edge),
      -24px 0 60px rgba(0, 0, 0, 0.55),
      0 0 70px -30px rgba(var(--front-rgb), 0.45);
    font-size: var(--fs-label);
    font-feature-settings: 'cv11';
    animation: slide-in 240ms var(--ease);
  }
  @keyframes slide-in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-small);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 18px 10px;
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
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 3px 0 0;
    color: var(--muted);
  }
  .head > button {
    align-self: flex-start;
  }
  .tabs {
    padding: 0 12px 8px;
    border-bottom: 1px solid var(--hairline);
  }
  .tab {
    gap: 6px;
  }

  /* ------------------------------------------------------------- body */

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 18px 16px;
    scrollbar-color: var(--line-strong) transparent;
    scrollbar-width: thin;
  }
  section {
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: var(--fs-label);
    font-weight: 600;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .body > .list {
    margin-top: 12px;
  }
  .empty,
  .hint,
  .note {
    margin: 10px 0;
    color: var(--low);
    line-height: 1.5;
  }
  .note,
  .err {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
  }
  .err {
    color: var(--high);
  }
  .note {
    padding: 8px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.45);
  }

  /* A row: a card with the description on the left, actions on the right.
     Its slot colour lights the edge when chosen as A or B. */
  .row {
    --c-rgb: var(--a-rgb);
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 10px 9px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--surface-rgb), 0.55);
    box-shadow: var(--edge);
    text-align: left;
    transition:
      border-color 160ms var(--ease),
      background-color 160ms var(--ease),
      box-shadow 160ms var(--ease);
  }
  .row:hover {
    border-color: var(--line-strong);
  }
  .row.is-b {
    --c-rgb: var(--b-rgb);
  }
  .row.is-a,
  .row.is-b {
    border-color: rgba(var(--c-rgb), 0.55);
    background: linear-gradient(90deg, rgba(var(--c-rgb), 0.1), rgba(var(--surface-rgb), 0.55) 70%);
    box-shadow:
      var(--edge),
      0 0 18px -10px rgba(var(--c-rgb), 0.9);
  }
  /* Not selectable next to A, or not readable: dimmed by colour (no
     opacity layer over the frosted sheet). */
  .row.other .fname,
  .row.broken .fname,
  .row.other .quant,
  .row.broken .quant {
    color: var(--low);
  }
  .row.other .line2,
  .row.broken .line2 {
    color: var(--unlikely);
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .line1 {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 8px;
    min-width: 0;
  }
  .line2 {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    color: var(--low);
    font-size: var(--fs-small);
    font-variant-numeric: tabular-nums;
  }
  .line2 .mono {
    font-size: var(--fs-small);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep::before {
    content: '·';
    margin: 0 6px;
    color: var(--faint);
  }
  .fname {
    color: var(--high);
    font-size: var(--fs-body);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .fname.mono {
    font-size: var(--fs-label);
    font-weight: 400;
  }
  .quant {
    color: rgba(var(--a-rgb), 0.9);
    font-weight: 500;
  }
  .quant.b,
  .row.is-b .quant {
    color: rgba(var(--b-rgb), 0.9);
  }
  .quant.solo {
    min-width: 8ch;
    color: var(--high);
  }
  .row.is-a .quant.solo {
    color: var(--a);
  }
  .row.is-b .quant.solo {
    color: var(--b);
  }
  .pair-note {
    color: var(--muted);
  }
  .why {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .acts {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .acts button {
    min-height: 28px;
    padding: 3px 10px;
  }
  .ask {
    margin-right: 4px;
    color: var(--high);
  }
  /* Deleting: neutral but firm, as every warning (warnings never take a
     model's colour or the mismatch magenta). */
  button.danger:not(:disabled) {
    border-color: rgba(var(--high-rgb), 0.6);
    background: rgba(var(--high-rgb), 0.1);
    color: var(--high);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 9px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    background: rgba(var(--surface-3-rgb), 0.8);
    color: var(--muted);
    font-size: var(--fs-small);
    font-weight: 500;
    white-space: nowrap;
  }
  .tag.lit {
    border-color: rgba(var(--a-rgb), 0.45);
    background: rgba(var(--a-rgb), 0.1);
    color: var(--a);
  }
  .tag.lit.b {
    border-color: rgba(var(--b-rgb), 0.45);
    background: rgba(var(--b-rgb), 0.1);
    color: var(--b);
  }

  /* The A and B buttons of a row: small squares in their slot's colour. */
  .pickbtn,
  .tick {
    --c: var(--a);
    --c-rgb: var(--a-rgb);
    width: 28px;
    min-width: 28px;
    padding: 0 !important;
    font-weight: 600;
    color: var(--muted);
  }
  .pickbtn.b,
  .tick.b {
    --c: var(--b);
    --c-rgb: var(--b-rgb);
  }
  .pickbtn:hover:not(:disabled) {
    border-color: rgba(var(--c-rgb), 0.6);
    color: var(--c);
    box-shadow: 0 0 0 3px rgba(var(--c-rgb), 0.12);
  }
  .pickbtn.on,
  .tick.on {
    border-color: var(--c);
    background: var(--c);
    color: var(--bg);
    box-shadow: 0 0 12px rgba(var(--c-rgb), 0.6);
  }
  .pickbtn.on:hover:not(:disabled) {
    background: var(--c);
    color: var(--bg);
  }
  .trash {
    width: 28px;
    color: var(--low);
  }
  .tick {
    flex: none;
    height: 22px;
    min-height: 22px !important;
    width: 22px;
    min-width: 22px;
    border-radius: var(--radius-chip);
    background: rgba(var(--bg-rgb), 0.6);
    font-size: var(--fs-small);
  }
  .tick:not(.on):hover {
    border-color: rgba(var(--front-rgb), 0.6);
  }

  /* Families: a quiet heading over their rows. */
  .family + .family {
    margin-top: 14px;
  }
  .fam-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 2px 6px;
  }
  .fam-name {
    color: var(--high);
    font-size: var(--fs-body);
    font-weight: 600;
  }
  .fam-meta {
    color: var(--low);
    font-size: var(--fs-small);
  }

  .recent {
    align-items: center;
  }
  .mini {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: rgba(var(--a-rgb), 0.18);
    color: var(--a);
    font-size: 10px;
    font-weight: 600;
  }
  .mini.b {
    background: rgba(var(--b-rgb), 0.18);
    color: var(--b);
  }
  .vs {
    color: var(--low);
  }

  /* ------------------------------------------------------ Hugging Face */

  .search {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .search-box {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.55);
    color: var(--muted);
    transition:
      border-color 140ms var(--ease),
      box-shadow 140ms var(--ease);
  }
  .search-box:focus-within {
    border-color: rgba(var(--front-rgb), 0.7);
    box-shadow: 0 0 0 3px rgba(var(--front-rgb), 0.14);
  }
  .search-box input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 6px 0;
  }
  .search-box input:focus {
    box-shadow: none;
  }
  .repo {
    cursor: pointer;
    color: var(--low);
  }
  .repo:hover {
    background: rgba(var(--surface-3-rgb), 0.6);
    color: var(--high);
    box-shadow: var(--edge);
  }
  .owner {
    color: var(--muted);
    font-size: var(--fs-label);
    margin-right: -8px;
  }
  .repo-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 4px;
  }
  .back {
    padding-left: 6px;
  }
  .repo-id {
    flex: 1;
    min-width: 0;
    color: var(--high);
    font-size: var(--fs-label);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .button.icon-only {
    width: 30px;
    padding: 0;
  }
  .hub-file .info {
    gap: 2px;
  }

  /* Progress bars (downloads, VRAM): a thin track, filled in the colour in
     front. */
  .track {
    position: relative;
    flex: 1;
    height: 4px;
    min-width: 40px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(var(--high-rgb), 0.12);
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 2px;
    background: var(--front);
    box-shadow: 0 0 8px rgba(var(--front-rgb), 0.7);
    transition: width 240ms var(--ease);
  }
  .fill.queued {
    background: transparent;
    box-shadow: none;
  }
  .figure {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: var(--fs-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }

  /* ------------------------------------------------------------ footer */

  .foot {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 18px 16px;
    border-top: 1px solid var(--hairline);
    background: linear-gradient(180deg, rgba(var(--surface-rgb), 0.55), rgba(var(--bg-rgb), 0.55));
  }
  .compare-row,
  .load-row,
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .compare-row {
    padding-bottom: 10px;
    border-bottom: 1px solid var(--hairline);
  }
  .note-inline {
    flex: 1;
    min-width: 0;
    color: var(--low);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .slots {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .slot-box {
    --c: var(--a);
    --c-rgb: var(--a-rgb);
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 46px;
    padding: 0 4px 0 7px;
    border: 1px solid rgba(var(--c-rgb), 0.5);
    border-radius: 11px;
    background:
      linear-gradient(180deg, rgba(var(--c-rgb), 0.14), rgba(var(--c-rgb), 0.03)),
      rgba(var(--surface-rgb), 0.9);
    box-shadow:
      var(--edge),
      0 0 22px -8px rgba(var(--c-rgb), 0.6);
  }
  .slot-box.b {
    --c: var(--b);
    --c-rgb: var(--b-rgb);
  }
  .slot-box.empty {
    border-style: dashed;
    border-color: var(--line-strong);
    background: rgba(var(--bg-rgb), 0.4);
    box-shadow: none;
  }
  .badge {
    flex: none;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: var(--c);
    color: var(--bg);
    font-size: var(--fs-body);
    font-weight: 600;
    box-shadow: 0 0 12px rgba(var(--c-rgb), 0.6);
  }
  .empty .badge {
    border: 1px solid rgba(var(--c-rgb), 0.4);
    background: rgba(var(--c-rgb), 0.1);
    color: var(--c);
    box-shadow: none;
  }
  .s-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    line-height: 1.25;
  }
  .s-name {
    overflow: hidden;
    color: var(--high);
    font-size: var(--fs-body);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s-meta {
    color: rgba(var(--c-rgb), 0.9);
    font-size: var(--fs-small);
    white-space: nowrap;
  }
  .s-empty {
    color: var(--low);
  }
  .clear {
    width: 24px !important;
    min-height: 24px;
  }
  .swap {
    flex: none;
  }
  .vram {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .v-label {
    color: var(--muted);
    font-weight: 500;
  }
  /* Over the GPU: the bar goes full and white, with a warning sign. Warnings
     are neutral (no amber, no magenta). */
  .vram.over .fill {
    background: var(--high);
    box-shadow: 0 0 10px rgba(var(--high-rgb), 0.6);
  }
  .vram.over .figure {
    color: var(--high);
  }
  .vram.unknown .track {
    background: repeating-linear-gradient(90deg, rgba(var(--high-rgb), 0.12) 0 6px, transparent 6px 10px);
  }
  .status {
    padding: 8px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    background: rgba(var(--bg-rgb), 0.5);
    color: var(--muted);
  }
  .status.err {
    border-color: rgba(var(--high-rgb), 0.3);
    color: var(--high);
  }
  .status button {
    min-height: 24px;
    padding: 1px 9px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--front);
    box-shadow: 0 0 8px var(--front);
  }
  .load {
    min-width: 96px;
  }
  .queue h3 {
    margin-bottom: 6px;
  }
  .queue ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 120px;
    overflow-y: auto;
  }
  .queue li {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(60px, 1fr) auto auto;
    align-items: center;
    gap: 10px;
  }
  .q-name {
    overflow: hidden;
    color: var(--high);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .queue button {
    width: 24px !important;
    min-height: 24px;
  }
</style>
