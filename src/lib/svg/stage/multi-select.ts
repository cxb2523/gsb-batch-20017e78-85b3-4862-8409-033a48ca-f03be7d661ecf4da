/*
 * $project.fileName
 * https://github.com/alisaitteke/seatmap-canvas Copyright 2023 Ali Sait TEKE
 */

import {pointer as d3Pointer, select as d3Select} from 'd3-selection'

import SvgBase from "@svg//svg.base";
import Stage from "./stage.index";
import MultiSelectRect from "./multi-select/rect";
import {EventType} from "@enum/global";
import {SeatItem} from "./blocks/block-item/seat/seat-item.index";


import {dom} from "@decorator/dom";

declare const window: any;

export interface MultiSelectBox {
    x: number,
    y: number,
    width: number,
    height: number
}

@dom({
    tag: "g",
    class: "multi-select-tools",
    autoGenerate: false
})
export default class MultiSelect extends SvgBase {


    public rect: MultiSelectRect;
    public enable: boolean;
    public start: boolean;

    public points: any = {
        start: null,
        end: null
    };

    constructor(public parent: Stage) {
        super(parent);
        this.enable = false;
        this.start = false;

        this.global.eventManager.addEventListener(EventType.MULTI_SELECT_ENABLE, () => {
            this.enable = true;
            // Freeze any in-flight zoom transition: otherwise the stage keeps
            // moving under the pointer while the user drags.
            this.stopZoomAnimation();
            // Never leave a stale rectangle behind when the modifier is
            // pressed again.
            this.cancel();
        });

        this.global.eventManager.addEventListener(EventType.MULTI_SELECT_DISABLE, () => {
            this.enable = false;
            // Releasing the modifier mid-drag must clear the temporary
            // rectangle *and* the start/end points so a later mousedown
            // starts from a clean state.
            this.cancel();
        });

        return this;
    }

    update(): this {

        this.rect = new MultiSelectRect(this).addTo(this);
        this.updateChilds();

        return this;
    }

    afterGenerate() {

        const svgNode = this.parent.parent ? this.parent.parent.node : this.parent.node;

        // Selection starts anywhere on the canvas (empty space, block hulls,
        // seats, ...) because mousedown bubbles up to the SVG root. Pointer
        // coordinates are still resolved against the stage so they match the
        // seats' local coordinate system. Movement and release are tracked on
        // the window so a drag that leaves the canvas still finishes and
        // clears its state.
        svgNode.on("mousedown.multiselect", (event: any) => {
            if (!this.global.multi_select) return;
            // Only the primary button may start a selection.
            if (typeof event.button !== "undefined" && event.button !== 0) return;
            event?.preventDefault?.();

            let mouse = this.getPointer(event);
            this.begin(mouse);
        });

        // While multi-select is active, individual clicks must not toggle
        // seats or trigger the zoom-out background: the drag owns the
        // interaction. Capture phase guarantees nothing below runs.
        svgNode.on("click.multiselect", (event: any) => {
            if (!this.global.multi_select) return;
            event?.stopPropagation?.();
            event?.preventDefault?.();
        }, true);

        const win = d3Select(window);
        win.on("mousemove.multiselect", (event: any) => {
            if (!this.global.multi_select || !this.start) return;
            this.move(this.getPointer(event));
        });
        win.on("mouseup.multiselect", (event: any) => {
            if (!this.global.multi_select || !this.start) return;
            this.end(this.getPointer(event));
        });
    }

    /**
     * Convert an event into stage-local coordinates. This is the same
     * coordinate system seat `x`/`y` live in, and it already accounts for the
     * stage translate/scale transform.
     */
    private getPointer(event: any): [number, number] {
        return d3Pointer(event, this.parent.node.node());
    }

    public begin(point: [number, number]): this {
        // A running zoom transition would move the stage transform while the
        // user drags, which shifts the rectangle relative to the seats. Stop
        // any in-flight transition so the drag is measured against a stable
        // transform.
        this.stopZoomAnimation();
        this.start = true;
        this.points.start = [point[0], point[1]];
        this.points.end = [point[0], point[1]];
        if (this.rect && this.rect.node) {
            this.rect.draw(point[0], point[1], 0, 0);
        }
        return this;
    }

    /**
     * Interrupt the d3-zoom transition, which runs on the SVG root node (the
     * stage only receives the resulting transform attribute). Interrupting the
     * stage would leave the animation running.
     */
    private stopZoomAnimation(): this {
        const svgNode = this.parent.parent ? this.parent.parent.node : null;
        if (svgNode) {
            svgNode.interrupt();
        }
        if (this.parent.node) {
            this.parent.node.interrupt();
        }
        return this;
    }

    public move(point: [number, number]): this {
        if (!this.start || !this.points.start) return this;
        this.points.end = [point[0], point[1]];
        this.drawRect();
        return this;
    }

    public end(point: [number, number]): this {
        if (!this.start || !this.points.start) return this;
        this.points.end = [point[0], point[1]];

        const box = this.getBox();
        this.selectInBox(box);

        this.start = false;
        this.points.start = null;
        this.points.end = null;
        if (this.rect) {
            this.rect.reset();
        }
        return this;
    }

    /**
     * Abort the current selection without selecting anything.
     */
    public cancel(): this {
        this.start = false;
        this.points.start = null;
        this.points.end = null;
        if (this.rect) {
            this.rect.reset();
        }
        return this;
    }

    /**
     * Normalized selection rectangle: always anchored at the smaller of the
     * start / current coordinates, with absolute width and height. This makes
     * every drag direction (including up-left) render and select correctly.
     */
    public getBox(): MultiSelectBox {
        if (!this.points.start || !this.points.end) {
            return {x: 0, y: 0, width: 0, height: 0};
        }
        const startX = this.points.start[0];
        const startY = this.points.start[1];
        const endX = this.points.end[0];
        const endY = this.points.end[1];

        return {
            x: Math.min(startX, endX),
            y: Math.min(startY, endY),
            width: Math.abs(endX - startX),
            height: Math.abs(endY - startY)
        };
    }

    private drawRect(): this {
        if (!this.rect || !this.rect.node) return this;
        const box = this.getBox();
        this.rect.draw(box.x, box.y, box.width, box.height);
        return this;
    }

    /**
     * Select every salable seat whose center falls inside the box. Non-salable
     * seats are left untouched so they remain unselectable.
     */
    public selectInBox(box: MultiSelectBox): Array<SeatItem> {
        const selected: Array<SeatItem> = [];
        if (!(box.width > 0 || box.height > 0)) return selected;
        if (!this.parent.blocks) return selected;

        const minX = box.x;
        const maxX = box.x + box.width;
        const minY = box.y;
        const maxY = box.y + box.height;

        const blocks = this.parent.blocks.getBlocks();
        for (let bi = 0; bi < blocks.length; bi++) {
            const block = blocks[bi];
            if (!block.seats) continue;

            const seats = block.seats.getSeats() || [];
            for (let si = 0; si < seats.length; si++) {
                const seat: SeatItem = seats[si];
                if (!seat || !seat.item) continue;
                if (!seat.isSalable()) continue;

                const x = seat.item.x;
                const y = seat.item.y;
                if (x < minX || x > maxX || y < minY || y > maxY) continue;

                seat.select();
                selected.push(seat);
            }
        }

        return selected;
    }
}
