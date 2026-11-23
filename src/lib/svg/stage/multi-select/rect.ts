/*
 * https://github.com/alisaitteke/seatmap-canvas Copyright 2023 Ali Sait TEKE
 */


import {dom} from "@decorator/dom";
import SvgBase from "@svg/svg.base";
import MultiSelect from "../multi-select";

@dom({
    tag: "rect",
    class: "multi-select-rect",
    autoGenerate: false
})
export default class MultiSelectRect extends SvgBase {


    constructor(public parent: MultiSelect) {
        super(parent);
        this.attr("width", 0);
        this.attr("height", 0);

        this.attr("x", 0);
        this.attr("y", 0);

        this.attr("fill", "none");
        this.attr("stroke", "rgba(0,0,0,0.5)");
        this.attr("stroke-width", "3px");
        this.attr("stroke-dasharray", "4");
        this.attr("pointer-events", "none");
        this.attr("opacity", 0);
    }

    update() {

    }

    /**
     * Draw the selection rectangle for the given (already normalized) box.
     */
    public draw(x: number, y: number, width: number, height: number): this {
        if (!this.node) return this;
        this.node
            .attr("x", x)
            .attr("y", y)
            .attr("width", width)
            .attr("height", height)
            .attr("opacity", 1);
        return this;
    }

    /**
     * Remove the temporary rectangle from the screen without touching its
     * position state (the caller owns that).
     */
    public reset(): this {
        if (!this.node) return this;
        this.node
            .attr("x", 0)
            .attr("y", 0)
            .attr("width", 0)
            .attr("height", 0)
            .attr("opacity", 0);
        return this;
    }
}
