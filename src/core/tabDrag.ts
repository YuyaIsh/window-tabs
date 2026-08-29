/** A cancelled or successfully dropped tab must never be released from its group. */
export const shouldReleaseDraggedTab = (dropHandled: boolean, cancelled: boolean) => !dropHandled && !cancelled;
