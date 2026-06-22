import { describe, it, expect } from 'vitest';
import {
  validateEdge,
  isAcyclic,
  getAllowedSuccessors,
  getAllowedPredecessors,
  ALLOWED_EDGES,
} from '../internalization-job-graph.js';

describe('Internalization Job Graph (PRI-61)', () => {
  describe('ALLOWED_EDGES', () => {
    it('defines the expected v1 edges', () => {
      expect(ALLOWED_EDGES).toEqual([
        ['dreamer', 'philosopher'],
        ['philosopher', 'scribe'],
        ['scribe', 'artificer'],
        ['artificer', 'evaluator'],
        ['evaluator', 'rollout_reviewer'],
      ]);
    });
  });

  describe('validateEdge', () => {
    it('accepts allowed edges', () => {
      expect(validateEdge('dreamer', 'philosopher')).toBe(true);
      expect(validateEdge('philosopher', 'scribe')).toBe(true);
      expect(validateEdge('scribe', 'artificer')).toBe(true);
      expect(validateEdge('artificer', 'evaluator')).toBe(true);
      expect(validateEdge('evaluator', 'rollout_reviewer')).toBe(true);
    });

    it('rejects invalid edges (reverse direction)', () => {
      expect(validateEdge('philosopher', 'dreamer')).toBe(false);
      expect(validateEdge('artificer', 'philosopher')).toBe(false);
    });

    it('rejects edges skipping intermediate runners', () => {
      expect(validateEdge('dreamer', 'artificer')).toBe(false);
      expect(validateEdge('philosopher', 'evaluator')).toBe(false);
    });

    it('rejects same-kind edges (self-loop)', () => {
      expect(validateEdge('dreamer', 'dreamer')).toBe(false);
      expect(validateEdge('rollout_reviewer', 'rollout_reviewer')).toBe(false);
    });
  });

  describe('isAcyclic', () => {
    it('returns true for empty graph', () => {
      expect(isAcyclic([])).toBe(true);
    });

    it('returns true for single edge', () => {
      expect(isAcyclic([['a', 'b'] as const])).toBe(true);
    });

    it('returns true for valid DAG', () => {
      const edges = [
        ['dreamer', 'philosopher'] as const,
        ['philosopher', 'scribe'] as const,
        ['scribe', 'artificer'] as const,
      ];
      expect(isAcyclic(edges)).toBe(true);
    });

    it('returns false for simple cycle', () => {
      const edges = [
        ['a', 'b'] as const,
        ['b', 'a'] as const,
      ];
      expect(isAcyclic(edges)).toBe(false);
    });

    it('returns false for longer cycle', () => {
      const edges = [
        ['dreamer', 'philosopher'] as const,
        ['philosopher', 'scribe'] as const,
        ['scribe', 'dreamer'] as const,
      ];
      expect(isAcyclic(edges)).toBe(false);
    });

    it('returns true for DAG with multiple branches', () => {
      const edges = [
        ['a', 'b'] as const,
        ['a', 'c'] as const,
        ['b', 'd'] as const,
        ['c', 'd'] as const,
      ];
      expect(isAcyclic(edges)).toBe(true);
    });

    it('returns false for cycle in larger graph', () => {
      const edges = [
        ['dreamer', 'philosopher'] as const,
        ['philosopher', 'scribe'] as const,
        ['scribe', 'artificer'] as const,
        ['artificer', 'philosopher'] as const,
      ];
      expect(isAcyclic(edges)).toBe(false);
    });

    it('returns false for self-loop', () => {
      expect(isAcyclic([['a', 'a'] as const])).toBe(false);
    });

    it('returns true for disconnected DAG components', () => {
      const edges = [
        ['a', 'b'] as const,
        ['c', 'd'] as const,
      ];
      expect(isAcyclic(edges)).toBe(true);
    });

    it('returns false when one disconnected component has a cycle', () => {
      const edges = [
        ['a', 'b'] as const,
        ['c', 'd'] as const,
        ['d', 'c'] as const,
      ];
      expect(isAcyclic(edges)).toBe(false);
    });
  });

  describe('getAllowedSuccessors', () => {
    it('returns correct successor for dreamer', () => {
      expect(getAllowedSuccessors('dreamer')).toEqual(['philosopher']);
    });

    it('returns correct successor for philosopher', () => {
      expect(getAllowedSuccessors('philosopher')).toEqual(['scribe']);
    });

    it('returns correct successor for scribe', () => {
      expect(getAllowedSuccessors('scribe')).toEqual(['artificer']);
    });

    it('returns correct successor for artificer', () => {
      expect(getAllowedSuccessors('artificer')).toEqual(['evaluator']);
    });

    it('returns correct successor for evaluator', () => {
      expect(getAllowedSuccessors('evaluator')).toEqual(['rollout_reviewer']);
    });

    it('returns empty array for rollout_reviewer (terminal node)', () => {
      expect(getAllowedSuccessors('rollout_reviewer')).toEqual([]);
    });
  });

  describe('getAllowedPredecessors', () => {
    it('returns empty array for dreamer (source node)', () => {
      expect(getAllowedPredecessors('dreamer')).toEqual([]);
    });

    it('returns correct predecessor for philosopher', () => {
      expect(getAllowedPredecessors('philosopher')).toEqual(['dreamer']);
    });

    it('returns correct predecessor for scribe', () => {
      expect(getAllowedPredecessors('scribe')).toEqual(['philosopher']);
    });

    it('returns correct predecessor for artificer', () => {
      expect(getAllowedPredecessors('artificer')).toEqual(['scribe']);
    });

    it('returns correct predecessor for evaluator', () => {
      expect(getAllowedPredecessors('evaluator')).toEqual(['artificer']);
    });

    it('returns correct predecessor for rollout_reviewer', () => {
      expect(getAllowedPredecessors('rollout_reviewer')).toEqual(['evaluator']);
    });
  });
});
