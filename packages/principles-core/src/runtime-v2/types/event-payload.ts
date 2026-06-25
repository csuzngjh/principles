/**
 * Discriminated union for EventLogEntry — replaces flat data: Record<string, unknown>.
 * Each union member is keyed on the `type` field for type narrowing.
 */

import { Type, type Static } from '@sinclair/typebox';
import type {
  ToolCallEventData,
  PainSignalEventData,
  RulePromotionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  GateBypassEventData,
  PlanApprovalEventData,
  EvolutionTaskEventData,
  EmpathyRollbackEventData,
  EventCategory,
} from './event-types.js';
import { EventCategorySchema } from './event-types.js';

export type EventLogEntry =
  | { ts: string; date: string; type: 'tool_call'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: ToolCallEventData }
  | { ts: string; date: string; type: 'pain_signal'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: PainSignalEventData }
  | { ts: string; date: string; type: 'rule_promotion'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: RulePromotionEventData }
  | { ts: string; date: string; type: 'hook_execution'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: HookExecutionEventData }
  | { ts: string; date: string; type: 'gate_block'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: GateBlockEventData }
  | { ts: string; date: string; type: 'gate_bypass'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: GateBypassEventData }
  | { ts: string; date: string; type: 'plan_approval'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: PlanApprovalEventData }
  | { ts: string; date: string; type: 'evolution_task'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: EvolutionTaskEventData }
  | { ts: string; date: string; type: 'empathy_rollback'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: EmpathyRollbackEventData }
  | { ts: string; date: string; type: 'error'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: Record<string, unknown> }
  | { ts: string; date: string; type: 'warn'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: Record<string, unknown> };

// Type predicates for safe narrowing

export function isToolCallEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'tool_call' }> {
  return entry.type === 'tool_call';
}

export function isPainSignalEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'pain_signal' }> {
  return entry.type === 'pain_signal';
}

export function isRulePromotionEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'rule_promotion' }> {
  return entry.type === 'rule_promotion';
}

export function isHookExecutionEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'hook_execution' }> {
  return entry.type === 'hook_execution';
}

export function isGateBlockEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'gate_block' }> {
  return entry.type === 'gate_block';
}

export function isGateBypassEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'gate_bypass' }> {
  return entry.type === 'gate_bypass';
}

export function isPlanApprovalEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'plan_approval' }> {
  return entry.type === 'plan_approval';
}

export function isEvolutionTaskEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'evolution_task' }> {
  return entry.type === 'evolution_task';
}

export function isEmpathyRollbackEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'empathy_rollback' }> {
  return entry.type === 'empathy_rollback';
}

// TypeBox schema definitions
export const DiscriminatedEventLogEntrySchema = Type.Union([
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('tool_call'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('pain_signal'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('rule_promotion'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('hook_execution'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('gate_block'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('gate_bypass'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('plan_approval'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('evolution_task'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('empathy_rollback'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('error'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
  Type.Object({
    ts: Type.String(),
    date: Type.String(),
    type: Type.Literal('warn'),
    category: EventCategorySchema,
    sessionId: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
    data: Type.Record(Type.String(), Type.Any()),
  }),
]);
export type DiscriminatedEventLogEntryStatic = Static<typeof DiscriminatedEventLogEntrySchema>;
