import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import type { IKPlayerOptions, SourceOptions } from '../../interfaces';
import { prepareSeekThumbnailVttSrc } from '../../utils';

const log = videojs.log.createLogger('videojs-seek-thumbnail');

/**
 * Cue parsed from WebVTT.
 */
type WebVTTCue = {
  startTime: number;
  endTime: number;
  settings: Record<string, string>;
  text: string;
};

type ThumbnailCue = { startTime: number; endTime: number; url: URL };

/** The subset of Video.js's progress control that we rely on. */
interface ProgressControlLike {
  on(event: string, handler: (e: MouseEvent) => void): void;
  off(event: string, handler: (e: MouseEvent) => void): void;
  el(): HTMLElement;
}

interface PlayerWithControlBar {
  controlBar?: {
    progressControl?: ProgressControlLike;
  };
}

/**
 * Per-player state that makes seek-thumbnail initialization safe across source switches.
 *
 * Every "load" gets a generation number. Starting a new load (or tearing the player's
 * thumbnails down) bumps the generation and aborts the in-flight fetch. A request is
 * only allowed to touch the DOM, register hover listeners, or publish itself as the
 * current manager while its generation is still the active one.
 */
interface SeekThumbnailSession {
  generation: number;
  current: SeekThumbnailsManager | null;
  currentSourceKey: string | null;
  pending: { sourceKey: string; promise: Promise<SeekThumbnailsManager | null> } | null;
  abort: AbortController | null;
}

const sessions = new WeakMap<Player, SeekThumbnailSession>();

function getSession(player: Player): SeekThumbnailSession {
  let session = sessions.get(player);
  if (!session) {
    session = {
      generation: 0,
      current: null,
      currentSourceKey: null,
      pending: null,
      abort: null,
    };
    sessions.set(player, session);
  }
  return session;
}

/** Identity of a source for the purpose of de-duplicating repeated initializations. */
function sourceKey(source: SourceOptions): string {
  return source.src;
}

/** Cancel any in-flight request for this player, whether or not it has produced a manager. */
function invalidatePendingRequest(session: SeekThumbnailSession): void {
  session.generation += 1;
  if (session.abort) {
    try {
      session.abort.abort();
    } catch {
      // Aborting is best-effort; the generation check below is the real guard.
    }
    session.abort = null;
  }
  session.pending = null;
}

function isRequestCurrent(
  session: SeekThumbnailSession,
  generation: number,
  abort: AbortController
): boolean {
  return session.generation === generation && !abort.signal.aborted;
}

/** Remove any thumbnail preview containers still in the player element. */
function removePreviewContainers(player: Player): void {
  const root = player.el();
  if (!root) return;
  root.querySelectorAll('.thumbnail-preview').forEach((el) => el.remove());
}

function getProgressControl(player: Player): ProgressControlLike | null {
  const candidate = player as unknown as PlayerWithControlBar;
  return candidate.controlBar?.progressControl ?? null;
}

export class SeekThumbnailsManager {
  private thumbnails_: ThumbnailCue[] = [];
  private container_: HTMLDivElement | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseLeaveHandler: (() => void) | null = null;
  private player_: Player | null = null;
  private attached_ = false;

  private constructor(player: Player, thumbnails: ThumbnailCue[]) {
    this.player_ = player;
    this.thumbnails_ = thumbnails;
  }

