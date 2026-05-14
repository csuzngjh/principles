export interface PrincipleDependency {
  principleId: string;
  dependsOn: string[];
  conflictedWith: string[];
  supersedes: string[];
}
