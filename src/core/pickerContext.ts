export type PickerContext = {
  groupId?: string;
  assigningTabId?: string;
  creatingGroup: boolean;
};

export const newGroupPickerContext = (): PickerContext => ({ creatingGroup: true });

export const groupPickerContext = (groupId: string): PickerContext => ({ groupId, creatingGroup: false });

export const assignmentPickerContext = (groupId: string, assigningTabId: string): PickerContext => ({ groupId, assigningTabId, creatingGroup: false });

export const closedPickerContext = (): PickerContext => ({ creatingGroup: false });
