import type {
  PDTaskSchedule as CorePDTaskSchedule,
  PDTaskExecution as CorePDTaskExecution,
  PDTaskDelivery as CorePDTaskDelivery,
  PDTaskMeta as CorePDTaskMeta,
  PDTaskSpec as CorePDTaskSpec,
} from '@principles/core/runtime-v2';

export type PDTaskSchedule = CorePDTaskSchedule;
export type PDTaskExecution = CorePDTaskExecution;
export type PDTaskDelivery = CorePDTaskDelivery;
export type PDTaskMeta = CorePDTaskMeta;
export type PDTaskSpec = CorePDTaskSpec;

export {
  PDTaskScheduleSchema,
  PDTaskExecutionSchema,
  PDTaskDeliverySchema,
  PDTaskMetaSchema,
  PDTaskSpecSchema,
} from '@principles/core/runtime-v2';

export const BUILTIN_PD_TASKS: PDTaskSpec[] = [];

