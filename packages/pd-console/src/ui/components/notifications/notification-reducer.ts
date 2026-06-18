export type NotificationCounts = {
  pendingCount: number;
  degradedCount: number;
};

export type NotificationDiff = {
  pendingIncreased: boolean;
  degradedIncreased: boolean;
};

export function diffNotificationCounts(
  current: NotificationCounts,
  previous: NotificationCounts | null,
): NotificationDiff {
  if (previous === null) {
    return { pendingIncreased: false, degradedIncreased: false };
  }
  return {
    pendingIncreased: current.pendingCount > previous.pendingCount,
    degradedIncreased: current.degradedCount > previous.degradedCount,
  };
}
