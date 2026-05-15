import { Type, type Static } from '@sinclair/typebox';

export interface PrincipleDependency {
  principleId: string;
  dependsOn: string[];
  conflictedWith: string[];
  supersedes: string[];
}

export const PrincipleDependencySchema = Type.Object({
  principleId: Type.String(),
  dependsOn: Type.Array(Type.String()),
  conflictedWith: Type.Array(Type.String()),
  supersedes: Type.Array(Type.String()),
});
export type PrincipleDependencyStatic = Static<typeof PrincipleDependencySchema>;
