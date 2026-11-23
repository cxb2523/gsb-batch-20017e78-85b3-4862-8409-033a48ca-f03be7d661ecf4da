import { expect, test } from "vitest";
import { VTTCue } from "@react-av/vtt-core";

function cueAsHTML(text: string) {
    const cue = new VTTCue(0, 1, text);
    const container = document.createElement("div");
    container.append(cue.getCueAsHTML());
    return container;
}

test("a voice tag renders as a span whose title is the annotation", () => {
    const container = cueAsHTML("<v Bob>Hello</v>");
    const span = container.querySelector("span");

    expect(span?.getAttribute("title")).toBe("Bob");
    expect(span?.textContent).toBe("Hello");
});

test("nested voice tags render as nested spans", () => {
    const container = cueAsHTML("<v Bob>Hi <v Sue>there</v> again</v>");

    const outer = container.querySelector("span")!;
    const inner = outer.querySelector("span")!;
    expect(outer.getAttribute("title")).toBe("Bob");
    expect(inner.getAttribute("title")).toBe("Sue");
    expect(inner.textContent).toBe("there");
    expect(outer.textContent).toBe("Hi there again");
});

test("class, lang and ruby output is unchanged", () => {
    const container = cueAsHTML('<c.k>c</c><lang fr>l</lang><ruby>b<rt>r</rt></ruby>');

    expect(container.querySelector("span.k")?.textContent).toBe("c");
    expect(container.querySelector('span[lang="fr"]')?.textContent).toBe("l");
    expect(container.querySelector("ruby")?.textContent).toBe("br");
    expect(container.querySelector("rt")?.textContent).toBe("r");
});