  /**
   * Build a manager for `source`: fetch the VTT, parse cues, create the container,
   * and attach hover handlers. A request that is superseded by another source (or
   * torn down) before it completes resolves to `null` and leaves no DOM/listeners
   * behind.
   */
  static async initSeekThumbnails(
    player: Player,
    source: SourceOptions,
    playerOptions: IKPlayerOptions
  ): Promise<SeekThumbnailsManager | null> {
    const session = getSession(player);
    const key = sourceKey(source);

    // Same source already active: reuse it instead of stacking another container/listener.
    if (
      session.current &&
      session.currentSourceKey === key &&
      session.current.isAttachedTo(player)
    ) {
      return session.current;
    }

    // Same source already loading: share the one request.
    if (session.pending && session.pending.sourceKey === key) {
      return session.pending.promise;
    }

    // A different source is taking over. Invalidate the old request first, then
    // release the previous source's container and listeners.
    invalidatePendingRequest(session);
    const previous = session.current;
    session.current = null;
    session.currentSourceKey = null;
    if (previous) {
      previous.destroy(player);
    }

    const generation = session.generation;
    const abort = new AbortController();
    session.abort = abort;

    const pending: {
      sourceKey: string;
      promise: Promise<SeekThumbnailsManager | null>;
    } = { sourceKey: key, promise: Promise.resolve(null) };

    const run = async (): Promise<SeekThumbnailsManager | null> => {
      try {
        // 1) Build the VTT URL (may hit a user-provided async signer).
        const manifestUrl = await prepareSeekThumbnailVttSrc(source, playerOptions);
        if (!isRequestCurrent(session, generation, abort)) return null;

        // 2) Fetch the VTT.
        log.debug('Fetching VTT →', manifestUrl);
        const resp = await fetch(manifestUrl, { signal: abort.signal });
        if (!isRequestCurrent(session, generation, abort)) return null;
        if (!resp.ok) {
          log.warn(`VTT fetch failed (${resp.status}); skipping seek thumbnails.`);
          return null;
        }
        const vttText = await resp.text();
        if (!isRequestCurrent(session, generation, abort)) return null;

        // 3) Parse cues. Failures here must not leave any DOM behind.
        const cues = parseWebVTT(vttText);
        if (!cues.length) {
          log.warn('No cues in VTT; skipping thumbnails.');
          return null;
        }

        // Cue text is normally absolute, but resolve relative sprite URLs against the VTT.
        const thumbnails: ThumbnailCue[] = [];
        for (const cue of cues) {
          try {
            thumbnails.push({
              startTime: cue.startTime,
              endTime: cue.endTime,
              url: new URL(cue.text, manifestUrl),
            });
          } catch {
            // A single malformed cue must not discard the rest of the track.
          }
        }
        if (!thumbnails.length) {
          log.warn('No usable thumbnail URLs in VTT; skipping thumbnails.');
          return null;
        }

        // 4) No `await` from here on: the staleness check and all side effects are atomic.
        const mgr = new SeekThumbnailsManager(player, thumbnails);

        if (!mgr.attach()) {
          // No control bar to bind to; don't leave a half-initialized container.
          mgr.destroy(player);
          return null;
        }

        session.current = mgr;
        session.currentSourceKey = key;
        log.debug('SeekThumbnailsManager initialized');
        return mgr;
      } catch (err) {
        if (abort.signal.aborted || !isRequestCurrent(session, generation, abort)) {
          // Expected: this request was superseded or torn down mid-flight.
          return null;
        }
        log.error('Error initializing seek thumbnails:', err);
        return null;
      } finally {
        if (session.pending === pending) {
          session.pending = null;
        }
        if (session.abort === abort) {
          session.abort = null;
        }
      }
    };

    pending.promise = run();
    session.pending = pending;
    return pending.promise;
  }

  /**
   * Tear down all seek-thumbnail state for a player: cancels any in-flight request,
   * removes the container, unbinds listeners, and drops the thumbnail data.
   */
  static destroyForPlayer(player: Player): void {
    const session = sessions.get(player);
    if (!session) {
      // Defensive: remove containers left by an older build/bug even without session state.
      removePreviewContainers(player);
      return;
    }

    invalidatePendingRequest(session);
    const previous = session.current;
    session.current = null;
    session.currentSourceKey = null;
    if (previous) {
      previous.destroy(player);
    }

    // Defensive sweep: guarantee no orphaned preview DOM survives teardown.
    removePreviewContainers(player);
  }

  /** True when this manager's container is still mounted in the player element. */
  public isAttachedTo(player: Player): boolean {
    if (!this.attached_ || !this.container_ || this.player_ !== player) return false;
    const root = player.el();
    return !!root && root.contains(this.container_);
  }

  /**
   * Create the container and bind hover handlers. Returns false when the player has
   * no progress control to bind to (nothing is left in the DOM in that case).
   */
  private attach(): boolean {
    const player = this.player_;
    if (!player) return false;

    const root = player.el();
    if (!root) return false;

    const progress = getProgressControl(player);
    if (!progress) {
      log.warn('Progress control unavailable; skipping seek thumbnails.');
      return false;
    }

    // Guarantee a single container per player even if a previous instance leaked.
    removePreviewContainers(player);

    const container = document.createElement('div');
    container.className = 'thumbnail-preview';
    root.appendChild(container);
    this.container_ = container;

    this.mouseMoveHandler = (e: MouseEvent) => onMouseMove(e, player, this);
    this.mouseLeaveHandler = () => {
      if (this.container_) this.container_.style.display = 'none';
    };

    progress.on('mousemove', this.mouseMoveHandler);
    progress.on('mouseleave', this.mouseLeaveHandler);
    this.attached_ = true;
    return true;
  }

  /**
   * Remove this manager's container and unbind only the handlers it attached.
   * Idempotent; safe to call more than once.
   */
  public destroy(player?: Player): void {
    const owningPlayer = player ?? this.player_ ?? null;

    const progress = owningPlayer ? getProgressControl(owningPlayer) : null;
    if (progress) {
      if (this.mouseMoveHandler) {
        progress.off('mousemove', this.mouseMoveHandler);
      }
      if (this.mouseLeaveHandler) {
        progress.off('mouseleave', this.mouseLeaveHandler);
      }
    }
    this.mouseMoveHandler = null;
    this.mouseLeaveHandler = null;

    if (this.container_) {
      this.container_.remove();
      this.container_ = null;
    }

    this.thumbnails_ = [];
    this.attached_ = false;
    this.player_ = null;
  }
}

/**
 * Extracts the thumbnail width from the VTT URL hash, or returns a default.
 * @param url The thumbnail URL.
 * @returns The width of the thumbnail frame.
 */
