"""Stage-level tests for removing and clearing playlist entries.

These drive the real ``MainWindow`` with a fake tile player (no libmpv, no
hardware decoding) and a fake prober, so the whole remove -> stop -> pool
chain and the asynchronous layout scheduling can be exercised deterministically.
"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QObject, QRect, Signal
from PySide6.QtWidgets import QApplication

from polyreel import app as app_mod
from polyreel.playlist import Item


# --------------------------------------------------------------------- fakes
class FakeTile(QObject):
    """Stand-in for VideoTile: records every playback command, no decoder."""

    double_clicked = Signal(object)
    right_clicked = Signal(object)
    finished = Signal(object)
    failed = Signal(object, str)
    shape_changed = Signal(object, float)

    _numbers = iter(range(1, 1 << 20))

    def __init__(self, parent=None, **_kwargs) -> None:
        super().__init__(parent)
        self.num = next(self._numbers)
        self.item = None
        self._paused = False
        self._muted = True
        self.volume_value = 100
        self.user_muted = False
        self.keep_sound = False
        self.zoom = 1.0
        self.visible = False
        self._rect = QRect(0, 0, 1, 1)
        self.loaded: list[Item] = []      # every item ever loaded
        self.stop_count = 0
        self.is_playing = False
        self.load_started = 0.0
        self._stops_sent = self._stops_done = 0

    # -- playback surface used by MainWindow --------------------------------
    def load(self, item, start: float = 0.0, loop: bool = False, hwdec=None) -> None:
        self.item = item
        self._paused = False
        self._muted = False
        self.is_playing = True
        self.load_started = 1.0
        self.loaded.append(item)
        self.show()

    def stop(self) -> None:
        self.stop_count += 1
        self._stops_sent += 1
        self._stops_done = self._stops_sent
        self.item = None
        self.is_playing = False
        self.load_started = 0.0
        self.hide()

    def set_paused(self, paused: bool) -> None:
        self._paused = paused

    @property
    def paused(self) -> bool:
        return self._paused

    def set_muted(self, muted: bool) -> None:
        self._muted = muted

    @property
    def muted(self) -> bool:
        return self._muted

    def set_volume(self, volume: int) -> None:
        self.volume_value = max(0, min(100, volume))

    def set_zoom(self, zoom: float) -> None:
        self.zoom = zoom

    def move_to(self, rect, animate: bool = True) -> None:
        self._rect = QRect(rect)
        self.show()

    def geometry(self) -> QRect:
        return QRect(self._rect)

    def show(self) -> None:
        self.visible = True

    def hide(self) -> None:
        self.visible = False

    def isVisible(self) -> bool:
        return self.visible

    def raise_(self) -> None:
        pass

    def position(self) -> float:
        return 0.0

    def duration(self) -> float:
        return float(self.item.duration or 0.0) if self.item else 0.0

    def poll(self) -> None:
        pass

    def sample(self):
        return None

    # the real tile only becomes "ready" after its starter thread runs; fakes
    # are immediately ready, and these are only used by the benchmark.
    @property
    def is_ready(self) -> bool:
        return True

    @property
    def is_stopped(self) -> bool:
        return self._stops_done >= self._stops_sent

    def retire(self) -> None:
        self.hide()

    def shutdown(self, wait: float = 2.0) -> None:
        self.item = None


class FakeProber(QObject):
    probed = Signal(int, object, object, object)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)

    def submit(self, item_id: int, path: str) -> None:
        # Pretend probing finished instantly with a generic 16:9 shape.
        self.probed.emit(item_id, 16 / 9, 10.0, None)

    def close(self) -> None:
        pass


# ------------------------------------------------------------------- fixtures
@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance() or QApplication([])
    app.setOrganizationName("PolyreelTest")
    app.setApplicationName("PolyreelTest")
    yield app


@pytest.fixture
def window(qapp, monkeypatch):
    # The window must build FakeTiles instead of real libmpv players.
    monkeypatch.setattr(app_mod, "VideoTile", FakeTile)
    win = app_mod.MainWindow([], tile_factory=lambda parent: FakeTile(parent),
                             prober=FakeProber())
    win.resize(1280, 760)
    win.settings.benchmark_asked = True   # skip the first-run benchmark flow
    win._bench_pending = False
    win._results_open = False
    yield win
    win.close()


def _item(path: str) -> Item:
    it = Item(path)
    it.aspect, it.duration, it.probed = 16 / 9, 10.0, True
    return it


def _add_items(win, n):
    items = win.pl.add([f"/v/{i}.mp4" for i in range(n)])
    for it in items:
        it.aspect, it.duration, it.probed = 16 / 9, 10.0, True
    # The first add would normally arm the first-run benchmark; tests drive
    # the wall directly, so keep that flow out of the way.
    win._bench_pending = False
    # Items are added already-probed, so nothing else will request a plan;
    # do it here, just like a real probe completion would.
    win.schedule_soon()
    return items


def _pump(qapp, ms=400):
    """Let queued Qt timers and the background plan thread run to completion."""
    # Process events in small slices so threaded plan results land and any
    # follow-up schedule_soon() timers fire too.
    import time
    end = time.monotonic() + ms / 1000.0
    while time.monotonic() < end:
        qapp.processEvents()
        # also spin any zero/timer due events a few times
        for _ in range(5):
            qapp.processEvents()
        time.sleep(0.01)


def _settle(win, qapp):
    """Run until no plan is in flight and no re-plan has been requested."""
    import time
    end = time.monotonic() + 3.0
    while time.monotonic() < end:
        _pump(qapp, 50)
        if not win._planning and not win._replan and not win._schedule_timer.isActive():
            # one more drain to catch trailing load timers
            _pump(qapp, 80)
            if not win._planning and not win._replan:
                return
    raise AssertionError("window did not settle: planning never finished")


# --------------------------------------------------------------------- tests
def test_remove_playing_item_stops_and_returns_tile(window, qapp):
    items = _add_items(window, 3)
    _settle(window, qapp)

    assert len(window.tiles) == 3
    target = items[1]
    tile = window.tiles[target.id]
    assert tile.item is target and tile.stop_count == 0

    window._remove_ids([target.id])
    _settle(window, qapp)

    # The tile was stopped, detached and returned to the pool ...
    assert tile in window.pool
    assert tile.item is None
    assert tile.stop_count >= 1
    assert tile.muted is True and tile.paused is True
    assert tile.keep_sound is False and tile.user_muted is False
    # ... it is gone from the stage and from every playlist.
    assert target.id not in window.tiles
    assert window.pl.find(target.id) is None
    assert [it.id for it in window.pl.playing] == [items[0].id, items[2].id]


def test_remove_queued_item_is_never_started(window, qapp):
    # Small cap so most of the items stay queued.
    window.settings.max_streams = 2
    items = _add_items(window, 5)
    _settle(window, qapp)

    playing_ids = {it.id for it in window.pl.playing}
    queued = [it for it in items if it.id not in playing_ids]
    assert len(queued) == 3
    victim = queued[0]

    window._remove_ids([victim.id])
    _settle(window, qapp)

    assert window.pl.find(victim.id) is None
    # No tile ever loaded the removed queued item.
    for t in window.all_tiles:
        assert victim not in t.loaded
        assert t.item is not victim
    # The remaining queued items still get their turn.
    assert all(window.pl.find(it.id) is not None for it in queued[1:])


def test_remove_pending_load_item_is_skipped(window, qapp, monkeypatch):
    """An item already placed in the to-load queue but not yet started must be
    skipped if it is removed before the load timer fires."""
    _add_items(window, 4)
    _settle(window, qapp)
    # Freeze the loader so newly placed items pile up in _to_load.
    monkeypatch.setattr(window, "_load_next", lambda: None)

    _add_items(window, 2)
    window.schedule_soon()
    _settle(window, qapp)
    assert window._to_load, "expected items waiting to start"

    victim = next(it for (_, it) in window._to_load)
    window._remove_ids([victim.id])

    # Restore the real loader and let it drain the queue.
    monkeypatch.undo()
    window._load_next()
    _settle(window, qapp)

    for t in window.all_tiles:
        assert victim not in t.loaded
    assert window.pl.find(victim.id) is None
    assert victim.id not in window.tiles
    # Everything else that remains still made it onto the stage.
    assert {it.id for it in window.pl.playing}.issubset(set(window.tiles) | {victim.id})


def test_remove_loading_item_stops_tile_and_drops_it_from_loading(window, qapp):
    """A tile that has started opening a removed video is stopped, pooled and
    removed from the opening list, so the loader never keeps tracking a tile
    that no longer belongs to the wall."""
    items = _add_items(window, 3)
    _settle(window, qapp)
    target = items[1]
    tile = window.tiles[target.id]
    # Simulate the tile being mid-load (file asked for, not yet playing).
    window._loading.append(tile)
    assert tile in window._loading

    window._remove_ids([target.id])
    _settle(window, qapp)

    assert tile not in window._loading
    assert tile in window.pool and tile.item is None
    assert tile.stop_count >= 1 and tile.muted is True and tile.paused is True
    assert window.pl.find(target.id) is None


def test_release_resets_everything_before_pooling(window, qapp):
    """The pool contract: a returned tile is stopped, muted, paused, detached
    and carries no per-item sound markers."""
    _add_items(window, 1)
    _settle(window, qapp)
    tile = next(iter(window.tiles.values()))
    tile.user_muted = False
    tile.keep_sound = True
    tile.set_volume(33)
    tile.set_paused(False)
    tile.set_muted(False)

    window._release(tile)

    assert tile in window.pool
    assert tile.item is None and tile.stop_count >= 1
    assert tile.muted is True and tile.paused is True
    assert tile.volume_value == 100
    assert tile.user_muted is False and tile.keep_sound is False


def test_clear_removes_every_tile_from_stage(window, qapp):
    _add_items(window, 4)
    _settle(window, qapp)
    assert len(window.tiles) == 4
    tiles = list(window.tiles.values())

    window._clear()
    _settle(window, qapp)

    assert window.tiles == {}
    assert len(window.pl) == 0
    assert window.pl.playing == [] and window.pl.queued == [] and window.pl.played == []
    # Every tile was stopped and pooled; none still holds an item.
    assert sorted(window.pool, key=id) == sorted(tiles, key=id)
    for t in tiles:
        assert t.item is None and t.stop_count >= 1
        assert t.muted is True and t.paused is True
    # No layout rect is left pointing at a tile on the empty stage.
    assert not window.layout_ or not window.layout_.rects


def test_stale_plan_result_is_discarded(window, qapp, monkeypatch):
    """A layout computed on a background thread from the pre-removal list must
    be dropped; the final layout matches the current (shorter) list."""
    items = _add_items(window, 4)
    _settle(window, qapp)
    original_plan = app_mod.plan

    class Blocked:
        def __init__(self):
            self.entered = False

    gate = Blocked()
    calls = []

    def slow_plan(*args, **kwargs):
        gate.entered = True
        # Simulate a layout computed against the list as it was at schedule
        # time, while the GUI removes an item before we return.
        import time
        time.sleep(0.15)
        p = original_plan(*args, **kwargs)
        calls.append(p)
        return p

    monkeypatch.setattr(app_mod, "plan", slow_plan)
    # Kick off a plan (it captures the 4-item list), then remove an item while
    # the worker thread is still inside plan().
    window.schedule_soon()
    import time as _time
    deadline = _time.monotonic() + 2.0
    while not window._planning and _time.monotonic() < deadline:
        _pump(qapp, 20)
    assert window._planning
    victim = items[3]
    window._remove_ids([victim.id])
    _settle(window, qapp)
    monkeypatch.undo()
    _settle(window, qapp)

    # The applied layout contains exactly the surviving playing items, no more.
    surviving = {it.id for it in window.pl.playing}
    assert victim.id not in surviving
    assert set(window.layout_.rects) == surviving
    assert set(window.tiles) == surviving
    # At least one background result had to be thrown away.
    assert calls, "expected a background plan to have run"


def test_remove_focused_item_exits_focus_and_restores_pause(window, qapp):
    items = _add_items(window, 3)
    _settle(window, qapp)
    focused_tile = window.tiles[items[0].id]
    others = [window.tiles[it.id] for it in items[1:]]
    window.enter_focus(focused_tile)
    assert window.focus_tile is focused_tile
    assert all(t.paused for t in others)

    window._remove_ids([items[0].id])
    _pump(qapp, 100)

    assert window.focus_tile is None
    assert all(not t.paused for t in others)      # pause state restored to paused_all=False
    assert focused_tile.item is None and focused_tile in window.pool


def test_reused_pool_tile_loads_with_clean_sound_state(window, qapp):
    # One video on the wall and nothing queued, so its tile must sit in the
    # pool after removal rather than being handed straight to a replacement.
    items = _add_items(window, 1)
    _settle(window, qapp)
    assert len(window.tiles) == 1
    first_tile = next(iter(window.tiles.values()))
    first_item = items[0]

    # Hand-adjust the first tile's sound, then remove it: the tile is pooled.
    first_tile.user_muted = False
    first_tile.keep_sound = True
    first_tile.set_volume(40)
    window._remove_ids([first_item.id])
    _settle(window, qapp)
    assert first_tile in window.pool
    # The release reset every per-item sound choice.
    assert first_tile.user_muted is False and first_tile.keep_sound is False
    assert first_tile.volume_value == 100 and first_tile.muted is True

    # A fresh item reuses the pooled tile and must load with a clean slate.
    new_items = _add_items(window, 1)
    _settle(window, qapp)

    assert first_tile.item is new_items[0]
    assert first_tile.volume_value == 100          # load() reset the volume
    assert first_tile.keep_sound is False
    # silent mode (the default) mutes the new item
    assert first_tile.user_muted is True
    assert first_tile.muted is True
    assert first_item not in first_tile.loaded[1:]


def test_remove_played_and_queued_keeps_wall_intact(window, qapp):
    items = _add_items(window, 3)
    _settle(window, qapp)
    # Finish one so it lands in Played.
    played_tile = window.tiles[items[0].id]
    window._tile_finished(played_tile)
    _settle(window, qapp)
    assert items[0] in window.pl.played
    queued_extra = _add_items(window, 1)[0]
    playing_before = list(window.pl.playing)

    window._remove_ids([items[0].id, queued_extra.id])
    _settle(window, qapp)

    assert window.pl.find(items[0].id) is None
    assert window.pl.find(queued_extra.id) is None
    assert [it.id for it in window.pl.playing] == [it.id for it in playing_before]
    assert set(window.tiles) == {it.id for it in window.pl.playing}
