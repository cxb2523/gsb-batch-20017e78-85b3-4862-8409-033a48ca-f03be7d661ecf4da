import {
    isItemCollection,
    type ItemCollectionChange,
    type ItemKey,
    type ReadonlyItemCollection,
} from "./ItemCollection";
import type { SpatialIndex, SpatialIndexToken, SpatialItem } from "./SpatialIndex";

/**
 * Keeps a {@link SpatialIndex} mirrored against a live
 * {@link ReadonlyItemCollection}.
 *
 * Registration loads every collection item once, in collection order, and
 * subscribes to its changes. Each delivered notification then applies inside
 * one synchronous callback:
 *
 * - `insert` appends a new indexed occurrence (after all existing ones);
 * - `update` replaces that occurrence's bounding box in place, keeping its
 *   registration order;
 * - `remove` deletes exactly that occurrence, so subsequent viewport queries
 *   return the collection's current dense order without stale or repeated
 *   entries.
 *
 * The collection object itself is the registration key. Re-attaching the same
 * collection returns the same syncer and keeps a single subscription;
 * {@link dispose} releases it exactly once. Ordinary arrays are not supported
 * here - use {@link SpatialIndex.fromArray} / `load` for the full-rebuild path.
 */
export class SpatialIndexSyncer<T extends SpatialItem> {
    /** One live syncer per collection object; keyed by the collection itself. */
    private static registry = new WeakMap<ReadonlyItemCollection<SpatialItem>, SpatialIndexSyncer<SpatialItem>>();

    /**
     * Mirror `collection` into `index` and keep them in sync until
     * {@link dispose}. The index starts from the collection's current items in
     * order; it should be empty, because attaching always performs a full load.
     * Re-attaching the same collection returns its existing syncer without
     * touching the index passed on the second call.
     */
    static attach<T extends SpatialItem>(
        collection: ReadonlyItemCollection<T>,
        index: SpatialIndex<T>,
    ): SpatialIndexSyncer<T> {
        if (!isItemCollection(collection)) {
            throw new TypeError(
                "SpatialIndexSyncer.attach: expected an ItemCollection; ordinary arrays use SpatialIndex.load/fromArray.",
            );
        }
        const existing = SpatialIndexSyncer.registry.get(collection);
        if (existing) {
            return existing as SpatialIndexSyncer<T>;
        }
        const syncer = new SpatialIndexSyncer(collection, index);
        SpatialIndexSyncer.registry.set(collection, syncer);
        return syncer;
    }

    private readonly tokens = new Map<ItemKey, SpatialIndexToken<T>>();
    private unsubscribe: (() => void) | null;
    private deliveredNotifications = 0;

    private constructor(
        private readonly collection: ReadonlyItemCollection<T>,
        private readonly index: SpatialIndex<T>,
    ) {
        // Full load first, in collection order; bulk `load` also assigns the
        // registration order that every later query sorts by.
        const tokens = this.index.load(this.collection.items);
        this.collection.items.forEach((_, position) => {
            this.tokens.set(this.collection.keyAt(position)!, tokens[position]);
        });
        this.unsubscribe = this.collection.subscribe((changes) => {
            this.apply(changes);
        });
    }

    /** Number of subscription callbacks delivered and applied, one per notification. */
    getSyncCount(): number {
        return this.deliveredNotifications;
    }

    /** Whether {@link dispose} has released the subscription already. */
    get isDisposed(): boolean {
        return this.unsubscribe === null;
    }

    /**
     * Unsubscribe exactly once and forget every indexed token. The index
     * itself is not cleared: its last-synced contents stay queryable, but
     * later collection mutations never touch it. Re-attaching the collection
     * afterwards starts a fresh syncer and full load.
     */
    dispose(): void {
        if (this.unsubscribe === null) {
            return;
        }
        this.unsubscribe();
        this.unsubscribe = null;
        SpatialIndexSyncer.registry.delete(this.collection);
        this.tokens.clear();
    }

    private apply(changes: readonly ItemCollectionChange<T>[]): void {
        // One callback may carry a whole merged batch; the count tracks
        // callback executions, not individual changes.
        this.deliveredNotifications++;
        for (const change of changes) {
            switch (change.type) {
                case "insert":
                    this.tokens.set(change.key, this.index.insert(change.item));
                    break;
                case "update": {
                    const token = this.tokens.get(change.key);
                    if (token) {
                        // In-place replacement keeps the entry's order, so
                        // viewport results keep matching collection order.
                        this.index.update(token, change.item);
                    }
                    break;
                }
                case "remove": {
                    const token = this.tokens.get(change.key);
                    if (token) {
                        this.index.remove(token);
                        this.tokens.delete(change.key);
                    }
                    break;
                }
            }
        }
    }
}
