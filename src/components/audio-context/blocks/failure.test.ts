import { compileFailure, runtimeFailure } from "./failure";
import { describe, expect, it } from "vitest";

const program = { stop() { } };

describe('compile failure policy', () => {
  it('keeps the playing program when a new build fails', () => {
    // Причина видна на блоке, а звук не прерывается: старая программа остаётся
    expect(compileFailure('Expression: Unknown identifier', program)).toEqual({
      error: 'Expression: Unknown identifier',
      keep: program,
    });
  });

  it('falls back to live nodes when nothing plays yet', () => {
    expect(compileFailure('Oscillator is not compilable', null)).toEqual({
      error: 'Oscillator is not compilable',
      keep: null,
    });
  });

  it('drops a crashed program and returns to live nodes', () => {
    // Процессор умер: держать его нельзя — блок должен снова звучать своими нодами
    expect(runtimeFailure('Compiled block stopped with an error')).toEqual({
      error: 'Compiled block stopped with an error',
      keep: null,
    });
  });
});
