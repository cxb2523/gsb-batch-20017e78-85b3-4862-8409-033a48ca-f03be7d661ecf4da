import { describe, expect, it } from "vitest";
import { ItemCollection, type ReadonlyItemCollection } from "../../src/modules/ItemCollection";
import { SpatialIndex, type SpatialItem } from "../../src/modules/SpatialIndex";
import { SpatialIndexSyncer } from "../../src/modules/SpatialIndexSyncer";

interface Place extends SpatialItem {
    id: string;
}

const makeCollection = (items: readonly Place[] = []) => new ItemCollection(items, { keyOf: (place) => place.id });

const WORLD = { minX: -10, minY: -10, maxX: 200, maxY: 200 };

/** A plain-array index is the reference implementation of the full-load path. */
const referenceQuery = (
    collection: ReadonlyItemCollection<Place>,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
) => SpatialIndex.fromArray(collection.items).query(minX, minY, maxX, maxY);

describe("SpatialIndexSyncer", () => {
    describe("initial load", () => {
        it("loads an empty collection and stays queryable through later inserts", () => {
            const collection = makeCollection();
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);

            expect(syncer.getSyncCount()).toBe(0);
            expect(index.query(WORLD.minX, WORLD.minY, WORLD.maxX, WORLD.maxY)).toEqual([]);

            collection.insert({ id: "a", x: 1, y: 1 });
            expect(syncer.getSyncCount()).toBe(1);
            expect(index.query(0, 0, 2, 2).map((place) => place.id)).toEqual(["a"]);
        });

        it("bulk-loads current items in collection order", () => {
            const items: Place[] = [
                { id: "a", x: 0, y: 0 },
                { id: "b", x: 5, y: 5 },
                { id: "c", x: 9, y: 9 },
            ];
            const collection = makeCollection(items);
            const index = new SpatialIndex<Place>();
            SpatialIndexSyncer.attach(collection, index);

            expect(index.query(-1, -1, 10, 10)).toEqual(items);
        });

        it("preserves registration order past the linear-scan threshold", () => {
            const items = Array.from({ length: 600 }, (_, i) => ({
                id: `p${i}`,
                x: (i * 13) % 97,
                y: (i * 7) % 89,
            }));
            const collection = makeCollection(items);
            const index = new SpatialIndex<Place>();
            SpatialIndexSyncer.attach(collection, index);

            expect(index.query(-1, -1, 97, 89).map((place) => place.id)).toEqual(items.map((place) => place.id));
        });
    });

    describe("incremental changes", () => {
        it("appends inserts after the loaded occurrences", () => {
            const collection = makeCollection([
                { id: "a", x: 0, y: 0 },
                { id: "b", x: 1, y: 1 },
            ]);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);

            collection.insert({ id: "c", x: 2, y: 2 });
            collection.insert({ id: "d", x: 3, y: 3 });

            expect(syncer.getSyncCount()).toBe(2);
            expect(index.query(-1, -1, 4, 4).map((place) => place.id)).toEqual(["a", "b", "c", "d"]);
        });

        it("replaces an item's bounding box in place without changing order", () => {
            const items = Array.from({ length: 600 }, (_, i) => ({
                id: `p${i}`,
                x: (i * 13) % 97,
                y: (i * 7) % 89,
            }));
            const collection = makeCollection(items);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);

            const moved = { id: "p300", x: 150, y: 150 };
            collection.update("p300", moved);

            expect(syncer.getSyncCount()).toBe(1);
            // Old partition no longer contains it, new partition does.
            expect(index.query(0, 0, 97, 89).map((place) => place.id)).not.toContain("p300");
            expect(index.query(149, 149, 151, 151)).toEqual([moved]);
            // Its registration position among the other 599 items is unchanged.
            expect(index.query(-1, -1, 200, 200)).toEqual(collection.items);
        });

        it("removes exactly one occurrence and drops its token", () => {
            const collection = makeCollection([
                { id: "a", x: 0, y: 0 },
                { id: "b", x: 1, y: 1 },
                { id: "x", x: 2, y: 2 },
            ]);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);
            collection.insert({ id: "y", x: 3, y: 3 });

            expect(collection.remove("b")).toBe(true);
            expect(syncer.getSyncCount()).toBe(2);
            expect(index.query(-1, -1, 4, 4).map((place) => place.id)).toEqual(["a", "x", "y"]);

            // A reinserted key gets a fresh token at the tail rather than reviving the old one.
            collection.insert({ id: "b", x: 5, y: 5 });
            expect(syncer.getSyncCount()).toBe(3);
            expect(index.query(-1, -1, 6, 6).map((place) => place.id)).toEqual(["a", "x", "y", "b"]);
        });
    });

    describe("batch merging", () => {
        it("applies all merged changes within a single callback and one count", () => {
            const collection = makeCollection([
                { id: "a", x: 0, y: 0 },
                { id: "b", x: 1, y: 1 },
                { id: "c", x: 2, y: 2 },
            ]);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);

            collection.batch(() => {
                collection.insert({ id: "d", x: 3, y: 3 });
                collection.update("a", { id: "a", x: 10, y: 10 });
                collection.remove("c");
                collection.batch(() => collection.insert({ id: "e", x: 4, y: 4 }));
            });

            expect(syncer.getSyncCount()).toBe(1);
            expect(index.query(-1, -1, 11, 11).map((place) => place.id)).toEqual(["a", "b", "d", "e"]);
            expect(index.query(9, 9, 11, 11).map((place) => place.id)).toEqual(["a"]);
        });

        it("does not count a batch that made no changes", () => {
            const collection = makeCollection([{ id: "a", x: 0, y: 0 }]);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);

            collection.batch(() => {
                expect(collection.remove("missing")).toBe(false);
            });

            expect(syncer.getSyncCount()).toBe(0);
        });

        it("keeps the index consistent through interleaved batches and single mutations", () => {
            const items = Array.from({ length: 600 }, (_, i) => ({
                id: `p${i}`,
                x: (i * 13) % 97,
                y: (i * 7) % 89,
            }));
            const collection = makeCollection(items);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);

            collection.batch(() => {
                collection.remove("p10");
                collection.remove("p20");
                collection.update("p30", { id: "p30", x: 90, y: 80 });
                collection.insert({ id: "p600", x: 50, y: 50 });
            });
            collection.remove("p0");
            collection.batch(() => {
                collection.update("p1", { id: "p1", x: 5, y: 5 });
                collection.insert({ id: "p601", x: 60, y: 60 });
            });

            expect(syncer.getSyncCount()).toBe(3);
            for (const [minX, minY, maxX, maxY] of [
                [-1, -1, 97, 89],
                [0, 0, 40, 40],
                [45, 45, 65, 65],
                [80, 70, 97, 89],
            ]) {
                const results = index.query(minX, minY, maxX, maxY);
                // No duplicates and exact current collection order.
                expect(new Set(results).size).toBe(results.length);
                expect(results).toEqual(referenceQuery(collection, minX, minY, maxX, maxY));
            }
        });
    });

    describe("ordering after removal", () => {
        it("compacts the index order when removals shift collection indices", () => {
            const items = Array.from({ length: 600 }, (_, i) => ({
                id: `p${i}`,
                x: (i * 13) % 97,
                y: (i * 7) % 89,
            }));
            const collection = makeCollection(items);
            const index = new SpatialIndex<Place>();
            SpatialIndexSyncer.attach(collection, index);

            collection.batch(() => {
                collection.remove("p0");
                collection.remove("p299");
                collection.remove("p599");
                collection.remove("p123");
            });
            collection.remove("p450");

            for (const [minX, minY, maxX, maxY] of [
                [-1, -1, 97, 89],
                [10, 10, 60, 60],
                [70, 0, 97, 50],
            ]) {
                const results = index.query(minX, minY, maxX, maxY);
                expect(new Set(results).size).toBe(results.length);
                expect(results).toEqual(referenceQuery(collection, minX, minY, maxX, maxY));
            }
            // Whole-range order equals the collection's current dense order.
            expect(index.query(-1, -1, 97, 89)).toEqual(collection.items);
        });

        it("answers with the latest items immediately, before any re-registration", () => {
            const collection = makeCollection([
                { id: "a", x: 0, y: 0 },
                { id: "b", x: 1, y: 1 },
                { id: "c", x: 2, y: 2 },
            ]);
            const index = new SpatialIndex<Place>();
            SpatialIndexSyncer.attach(collection, index);

            collection.remove("a");
            collection.update("b", { id: "b", x: 20, y: 20 });
            collection.insert({ id: "d", x: 3, y: 3 });

            expect(index.query(-1, -1, 25, 25)).toEqual([
                { id: "b", x: 20, y: 20 },
                { id: "c", x: 2, y: 2 },
                { id: "d", x: 3, y: 3 },
            ]);
        });
    });

    describe("registration keying and disposal", () => {
        it("returns the same syncer for a repeated registration with a single subscription", () => {
            const collection = makeCollection([{ id: "a", x: 0, y: 0 }]);
            const index = new SpatialIndex<Place>();
            const otherIndex = new SpatialIndex<Place>();

            const first = SpatialIndexSyncer.attach(collection, index);
            const second = SpatialIndexSyncer.attach(collection, otherIndex);
            expect(second).toBe(first);

            collection.insert({ id: "b", x: 1, y: 1 });

            // One subscription means one applied insert: no duplicate indexed occurrence.
            expect(first.getSyncCount()).toBe(1);
            expect(index.query(-1, -1, 2, 2).map((place) => place.id)).toEqual(["a", "b"]);
            // The index passed to the duplicate registration was never touched.
            expect(otherIndex.query(-1, -1, 2, 2)).toEqual([]);
        });

        it("syncs different collections independently", () => {
            const firstCollection = makeCollection([{ id: "a", x: 0, y: 0 }]);
            const secondCollection = makeCollection([{ id: "x", x: 0, y: 0 }]);
            const firstIndex = new SpatialIndex<Place>();
            const secondIndex = new SpatialIndex<Place>();

            const firstSyncer = SpatialIndexSyncer.attach(firstCollection, firstIndex);
            const secondSyncer = SpatialIndexSyncer.attach(secondCollection, secondIndex);
            expect(firstSyncer).not.toBe(secondSyncer);

            firstCollection.insert({ id: "b", x: 1, y: 1 });

            expect(firstSyncer.getSyncCount()).toBe(1);
            expect(secondSyncer.getSyncCount()).toBe(0);
            expect(firstIndex.query(-1, -1, 2, 2).map((place) => place.id)).toEqual(["a", "b"]);
            expect(secondIndex.query(-1, -1, 2, 2).map((place) => place.id)).toEqual(["x"]);
        });

        it("releases the subscription once and ignores every later collection change", () => {
            const collection = makeCollection([
                { id: "a", x: 0, y: 0 },
                { id: "b", x: 1, y: 1 },
            ]);
            const index = new SpatialIndex<Place>();
            const syncer = SpatialIndexSyncer.attach(collection, index);
            collection.insert({ id: "c", x: 2, y: 2 });

            expect(syncer.isDisposed).toBe(false);
            syncer.dispose();
            expect(syncer.isDisposed).toBe(true);
            syncer.dispose(); // Idempotent: no throw, no second unsubscribe.

            const snapshot = index.query(-1, -1, 10, 10);
            const frozenCount = syncer.getSyncCount();
            collection.insert({ id: "d", x: 3, y: 3 });
            collection.update("a", { id: "a", x: 99, y: 99 });
            collection.remove("b");

            expect(syncer.getSyncCount()).toBe(frozenCount);
            expect(index.query(-1, -1, 10, 10)).toEqual(snapshot);
            expect(index.query(98, 98, 100, 100)).toEqual([]);
        });

        it("allows a fresh registration after disposal on a new index", () => {
            const collection = makeCollection([{ id: "a", x: 0, y: 0 }]);
            const oldIndex = new SpatialIndex<Place>();
            const oldSyncer = SpatialIndexSyncer.attach(collection, oldIndex);
            oldSyncer.dispose();

            const newIndex = new SpatialIndex<Place>();
            const newSyncer = SpatialIndexSyncer.attach(collection, newIndex);
            expect(newSyncer).not.toBe(oldSyncer);
            expect(newSyncer.isDisposed).toBe(false);

            collection.insert({ id: "b", x: 1, y: 1 });
            expect(newSyncer.getSyncCount()).toBe(1);
            expect(newIndex.query(-1, -1, 2, 2).map((place) => place.id)).toEqual(["a", "b"]);
            // The released index keeps its last-synced contents and is not touched.
            expect(oldIndex.query(-1, -1, 2, 2).map((place) => place.id)).toEqual(["a"]);
        });

        it("rejects ordinary arrays; they keep the full-rebuild path", () => {
            const index = new SpatialIndex<Place>();
            expect(() =>
                SpatialIndexSyncer.attach([{ id: "a", x: 0, y: 0 }] as unknown as ReadonlyItemCollection<Place>, index),
            ).toThrow("ItemCollection");
            expect(index.query(-1, -1, 1, 1)).toEqual([]);
        });
    });
});
