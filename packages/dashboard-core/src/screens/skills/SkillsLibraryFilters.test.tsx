// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { initialInventoryFilter } from "./SkillsLibraryFilters";

afterEach(() => window.history.replaceState(null, "", "/"));

it.each(["active", "library", "draft", "archived", "all"])(
  "accepts the %s inventory state",
  (state) => {
    window.history.replaceState(null, "", `/?state=${state}`);
    expect(initialInventoryFilter()).toBe(state);
  },
);

it.each(["toString", "constructor", "__proto__", "missing", ""])(
  "rejects invalid inventory state %s",
  (state) => {
    window.history.replaceState(null, "", `/?state=${state}`);
    expect(initialInventoryFilter()).toBe("active");
  },
);
