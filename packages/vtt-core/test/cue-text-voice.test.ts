import { describe, expect, it } from "vitest";
import {
    WebVTTBold,
    WebVTTClass,
    WebVTTItalic,
    WebVTTLanguage,
    WebVTTParseCueText,
    WebVTTRuby,
    WebVTTRubyText,
    WebVTTText,
    WebVTTVoice,
} from "../src";

function children(node: unknown) {
    return (node as { children: unknown[] }).children;
}

describe("WebVTT cue text voice tags", () => {
    it("attaches a voice node to the current node and makes it current", () => {
        const tree = WebVTTParseCueText("<v Bob>Hello</v>");

        expect(children(tree)).toHaveLength(1);
        const voice = children(tree)[0];
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect((voice as WebVTTVoice).value).toBe("Bob");
        expect(children(voice)).toHaveLength(1);
        expect(children(voice)[0]).toBeInstanceOf(WebVTTText);
        expect((children(voice)[0] as WebVTTText).value).toBe("Hello");
    });

    it("uses an empty annotation when the voice tag has none", () => {
        const tree = WebVTTParseCueText("<v>Hello</v>");

        const voice = children(tree)[0] as WebVTTVoice;
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect(voice.value).toBe("");
    });

    it("nests voices and pops back to the parent on the end tag", () => {
        const tree = WebVTTParseCueText("<v Bob>Hi <v Sue>there</v> again</v>");

        expect(children(tree)).toHaveLength(1);
        const outer = children(tree)[0] as WebVTTVoice;
        expect(outer.value).toBe("Bob");

        // "Hi " text, nested voice, " again" text all live inside the outer voice.
        expect(children(outer)).toHaveLength(3);
        expect((children(outer)[0] as WebVTTText).value).toBe("Hi ");

        const inner = children(outer)[1] as WebVTTVoice;
        expect(inner).toBeInstanceOf(WebVTTVoice);
        expect(inner.value).toBe("Sue");
        expect((children(inner)[0] as WebVTTText).value).toBe("there");
        expect(inner.parent).toBe(outer);

        expect((children(outer)[2] as WebVTTText).value).toBe(" again");
    });

    it("returns to the parent so later text is a sibling, not a child", () => {
        const tree = WebVTTParseCueText("<v Bob>Hello</v> world");

        expect(children(tree)).toHaveLength(2);
        expect(children(tree)[0]).toBeInstanceOf(WebVTTVoice);
        expect((children(tree)[1] as WebVTTText).value).toBe(" world");
    });

    it("keeps voice class names and inherits the enclosing language", () => {
        const tree = WebVTTParseCueText('<lang en><v.first.second Bob>Hello</v></lang>');

        const language = children(tree)[0] as WebVTTLanguage;
        expect(language).toBeInstanceOf(WebVTTLanguage);
        const voice = children(language)[0] as WebVTTVoice;
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect(voice.classNames).toEqual(["first", "second"]);
        expect(voice.lang).toBe("en");
    });

    it("keeps voice inside other inline nodes", () => {
        const tree = WebVTTParseCueText("<b><v Bob>Hello</v></b>");

        const bold = children(tree)[0] as WebVTTBold;
        expect(bold).toBeInstanceOf(WebVTTBold);
        const voice = children(bold)[0] as WebVTTVoice;
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect(voice.value).toBe("Bob");
    });

    it("keeps existing class, lang and ruby parsing intact alongside voice", () => {
        const tree = WebVTTParseCueText('<c.k>class</c><lang fr>lang</lang><ruby>base<rt>rt</rt></ruby>');

        expect(children(tree)[0]).toBeInstanceOf(WebVTTClass);
        expect((children(tree)[0] as WebVTTClass).classNames).toEqual(["k"]);
        expect(children(tree)[1]).toBeInstanceOf(WebVTTLanguage);
        expect((children(tree)[1] as WebVTTLanguage).lang).toBe("fr");

        const ruby = children(tree)[2] as WebVTTRuby;
        expect(ruby).toBeInstanceOf(WebVTTRuby);
        expect(children(ruby)[0]).toBeInstanceOf(WebVTTText);
        expect(children(ruby)[1]).toBeInstanceOf(WebVTTRubyText);
        expect((children(ruby)[1] as WebVTTRubyText).classNames).toEqual([]);
    });

    it("treats an unclosed voice tag as spanning the rest of the text", () => {
        const tree = WebVTTParseCueText("<v Bob>Hi <i>there</i>");

        const voice = children(tree)[0] as WebVTTVoice;
        expect(voice).toBeInstanceOf(WebVTTVoice);
        expect(children(voice)[0]).toBeInstanceOf(WebVTTText);
        const italic = children(voice)[1] as WebVTTItalic;
        expect(italic).toBeInstanceOf(WebVTTItalic);
        expect((children(italic)[0] as WebVTTText).value).toBe("there");
    });
});
