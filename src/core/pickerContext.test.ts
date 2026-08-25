import { describe, expect, it } from "vitest";
import { assignmentPickerContext, groupPickerContext, newGroupPickerContext } from "./pickerContext";

describe("picker context", () => {
  it("keeps the target group when a secondary host opens the controller picker", () => {
    expect(groupPickerContext("group-a")).toEqual({ groupId: "group-a", creatingGroup: false });
  });

  it("keeps both the group and unresolved tab for manual assignment", () => {
    expect(assignmentPickerContext("group-a", "tab-a")).toEqual({ groupId: "group-a", assigningTabId: "tab-a", creatingGroup: false });
  });

  it("marks a launcher request as creating a new group", () => {
    expect(newGroupPickerContext()).toEqual({ creatingGroup: true });
  });
});