function getThumbnailWidthFromUrl(url: URL): number {
  const m = url.hash.match(/xywh=(\d+),(\d+),(\d+),(\d+)/);
  if (m && m[3]) {
    // The 'w' value from xywh=x,y,w,h
    return parseInt(m[3], 10);
  }
  // Default width if not specified in the URL hash
  return 160;
}

/**
 * Handle hover over the progress bar.
 * Renders the thumbnail and ensures it stays within the player bounds,
 * using the dynamic width from the VTT file.
 */
function onMouseMove(e: MouseEvent, player: Player, mgr: SeekThumbnailsManager) {
  if (!mgr['container_']) return;

  const playerEl = player.el();
  if (!playerEl) return;
  const playerRect = playerEl.getBoundingClientRect(); // Get player container position
  const playerWidth = (playerEl as HTMLElement).offsetWidth;
  const progress = getProgressControl(player);
  if (!progress) return;
  const barRect = progress.el().getBoundingClientRect();

  const pct = Math.max(0, Math.min(1, (e.clientX - barRect.left) / barRect.width));
  const time = pct * player.duration();

  const url = nearestThumbnail(mgr['thumbnails_'], time);
  if (!url) return;

  // 1. Get the DYNAMIC width for this specific thumbnail from its URL
  const thumbnailWidth = getThumbnailWidthFromUrl(url);
  const thumbnailHalfWidth = thumbnailWidth / 2;

  // 2. Calculate the hover position relative to the PLAYER container, not just progress bar
  // Account for progress bar's offset from player's left edge
  const progressBarLeftOffset = barRect.left - playerRect.left;
  const hoverPositionInPlayer = progressBarLeftOffset + pct * barRect.width;

  // 3. Clamp the position using the dynamic width so the thumbnail stays inside the player.
  // When the thumbnail is wider than the player it cannot fit, so centre it instead.
  const newLeft =
    thumbnailWidth >= playerWidth
      ? playerWidth / 2
      : Math.min(
          Math.max(hoverPositionInPlayer, thumbnailHalfWidth),
          playerWidth - thumbnailHalfWidth
        );

  // 4. Update the thumbnail element
  const container = mgr['container_']!;
  container.innerHTML = '';
  const thumbEl = createThumbnailElement(document, url);
  thumbEl.className = 'thumbnail';

  container.style.left = `${newLeft}px`;
  container.style.display = 'block';
  container.appendChild(thumbEl);
}

/** Find the cue whose startTime is closest to t */
function nearestThumbnail(list: ThumbnailCue[], t: number): URL | null {
  if (!list.length) return null;
  let best = list[0],
    bestDiff = Math.abs(best.startTime - t);
  for (const item of list) {
    const d = Math.abs(item.startTime - t);
    if (d < bestDiff) {
      best = item;
      bestDiff = d;
    }
  }
  return best.url;
}

/** Render one thumbnail DIV (reads sprite coords from URL.hash) */
function createThumbnailElement(doc: Document, url: URL): HTMLDivElement {
  const div = doc.createElement('div');
  Object.assign(div.style, {
    position: 'absolute',
    pointerEvents: 'none',
    backgroundImage: `url(${url.toString()})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: 'auto',
    transform: 'translateX(-50%) translateY(-100%)',
    backgroundPosition: 'center center',
    width: '160px',
    height: '90px',
    display: 'block',
  });

  const m = url.hash.match(/xywh=(\d+),(\d+),(\d+),(\d+)/);
  if (m) {
    const [, x, y, w, h] = m;
    div.style.width = `${w}px`;
    div.style.height = `${h}px`;
    div.style.backgroundPosition = `-${x}px -${y}px`;
    // Removed bottom style - translateY(-100%) already positions it correctly above container
  }
  return div;
}

/** Parse a WebVTT text blob into cue objects */
function parseWebVTT(input: string): WebVTTCue[] {
  const raw = input
    .replace(/\r\n|\r|\n/g, '\n')
    .replace(/\n\n+/g, '\n\n')
    .split('\n\n');
  const cueChunks = raw.filter((chunk) =>
    /\d{2}:\d{2}:\d{2}\.\d+ --> \d{2}:\d{2}:\d{2}\.\d+/.test(chunk)
  );
  return cueChunks.map(parseCue);
}

/** Parse one cue block */
function parseCue(chunk: string): WebVTTCue {
  const lines = chunk.split('\n');
  const idx = lines.findIndex((l) => / --> /.test(l));
  const [startRaw, endRaw] = lines[idx].split('-->').map((s) => s.trim());
  return {
    startTime: parseTimestamp(startRaw),
    endTime: parseTimestamp(endRaw),
    settings: {}, // unused for now
    text: lines.slice(idx + 1).join('\n'),
  };
}

/** Convert "hh:mm:ss.mmm" → seconds */
function parseTimestamp(ts: string): number {
  const [h, m, s] = ts.split(':');
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}
