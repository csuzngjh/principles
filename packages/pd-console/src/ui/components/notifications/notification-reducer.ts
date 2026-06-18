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
  previous: NotificationCounts,
): NotificationDiff {
  return {
    pendingIncreased: current.pendingCount > previous.pendingCount,
    degradedIncreased: current.degradedCount > previous.degradedCount,
  };
}
