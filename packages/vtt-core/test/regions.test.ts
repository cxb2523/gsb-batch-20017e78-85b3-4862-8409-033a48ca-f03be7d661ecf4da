import { describe, expect, it } from "vitest";
import { VTTParser } from "../src";

// Build a WebVTT file from the supplied lines. The signature is always present so the parser accepts it.
function parseVTT(lines: string[]) {
    return new VTTParser(["WEBVTT", ...lines].join("\n"));
}

function regionId(parser: VTTParser, cueIndex: number) {
    return parser.cues[cueIndex].region?.id ?? null;
}

describe("WebVTT region collection", () => {
    it("collects a REGION block that appears in the file header", () => {
        const parser = parseVTT([
            "REGION",
            "id:top width:40% lines:2",
            "",
            "00:00:00.000 --> 00:00:01.000 region:top",
            "hello",
        ]);

        expect(parser.regions).toHaveLength(1);
        expect(parser.regions[0]).toMatchObject({ id: "top", width: 40, lines: 2 });
        expect(parser.cues[0].region).toBe(parser.regions[0]);
    });

    it("collects a REGION block that appears in the body", () => {
        const parser = parseVTT([
            "",
            "REGION",
            "id:bottom width:25%",
            "",
            "00:00:00.000 --> 00:00:01.000 region:bottom",
            "hello",
        ]);

        expect(parser.regions).toHaveLength(1);
        expect(parser.regions[0]).toMatchObject({ id: "bottom", width: 25 });
        expect(parser.cues[0].region).toBe(parser.regions[0]);
    });

    it("collects header and body REGION blocks together", () => {
        const parser = parseVTT([
            "REGION",
            "id:header",
            "",
            "REGION",
            "id:body",
            "",
            "00:00:00.000 --> 00:00:01.000 region:header",
            "a",
            "",
            "00:00:00.000 --> 00:00:01.000 region:body",
            "b",
        ]);

        expect(parser.regions.map(region => region.id)).toEqual(["header", "body"]);
        expect(regionId(parser, 0)).toBe("header");
        expect(regionId(parser, 1)).toBe("body");
    });

    it("binds region: to the last region with a matching id", () => {
        const parser = parseVTT([
            "",
            "REGION",
            "id:dup lines:1",
            "",
            "REGION",
            "id:dup lines:4",
            "",
            "00:00:00.000 --> 00:00:01.000 region:dup",
            "x",
        ]);

        expect(parser.regions.map(region => region.lines)).toEqual([1, 4]);
        expect(parser.cues[0].region).toBe(parser.regions[1]);
        expect(parser.cues[0].region?.lines).toBe(4);
    });

    it("exposes collected regions on the text track", () => {
        const parser = parseVTT([
            "REGION",
            "id:header",
            "",
            "00:00:00.000 --> 00:00:01.000 region:header",
            "a",
        ]);

        const track = parser.textTrack("subtitles");
        expect(track._regions.map(region => region.id)).toEqual(["header"]);
        expect(track.cues).toHaveLength(1);
    });
});

describe("WebVTT cue region binding", () => {
    const regionBlock = ["", "REGION", "id:r", ""];

    it("keeps the region when only position or align are set", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r position:25%",
            "a",
            "",
            "00:00:00.000 --> 00:00:01.000 region:r align:start",
            "b",
        ]);

        expect(regionId(parser, 0)).toBe("r");
        expect(parser.cues[0].position).toBe(25);
        expect(regionId(parser, 1)).toBe("r");
    });

    it("drops the region when a line offset is set, whichever order the settings appear in", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r line:5",
            "a",
            "",
            "00:00:00.000 --> 00:00:01.000 line:5 region:r",
            "b",
        ]);

        expect(parser.cues[0].line).toBe(5);
        expect(parser.cues[1].line).toBe(5);
        expect(parser.cues[0].region).toBeNull();
        expect(parser.cues[1].region).toBeNull();
    });

    it("drops the region when the size is not 100%, whichever order the settings appear in", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r size:50%",
            "a",
            "",
            "00:00:00.000 --> 00:00:01.000 size:50% region:r",
            "b",
        ]);

        expect(parser.cues[0].size).toBe(50);
        expect(parser.cues[1].size).toBe(50);
        expect(parser.cues[0].region).toBeNull();
        expect(parser.cues[1].region).toBeNull();
    });

    it("keeps the region when the size is explicitly 100%", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r size:100%",
            "a",
        ]);

        expect(parser.cues[0].size).toBe(100);
        expect(regionId(parser, 0)).toBe("r");
    });

    it("drops the region when a vertical writing direction is set, whichever order the settings appear in", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r vertical:rl",
            "a",
            "",
            "00:00:00.000 --> 00:00:01.000 vertical:lr region:r",
            "b",
        ]);

        expect(parser.cues[0].vertical).toBe("rl");
        expect(parser.cues[1].vertical).toBe("lr");
        expect(parser.cues[0].region).toBeNull();
        expect(parser.cues[1].region).toBeNull();
    });

    it("keeps the region when an invalid vertical setting follows it", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r vertical:RL",
            "a",
        ]);

        expect(parser.cues[0].vertical).toBe("");
        expect(regionId(parser, 0)).toBe("r");
    });

    it("keeps the region when an unrelated setting follows it", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r align:end",
            "a",
        ]);

        expect(regionId(parser, 0)).toBe("r");
        expect(parser.cues[0].align).toBe("end");
    });

    it("does not disturb parsed line and position values when it drops the region", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:r line:5 position:25%",
            "a",
        ]);

        expect(parser.cues[0].line).toBe(5);
        expect(parser.cues[0].position).toBe(25);
        expect(parser.cues[0].region).toBeNull();
    });

    it("leaves the region unbound when the id is unknown", () => {
        const parser = parseVTT([
            ...regionBlock,
            "00:00:00.000 --> 00:00:01.000 region:missing",
            "a",
        ]);

        expect(parser.cues[0].region).toBeNull();
    });
});
